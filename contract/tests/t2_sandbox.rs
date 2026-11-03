//! gate: T2
//!
//! Smaller seeded interleaving run in the sandbox against the REAL verifier: proposals with
//! random MPC behavior (immediate, hold then valid/error/disclose-only), independent relays of
//! published or disclosed signatures, settlement, expiry, revocation and regrant. After every
//! action, every known signature is checked for live authority with the verifier's own
//! `simulate_intents`; live authority must be counted in the contract's outstanding accounting.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::evidence;
use common::sandbox::authority_live;
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy, order_state, u};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const SEEDS: [u64; 10] = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const ACTIONS: usize = 14;

struct Run {
    /// order id -> MultiPayload we hold (from the event or rebuilt from an MPC disclosure).
    signed: BTreeMap<u64, Value>,
    /// MPC request ids held for an explicit response.
    held: Vec<u64>,
    /// MPC request id -> payload hex, captured while pending.
    payloads: BTreeMap<u64, String>,
    violations: Vec<String>,
    actions: Vec<String>,
    fills: usize,
    salt: u8,
}

async fn check(w: &World, r: &mut Run, label: &str) -> anyhow::Result<()> {
    let g = w.grant_view().await?;
    let orders = w.orders().await?;
    let open: u128 = orders
        .iter()
        .filter(|o| {
            o["epoch"] == g["epoch"]
                && matches!(
                    order_state(o).as_str(),
                    "pricing" | "signing" | "signed" | "sign_unknown"
                )
        })
        .map(|o| u(&o["reserved_value"]))
        .sum();
    if open != u(&g["outstanding"]) {
        r.violations.push(format!(
            "{label}: outstanding {} != open reservations {open}",
            g["outstanding"]
        ));
    }
    for (id, mp) in &r.signed {
        let (live, why) = authority_live(&w.b.verifier, mp).await?;
        if !live {
            continue;
        }
        let o = w.order(*id).await?;
        let st = order_state(&o);
        let counted = matches!(st.as_str(), "signing" | "signed" | "sign_unknown")
            && o["epoch"] == g["epoch"]
            && g["status"] != "revoked";
        if !counted {
            r.violations.push(format!(
                "{label}: order {id} has live authority ({why}) but is {st} (grant {})",
                g["status"]
            ));
        }
    }
    Ok(())
}

async fn collect_disclosed(w: &World, r: &mut Run) -> anyhow::Result<()> {
    // Remember each MPC request's payload while it is pending; rebuild MultiPayloads for any
    // disclosed signature from the matching order's recorded payload, independent of our events.
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

async fn step(w: &World, rng: &mut ChaCha8Rng, r: &mut Run) -> anyhow::Result<()> {
    let roll = rng.random_range(0..100);
    let label;
    match roll {
        0..40 => {
            let mode = [
                "immediate",
                "immediate",
                "hold",
                "disclose_only",
                "immediate_error",
            ][rng.random_range(0..5)];
            w.mpc_mode(mode).await?;
            w.set_prices_now(100_000_000, rng.random_range(295_000_000..305_000_000))
                .await?;
            let (side, amt) = if rng.random_bool(0.5) {
                (Side::Usdc, rng.random_range(1..500) * USDC)
            } else {
                (Side::Wnear, rng.random_range(1..150) * NEAR)
            };
            if mode == "hold" || mode == "disclose_only" {
                let before: Vec<u64> = w
                    .mpc_pending()
                    .await?
                    .iter()
                    .filter_map(|p| p["request_id"].as_u64())
                    .collect();
                let _ = w.propose_async(side, amt, rng.random_range(0..=50)).await?;
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                for p in w.mpc_pending().await? {
                    if let Some(id) = p["request_id"].as_u64()
                        && !before.contains(&id)
                    {
                        r.held.push(id);
                    }
                }
            } else {
                let out = w.propose(side, amt, rng.random_range(0..=50)).await;
                if let Ok(id) = out.json::<String>() {
                    let id: u64 = id.parse()?;
                    if let Some(mp) = w.signed_payload(&out, id).await? {
                        r.signed.insert(id, mp);
                    }
                }
            }
            label = format!("propose ({mode})");
        }
        40..55 => {
            if r.held.is_empty() {
                return Ok(());
            }
            let req = r.held[rng.random_range(0..r.held.len())];
            let kind =
                ["valid", "error", "disclose_only", "invalid_signature"][rng.random_range(0..4)];
            let _ = w.mpc_respond(req, kind).await?;
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            label = format!("mpc respond {req} {kind}");
        }
        55..72 => {
            let ids: Vec<u64> = r.signed.keys().copied().collect();
            if ids.is_empty() {
                return Ok(());
            }
            let id = ids[rng.random_range(0..ids.len())];
            r.salt = r.salt.wrapping_add(1);
            let (out, _) = w.relay(&r.signed[&id], r.salt).await?;
            if out.is_success() {
                r.fills += 1;
            }
            label = format!("relay {id} executed={}", out.is_success());
        }
        72..80 => {
            let ids: Vec<u64> = r.signed.keys().copied().collect();
            if ids.is_empty() {
                return Ok(());
            }
            let id = ids[rng.random_range(0..ids.len())];
            let out = w.settle(&w.b.relayer, id).await;
            label = format!("settle {id} ok={}", out.is_success());
        }
        80..88 => {
            w.b.worker.fast_forward(rng.random_range(5..80)).await?;
            let orders = w.orders().await?;
            for o in orders {
                let id: u64 = o["id"].as_str().unwrap_or("0").parse()?;
                let _ = w.expire(&w.b.relayer, id).await;
            }
            label = "time + expire".into();
        }
        88..94 => {
            let out = w.revoke(None).await;
            label = format!("revoke ok={}", out.is_success());
        }
        _ => {
            w.set_prices_now(100_000_000, 300_000_000).await?;
            w.mpc_mode("immediate").await?;
            let out = w.grant(demo_policy()).await;
            label = format!("grant ok={}", out.is_success());
        }
    }
    collect_disclosed(w, r).await?;
    r.actions.push(label.clone());
    check(w, r, &label).await
}

/// gate: T2
#[tokio::test]
async fn t2_sandbox_interleavings_real_verifier() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    let mut results = Vec::new();
    for seed in SEEDS {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        // Each seed starts from a fresh grant (revoking the previous one).
        let g = w.grant_view().await?;
        if !g.is_null() && g["status"] != "revoked" {
            for _ in 0..5 {
                if w.revoke(None).await.is_success() || w.grant_view().await?["status"] == "revoked"
                {
                    break;
                }
            }
        }
        w.mpc_mode("immediate").await?;
        w.set_prices_now(100_000_000, 300_000_000).await?;
        let _ = w.grant(demo_policy()).await;
        let mut r = Run {
            signed: BTreeMap::new(),
            held: Vec::new(),
            payloads: BTreeMap::new(),
            violations: Vec::new(),
            actions: Vec::new(),
            fills: 0,
            salt: (seed as u8).wrapping_mul(16),
        };
        for _ in 0..ACTIONS {
            step(&w, &mut rng, &mut r).await?;
        }
        results.push(json!({
            "seed": seed,
            "passed": r.violations.is_empty(),
            "violations": r.violations,
            "actions": r.actions,
            "signatures_known": r.signed.len(),
            "fills": r.fills,
        }));
    }
    let failing: Vec<&Value> = results.iter().filter(|r| r["passed"] == false).collect();
    let total_fills: u64 = results.iter().filter_map(|r| r["fills"].as_u64()).sum();
    evidence::write(
        "T2",
        Some("sandbox-interleavings"),
        failing.is_empty(),
        "sandbox (real verifier; stub MPC/oracle/tokens)",
        json!({"seeds": SEEDS, "actions_per_seed": ACTIONS, "total_fills": total_fills, "runs": results}),
    );
    assert!(failing.is_empty(), "failing seeds: {failing:?}");
    Ok(())
}
