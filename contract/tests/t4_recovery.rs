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
        "dependency-failure",
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
/// account's NEAR. Documented bound: each proposal permanently charges at least
/// ceil(initial_value * proposal_charge_bps / 10000) of turnover and a rejection refunds only the
/// part above it, so one grant accepts at most floor(turnover_cap / floor) proposals. The mandate
/// is funded by an explicit rule (current storage + remaining proposals * measured record size +
/// margin); agent spam of tiny and deliberately rejected proposals must stop exactly at the
/// independently computed count without exhausting storage, and owner revoke/recover still work.
#[tokio::test]
async fn t4_proposal_record_bound_and_funding_rule() -> anyhow::Result<()> {
    const BYTE_COST: u128 = 10_000_000_000_000_000_000; // yocto per byte of storage
    const MARGIN_BYTES: u128 = 4_096;
    let charge_bps: u128 = 200; // test policy: 10000 / 200 = 50 proposals per grant
    let wasm_len = u128::try_from(common::sandbox::built_wasm("bounded_mandate")?.len())?;
    let w = World::new(WorldOpts {
        mandate_usdc: 100 * USDC,
        mandate_wnear: 6_300 * NEAR,
        agent_allowance: NearToken::from_near(5),
        // Code plus room for init, the grant and calibration only; the rule tops up the rest.
        mandate_yocto: Some((wasm_len + 8_000) * BYTE_COST),
        ..WorldOpts::default()
    })
    .await?;
    let mut policy = demo_policy();
    policy["proposal_charge_bps"] = json!(charge_bps);
    let g = w.grant_ok(policy.clone()).await?;

    // Independent bound from the documented rule and the recorded initial reference.
    let r = &g["initial_reference"];
    let px = |o: &Value| common::valuation::Px {
        mantissa: u(&o["price"]) as u64,
        expo: o["expo"].as_i64().unwrap_or(0) as i32,
    };
    let (bu, bw) = w.balances().await?;
    let my_initial = common::valuation::value_units(bu, 6, px(&r["usdc"]), false)
        + common::valuation::value_units(bw, 24, px(&r["wnear"]), false);
    let floor = (my_initial * charge_bps).div_ceil(10_000);
    let turnover_cap = common::valuation::bps_floor(
        my_initial,
        u128::from(policy["turnover_cap_bps"].as_u64().unwrap_or(0)),
    );
    // Bound with tiny/rejected proposals only (each charges exactly the floor).
    let bound_all_floor = turnover_cap / floor;
    assert_eq!(
        u(&g["initial_value"]),
        my_initial,
        "contract initial value differs from independent valuation"
    );

    // Calibrate the record size from storage deltas: one tiny signed order, one rejected order.
    let storage = |a: near_workspaces::types::AccountDetails| u128::from(a.storage_usage);
    let s0 = storage(w.b.worker.view_account(w.mandate.id()).await?);
    let (tiny_id, out) = w.propose_id(Side::Usdc, 1, 0).await?;
    let tiny_mp = w.signed_payload(&out, tiny_id).await?;
    let s1 = storage(w.b.worker.view_account(w.mandate.id()).await?);
    let (rej_id, _) = w.propose_id(Side::Usdc, 101 * USDC, 0).await?;
    let rej = w.wait_order_leaves(rej_id, "pricing", 50).await?;
    let s2 = storage(w.b.worker.view_account(w.mandate.id()).await?);
    anyhow::ensure!(
        order_state(&rej) == "rejected",
        "calibration order not rejected: {rej}"
    );
    // Largest record: a signed order with maximal digit counts (just under the per-order cap).
    let (big_id, out) = w.propose_id(Side::Wnear, 1_266 * NEAR - 1, 50).await?;
    let big_mp = w.signed_payload(&out, big_id).await?;
    let s3 = storage(w.b.worker.view_account(w.mandate.id()).await?);
    let record_bytes = (s1 - s0).max(s2 - s1).max(s3 - s2);
    let mut accepted: u128 = 3;
    // Charges so far by the documented rule: tiny and rejected (101 USD < floor) pay the floor;
    // the large order pays max(its conservative value, floor), valued independently at the
    // initial and the authorization reference.
    let big = w.order(big_id).await?;
    let big_value = [&r["wnear"], &big["reference"]["wnear"]]
        .iter()
        .map(|p| common::valuation::value_units(1_266 * NEAR - 1, 24, px(p), true))
        .max()
        .unwrap_or(0);
    let charged = floor + floor + big_value.max(floor);
    let expected_max = 3 + (turnover_cap - charged) / floor;

    // Funding rule.
    let required_bytes = s3 + (expected_max - accepted) * record_bytes + MARGIN_BYTES;
    let bal =
        w.b.worker
            .view_account(w.mandate.id())
            .await?
            .balance
            .as_yoctonear();
    let required_yocto = required_bytes * BYTE_COST;
    if required_yocto > bal {
        w.b.root
            .transfer_near(
                w.mandate.id(),
                NearToken::from_yoctonear(required_yocto - bal),
            )
            .await?
            .into_result()?;
    }

    // Spam: two rejected (sell above balance) per tiny signed order; fill+settle one order and
    // expire the rest periodically so open orders stay under the 32 limit.
    let mut stop = None;
    let mut storage_failures = Vec::new();
    let mut expired = 0;
    let mut settled = 0;
    if let Some(mp) = &big_mp {
        let (r, _) = w.relay(mp, 91).await?;
        if r.is_success() && w.settle(&w.b.relayer, big_id).await.is_success() {
            settled += 1;
        }
    }
    if let Some(mp) = &tiny_mp {
        let (r, _) = w.relay(mp, 90).await?;
        if r.is_success() && w.settle(&w.b.relayer, tiny_id).await.is_success() {
            settled += 1;
        }
    }
    for i in 0..(expected_max + 5) {
        let amount = if i % 3 == 0 { 1 } else { 101 * USDC };
        let out = w.propose(Side::Usdc, amount, 0).await;
        let text = out.failure_text();
        if text.contains("LackBalanceForState") {
            storage_failures.push(i);
        }
        match out.json::<String>() {
            Ok(id) => {
                accepted += 1;
                let id: u64 = id.parse()?;
                let _ = w.wait_order_leaves(id, "pricing", 50).await?;
            }
            Err(_) => {
                stop = Some(text.chars().take(300).collect::<String>());
                break;
            }
        }
        let open: Vec<Value> = w
            .orders()
            .await?
            .into_iter()
            .filter(|o| {
                matches!(
                    order_state(o).as_str(),
                    "signing" | "signed" | "sign_unknown"
                )
            })
            .collect();
        if open.len() >= 10 {
            let last = open
                .iter()
                .filter_map(|o| {
                    o["deadline_ns"]
                        .as_str()
                        .and_then(|d| d.parse::<u64>().ok())
                })
                .max()
                .unwrap_or(0);
            common::sandbox::advance_past(&w.b.worker, last).await?;
            for o in &open {
                let id: u64 = o["id"].as_str().unwrap_or("0").parse()?;
                if w.expire(&w.b.relayer, id).await.is_success() {
                    expired += 1;
                }
            }
            w.set_prices_now(100_000_000, 300_000_000).await?;
        }
    }
    let refused_at_cap = stop
        .as_deref()
        .is_some_and(|t| t.contains("turnover cap exceeded"));
    let s_end = storage(w.b.worker.view_account(w.mandate.id()).await?);
    let gv = w.grant_view().await?;

    // Owner actions after the bound is reached.
    let rv = w.revoke(None).await;
    let revoked = rv.is_success() && w.grant_view().await?["status"] == "revoked";
    let (ou0, ow0) = w.b.balances(w.owner.id()).await?;
    let (mu, mw) = w.balances().await?;
    let r1 = w.recover(Side::Usdc, None).await;
    let r2 = w.recover(Side::Wnear, None).await;
    let (ou1, ow1) = w.b.balances(w.owner.id()).await?;
    let recovered = r1.is_success()
        && r2.is_success()
        && ou1 - ou0 == mu
        && ow1 - ow0 == mw
        && w.balances().await? == (0, 0);
    let s_final = storage(w.b.worker.view_account(w.mandate.id()).await?);

    let demo_max = 10_000u128 / 50;
    let demo_required_bytes = s0 + demo_max * record_bytes + MARGIN_BYTES;
    let passed = accepted == expected_max
        && refused_at_cap
        && storage_failures.is_empty()
        && s_final <= required_bytes
        && revoked
        && recovered;
    let data = json!({
        "policy_proposal_charge_bps": charge_bps,
        "initial_value_independent": my_initial.to_string(),
        "proposal_floor_value": floor.to_string(),
        "turnover_cap_value": turnover_cap.to_string(),
        "expected_max_proposals": expected_max.to_string(),
        "bound_if_all_proposals_pay_floor": bound_all_floor.to_string(),
        "large_order_charge": big_value.max(floor).to_string(),
        "accepted_proposals": accepted.to_string(),
        "refusal": stop,
        "turnover_used_at_refusal": gv["turnover_used"],
        "record_bytes_measured": {"tiny_signed": (s1 - s0).to_string(), "rejected": (s2 - s1).to_string(), "large_signed": (s3 - s2).to_string(), "used": record_bytes.to_string()},
        "funding_rule": "balance >= (storage after grant + remaining proposals * record_bytes + 4096) * 1e19 yocto",
        "required_bytes": required_bytes.to_string(),
        "required_near": (required_bytes as f64) * 1e-5,
        "storage_bytes": {"after_grant": s0.to_string(), "end_of_spam": s_end.to_string(), "final": s_final.to_string()},
        "storage_failures_at_call": storage_failures,
        "settled": settled,
        "expired": expired,
        "owner_revoke_ok": revoked,
        "owner_recovery_ok": recovered,
        "demo_policy_minimum_funding": {"max_proposals": demo_max.to_string(), "bytes": demo_required_bytes.to_string(), "near": (demo_required_bytes as f64) * 1e-5},
    });
    evidence::write("T4", "record-bound", passed, "sandbox", data.clone());
    assert!(passed, "record bound / funding rule failed: {data}");
    Ok(())
}

async fn revoke_traced(
    w: &World,
) -> anyhow::Result<(
    near_workspaces::result::ExecutionFinalResult,
    Vec<(String, u64, u64, bool)>,
)> {
    let st = w
        .owner
        .call(w.mandate.id(), "revoke")
        .args_json(json!({}))
        .gas(common::sandbox::MAX_GAS)
        .transact_async()
        .await?;
    w.settle_key_ops().await?;
    // Detached removal receipts land after the first outcome: poll until they are included.
    let mut last = None;
    for _ in 0..50 {
        if let std::task::Poll::Ready(r) = st.status().await? {
            let gas = common::sandbox::receipt_gas(&w.b.worker, &r, w.mandate.id()).await?;
            let revoked = w.grant_view().await?["status"] == "revoked";
            let done = gas.iter().any(|g| g.0 == "on_key_presence")
                || (revoked && gas.iter().any(|g| g.0 == "on_key_removed"));
            last = Some((r, gas));
            if done {
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    last.ok_or_else(|| anyhow::anyhow!("revoke outcome unavailable"))
}

/// gate: T4 — revocation and recovery at MAX_OPEN_ORDERS (32) open orders, signed and pending
/// mixed, including a failed removal and retry; gas burnt by the removal callbacks is recorded
/// against the static gas they were given.
#[tokio::test]
async fn t4_open_order_limit() -> anyhow::Result<()> {
    const MAX_OPEN: usize = 32;
    let w = World::new(WorldOpts::default()).await?;
    w.grant_ok(demo_policy()).await?;
    let mut withheld = None;
    for i in 0..MAX_OPEN {
        if i % 6 == 0 {
            w.set_prices_now(100_000_000, 300_000_000).await?;
        }
        let (side, amount) = if i % 2 == 0 {
            (Side::Usdc, 10 * USDC)
        } else {
            (Side::Wnear, 3 * NEAR)
        };
        if i < 20 {
            w.mpc_mode("immediate").await?;
            let (id, out) = w.propose_id(side, amount, 50).await?;
            if withheld.is_none() {
                withheld = w.signed_payload(&out, id).await?;
            }
        } else {
            w.mpc_mode("hold").await?;
            let _ = w.propose_async(side, amount, 50).await?;
            let _ = w.wait_pending_sign(100).await;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }
    let orders = w.orders().await?;
    let mut by_state = std::collections::BTreeMap::new();
    for o in &orders {
        *by_state.entry(order_state(o)).or_insert(0usize) += 1;
    }
    let mpc_pending_at_revoke = w.mpc_pending().await?.len();
    let open = orders
        .iter()
        .filter(|o| {
            matches!(
                order_state(o).as_str(),
                "pricing" | "signing" | "signed" | "sign_unknown"
            )
        })
        .count();
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let over = w.propose(Side::Usdc, USDC, 0).await;
    let limit_enforced = !over.is_success() && over.failure_text().contains("too many open orders");

    // Failed removal at 32 open orders (verifier DAO disables predecessor auth), then retry.
    let d = w
        .dao(
            "force_disable_auth_by_predecessor_ids",
            json!({"account_ids": [w.mandate.id()]}),
        )
        .await;
    anyhow::ensure!(d.is_success(), "{}", d.failure_text());
    let (_, failed_gas) = revoke_traced(&w).await?;
    let after_fail = w.grant_view().await?;
    let e = w
        .dao(
            "force_enable_auth_by_predecessor_ids",
            json!({"account_ids": [w.mandate.id()]}),
        )
        .await;
    anyhow::ensure!(e.is_success(), "{}", e.failure_text());
    let (_, ok_gas) = revoke_traced(&w).await?;
    let g = w.grant_view().await?;
    let released: Vec<String> = w.orders().await?.iter().map(order_state).collect();
    let all_released = released
        .iter()
        .filter(|s| *s == "released:key_removed")
        .count()
        == open;
    let relay_after = match &withheld {
        Some(mp) => Some(w.relay(mp, 33).await?.0.is_success()),
        None => None,
    };

    // Recovery of all units.
    let (mu, mw) = w.balances().await?;
    let (ou0, ow0) = w.b.balances(w.owner.id()).await?;
    let r1 = w.recover(Side::Usdc, None).await;
    let r2 = w.recover(Side::Wnear, None).await;
    let (ou1, ow1) = w.b.balances(w.owner.id()).await?;
    let recovered = r1.is_success()
        && r2.is_success()
        && ou1 - ou0 == mu
        && ow1 - ow0 == mw
        && w.balances().await? == (0, 0);

    let gas_rows = |v: &[(String, u64, u64, bool)]| {
        v.iter()
            .filter(|g| g.0.starts_with("on_key"))
            .map(|g| json!({"method": g.0, "attached_gas": g.1, "gas_burnt": g.2, "attached_note": "prepaid gas of the receipt: static gas plus its share of unused gas", "burnt_share_of_attached": g.2 as f64 / g.1.max(1) as f64, "succeeded": g.3}))
            .collect::<Vec<_>>()
    };
    let callbacks_ok = |v: &[(String, u64, u64, bool)]| {
        let cb: Vec<_> = v.iter().filter(|g| g.0.starts_with("on_key")).collect();
        !cb.is_empty() && cb.iter().all(|g| g.3 && g.2 < g.1)
    };
    let passed = open == MAX_OPEN
        && limit_enforced
        && after_fail["status"] == "revoking"
        && callbacks_ok(&failed_gas)
        && callbacks_ok(&ok_gas)
        && ok_gas.iter().any(|g| g.0 == "on_key_removed")
        && g["status"] == "revoked"
        && all_released
        && relay_after != Some(true)
        && recovered;
    let data = json!({
        "open_orders": open,
        "states_before_revoke": by_state,
        "mpc_requests_pending_at_revoke": mpc_pending_at_revoke,
        "thirty_third_refused": limit_enforced,
        "failed_removal": {"grant_status": after_fail["status"], "callbacks": gas_rows(&failed_gas)},
        "successful_removal": {"grant_status": g["status"], "callbacks": gas_rows(&ok_gas)},
        "released_key_removed": released.iter().filter(|s| *s == "released:key_removed").count(),
        "withheld_relay_after_removal_executed": relay_after,
        "recovered_all_units": recovered,
    });
    evidence::write("T4", "open-order-limit", passed, "sandbox", data.clone());
    assert!(passed, "open-order-limit failed: {data}");
    Ok(())
}
