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
use near_workspaces::types::NearToken;
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
    evidence::write(
        "T2b",
        "disclosed-relay",
        passed,
        "sandbox",
        json!({"steps": steps}),
    );
    assert!(passed);
    Ok(())
}

const BYTE_COST: i128 = 10_000_000_000_000_000_000;

/// Polls a pending proposal transaction until its outcome shows a failed receipt on `mandate`
/// whose error is `LackBalanceForState`; returns that failure's description.
async fn wait_storage_failure(
    status: &near_workspaces::operations::TransactionStatus,
    mandate: &near_workspaces::AccountId,
) -> anyhow::Result<Option<String>> {
    for _ in 0..60 {
        if let std::task::Poll::Ready(r) = status.status().await? {
            let hit = r
                .receipt_outcomes()
                .iter()
                .filter(|o| &o.executor_id == mandate && o.is_failure())
                .map(|o| format!("{:?}", (*o).clone().into_result().err()))
                .find(|e| e.contains("LackBalanceForState"));
            if hit.is_some() {
                return Ok(hit);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    Ok(None)
}

async fn new_pending(w: &World, seen: &[u64]) -> anyhow::Result<u64> {
    for _ in 0..100 {
        if let Some(id) = w
            .mpc_pending()
            .await?
            .iter()
            .filter_map(|p| p["request_id"].as_u64())
            .find(|id| !seen.contains(id))
        {
            return Ok(id);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    anyhow::bail!("no new MPC request")
}

async fn order_on(m: &near_workspaces::Contract, id: u64) -> anyhow::Result<Value> {
    Ok(m.view("get_order")
        .args_json(json!({"order_id": id.to_string()}))
        .await?
        .json()?)
}

async fn wait_state(m: &near_workspaces::Contract, id: u64, want: &str) -> anyhow::Result<Value> {
    for _ in 0..100 {
        let o = order_on(m, id).await?;
        if !o.is_null() && order_state(&o) == want {
            return Ok(o);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    order_on(m, id).await
}

/// gate: T2b — the mandate's own `on_signed` receipt fails (LackBalanceForState: the account
/// cannot pay for storing the signature) after the MPC disclosed a valid signature. The order
/// must stay reserved, an independent relay must be consistent with accounting, and the order
/// must fail after confirmed removal. Production WASM; the funding is calibrated in-test on an
/// identically deployed mandate.
#[tokio::test]
async fn t2b_callback_failed_after_disclosure() -> anyhow::Result<()> {
    let b_init: u128 = 20 * NEAR;
    let w = World::new(WorldOpts {
        mandate_yocto: Some(b_init),
        ..WorldOpts::default()
    })
    .await?;
    let proposals = [(Side::Wnear, 5 * NEAR), (Side::Usdc, 50 * USDC)];

    // Calibration on the first mandate: free balance with both orders at Signing, and the
    // storage growth of one successful on_signed.
    w.grant_ok(demo_policy()).await?;
    w.mpc_mode("hold").await?;
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let mut seen = Vec::new();
    for (i, (side, amount)) in proposals.iter().enumerate() {
        let _ = w.propose_async(*side, *amount, 50).await?;
        seen.push(new_pending(&w, &seen).await?);
        wait_state(&w.mandate, i as u64, "signing").await?;
    }
    let (free_s, s_s) = w.free_balance(w.mandate.id()).await?;
    let r = w.mpc_respond(seen[0], "valid").await?;
    anyhow::ensure!(r.is_success(), "calibration respond: {}", r.failure_text());
    let signed = wait_state(&w.mandate, 0, "signed").await?;
    anyhow::ensure!(
        order_state(&signed) == "signed",
        "calibration on_signed did not record"
    );
    let (_, s_signed) = w.free_balance(w.mandate.id()).await?;
    let sign_growth = i128::from(s_signed) - i128::from(s_s);
    anyhow::ensure!(
        sign_growth > 0,
        "on_signed does not grow storage ({sign_growth} B)"
    );

    // Target mandate: same deployment, funded so that at Signing only half of on_signed's
    // storage growth is covered.
    let agent2 = common::sandbox::subaccount(&w.b.root, "agen2", 10).await?;
    let b2 = i128::try_from(b_init)? - free_s + sign_growth * BYTE_COST / 2;
    let m2 = w
        .deploy_extra_mandate("mandat2", agent2.id(), u128::try_from(b2)?)
        .await?;
    w.b.fund_intents_for(&w.owner, m2.id(), 10_000 * USDC, 3_000 * NEAR)
        .await?;
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let g = common::sandbox::call(
        &w.owner,
        m2.id(),
        "grant",
        json!({"policy": demo_policy()}),
        NearToken::from_yoctonear(0),
        common::world::GRANT_GAS,
    )
    .await;
    let mut gv = Value::Null;
    for _ in 0..100 {
        gv = m2.view("get_grant").await?.json()?;
        if gv["status"] == "active" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    anyhow::ensure!(
        gv["status"] == "active",
        "target grant: {gv} {}",
        g.failure_text()
    );
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let mut statuses = Vec::new();
    let mut reqs = Vec::new();
    for (i, (side, amount)) in proposals.iter().enumerate() {
        let st = agent2
            .call(m2.id(), "propose_order")
            .args_json(json!({"proposal": {"sell": side.as_str(), "sell_amount": amount.to_string(), "max_concession_bps": 50}}))
            .gas(common::world::PROPOSE_GAS)
            .transact_async()
            .await?;
        statuses.push(st);
        let mut all = seen.clone();
        all.extend(&reqs);
        reqs.push(new_pending(&w, &all).await?);
        wait_state(&m2, i as u64, "signing").await?;
    }
    let (free2, _) = w.free_balance(m2.id()).await?;
    let precondition = free2 >= 0 && free2 < sign_growth * BYTE_COST;
    anyhow::ensure!(
        precondition,
        "target free balance {free2} not inside [0, {}) at Signing",
        sign_growth * BYTE_COST
    );
    let pre_failure = wait_storage_failure_now(&statuses[0], m2.id()).await?;

    // The MPC discloses valid signatures and resumes; our on_signed must fail.
    let mut failures = Vec::new();
    for (i, req) in reqs.iter().enumerate() {
        let r = w.mpc_respond(*req, "valid").await?;
        anyhow::ensure!(r.is_success(), "respond: {}", r.failure_text());
        failures.push(wait_storage_failure(&statuses[i], m2.id()).await?);
    }
    let mut steps = Vec::new();
    let mut ok = pre_failure.is_none() && failures.iter().all(Option::is_some);
    let gv: Value = m2.view("get_grant").await?.json()?;
    let mut orders = Vec::new();
    for i in 0..2u64 {
        let o = order_on(&m2, i).await?;
        let accounted = order_state(&o) == "signing"
            && o["signature"].is_null()
            && u(&gv["outstanding"]) >= u(&o["reserved_value"])
            && u(&o["reserved_value"]) > 0;
        ok &= accounted;
        steps.push(json!({"order": i, "phase": "after failed on_signed", "state": order_state(&o), "signature_recorded": !o["signature"].is_null(), "accounted": accounted}));
        orders.push(o);
    }
    let outstanding_both =
        u(&gv["outstanding"]) == u(&orders[0]["reserved_value"]) + u(&orders[1]["reserved_value"]);
    ok &= outstanding_both;

    // Independent relay of order 0 from the MPC's disclosure.
    let sig0 = w.mpc_disclosed(reqs[0]).await?.expect("disclosed");
    let g2pk = gv["public_key"].as_str().unwrap_or_default().to_owned();
    let mp0 = rebuild(&orders[0], &g2pk, &sig0)?;
    ok &= DecodedOrder::from_multipayload(&mp0).signature_valid();
    let before = w.b.balances(m2.id()).await?;
    let (out, dec) = w.relay(&mp0, 61).await?;
    let after = w.b.balances(m2.id()).await?;
    let executed = out.is_success();
    let (usdc_t, wnear_t) = w.b.token_ids();
    let deltas_match = !executed
        || (after.0 as i128 - before.0 as i128 == dec.delta(&usdc_t)
            && after.1 as i128 - before.1 as i128 == dec.delta(&wnear_t));
    let o0 = order_on(&m2, 0).await?;
    let still_reserved = order_state(&o0) == "signing";
    ok &= executed && deltas_match && still_reserved;
    steps.push(json!({"order": 0, "phase": "independent relay", "executed": executed, "deltas_match_signed_amounts": deltas_match, "still_reserved": still_reserved}));

    // The experiment is done; fund storage so settlement and revocation can write state.
    w.b.root
        .transfer_near(m2.id(), NearToken::from_millinear(100))
        .await?
        .into_result()?;
    let st = common::sandbox::call(
        &w.b.relayer,
        m2.id(),
        "settle_order",
        json!({"order_id": "0"}),
        NearToken::from_yoctonear(0),
        near_workspaces::types::Gas::from_tgas(100),
    )
    .await;
    let settled = order_state(&order_on(&m2, 0).await?) == "released:settled";
    ok &= st.is_success() && settled;
    steps.push(
        json!({"order": 0, "phase": "settle on verifier evidence", "released_settled": settled}),
    );

    // Order 1: confirmed removal, then the disclosed order fails.
    let rv = common::sandbox::call(
        &w.owner,
        m2.id(),
        "revoke",
        json!({}),
        NearToken::from_yoctonear(0),
        common::sandbox::MAX_GAS,
    )
    .await;
    let mut gstatus = Value::Null;
    for _ in 0..100 {
        gstatus = m2.view("get_grant").await?.json()?;
        if gstatus["status"] == "revoked" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let sig1 = w.mpc_disclosed(reqs[1]).await?.expect("disclosed");
    let o1 = order_on(&m2, 1).await?;
    let mp1 = rebuild(&o1, &g2pk, &sig1)?;
    let (out1, _) = w.relay(&mp1, 62).await?;
    let removed_ok = rv.is_success()
        && gstatus["status"] == "revoked"
        && !out1.is_success()
        && order_state(&o1) == "released:key_removed";
    ok &= removed_ok;
    steps.push(json!({"order": 1, "phase": "relay after confirmed removal", "executed": out1.is_success(), "state": order_state(&o1), "grant": gstatus["status"]}));

    evidence::write(
        "T2b",
        "callback-failed-after-disclosure",
        ok,
        "sandbox",
        json!({
            "mechanism": "mandate funded (calibrated in-test) to cover storage up to Signing but not on_signed's growth; on_signed fails with LackBalanceForState after the MPC disclosed and resumed",
            "calibration": {"free_at_signing_yocto": free_s.to_string(), "storage_at_signing": s_s, "on_signed_growth_bytes": sign_growth},
            "target_free_at_signing_yocto": free2.to_string(),
            "failure_absent_before_respond": pre_failure.is_none(),
            "on_signed_failures": failures,
            "outstanding_equals_both_reservations": outstanding_both,
            "steps": steps,
        }),
    );
    assert!(
        ok,
        "T2b callback-failed-after-disclosure failed: {steps:?} failures {failures:?}"
    );
    Ok(())
}

/// One status check without waiting (the failure must not exist before the MPC responds).
async fn wait_storage_failure_now(
    status: &near_workspaces::operations::TransactionStatus,
    mandate: &near_workspaces::AccountId,
) -> anyhow::Result<Option<String>> {
    if let std::task::Poll::Ready(r) = status.status().await? {
        return Ok(r
            .receipt_outcomes()
            .iter()
            .filter(|o| &o.executor_id == mandate && o.is_failure())
            .map(|o| format!("{:?}", (*o).clone().into_result().err()))
            .next());
    }
    Ok(None)
}

fn rebuild(order: &Value, pk: &str, sig: &[u8]) -> anyhow::Result<Value> {
    let p = &order["payload"];
    let payload = common::intents::Nep413Payload {
        message: p["message"].as_str().unwrap_or_default().to_owned(),
        nonce: common::intents::unb64(p["nonce"].as_str().unwrap_or_default())
            .try_into()
            .map_err(|_| anyhow::anyhow!("nonce"))?,
        recipient: p["recipient"].as_str().unwrap_or_default().to_owned(),
        callback_url: None,
    };
    let pk: [u8; 32] = common::intents::parse_ed25519_str(pk)
        .try_into()
        .map_err(|_| anyhow::anyhow!("pk"))?;
    let sig: [u8; 64] = sig.try_into().map_err(|_| anyhow::anyhow!("sig"))?;
    Ok(common::intents::multipayload(&payload, &pk, &sig))
}
