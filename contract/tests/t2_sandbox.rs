//! gate: T2
//!
//! Seeded interleavings in the sandbox against the REAL verifier: proposals with random MPC
//! behavior (immediate, hold, disclose-only, error), stale-feed rejections, independent relays of
//! published or disclosed signatures, settlement, expiry, revocation and regrant. After every
//! step the caps and accounting are recomputed independently from the spec rule (including the
//! per-proposal turnover floor), every order whose authority the verifier's own
//! `simulate_intents` accepts must be counted in outstanding, and releases happen at most once,
//! on trusted evidence. Mandatory scenario coverage is enforced across the run.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::evidence;
use common::sandbox::authority_live;
use common::valuation::{Px, bps_floor, value_units};
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy, order_state, u};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const SEEDS: [u64; 8] = [11, 12, 13, 14, 15, 16, 17, 18];
const ACTIONS: usize = 8;

/// Minimum counts across the run; each exercises a distinct accounting path.
const REQUIRED: [(&str, usize); 7] = [
    ("fills", 8),
    ("settlements", 8),
    ("expiries", 4),
    ("revocations_with_signed_outstanding", 8),
    ("rejected_proposals", 8),
    ("regrants", 7),
    ("revocations_with_pending_signature", 4),
];

/// Independent per-grant reference: initial value from the recorded reference prices and the
/// balances observed at activation.
struct GrantRef {
    epoch: u64,
    initial: u128,
    usdc: Px,
    wnear: Px,
    key: String,
}

#[derive(Default)]
struct Run {
    /// order id -> MultiPayload we hold (from the event or rebuilt from an MPC disclosure).
    signed: BTreeMap<u64, Value>,
    /// MPC request id -> payload hex, captured while pending.
    payloads: BTreeMap<u64, String>,
    held: Vec<u64>,
    /// Last observed state per order, for release-once checks.
    states: BTreeMap<u64, String>,
    grants: BTreeMap<u64, GrantRef>,
    counts: BTreeMap<String, usize>,
    violations: Vec<String>,
    actions: Vec<String>,
    salt: u8,
}

impl Run {
    fn bump(&mut self, k: &str) {
        *self.counts.entry(k.to_owned()).or_default() += 1;
    }
}

fn px(o: &Value) -> Px {
    Px {
        mantissa: u(&o["price"]) as u64,
        expo: o["expo"].as_i64().unwrap_or(0) as i32,
    }
}

fn is_open(st: &str) -> bool {
    matches!(st, "pricing" | "signing" | "signed" | "sign_unknown")
}

async fn record_grant(w: &World, r: &mut Run) -> anyhow::Result<()> {
    let g = w.grant_view().await?;
    let Some(epoch) = g["epoch"].as_u64() else {
        return Ok(());
    };
    if g["status"] != "active" || r.grants.contains_key(&epoch) {
        return Ok(());
    }
    let (bu, bw) = w.balances().await?;
    let iref = &g["initial_reference"];
    let (up, wp) = (px(&iref["usdc"]), px(&iref["wnear"]));
    let initial = value_units(bu, 6, up, false) + value_units(bw, 24, wp, false);
    if u(&g["initial_value"]) > initial {
        r.violations.push(format!(
            "epoch {epoch}: initial value {} above independent {initial}",
            g["initial_value"]
        ));
    }
    r.grants.insert(
        epoch,
        GrantRef {
            epoch,
            initial,
            usdc: up,
            wnear: wp,
            key: g["public_key"].as_str().unwrap_or_default().to_owned(),
        },
    );
    Ok(())
}

async fn check(w: &World, r: &mut Run, label: &str) -> anyhow::Result<()> {
    let g = w.grant_view().await?;
    let orders = w.orders().await?;
    let epoch = g["epoch"].as_u64().unwrap_or(0);
    let mut v = Vec::new();

    // Accounting consistency and independent caps for the current grant.
    let open_sum: u128 = orders
        .iter()
        .filter(|o| o["epoch"].as_u64() == Some(epoch) && is_open(&order_state(o)))
        .map(|o| u(&o["reserved_value"]))
        .sum();
    if open_sum != u(&g["outstanding"]) {
        v.push(format!(
            "outstanding {} != open reservations {open_sum}",
            g["outstanding"]
        ));
    }
    if let Some(gr) = r.grants.get(&epoch) {
        let pol = &g["policy"];
        let bps = |k: &str| u128::from(pol[k].as_u64().unwrap_or(0) as u32);
        let per_cap = bps_floor(gr.initial, bps("per_order_cap_bps"));
        let out_cap = bps_floor(gr.initial, bps("outstanding_cap_bps"));
        let turn_cap = bps_floor(gr.initial, bps("turnover_cap_bps"));
        let floor_mine = (gr.initial * bps("proposal_charge_bps")).div_ceil(10_000);
        let floor_contract = (u(&g["initial_value"]) * bps("proposal_charge_bps")).div_ceil(10_000);
        let (mut my_out, mut my_turn, mut rule_turn) = (0u128, 0u128, 0u128);
        for o in orders
            .iter()
            .filter(|o| o["epoch"].as_u64() == Some(gr.epoch))
        {
            let st = order_state(o);
            let (amount, dec, init_px, cur) = match o["sell"].as_str() {
                Some("usdc") => (u(&o["sell_amount"]), 6, gr.usdc, &o["reference"]["usdc"]),
                _ => (u(&o["sell_amount"]), 24, gr.wnear, &o["reference"]["wnear"]),
            };
            let mut val = value_units(amount, dec, init_px, true);
            if !cur.is_null() {
                val = val.max(value_units(amount, dec, px(cur), true));
            }
            let rejected = st == "rejected";
            my_turn += if rejected {
                floor_mine
            } else {
                val.max(floor_mine)
            };
            rule_turn += if rejected {
                floor_contract
            } else {
                u(&o["reserved_value"]).max(floor_contract)
            };
            if !rejected && val > per_cap {
                v.push(format!(
                    "order {} value {val} above per-order cap {per_cap}",
                    o["id"]
                ));
            }
            if is_open(&st) {
                my_out += val;
                if val > u(&o["reserved_value"]) {
                    v.push(format!(
                        "order {} reserves {} below conservative value {val}",
                        o["id"], o["reserved_value"]
                    ));
                }
            }
        }
        if my_out > out_cap {
            v.push(format!("outstanding {my_out} above cap {out_cap}"));
        }
        if my_turn > turn_cap {
            v.push(format!("turnover {my_turn} above cap {turn_cap}"));
        }
        if my_turn > u(&g["turnover_used"]) || rule_turn != u(&g["turnover_used"]) {
            v.push(format!(
                "turnover_used {} vs independent {my_turn} / rule {rule_turn}",
                g["turnover_used"]
            ));
        }
    }

    // Live authority (the verifier's own checks) must be counted.
    for (id, mp) in &r.signed {
        let (live, why) = authority_live(&w.b.verifier, mp).await?;
        if !live {
            continue;
        }
        let Some(o) = orders
            .iter()
            .find(|o| o["id"].as_str() == Some(&id.to_string()))
        else {
            v.push(format!("live authority for unknown order {id}"));
            continue;
        };
        let st = order_state(o);
        let counted = matches!(st.as_str(), "signing" | "signed" | "sign_unknown")
            && o["epoch"].as_u64() == Some(epoch)
            && g["status"] != "revoked";
        if !counted {
            v.push(format!(
                "order {id} has live authority ({why}) but is {st} (grant {})",
                g["status"]
            ));
        }
    }

    // Release at most once, on trusted evidence.
    let now = w.b.now_ns().await?;
    for o in &orders {
        let id: u64 = o["id"].as_str().unwrap_or("0").parse()?;
        let st = order_state(o);
        let prev = r.states.insert(id, st.clone());
        if prev.as_ref() == Some(&st) {
            continue;
        }
        if let Some(p) = &prev
            && (p.starts_with("released") || p == "rejected")
        {
            v.push(format!("order {id} left final state {p} for {st}"));
        }
        match st.as_str() {
            "released:settled" => {
                r.bump("settlements");
                if !w.nonce_used(o).await? {
                    v.push(format!("order {id} settled without a used nonce"));
                }
            }
            "released:expired" => {
                r.bump("expiries");
                let dl: u64 = o["deadline_ns"].as_str().unwrap_or("0").parse()?;
                if now <= dl {
                    v.push(format!("order {id} expired before its deadline"));
                }
            }
            "released:key_removed" => {
                let key = r
                    .grants
                    .get(&o["epoch"].as_u64().unwrap_or(0))
                    .map(|g| g.key.clone());
                if let Some(k) = key
                    && !k.is_empty()
                    && w.has_grant_key(&k).await?
                {
                    v.push(format!(
                        "order {id} released for key removal while the key is registered"
                    ));
                }
            }
            "rejected" => r.bump("rejected_proposals"),
            _ => {}
        }
    }
    for m in v {
        r.violations.push(format!("{label}: {m}"));
    }
    Ok(())
}

async fn collect_disclosed(w: &World, r: &mut Run) -> anyhow::Result<()> {
    for p in w.mpc_pending().await? {
        if let (Some(id), Some(hex)) = (p["request_id"].as_u64(), p["payload_hex"].as_str()) {
            r.payloads.entry(id).or_insert_with(|| hex.to_owned());
        }
    }
    let reqs: Vec<(u64, String)> = r.payloads.iter().map(|(k, v)| (*k, v.clone())).collect();
    for (req, hex) in reqs {
        let Some(sig) = w.mpc_disclosed(req).await? else {
            continue;
        };
        let orders = w.orders().await?;
        let Some(o) = orders
            .iter()
            .find(|o| o["payload_hash"].as_str() == Some(hex.as_str()))
        else {
            r.violations.push(format!(
                "disclosed signature for request {req} matches no order"
            ));
            continue;
        };
        let id: u64 = o["id"].as_str().unwrap_or("0").parse()?;
        if let std::collections::btree_map::Entry::Vacant(e) = r.signed.entry(id) {
            let mp = w.multipayload_from(o, &sig).await?;
            if common::intents::DecodedOrder::from_multipayload(&mp).signature_valid() {
                e.insert(mp);
            }
        }
    }
    Ok(())
}

async fn propose(
    w: &World,
    r: &mut Run,
    mode: &str,
    side: Side,
    amount: u128,
) -> anyhow::Result<String> {
    w.mpc_mode(mode).await?;
    if mode == "hold" || mode == "disclose_only" {
        let before: Vec<u64> = w
            .mpc_pending()
            .await?
            .iter()
            .filter_map(|p| p["request_id"].as_u64())
            .collect();
        let _ = w.propose_async(side, amount, 50).await?;
        for _ in 0..40 {
            let now: Vec<u64> = w
                .mpc_pending()
                .await?
                .iter()
                .filter_map(|p| p["request_id"].as_u64())
                .filter(|id| !before.contains(id))
                .collect();
            if let Some(id) = now.first() {
                r.held.push(*id);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
    } else {
        let out = w.propose(side, amount, 50).await;
        if let Ok(id) = out.json::<String>() {
            let id: u64 = id.parse()?;
            if let Some(mp) = w.signed_payload(&out, id).await? {
                r.signed.insert(id, mp);
            }
        }
    }
    Ok(format!("propose ({mode})"))
}

async fn revoke(w: &World, r: &mut Run) -> anyhow::Result<String> {
    let orders = w.orders().await?;
    let signed = orders
        .iter()
        .any(|o| matches!(order_state(o).as_str(), "signed" | "sign_unknown"));
    let pending = orders.iter().any(|o| order_state(o) == "signing");
    let out = w.revoke(None).await;
    let revoked = w.grant_view().await?["status"] == "revoked";
    if out.is_success() && revoked {
        if signed {
            r.bump("revocations_with_signed_outstanding");
        }
        if pending {
            r.bump("revocations_with_pending_signature");
        }
    }
    Ok(format!(
        "revoke ok={revoked} signed={signed} pending={pending}"
    ))
}

async fn step(w: &World, rng: &mut ChaCha8Rng, r: &mut Run) -> anyhow::Result<()> {
    let label = match rng.random_range(0..100) {
        0..32 => {
            w.set_prices_now(100_000_000, rng.random_range(296_000_000..304_000_000))
                .await?;
            let mode = [
                "immediate",
                "immediate",
                "immediate",
                "hold",
                "disclose_only",
                "immediate_error",
            ][rng.random_range(0..6)];
            let (side, amt) = if rng.random_bool(0.5) {
                (Side::Usdc, rng.random_range(1..400) * USDC)
            } else {
                (Side::Wnear, rng.random_range(1..120) * NEAR)
            };
            propose(w, r, mode, side, amt).await?
        }
        32..40 => {
            // Stale feed: the oracle still answers (age <= 60 s) but the deadline window is too
            // short, so pricing must reject without a sign request.
            let t = w.now_s().await?;
            w.set_price(Side::Usdc, 100_000_000, 20_000, t - 58).await?;
            w.set_price(Side::Wnear, 300_000_000, 60_000, t).await?;
            propose(w, r, "immediate", Side::Wnear, 2 * NEAR).await?;
            "propose on near-stale feed".into()
        }
        40..48 => {
            let Some(req) = r.held.pop() else {
                return Ok(());
            };
            let kind =
                ["valid", "error", "disclose_only", "invalid_signature"][rng.random_range(0..4)];
            let _ = w.mpc_respond(req, kind).await?;
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            format!("mpc respond {req} {kind}")
        }
        48..76 | 90..100 => {
            // Prefer orders whose authority is still live; any held signature otherwise.
            let mut ids = Vec::new();
            for (id, mp) in &r.signed {
                if authority_live(&w.b.verifier, mp).await?.0 {
                    ids.push(*id);
                }
            }
            if ids.is_empty() {
                ids = r.signed.keys().copied().collect();
            }
            if ids.is_empty() {
                return Ok(());
            }
            let id = ids[rng.random_range(0..ids.len())];
            r.salt = r.salt.wrapping_add(1);
            let (out, _) = w.relay(&r.signed[&id], r.salt).await?;
            if out.is_success() {
                r.bump("fills");
                let _ = w.settle(&w.b.relayer, id).await;
            }
            format!("relay {id} executed={}", out.is_success())
        }
        76..84 => {
            let orders = w.orders().await?;
            let last = orders
                .iter()
                .filter(|o| {
                    matches!(
                        order_state(o).as_str(),
                        "signed" | "signing" | "sign_unknown"
                    )
                })
                .filter_map(|o| {
                    o["deadline_ns"]
                        .as_str()
                        .and_then(|d| d.parse::<u64>().ok())
                })
                .max();
            if let Some(dl) = last {
                common::sandbox::advance_past(&w.b.worker, dl).await?;
            }
            for o in &orders {
                let id: u64 = o["id"].as_str().unwrap_or("0").parse()?;
                if matches!(
                    order_state(o).as_str(),
                    "signed" | "signing" | "sign_unknown"
                ) {
                    let _ = w.expire(&w.b.relayer, id).await;
                }
            }
            "time + expire".into()
        }
        _ => {
            w.set_prices_now(100_000_000, 300_000_000).await?;
            let _ = propose(w, r, "immediate", Side::Usdc, 20 * USDC).await?;
            let s = revoke(w, r).await?;
            regrant(w, r).await?;
            format!("{s}; regrant")
        }
    };
    collect_disclosed(w, r).await?;
    r.actions.push(label.clone());
    check(w, r, &label).await
}

/// Scripted paths every seed must contain (fill + settlement, a pricing rejection, and on odd
/// seeds an expiry), so coverage does not depend on the random draw; random actions then
/// interleave around the resulting open orders.
async fn prologue(w: &World, r: &mut Run, seed: u64) -> anyhow::Result<()> {
    w.set_prices_now(100_000_000, 300_000_000).await?;
    propose(w, r, "immediate", Side::Wnear, 5 * NEAR).await?;
    if let Some((id, mp)) = r.signed.iter().next_back().map(|(k, v)| (*k, v.clone())) {
        r.salt = r.salt.wrapping_add(1);
        let (out, _) = w.relay(&mp, r.salt).await?;
        if out.is_success() {
            r.bump("fills");
            let _ = w.settle(&w.b.relayer, id).await;
        }
    }
    let t = w.now_s().await?;
    w.set_price(Side::Usdc, 100_000_000, 20_000, t - 58).await?;
    propose(w, r, "immediate", Side::Wnear, 2 * NEAR).await?;
    w.set_prices_now(100_000_000, 300_000_000).await?;
    if seed % 2 == 1 {
        propose(w, r, "immediate", Side::Usdc, 30 * USDC).await?;
        let orders = w.orders().await?;
        if let Some(o) = orders.iter().rev().find(|o| order_state(o) == "signed") {
            let id: u64 = o["id"].as_str().unwrap_or("0").parse()?;
            let dl: u64 = o["deadline_ns"].as_str().unwrap_or("0").parse()?;
            common::sandbox::advance_past(&w.b.worker, dl).await?;
            let _ = w.expire(&w.b.relayer, id).await;
        }
        w.set_prices_now(100_000_000, 300_000_000).await?;
    }
    collect_disclosed(w, r).await?;
    r.actions.push(format!("prologue (seed {seed})"));
    check(w, r, "prologue").await
}

async fn regrant(w: &World, r: &mut Run) -> anyhow::Result<()> {
    w.mpc_mode("immediate").await?;
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let before = w.grant_view().await?["epoch"].as_u64();
    let out = w.grant(demo_policy()).await;
    let g = w.grant_view().await?;
    if out.is_success() && g["status"] == "active" {
        if before.is_some() {
            r.bump("regrants");
        }
        record_grant(w, r).await?;
    }
    Ok(())
}

/// gate: T2
#[tokio::test]
async fn t2_sandbox_interleavings_real_verifier() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    let mut r = Run {
        salt: 7,
        ..Run::default()
    };
    let mut per_seed = Vec::new();
    for seed in SEEDS {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let v0 = r.violations.len();
        let a0 = r.actions.len();
        regrant(&w, &mut r).await?;
        prologue(&w, &mut r, seed).await?;
        for _ in 0..ACTIONS {
            step(&w, &mut rng, &mut r).await?;
        }
        // Close each seed by revoking with a withheld signed order and, on even seeds, a
        // signature still pending at the MPC.
        w.set_prices_now(100_000_000, 300_000_000).await?;
        propose(&w, &mut r, "immediate", Side::Usdc, 15 * USDC).await?;
        if seed % 2 == 0 {
            propose(&w, &mut r, "hold", Side::Wnear, 4 * NEAR).await?;
        }
        let s = revoke(&w, &mut r).await?;
        collect_disclosed(&w, &mut r).await?;
        check(&w, &mut r, &format!("seed {seed} final {s}")).await?;
        // Every signature we hold must now be unusable.
        for (id, mp) in r.signed.clone() {
            let (out, _) = w.relay(&mp, r.salt.wrapping_add(100)).await?;
            if out.is_success() {
                r.violations.push(format!(
                    "seed {seed}: order {id} executed after confirmed removal"
                ));
            }
        }
        r.signed.clear();
        per_seed.push(json!({
            "seed": seed,
            "violations": r.violations[v0..].to_vec(),
            "actions": r.actions[a0..].to_vec(),
        }));
    }
    let coverage: BTreeMap<&str, (usize, usize)> = REQUIRED
        .iter()
        .map(|(k, min)| (*k, (r.counts.get(*k).copied().unwrap_or(0), *min)))
        .collect();
    let coverage_ok = coverage.values().all(|(got, min)| got >= min);
    let passed = r.violations.is_empty() && coverage_ok;
    evidence::write(
        "T2",
        "sandbox-interleavings",
        passed,
        "sandbox",
        json!({
            "seeds": SEEDS,
            "actions_per_seed": ACTIONS,
            "coverage": coverage.iter().map(|(k, (got, min))| (k.to_string(), json!({"count": got, "required": min}))).collect::<serde_json::Map<_, _>>(),
            "coverage_ok": coverage_ok,
            "violations": r.violations,
            "runs": per_seed,
        }),
    );
    assert!(
        coverage_ok,
        "mandatory scenario coverage not met: {coverage:?}"
    );
    assert!(r.violations.is_empty(), "violations: {:?}", r.violations);
    Ok(())
}
