//! gate: T4
//!
//! Owner recovery with the agent stopped (its allowance exhausted), the MPC unresponsive and the
//! oracle failing, including a partial failure (verifier mt_transfer paused by its DAO between
//! assets) and retry. SPEC: all recoverable units reach owner control without oracle/signature/
//! agent dependence and with no duplicate transfer.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::evidence;
use common::sandbox::TxOutcome;
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy, order_state, u};
use near_workspaces::types::NearToken;
use serde_json::{Value, json};

fn touched(out: &TxOutcome, w: &World) -> Vec<String> {
    match out {
        TxOutcome::Rejected(_) => Vec::new(),
        TxOutcome::Executed(r) => r
            .receipt_outcomes()
            .iter()
            .map(|o| o.executor_id.to_string())
            .filter(|e| e == w.oracle.id().as_str() || e == w.mpc.id().as_str())
            .collect(),
    }
}

/// gate: T4
#[tokio::test]
async fn t4_recovery_without_agent_oracle_mpc() -> anyhow::Result<()> {
    let w = World::new(WorldOpts {
        // Enough for a few proposals at 150 TGas (sandbox gas price 1e9 yocto/gas).
        agent_allowance: NearToken::from_millinear(250),
        ..WorldOpts::default()
    })
    .await?;
    let mut log: Vec<Value> = Vec::new();
    w.grant_ok(demo_policy()).await?;

    // One executed trade and one withheld order, so recovered amounts differ from deposits.
    let out = w.propose(Side::Wnear, 25 * NEAR, 50).await;
    let id: u64 = out.json::<String>()?.parse()?;
    let mp = w.signed_payload(&out, id).await?.expect("signed");
    let (r, _) = w.relay(&mp, 1).await?;
    assert!(r.is_success(), "{}", r.failure_text());
    let _withheld = w.propose(Side::Usdc, 100 * USDC, 50).await;

    // Exhaust the agent's finite allowance. Record the mandate's storage growth: every accepted
    // proposal leaves a permanent order record paid by the mandate account.
    let storage_before = w.b.worker.view_account(w.mandate.id()).await?.storage_usage;
    let orders_before = w.orders().await?.len();
    let mut agent_calls = 0;
    let mut last_allowance;
    let allowance_error = loop {
        agent_calls += 1;
        let keys = w.b.worker.view_access_keys(w.agent.id()).await?;
        last_allowance = keys
            .first()
            .map(|k| format!("{:?}", k.access_key.permission));
        let o = w.propose(Side::Usdc, USDC, 0).await;
        if let TxOutcome::Rejected(e) = &o {
            break Some(e.clone());
        }
        if agent_calls > 150 {
            break None;
        }
    };
    let allowance_hit = allowance_error
        .as_deref()
        .is_some_and(|e| e.contains("Allowance") || e.contains("allowance"));
    let storage_after = w.b.worker.view_account(w.mandate.id()).await?.storage_usage;
    let orders_after = w.orders().await?.len();
    log.push(json!({"step": "mandate storage growth from agent calls", "storage_bytes_before": storage_before, "storage_bytes_after": storage_after, "order_records_added": orders_after - orders_before, "bytes_per_record": (storage_after - storage_before) / u64::try_from((orders_after - orders_before).max(1))?}));
    log.push(json!({"step": "agent allowance exhausted", "agent_calls": agent_calls, "last_allowance_seen": last_allowance, "error": allowance_error}));
    assert!(
        allowance_hit,
        "agent never hit its allowance: {allowance_error:?}"
    );

    // Stop MPC and break the oracle.
    w.mpc_mode("hold").await?;
    w.oracle_ctl("set_fail", json!({"fail": true})).await?;

    let rv = w.revoke(None).await;
    log.push(json!({"step": "owner revoke", "ok": rv.is_success(), "touched_oracle_or_mpc": touched(&rv, &w)}));
    assert!(rv.is_success(), "{}", rv.failure_text());
    assert_eq!(w.grant_view().await?["status"], "revoked");
    assert!(touched(&rv, &w).is_empty());

    let (mu, mw) = w.balances().await?;
    let (ou0, ow0) = w.b.balances(w.owner.id()).await?;
    log.push(json!({"step": "balances at revocation", "mandate_usdc": mu.to_string(), "mandate_wnear": mw.to_string()}));

    // USDC recovers.
    let r1 = w.recover(Side::Usdc, None).await;
    log.push(json!({"step": "recover usdc", "ok": r1.is_success(), "touched_oracle_or_mpc": touched(&r1, &w), "recovery": w.recovery().await?}));
    assert!(touched(&r1, &w).is_empty());

    // Partial failure: the verifier DAO pauses mt_transfer before wNEAR.
    let pause = common::sandbox::call(
        &w.b.dao,
        w.b.verifier.id(),
        "pa_pause_feature",
        json!({"key": "mt_transfer"}),
        NearToken::from_yoctonear(0),
        common::sandbox::MAX_GAS,
    )
    .await;
    assert!(pause.is_success(), "{}", pause.failure_text());
    let r2 = w.recover(Side::Wnear, None).await;
    let after_fail = w.balances().await?;
    log.push(json!({"step": "recover wnear while mt_transfer paused", "tx_ok": r2.is_success(), "mandate_wnear": after_fail.1.to_string(), "recovery": w.recovery().await?}));
    assert_eq!(after_fail.1, mw, "paused transfer must not move funds");
    let unpause = common::sandbox::call(
        &w.b.dao,
        w.b.verifier.id(),
        "pa_unpause_feature",
        json!({"key": "mt_transfer"}),
        NearToken::from_yoctonear(0),
        common::sandbox::MAX_GAS,
    )
    .await;
    assert!(unpause.is_success(), "{}", unpause.failure_text());

    // Retry; then repeat both to show no duplicate transfer.
    let r3 = w.recover(Side::Wnear, None).await;
    log.push(json!({"step": "retry recover wnear", "ok": r3.is_success(), "touched_oracle_or_mpc": touched(&r3, &w), "recovery": w.recovery().await?}));
    let r4 = w.recover(Side::Usdc, None).await;
    let r5 = w.recover(Side::Wnear, None).await;
    log.push(json!({"step": "repeat recover both", "usdc_ok": r4.is_success(), "wnear_ok": r5.is_success(), "recovery": w.recovery().await?}));

    let (fu, fw) = w.balances().await?;
    let (ou1, ow1) = w.b.balances(w.owner.id()).await?;
    let rec = w.recovery().await?;
    let recovered_u = u(&rec[0]["recovered"]);
    let recovered_w = u(&rec[1]["recovered"]);
    let passed = fu == 0
        && fw == 0
        && ou1 - ou0 == mu
        && ow1 - ow0 == mw
        && recovered_u == mu
        && recovered_w == mw;
    // Agent is still stopped; owner actions kept working.
    let agent_after = w.propose(Side::Usdc, USDC, 0).await;
    let orders: Vec<String> = w.orders().await?.iter().map(order_state).collect();
    evidence::write(
        "T4",
        None,
        passed,
        "sandbox",
        json!({
            "steps": log,
            "owner_intents_gain": {"usdc": (ou1 - ou0).to_string(), "wnear": (ow1 - ow0).to_string()},
            "mandate_final": {"usdc": fu.to_string(), "wnear": fw.to_string()},
            "contract_recovered": {"usdc": recovered_u.to_string(), "wnear": recovered_w.to_string()},
            "agent_after_exhaustion_ok": agent_after.is_success(),
            "order_states": orders,
            "destination": "owner's Intents account (mt_transfer inside the verifier)",
        }),
    );
    assert_eq!((fu, fw), (0, 0), "units left in the mandate account");
    assert_eq!(
        (ou1 - ou0, ow1 - ow0),
        (mu, mw),
        "owner did not receive exactly the remaining units"
    );
    assert_eq!(
        (recovered_u, recovered_w),
        (mu, mw),
        "contract recovery accounting differs from transfers"
    );
    Ok(())
}

/// gate: T4 — every accepted proposal leaves a permanent order record paid from the mandate
/// account's NEAR. SPEC: owner actions remain available after the agent exhausts its allowed gas
/// budget. A thinly funded mandate and a generous allowance test whether agent spam can make the
/// owner's revocation fail for lack of storage balance.
#[tokio::test]
async fn t4_agent_storage_spam_cannot_block_revocation() -> anyhow::Result<()> {
    let w = World::new(WorldOpts {
        agent_allowance: NearToken::from_near(3),
        // Code (~305 KB) needs ~3.05 NEAR of storage stake; leave ~0.5 NEAR of headroom.
        mandate_near: 4,
        ..WorldOpts::default()
    })
    .await?;
    w.grant_ok(demo_policy()).await?;
    let acct0 = w.b.worker.view_account(w.mandate.id()).await?;
    let mut calls = 0;
    let mut stop = None;
    let mut accepted = 0;
    let mut released = 0;
    while calls < 400 {
        calls += 1;
        let out = w.propose(Side::Usdc, 1, 0).await;
        match &out {
            TxOutcome::Rejected(e) => {
                stop = Some(format!(
                    "agent tx rejected: {}",
                    e.chars().take(300).collect::<String>()
                ));
                break;
            }
            o if o.is_success() => accepted += 1,
            o => {
                let t = o.failure_text();
                if t.contains("too many open orders") {
                    // Free slots the permissionless way the agent itself could: settle/expire.
                    for ord in w.orders().await? {
                        let id: u64 = ord["id"].as_str().unwrap_or("0").parse()?;
                        if matches!(
                            order_state(&ord).as_str(),
                            "signed" | "signing" | "sign_unknown"
                        ) {
                            let dl: u64 = ord["deadline_ns"].as_str().unwrap_or("0").parse()?;
                            common::sandbox::advance_past(&w.b.worker, dl).await?;
                            if w.expire(&w.b.relayer, id).await.is_success() {
                                released += 1;
                            }
                        }
                    }
                    w.set_prices_now(100_000_000, 300_000_000).await?;
                    continue;
                }
                stop = Some(format!(
                    "propose failed: {}",
                    t.chars().take(300).collect::<String>()
                ));
                if t.contains("LackBalanceForState") || t.contains("storage") {
                    break;
                }
            }
        }
    }
    let acct1 = w.b.worker.view_account(w.mandate.id()).await?;
    let rv = w.revoke(None).await;
    let g = w.grant_view().await?;
    let revoked = rv.is_success() && g["status"] == "revoked";
    let data = json!({
        "agent_calls": calls,
        "accepted_proposals": accepted,
        "released_by_expiry": released,
        "stopped_by": stop,
        "mandate_storage_bytes": {"before": acct0.storage_usage, "after": acct1.storage_usage},
        "mandate_balance_yocto": {"before": acct0.balance.as_yoctonear().to_string(), "after": acct1.balance.as_yoctonear().to_string()},
        "owner_revoke_ok": revoked,
        "owner_revoke_error": (!revoked).then(|| rv.failure_text().chars().take(600).collect::<String>()),
    });
    evidence::write("T4", Some("storage-spam"), revoked, "sandbox", data.clone());
    assert!(revoked, "owner revocation blocked after agent spam: {data}");
    Ok(())
}
