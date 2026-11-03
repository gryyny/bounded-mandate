//! gate: T2b
//!
//! The MPC publishes a valid signature but the mandate's callback never records it (yield never
//! resumed, then times out). An unrelated relayer rebuilds the MultiPayload from the order's
//! recorded payload and the MPC's public disclosure only, and submits it. SPEC: the order remains
//! fully accounted for or is unusable, independent of our filler or page.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::evidence;
use common::intents::DecodedOrder;
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy, order_state, u};
use serde_json::{Value, json};

async fn accounted(w: &World, id: u64) -> anyhow::Result<(bool, Value)> {
    let o = w.order(id).await?;
    let g = w.grant_view().await?;
    let reserved = u(&o["reserved_value"]);
    let open = matches!(
        order_state(&o).as_str(),
        "signing" | "signed" | "sign_unknown"
    );
    let ok = open && reserved > 0 && u(&g["outstanding"]) >= reserved && g["epoch"] == o["epoch"];
    Ok((
        ok,
        json!({"state": order_state(&o), "reserved": reserved.to_string(), "outstanding": g["outstanding"]}),
    ))
}

/// gate: T2b
#[tokio::test]
async fn t2b_disclosed_signature_relayed_independently() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    let mut steps = Vec::new();
    let g = w.grant_ok(demo_policy()).await?;
    w.mpc_mode("disclose_only").await?;

    // Order 0: disclosed, callback pending; relayed while our record says "signing".
    let s0 = w.propose_async(Side::Wnear, 15 * NEAR, 50).await?;
    let p0 = w.wait_pending_sign(300).await?;
    let req0 = p0["request_id"].as_u64().unwrap();
    let sig0 = w.mpc_disclosed(req0).await?.expect("disclosed");
    let o0 = w.order(0).await?;
    assert!(
        o0["signature"].is_null(),
        "our callback has not recorded a signature"
    );
    let (acc0, snap0) = accounted(&w, 0).await?;
    steps.push(json!({"order": 0, "phase": "disclosed, callback pending", "accounted": acc0, "snapshot": snap0}));
    assert!(acc0, "disclosed authority must be reserved: {snap0}");
    let mp0 = w.multipayload_from(&o0, &sig0).await?;
    assert_eq!(mp0["public_key"], g["public_key"]);
    assert!(DecodedOrder::from_multipayload(&mp0).signature_valid());
    let before = w.balances().await?;
    let (out, dec) = w.relay(&mp0, 11).await?;
    let after = w.balances().await?;
    let executed = out.is_success();
    steps.push(json!({"order": 0, "phase": "independent relay", "executed": executed, "error": (!executed).then(|| out.failure_text())}));
    // Still accounted until trusted settlement evidence; then released once.
    let (acc0b, snap0b) = accounted(&w, 0).await?;
    steps.push(json!({"order": 0, "phase": "after relay, before settle", "accounted": acc0b, "snapshot": snap0b}));
    assert!(acc0b, "executed-but-unsettled order must stay reserved");
    if executed {
        let (usdc_t, wnear_t) = w.b.token_ids();
        assert_eq!(after.1 as i128 - before.1 as i128, dec.delta(&wnear_t));
        assert_eq!(after.0 as i128 - before.0 as i128, dec.delta(&usdc_t));
        let st = w.settle(&w.b.relayer, 0).await;
        assert!(st.is_success(), "{}", st.failure_text());
        assert_eq!(order_state(&w.order(0).await?), "released:settled");
    }

    // Order 1: disclosed, then the MPC resumes with an error so our callback sees a failure.
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let s1 = w.propose_async(Side::Usdc, 300 * USDC, 50).await?;
    let mut req1 = None;
    for _ in 0..300 {
        if let Some(p) = w
            .mpc_pending()
            .await?
            .into_iter()
            .find(|p| p["request_id"].as_u64() != Some(req0))
        {
            req1 = p["request_id"].as_u64();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let req1 = req1.expect("second request pending");
    let sig1 = w.mpc_disclosed(req1).await?.expect("disclosed");
    let id1 = 1u64;
    let r = w.mpc_respond(req1, "error").await?;
    assert!(r.is_success(), "{}", r.failure_text());
    let r1 = s1.await;
    let r1_failures: Vec<String> = r1
        .as_ref()
        .map(|r| {
            r.receipt_failures()
                .iter()
                .map(|o| format!("{} {:?}", o.executor_id, (*o).clone().into_result().err()))
                .collect()
        })
        .unwrap_or_default();
    let r1_events: Vec<Value> = r1
        .as_ref()
        .map(|r| {
            common::sandbox::events(
                &r.logs().into_iter().map(str::to_owned).collect::<Vec<_>>(),
                common::world::STANDARD,
            )
            .iter()
            .map(|e| e["event"].clone())
            .collect()
        })
        .unwrap_or_default();
    steps.push(json!({"phase": "callback failure injected", "propose1_tx_ok": r1.as_ref().map(|r| r.is_success()).ok(), "receipt_failures": r1_failures, "events": r1_events}));
    let o1 = w.wait_order_leaves(id1, "signing", 100).await?;
    let st1 = order_state(&o1);
    let (acc1, snap1) = accounted(&w, id1).await?;
    let now = w.b.now_ns().await?;
    let deadline = o1["deadline_ns"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    steps.push(json!({"order": id1, "phase": "callback failed after disclosure", "state": st1, "accounted": acc1, "snapshot": snap1, "past_deadline": now > deadline}));
    let mp1 = w.multipayload_from(&o1, &sig1).await?;
    let (out1, _) = w.relay(&mp1, 12).await?;
    let executed1 = out1.is_success();
    steps.push(json!({"order": id1, "phase": "independent relay after callback failure", "executed": executed1, "error": (!executed1).then(|| out1.failure_text())}));
    // Either still accounted (and possibly executed), or unusable (expired) and only then released.
    let unusable = !executed1 && now > deadline;
    assert!(
        acc1 || unusable,
        "order neither accounted nor unusable: {snap1}"
    );
    if unusable {
        let e = w.expire(&w.b.relayer, id1).await;
        steps.push(json!({"order": id1, "phase": "expire", "ok": e.is_success()}));
        assert_eq!(order_state(&w.order(id1).await?), "released:expired");
    }
    if executed1 {
        assert!(w.settle(&w.b.relayer, id1).await.is_success());
        assert_eq!(order_state(&w.order(id1).await?), "released:settled");
    }

    // Order 2: disclosed, callback failed, NOT relayed until after revocation: unusable.
    w.mpc_mode("hold").await?;
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let s2 = w.propose_async(Side::Wnear, 5 * NEAR, 50).await?;
    let mut req2 = None;
    for _ in 0..300 {
        if let Some(p) = w
            .mpc_pending()
            .await?
            .into_iter()
            .find(|p| p["request_id"].as_u64() > Some(req1))
        {
            req2 = p["request_id"].as_u64();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let req2 = req2.expect("third request");
    let r = w.mpc_respond(req2, "disclose_only").await?;
    assert!(r.is_success(), "{}", r.failure_text());
    let sig2 = w.mpc_disclosed(req2).await?.expect("disclosed");
    let (acc2, snap2) = accounted(&w, 2).await?;
    steps.push(json!({"order": 2, "phase": "disclosed via respond(disclose_only)", "accounted": acc2, "snapshot": snap2}));
    assert!(acc2);
    assert!(w.revoke(None).await.is_success());
    assert_eq!(w.grant_view().await?["status"], "revoked");
    let o2 = w.order(2).await?;
    let mp2 = w.multipayload_from(&o2, &sig2).await?;
    let (out2, _) = w.relay(&mp2, 13).await?;
    steps.push(json!({"order": 2, "phase": "relay after confirmed removal", "executed": out2.is_success(), "state": order_state(&o2)}));
    assert!(
        !out2.is_success(),
        "disclosed order executed after confirmed removal"
    );
    drop(s2);
    drop(s0);

    // Every disclosed signature corresponds to an order that was accounted until trusted
    // evidence released it.
    let passed = acc0 && acc0b && (acc1 || unusable) && acc2 && !out2.is_success();
    evidence::write("T2b", None, passed, "sandbox", json!({"steps": steps}));
    assert!(passed);
    Ok(())
}
