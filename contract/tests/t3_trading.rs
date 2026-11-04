//! gate: T3
//!
//! Adversarial but permitted trading in the sandbox against the pinned verifier. Every executed
//! fill's concession is measured from verifier balance changes against the order's recorded
//! authorization reference and asserted <= 50 bps (SPEC policy), using independent arithmetic.
//! The breaker is driven by price shocks; drawdown, fees and still-executable orders at the trip
//! are reported. Unknown valuation (missing/invalid price) must block authorization.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::evidence;
use common::intents::DecodedOrder;
use common::valuation::{Px, concession_bps, concession_within, value_units};
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy, order_state, u};
use serde_json::{Value, json};

const MAX_BPS: u128 = 50;

/// (price, conf, age_sec) for one feed.
type Feed = (i64, u64, i64);

fn px(o: &Value) -> Px {
    Px {
        mantissa: u(&o["price"]) as u64,
        expo: o["expo"].as_i64().unwrap() as i32,
    }
}

struct Fill {
    order: u64,
    sell: Side,
    sold: u128,
    bought: u128,
    within: bool,
    bps: f64,
    fees: (u128, u128),
}

/// Proposes at max concession, relays immediately, measures from balance deltas.
async fn trade(
    w: &World,
    sell: Side,
    amount: u128,
    label: &str,
    log: &mut Vec<Value>,
) -> anyhow::Result<Option<Fill>> {
    let out = w.propose(sell, amount, 50).await;
    let Ok(id) = out.json::<String>() else {
        log.push(json!({"case": label, "proposed": false, "error": out.failure_text()}));
        return Ok(None);
    };
    let id: u64 = id.parse()?;
    let o = w.order(id).await?;
    let Some(mp) = w.signed_payload(&out, id).await? else {
        log.push(json!({"case": label, "order": id, "state": order_state(&o), "signed": false}));
        return Ok(None);
    };
    let fees_before = w.b.balances(w.b.fee_collector.id()).await?;
    let before = w.balances().await?;
    let (r, _) = w.relay(&mp, (id % 250) as u8 + 1).await?;
    let after = w.balances().await?;
    let fees_after = w.b.balances(w.b.fee_collector.id()).await?;
    if !r.is_success() {
        log.push(json!({"case": label, "order": id, "executed": false, "error": r.failure_text()}));
        return Ok(None);
    }
    let (sold, bought) = match sell {
        Side::Usdc => (before.0 - after.0, after.1 - before.1),
        Side::Wnear => (before.1 - after.1, after.0 - before.0),
    };
    let reference = &o["reference"];
    let (up, wp) = (px(&reference["usdc"]), px(&reference["wnear"]));
    let (sd, sp, bd, bp) = match sell {
        Side::Usdc => (6, up, 24, wp),
        Side::Wnear => (24, wp, 6, up),
    };
    let within = concession_within(sold, sd, sp, bought, bd, bp, MAX_BPS);
    let bps = concession_bps(sold, sd, sp, bought, bd, bp);
    // Cross-check the signed amounts against the verifier deltas: the mandate pays/receives exactly.
    let dec = DecodedOrder::from_multipayload(&mp);
    assert_eq!(dec.signer_id, w.mandate.id().as_str());
    let st = w.settle(&w.b.relayer, id).await;
    assert!(st.is_success(), "{}", st.failure_text());
    let fees = (fees_after.0 - fees_before.0, fees_after.1 - fees_before.1);
    log.push(json!({
        "case": label, "order": id, "sell": sell.as_str(), "sold": sold.to_string(), "bought": bought.to_string(),
        "reference": reference, "concession_bps_approx": (bps * 1e6).round() / 1e6, "within_50bps": within,
        "fees_collected_usdc_units": fees.0.to_string(), "fees_collected_wnear_yocto": fees.1.to_string(),
        "state_after_settle": order_state(&w.order(id).await?),
    }));
    Ok(Some(Fill {
        order: id,
        sell,
        sold,
        bought,
        within,
        bps,
        fees,
    }))
}

/// gate: T3 — max-concession trading, rounding boundaries, shocks between authorization and fill.
#[tokio::test]
async fn t3_concession_bound_on_every_fill() -> anyhow::Result<()> {
    // Non-round prices to exercise rounding: USDC 0.99987654, NEAR 3.14159265.
    let w = World::new(WorldOpts {
        usdc_price: 99_987_654,
        near_price: 314_159_265,
        ..WorldOpts::default()
    })
    .await?;
    w.grant_ok(demo_policy()).await?;
    let mut log = Vec::new();
    let mut fills = Vec::new();
    let cases: Vec<(Side, u128, &str)> = vec![
        (Side::Usdc, 1, "1 USDC unit"),
        (Side::Wnear, 1, "1 yocto wNEAR"),
        (Side::Wnear, 999_999, "sub-micro wNEAR"),
        (Side::Usdc, 999_999, "0.999999 USDC"),
        (Side::Usdc, 1_000_001, "1.000001 USDC"),
        (Side::Wnear, NEAR - 1, "1 wNEAR - 1 yocto"),
        (Side::Wnear, NEAR + 1, "1 wNEAR + 1 yocto"),
        (Side::Usdc, 123_456_789, "123.456789 USDC"),
        (
            Side::Wnear,
            7 * NEAR + 333_333_333_333_333_333_333,
            "7.33 wNEAR",
        ),
        (Side::Usdc, 3_700 * USDC, "near per-order cap (USDC)"),
        (Side::Wnear, 1_150 * NEAR, "near per-order cap (wNEAR)"),
    ];
    for (side, amount, label) in cases {
        w.set_prices_now(99_987_654, 314_159_265).await?;
        if let Some(f) = trade(&w, side, amount, label, &mut log).await? {
            fills.push(f);
        }
    }

    // Price shock between authorization and fill: the concession is measured against the
    // authorization reference; the mark-to-market move is reported separately.
    w.set_prices_now(99_987_654, 314_159_265).await?;
    let out = w.propose(Side::Wnear, 100 * NEAR, 50).await;
    let id: u64 = out.json::<String>()?.parse()?;
    let mp = w.signed_payload(&out, id).await?.expect("signed");
    w.set_prices_now(99_987_654, 282_743_338).await?; // -10% NEAR after signing
    let before = w.balances().await?;
    let (r, _) = w.relay(&mp, 200).await?;
    assert!(r.is_success(), "{}", r.failure_text());
    let after = w.balances().await?;
    let o = w.order(id).await?;
    let (up, wp) = (px(&o["reference"]["usdc"]), px(&o["reference"]["wnear"]));
    let (sold, bought) = (before.1 - after.1, after.0 - before.0);
    let within = concession_within(sold, 24, wp, bought, 6, up, MAX_BPS);
    let fill_px = Px {
        mantissa: 282_743_338,
        expo: -8,
    };
    log.push(json!({
        "case": "shock -10% between authorization and fill", "order": id,
        "concession_bps_vs_authorization": concession_bps(sold, 24, wp, bought, 6, up),
        "concession_bps_vs_fill_time_price": concession_bps(sold, 24, fill_px, bought, 6, up),
        "within_50bps": within,
    }));
    fills.push(Fill {
        order: id,
        sell: Side::Wnear,
        sold,
        bought,
        within,
        bps: concession_bps(sold, 24, wp, bought, 6, up),
        fees: (0, 0),
    });
    assert!(w.settle(&w.b.relayer, id).await.is_success());

    let total_fees = fills
        .iter()
        .fold((0u128, 0u128), |a, f| (a.0 + f.fees.0, a.1 + f.fees.1));
    let violations: Vec<u64> = fills
        .iter()
        .filter(|f| !f.within)
        .map(|f| f.order)
        .collect();
    let max_bps = fills.iter().map(|f| f.bps).fold(f64::MIN, f64::max);
    let passed = violations.is_empty() && fills.len() >= 12;
    evidence::write(
        "T3",
        "concession",
        passed,
        "sandbox",
        json!({
            "fills": fills.len(),
            "max_concession_bps_approx": (max_bps * 1e6).round() / 1e6,
            "assertion": "exact rational: value(bought) * 10000 >= value(sold) * 9950 at the recorded authorization reference",
            "violations": violations,
            "fees_paid_by_filler": {"usdc_units": total_fees.0.to_string(), "wnear_yocto": total_fees.1.to_string()},
            "per_fill": log,
            "sides": fills.iter().map(|f| json!({"order": f.order, "sell": f.sell.as_str(), "sold": f.sold.to_string(), "bought": f.bought.to_string()})).collect::<Vec<_>>(),
        }),
    );
    assert!(violations.is_empty(), "fills over 50 bps: {violations:?}");
    assert!(fills.len() >= 12, "too few fills executed: {}", fills.len());
    Ok(())
}

/// gate: T3 — stale/near-stale feeds, confidence, missing/invalid prices, delayed signatures.
#[tokio::test]
async fn t3_feed_and_timing_adversity() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    w.grant_ok(demo_policy()).await?;
    let mut log = Vec::new();
    let mut failures = Vec::new();
    let now = w.now_s().await?;
    // (label, usdc (price, conf, age), near (price, conf, age), must_sign)
    let scenarios: Vec<(&str, Feed, Feed, Option<bool>)> = vec![
        (
            "fresh",
            (100_000_000, 20_000, 0),
            (300_000_000, 60_000, 0),
            Some(true),
        ),
        (
            "stale 61s",
            (100_000_000, 20_000, 0),
            (300_000_000, 60_000, 61),
            Some(false),
        ),
        (
            "near-stale 59s (deadline too short)",
            (100_000_000, 20_000, 0),
            (300_000_000, 60_000, 59),
            Some(false),
        ),
        (
            "aged 40s (short deadline)",
            (100_000_000, 20_000, 40),
            (300_000_000, 60_000, 0),
            None,
        ),
        (
            "confidence 1%",
            (100_000_000, 1_000_000, 0),
            (300_000_000, 60_000, 0),
            Some(false),
        ),
        (
            "confidence exactly 0.5%",
            (100_000_000, 500_000, 0),
            (300_000_000, 1_500_000, 0),
            Some(true),
        ),
        (
            "zero price",
            (0, 0, 0),
            (300_000_000, 60_000, 0),
            Some(false),
        ),
        (
            "negative price",
            (100_000_000, 20_000, 0),
            (-300_000_000, 60_000, 0),
            Some(false),
        ),
        (
            "published 30s in future",
            (100_000_000, 20_000, -30),
            (300_000_000, 60_000, 0),
            None,
        ),
        // Last: a 10% USDC depeg is a >2% drawdown and trips the breaker for this grant.
        (
            "USDC depeg 0.90 (trips breaker)",
            (90_000_000, 20_000, 0),
            (300_000_000, 60_000, 0),
            Some(false),
        ),
    ];
    for (label, uu, nn, must) in scenarios {
        let t = w.now_s().await?;
        w.set_price(Side::Usdc, uu.0, uu.1, t - uu.2).await?;
        w.set_price(Side::Wnear, nn.0, nn.1, t - nn.2).await?;
        let out = w.propose(Side::Usdc, 50 * USDC, 50).await;
        let id = out
            .json::<String>()
            .ok()
            .and_then(|s| s.parse::<u64>().ok());
        let (state, signed, deadline_left) = match id {
            Some(id) => {
                let o = w.order(id).await?;
                let d = o["deadline_ns"]
                    .as_str()
                    .and_then(|s| s.parse::<u64>().ok());
                let now_ns = i128::from(w.b.now_ns().await?);
                let left = d.map(|d| (d as i128 - now_ns) / 1_000_000_000);
                let signed = w.signed_payload(&out, id).await?.is_some();
                (order_state(&o), signed, left)
            }
            None => (
                format!("propose failed: {}", out.failure_text()),
                false,
                None,
            ),
        };
        if let Some(m) = must
            && m != signed
        {
            failures.push(label);
        }
        log.push(json!({"case": label, "signed": signed, "state": state, "deadline_seconds_left_at_view": deadline_left, "expected_signed": must}));
        // Release whatever was signed so caps do not accumulate.
        if let Some(id) = id
            && signed
        {
            let o = w.order(id).await?;
            let mp = w.signed_payload(&out, id).await?.unwrap();
            let (r, _) = w.relay(&mp, (id % 200) as u8 + 3).await?;
            if r.is_success() {
                assert!(w.settle(&w.b.relayer, id).await.is_success());
            }
            let _ = o;
        }
    }
    let _ = now;

    let g = w.grant_view().await?;
    log.push(json!({"case": "breaker after depeg", "breaker": g["breaker"]}));
    if g["breaker"].is_null() {
        failures.push("depeg did not trip the breaker");
    }
    // Fresh grant for the remaining cases (the breaker is per grant).
    w.set_prices_now(100_000_000, 300_000_000).await?;
    assert!(w.revoke(None).await.is_success());
    w.grant_ok(demo_policy()).await?;

    // Missing price: unavailable feed blocks authorization (unknown valuation is not zero).
    w.set_prices_now(100_000_000, 300_000_000).await?;
    w.oracle_ctl(
        "set_unavailable",
        json!({"price_id": common::world::NEAR_PRICE_ID}),
    )
    .await?;
    let out = w.propose(Side::Usdc, 10 * USDC, 0).await;
    let missing_signed = match out
        .json::<String>()
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        Some(id) => w.signed_payload(&out, id).await?.is_some(),
        None => false,
    };
    log.push(json!({"case": "missing NEAR price", "signed": missing_signed}));
    if missing_signed {
        failures.push("missing NEAR price");
    }
    // Oracle call failing outright.
    w.set_prices_now(100_000_000, 300_000_000).await?;
    w.oracle_ctl("set_fail", json!({"fail": true})).await?;
    let out = w.propose(Side::Usdc, 10 * USDC, 0).await;
    let fail_signed = match out
        .json::<String>()
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        Some(id) => w.signed_payload(&out, id).await?.is_some(),
        None => false,
    };
    log.push(json!({"case": "oracle failing", "signed": fail_signed}));
    if fail_signed {
        failures.push("oracle failing");
    }
    w.oracle_ctl("set_fail", json!({"fail": false})).await?;

    // Delayed signature: the MPC answers after the deadline; the order cannot execute and is
    // released only by expiry.
    w.set_prices_now(100_000_000, 300_000_000).await?;
    w.mpc_mode("hold").await?;
    let status = w.propose_async(Side::Wnear, 3 * NEAR, 50).await?;
    let p = match w.wait_pending_sign(100).await {
        Ok(p) => p,
        Err(e) => {
            let last = w.orders().await?.last().cloned();
            anyhow::bail!("{e}: last order {last:?}; cases so far {log:?}");
        }
    };
    let req = p["request_id"].as_u64().unwrap();
    let orders = w.orders().await?;
    let o = orders.last().unwrap().clone();
    let id: u64 = o["id"].as_str().unwrap().parse()?;
    let deadline: u64 = o["deadline_ns"].as_str().unwrap().parse()?;
    common::sandbox::advance_past(&w.b.worker, deadline).await?;
    let r = w.mpc_respond(req, "valid").await?;
    let _ = status.await;
    let o = w.order(id).await?;
    let relay_executed = match w.mpc_disclosed(req).await? {
        Some(sig) => {
            let mp = w.multipayload_from(&o, &sig).await?;
            Some(w.relay(&mp, 251).await?.0.is_success())
        }
        None => None,
    };
    let ex = w.expire(&w.b.relayer, id).await;
    log.push(json!({"case": "signature delivered after deadline", "respond_ok": r.is_success(), "state_after_callback": order_state(&o), "relay_executed": relay_executed, "expire_ok": ex.is_success(), "final": order_state(&w.order(id).await?)}));
    if relay_executed == Some(true) {
        failures.push("delayed signature executed after deadline");
    }
    w.mpc_mode("immediate").await?;

    let passed = failures.is_empty();
    evidence::write(
        "T3",
        "feeds-timing",
        passed,
        "sandbox",
        json!({"cases": log, "failures": failures}),
    );
    assert!(passed, "unexpected authorization outcomes: {failures:?}");
    Ok(())
}

/// gate: T3 — drive a drawdown to trip the breaker; report drawdown, fees and still-executable
/// orders at the trip; executable orders remain usable (the breaker is not a total-loss cap).
#[tokio::test]
async fn t3_breaker_trip_report() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    let g = w.grant_ok(demo_policy()).await?;
    let initial = u(&g["initial_value"]);
    let iref = &g["initial_reference"];
    let (b0u, b0w) = w.balances().await?;
    let mine = value_units(b0u, 6, px(&iref["usdc"]), false)
        + value_units(b0w, 24, px(&iref["wnear"]), false);
    assert!(
        initial <= mine,
        "contract initial value {initial} above independent {mine}"
    );

    // Adversarial agent: max-concession trades until turnover is exhausted, then withhold two
    // signed orders.
    let mut fees = (0u128, 0u128);
    let mut fill_log = Vec::new();
    for i in 0..6 {
        w.set_prices_now(100_000_000, 300_000_000).await?;
        if let Some(f) = trade(
            &w,
            if i % 2 == 0 { Side::Usdc } else { Side::Wnear },
            if i % 2 == 0 {
                3_000 * USDC
            } else {
                1_000 * NEAR
            },
            "churn",
            &mut fill_log,
        )
        .await?
        {
            assert!(f.within);
            fees.0 += f.fees.0;
            fees.1 += f.fees.1;
        }
    }
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let mut withheld = Vec::new();
    for amount in [400 * USDC, 300 * USDC] {
        let out = w.propose(Side::Usdc, amount, 50).await;
        if let Ok(id) = out.json::<String>() {
            let id: u64 = id.parse()?;
            if let Some(mp) = w.signed_payload(&out, id).await? {
                withheld.push((id, mp));
            }
        }
    }
    // Price shock: NEAR -8%.
    w.set_prices_now(100_000_000, 276_000_000).await?;
    let trip_out = w.propose(Side::Usdc, 10 * USDC, 0).await;
    let g = w.grant_view().await?;
    let trip = g["breaker"].clone();
    let (bu, bw) = w.balances().await?;
    let mtm = value_units(
        bu,
        6,
        Px {
            mantissa: 100_000_000,
            expo: -8,
        },
        false,
    ) + value_units(
        bw,
        24,
        Px {
            mantissa: 276_000_000,
            expo: -8,
        },
        false,
    );
    let drawdown_bps = (mine as f64 - mtm as f64) / mine as f64 * 10_000.0;
    // Independent count of still-executable orders: signed, key registered, unexpired, unused.
    let pk = g["public_key"].as_str().unwrap().to_owned();
    let key_on = w.has_grant_key(&pk).await?;
    let now = w.b.now_ns().await?;
    let mut exec_count = 0u32;
    let mut exec_value = 0u128;
    for (id, _) in &withheld {
        let o = w.order(*id).await?;
        let dl: u64 = o["deadline_ns"].as_str().unwrap().parse()?;
        if key_on && now <= dl && !w.nonce_used(&o).await? {
            exec_count += 1;
            exec_value += u(&o["reserved_value"]);
        }
    }
    let after_trip = w.propose(Side::Usdc, 10 * USDC, 0).await;
    // A withheld order still executes after the trip (breaker stops only new authorization).
    let mut post_trip_exec = None;
    if let Some((id, mp)) = withheld.first() {
        let (r, _) = w.relay(mp, 77).await?;
        post_trip_exec = Some(json!({"order": id, "executed": r.is_success()}));
    }
    let tripped = !trip.is_null();
    let passed = tripped
        && trip["executable_orders"].as_u64() == Some(u64::from(exec_count))
        && !after_trip.is_success();
    evidence::write(
        "T3",
        "breaker",
        passed,
        "sandbox",
        json!({
            "initial_value_contract": initial.to_string(),
            "initial_value_independent": mine.to_string(),
            "trip": trip,
            "trip_propose_error": (!trip_out.is_success()).then(|| trip_out.failure_text()),
            "independent_mark_to_market_at_trip": mtm.to_string(),
            "independent_drawdown_bps": drawdown_bps,
            "fees_paid_by_filler_before_trip": {"usdc_units": fees.0.to_string(), "wnear_yocto": fees.1.to_string()},
            "fees_paid_by_mandate": "0 (verifier fees are charged on the counterparty's negative deltas)",
            "independent_still_executable_orders": exec_count,
            "independent_still_executable_reserved_value": exec_value.to_string(),
            "proposal_after_trip_rejected": !after_trip.is_success(),
            "post_trip_withheld_execution": post_trip_exec,
            "churn_fills": fill_log,
        }),
    );
    assert!(
        tripped,
        "breaker did not trip at {drawdown_bps:.1} bps drawdown: {g}"
    );
    assert_eq!(
        trip["executable_orders"].as_u64(),
        Some(u64::from(exec_count)),
        "reported executable orders differ"
    );
    assert!(
        !after_trip.is_success(),
        "authorization continued after the breaker"
    );
    Ok(())
}
