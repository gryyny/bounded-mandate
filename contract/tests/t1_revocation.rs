//! gate: T1
//!
//! Withheld signed orders after confirmed key removal, in the sandbox against the pinned verifier
//! WASM with labelled stub MPC/oracle/tokens. Expectations come from SPEC.md "Authority lifecycle"
//! and T1: zero executions after confirmed removal, old authority never returns, executions before
//! removal recorded honestly.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::evidence;
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy, order_state};
use serde_json::{Value, json};

#[derive(Default)]
struct Ledger {
    /// (label, order id, epoch, relayed_after_confirmed_removal, executed)
    relays: Vec<(String, u64, u64, bool, bool)>,
    notes: Vec<String>,
}

impl Ledger {
    fn record(&mut self, label: &str, order: &Value, after_removal: bool, executed: bool) {
        self.relays.push((
            label.to_owned(),
            order["id"].as_str().unwrap_or("0").parse().unwrap_or(0),
            order["epoch"].as_u64().unwrap_or(0),
            after_removal,
            executed,
        ));
    }

    fn executions_after_removal(&self) -> usize {
        self.relays.iter().filter(|r| r.3 && r.4).count()
    }

    fn json(&self) -> Value {
        json!({
            "relays": self.relays.iter().map(|r| json!({"label": r.0, "order_id": r.1, "epoch": r.2, "after_confirmed_removal": r.3, "executed": r.4})).collect::<Vec<_>>(),
            "executions_after_confirmed_removal": self.executions_after_removal(),
            "notes": self.notes,
        })
    }
}

async fn signed_order(w: &World, sell: Side, amount: u128) -> anyhow::Result<(Value, Value)> {
    let (id, out) = w.propose_id(sell, amount, 50).await?;
    let mp = w
        .signed_payload(&out, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no order_signed event for {id}: {}", out.failure_text()))?;
    Ok((w.order(id).await?, mp))
}

/// Relays and checks the result honestly against verifier balance changes.
async fn relay_and_measure(w: &World, mp: &Value, salt: u8) -> anyhow::Result<bool> {
    let before = w.balances().await?;
    let (out, decoded) = w.relay(mp, salt).await?;
    let after = w.balances().await?;
    let executed = out.is_success();
    if executed {
        let (usdc_t, wnear_t) = w.b.token_ids();
        let du = after.0 as i128 - before.0 as i128;
        let dw = after.1 as i128 - before.1 as i128;
        anyhow::ensure!(du == decoded.delta(&usdc_t), "usdc delta {du} != signed");
        anyhow::ensure!(dw == decoded.delta(&wnear_t), "wnear delta {dw} != signed");
    } else {
        anyhow::ensure!(before == after, "failed relay moved balances");
    }
    Ok(executed)
}

async fn assert_only_key(w: &World, expected: Option<&str>) -> anyhow::Result<()> {
    let keys = w.b.verifier.public_keys_of(w.mandate.id()).await?;
    let want: Vec<String> = expected.into_iter().map(str::to_owned).collect();
    anyhow::ensure!(
        keys == want,
        "mandate verifier keys {keys:?}, expected {want:?}"
    );
    anyhow::ensure!(
        w.b.verifier
            .auth_by_predecessor_enabled(w.mandate.id())
            .await?,
        "predecessor auth disabled"
    );
    Ok(())
}

/// gate: T1 — withhold, revoke, relay from another account; repeat after regrant.
#[tokio::test]
async fn t1_withheld_order_fails_after_removal_and_regrant() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    let mut l = Ledger::default();
    let g1 = w.grant_ok(demo_policy()).await?;
    let pk1 = g1["public_key"].as_str().unwrap().to_owned();
    assert_eq!(g1["path"], "mandate/v1/1");
    assert_eq!(
        pk1,
        w.derived_key("mandate/v1/1").await?,
        "grant key is the MPC-derived key"
    );
    assert_only_key(&w, Some(&pk1)).await?;

    // Executed before removal, recorded honestly and settled.
    let (x, mp_x) = signed_order(&w, Side::Wnear, 10 * NEAR).await?;
    let ok = relay_and_measure(&w, &mp_x, 1).await?;
    l.record("before-removal", &x, false, ok);
    assert!(
        ok,
        "a valid signed order must execute while the key is registered"
    );
    let out = w.settle(&w.b.relayer, 0).await;
    assert!(out.is_success(), "{}", out.failure_text());
    assert_eq!(order_state(&w.order(0).await?), "released:settled");

    // Withheld.
    let (wo, mp_w) = signed_order(&w, Side::Usdc, 100 * USDC).await?;
    let out = w.revoke(None).await;
    assert!(out.is_success(), "revoke: {}", out.failure_text());
    let g = w.grant_view().await?;
    assert_eq!(g["status"], "revoked", "{g}");
    assert!(!w.has_grant_key(&pk1).await?);
    assert_only_key(&w, None).await?;
    let wid: u64 = wo["id"].as_str().unwrap().parse()?;
    assert_eq!(order_state(&w.order(wid).await?), "released:key_removed");
    let ok = relay_and_measure(&w, &mp_w, 2).await?;
    l.record("withheld-after-revoke", &wo, true, ok);
    assert!(!w.nonce_used(&wo).await?);

    // Regrant: new path and key; old order still fails; old key never returns.
    let g2 = w.grant_ok(demo_policy()).await?;
    let pk2 = g2["public_key"].as_str().unwrap().to_owned();
    assert_eq!(g2["epoch"], 2);
    assert_eq!(g2["path"], "mandate/v1/2");
    assert_ne!(pk1, pk2);
    assert!(!w.has_grant_key(&pk1).await?);
    assert_only_key(&w, Some(&pk2)).await?;
    let ok = relay_and_measure(&w, &mp_w, 3).await?;
    l.record("withheld-after-regrant", &wo, true, ok);
    // Re-signing the old payload under the new grant is impossible: the old message is bound to
    // the old key; NEAR and Intents still work for new orders.
    let (y, mp_y) = signed_order(&w, Side::Wnear, 5 * NEAR).await?;
    let ok = relay_and_measure(&w, &mp_y, 4).await?;
    l.record("new-grant-order", &y, false, ok);
    assert!(ok);
    assert_ne!(mp_y["public_key"], mp_w["public_key"]);

    // Third cycle: revoke epoch 2 with a withheld order, regrant epoch 3, both old orders fail.
    let (z, mp_z) = signed_order(&w, Side::Usdc, 50 * USDC).await?;
    assert!(w.revoke(None).await.is_success());
    let g3 = w.grant_ok(demo_policy()).await?;
    assert_eq!(g3["path"], "mandate/v1/3");
    for (label, o, mp, s) in [
        ("epoch1-after-epoch3", &wo, &mp_w, 5u8),
        ("epoch2-after-epoch3", &z, &mp_z, 6),
    ] {
        let ok = relay_and_measure(&w, mp, s).await?;
        l.record(label, o, true, ok);
    }
    assert_only_key(&w, g3["public_key"].as_str()).await?;

    let after = l.executions_after_removal();
    evidence::write(
        "T1",
        Some("withheld-regrant"),
        after == 0,
        "sandbox",
        l.json(),
    );
    assert_eq!(
        after, 0,
        "executions after confirmed removal: {:?}",
        l.relays
    );
    Ok(())
}

/// gate: T1 — revoke while the sign request is pending (MPC holds), then deliver the signature.
#[tokio::test]
async fn t1_revoke_while_signing_then_signature_delivered() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    let mut l = Ledger::default();
    let g = w.grant_ok(demo_policy()).await?;
    let pk = g["public_key"].as_str().unwrap().to_owned();
    w.mpc_mode("hold").await?;
    let status = w.propose_async(Side::Wnear, 20 * NEAR, 50).await?;
    let pending = w.wait_pending_sign(300).await?;
    let req = pending["request_id"].as_u64().unwrap();
    let o = w.order(0).await?;
    assert_eq!(order_state(&o), "signing");

    let out = w.revoke(None).await;
    assert!(out.is_success(), "{}", out.failure_text());
    assert_eq!(w.grant_view().await?["status"], "revoked");
    assert_eq!(order_state(&w.order(0).await?), "released:key_removed");

    // The MPC now publishes a valid signature and resumes our callback.
    let r = w.mpc_respond(req, "valid").await?;
    assert!(r.is_success(), "{}", r.failure_text());
    let _ = status.await?;
    let sig = w.mpc_disclosed(req).await?.expect("signature disclosed");
    // Give the resumed on_signed callback time to land; it must not revive the order.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let o = w.order(0).await?;
    assert_eq!(
        order_state(&o),
        "released:key_removed",
        "late signature must not revive the order"
    );
    let mp = w.multipayload_from(&o, &sig).await?;
    assert_eq!(mp["public_key"], json!(pk));
    let decoded = common::intents::DecodedOrder::from_multipayload(&mp);
    assert!(
        decoded.signature_valid(),
        "disclosed signature verifies over the recorded payload"
    );
    let ok = relay_and_measure(&w, &mp, 7).await?;
    l.record("signature-delivered-after-revoke", &o, true, ok);
    assert!(!w.has_grant_key(&pk).await?);
    assert_only_key(&w, None).await?;
    // Also after a regrant.
    w.mpc_mode("immediate").await?;
    w.grant_ok(demo_policy()).await?;
    let ok = relay_and_measure(&w, &mp, 8).await?;
    l.record("signature-delivered-after-regrant", &o, true, ok);
    let after = l.executions_after_removal();
    evidence::write("T1", Some("pending-sign"), after == 0, "sandbox", l.json());
    assert_eq!(after, 0);
    Ok(())
}

/// gate: T1 — revoke while registration (or derivation) is pending, interleaving receipts. The
/// revoke transaction is submitted with growing delays after the grant; which lifecycle point it
/// hit is read from its own events. Both "derivation in flight" and "registration in flight" must
/// be hit, otherwise the gate is not exercised.
#[tokio::test]
async fn t1_revoke_during_activation() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    let mut cases = Vec::new();
    let mut hit = std::collections::BTreeSet::new();
    for attempt in 0..12u64 {
        if hit.contains("deriving") && hit.contains("registering") && attempt >= 4 {
            break;
        }
        w.set_prices_now(100_000_000, 300_000_000).await?;
        let grant = w.grant_async(demo_policy()).await?;
        tokio::time::sleep(std::time::Duration::from_millis(150 * (attempt % 6))).await;
        let revoke = w
            .owner
            .call(w.mandate.id(), "revoke")
            .args_json(json!({}))
            .gas(common::sandbox::MAX_GAS)
            .transact_async()
            .await?;
        let grant_out = grant.await?;
        let revoke_out = common::sandbox::TxOutcome::Executed(Box::new(revoke.await?));
        let evs: Vec<String> = common::sandbox::events(&revoke_out.logs(), common::world::STANDARD)
            .iter()
            .filter_map(|e| e["event"].as_str().map(str::to_owned))
            .collect();
        let point = if !revoke_out.is_success() {
            "before grant or already revoked"
        } else if evs.iter().any(|e| e == "key_removal_requested") {
            "after registration"
        } else if evs.iter().any(|e| e == "grant_revoked") {
            "deriving"
        } else {
            "registering"
        };
        hit.insert(point);
        // Converge: retry revoke until the grant is revoked (owner behavior after a failed call).
        let mut retries = 0;
        let mut g = w.grant_view().await?;
        let g_before_retry = g.clone();
        while g["status"] != "revoked" && retries < 20 {
            let _ = w.revoke(None).await;
            g = w.grant_view().await?;
            retries += 1;
        }
        let pk = g["public_key"].as_str().map(str::to_owned);
        let key_registered = match &pk {
            Some(pk) => w.has_grant_key(pk).await?,
            None => false,
        };
        let keys = w.b.verifier.public_keys_of(w.mandate.id()).await?;
        // A proposal now must not authorize anything.
        let p = w.propose(Side::Usdc, 10 * USDC, 0).await;
        cases.push(json!({
            "attempt": attempt,
            "delay_ms": 150 * (attempt % 6),
            "grant_tx_ok": grant_out.is_success(),
            "grant_tx_events": common::sandbox::events(&grant_out.logs().into_iter().map(str::to_owned).collect::<Vec<_>>(), common::world::STANDARD).iter().map(|e| e["event"].clone()).collect::<Vec<_>>(),
            "grant_view_before_retry": g_before_retry,
            "revoke_hit": point,
            "revoke_events": evs,
            "revoke_error": (!revoke_out.is_success()).then(|| revoke_out.failure_text().chars().take(200).collect::<String>()),
            "epoch": g["epoch"],
            "final_status": g["status"],
            "retries": retries,
            "key_registered": key_registered,
            "verifier_keys": keys,
            "propose_after_ok": p.is_success(),
        }));
        anyhow::ensure!(g["status"] == "revoked", "grant not revoked: {g}");
        anyhow::ensure!(
            !key_registered && keys.is_empty(),
            "key survived revocation: {keys:?}"
        );
        anyhow::ensure!(!p.is_success(), "proposal accepted after revocation");
        anyhow::ensure!(
            w.orders().await?.iter().all(|o| matches!(
                order_state(o).as_str(),
                "released:key_removed"
                    | "released:settled"
                    | "released:expired"
                    | "released:unsigned"
            ) || o["state"]["state"] == "rejected"),
            "an order kept authority after revocation"
        );
    }
    let both = hit.contains("deriving") && hit.contains("registering");
    evidence::write(
        "T1",
        Some("revoke-during-activation"),
        both,
        "sandbox",
        json!({"cases": cases, "lifecycle_points_hit": hit}),
    );
    assert!(
        both,
        "revocation during derivation and during registration not both exercised: {hit:?}"
    );
    Ok(())
}

/// gate: T1 — removal fails for an honest verifier reason, signed orders may still execute while
/// Revoking (recorded), retry confirms removal, then withheld orders fail.
#[tokio::test]
async fn t1_failed_removal_and_retry() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    let mut l = Ledger::default();
    let g = w.grant_ok(demo_policy()).await?;
    let pk = g["public_key"].as_str().unwrap().to_owned();
    let (a, mp_a) = signed_order(&w, Side::Wnear, 10 * NEAR).await?;
    let (b, mp_b) = signed_order(&w, Side::Usdc, 200 * USDC).await?;

    // Failure 1: the verifier DAO disables predecessor auth for the mandate account; the
    // predecessor-authorized remove_public_key then fails.
    let d = w
        .dao(
            "force_disable_auth_by_predecessor_ids",
            json!({"account_ids": [w.mandate.id()]}),
        )
        .await;
    assert!(d.is_success(), "{}", d.failure_text());
    let out = w.revoke(None).await;
    let g = w.grant_view().await?;
    l.notes.push(format!(
        "failure 1 (auth disabled): revoke tx success={}, status={}",
        out.is_success(),
        g["status"]
    ));
    assert_eq!(
        g["status"], "revoking",
        "failed removal must stay revoking: {g}"
    );
    assert!(w.has_grant_key(&pk).await?);
    let p = w.propose(Side::Usdc, 10 * USDC, 0).await;
    assert!(!p.is_success(), "no new authorization while revoking");

    // Already-signed orders may still execute while Revoking; this one does, and is recorded.
    let ok = relay_and_measure(&w, &mp_a, 9).await?;
    l.record("revoking-before-confirmed-removal", &a, false, ok);
    assert!(
        ok,
        "signed order with a registered key executes (Revoking is not Revoked)"
    );
    let s = w.settle(&w.b.relayer, 0).await;
    assert!(s.is_success());
    assert_eq!(order_state(&w.order(0).await?), "released:settled");

    let e = w
        .dao(
            "force_enable_auth_by_predecessor_ids",
            json!({"account_ids": [w.mandate.id()]}),
        )
        .await;
    assert!(e.is_success(), "{}", e.failure_text());

    // Failure 2: the account is locked by the verifier DAO.
    let lk = w
        .dao("force_lock_account", json!({"account_id": w.mandate.id()}))
        .await;
    assert!(lk.is_success(), "{}", lk.failure_text());
    let out = w.revoke(None).await;
    let g = w.grant_view().await?;
    l.notes.push(format!(
        "failure 2 (account locked): revoke tx success={}, status={}",
        out.is_success(),
        g["status"]
    ));
    assert_eq!(g["status"], "revoking");
    let ul = w
        .dao(
            "force_unlock_account",
            json!({"account_id": w.mandate.id()}),
        )
        .await;
    assert!(ul.is_success(), "{}", ul.failure_text());

    // A gas override below the default cannot be used to make removal fail.
    let low = w.revoke(Some(1)).await;
    l.notes.push(format!(
        "revoke with 1 TGas override rejected: {}",
        !low.is_success()
    ));
    assert!(!low.is_success());

    // Retry succeeds.
    let out = w.revoke(None).await;
    assert!(out.is_success(), "{}", out.failure_text());
    assert_eq!(w.grant_view().await?["status"], "revoked");
    assert!(!w.has_grant_key(&pk).await?);
    let bid: u64 = b["id"].as_str().unwrap().parse()?;
    assert_eq!(order_state(&w.order(bid).await?), "released:key_removed");
    let ok = relay_and_measure(&w, &mp_b, 10).await?;
    l.record("withheld-after-retry", &b, true, ok);
    assert_only_key(&w, None).await?;
    let again = w.revoke(None).await;
    assert!(!again.is_success(), "revoke after revoked must fail");

    let after = l.executions_after_removal();
    evidence::write(
        "T1",
        Some("failed-removal-retry"),
        after == 0,
        "sandbox",
        l.json(),
    );
    assert_eq!(after, 0);
    Ok(())
}
