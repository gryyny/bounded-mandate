//! gate: DEPLOY
//!
//! The exact deployment candidate (the reproducible WASM the mainnet approval package proposes)
//! loaded byte-for-byte from fixtures/, verified against the fixture manifest at runtime and
//! against the deployed account's code hash, then driven through the core lifecycle in the
//! sandbox. Its exported method set must equal the local build's, so the tested source and the
//! candidate agree.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::evidence::{self, note_wasm, repo_root, sha256_file};
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy, order_state};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn leb(bytes: &[u8], pos: &mut usize) -> anyhow::Result<u64> {
    let (mut result, mut shift) = (0u64, 0u32);
    loop {
        let b = *bytes
            .get(*pos)
            .ok_or_else(|| anyhow::anyhow!("truncated leb128"))?;
        *pos += 1;
        result |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
        anyhow::ensure!(shift < 64, "leb128 overflow");
    }
}

/// Names of exported functions, from the WASM export section (id 7).
fn function_exports(wasm: &[u8]) -> anyhow::Result<BTreeSet<String>> {
    anyhow::ensure!(wasm.get(..4) == Some(b"\0asm"), "not a wasm module");
    let mut pos = 8;
    let mut out = BTreeSet::new();
    while pos < wasm.len() {
        let id = wasm[pos];
        pos += 1;
        let size = leb(wasm, &mut pos)? as usize;
        let end = pos + size;
        if id == 7 {
            let mut p = pos;
            for _ in 0..leb(wasm, &mut p)? {
                let len = leb(wasm, &mut p)? as usize;
                let name = String::from_utf8(wasm[p..p + len].to_vec())?;
                p += len;
                let kind = wasm[p];
                p += 1;
                let _index = leb(wasm, &mut p)?;
                if kind == 0 {
                    out.insert(name);
                }
            }
        }
        pos = end;
    }
    Ok(out)
}

/// gate: DEPLOY
#[tokio::test]
async fn deploy_candidate_lifecycle() -> anyhow::Result<()> {
    // The candidate is whatever the manifest declares as the deployment candidate.
    let root = repo_root();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(root.join("fixtures/manifest.json"))?)?;
    let candidates: Vec<(&String, &Value)> = manifest["files"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("manifest files"))?
        .iter()
        .filter(|(_, v)| v["kind"] == "deployment-candidate")
        .collect();
    anyhow::ensure!(
        candidates.len() == 1,
        "expected exactly one deployment candidate, found {}",
        candidates.len()
    );
    let (rel, entry) = candidates[0];
    let path = root.join("fixtures").join(rel);
    let bytes = std::fs::read(&path)?;
    let file_sha = hex::encode(Sha256::digest(&bytes));
    let manifest_sha = entry["sha256"].as_str().unwrap_or_default().to_owned();
    let sha_matches =
        file_sha == manifest_sha && sha256_file(&path).as_deref() == Some(file_sha.as_str());

    // Export parity with the local build of the tested source.
    let local_path = root.join("target/near/bounded_mandate/bounded_mandate.wasm");
    note_wasm(&local_path);
    let local = std::fs::read(&local_path)?;
    let cand_exports = function_exports(&bytes)?;
    let local_exports = function_exports(&local)?;
    let exports_equal = cand_exports == local_exports;
    let has_reconcile = cand_exports.contains("reconcile_registration");

    // Deploy the candidate bytes from fixtures/ (World asserts the path and records its hash).
    let w = World::new(WorldOpts {
        mandate_wasm: Some(path.clone()),
        ..WorldOpts::default()
    })
    .await?;
    let account = common::sandbox::rpc(
        &w.b.worker,
        "query",
        json!({"request_type": "view_account", "finality": "final", "account_id": w.mandate.id()}),
    )
    .await?;
    let code_hash = account["code_hash"].as_str().unwrap_or_default().to_owned();
    let expected_code_hash = near_sdk::bs58::encode(Sha256::digest(&bytes)).into_string();
    let deployed_is_candidate = code_hash == expected_code_hash;

    let mut steps = Vec::new();
    let g = w.grant_ok(demo_policy()).await?;
    let pk = g["public_key"].as_str().unwrap_or_default().to_owned();
    steps.push(json!({"step": "grant", "status": g["status"], "key_registered": w.has_grant_key(&pk).await?}));

    // Trade, fill, settle.
    let (id0, out) = w.propose_id(Side::Wnear, 10 * NEAR, 50).await?;
    let mp0 = w
        .signed_payload(&out, id0)
        .await?
        .ok_or_else(|| anyhow::anyhow!("order 0 not signed"))?;
    let before = w.balances().await?;
    let (r, dec) = w.relay(&mp0, 1).await?;
    let after = w.balances().await?;
    let (usdc_t, wnear_t) = w.b.token_ids();
    let filled = r.is_success()
        && after.0 as i128 - before.0 as i128 == dec.delta(&usdc_t)
        && after.1 as i128 - before.1 as i128 == dec.delta(&wnear_t);
    let settled = w.settle(&w.b.relayer, id0).await.is_success()
        && order_state(&w.order(id0).await?) == "released:settled";
    steps.push(json!({"step": "trade+fill+settle", "filled": filled, "settled": settled}));

    // Withheld order, confirmed removal, relay rejected.
    let (id1, out) = w.propose_id(Side::Usdc, 100 * USDC, 50).await?;
    let mp1 = w
        .signed_payload(&out, id1)
        .await?
        .ok_or_else(|| anyhow::anyhow!("order 1 not signed"))?;
    let rv = w.revoke(None).await;
    let gv = w.grant_view().await?;
    let removed = rv.is_success() && gv["status"] == "revoked" && !w.has_grant_key(&pk).await?;
    let (r1, _) = w.relay(&mp1, 2).await?;
    let withheld_state = order_state(&w.order(id1).await?);
    let rejected = !r1.is_success() && withheld_state == "released:key_removed";
    steps.push(json!({"step": "withheld+revoke+relay", "removal_confirmed": removed, "relay_rejected": rejected, "state": withheld_state}));

    // Recover all units to the owner's Intents account.
    let (mu, mw) = w.balances().await?;
    let (ou0, ow0) = w.b.balances(w.owner.id()).await?;
    let rc1 = w.recover(Side::Usdc, None).await;
    let rc2 = w.recover(Side::Wnear, None).await;
    let (ou1, ow1) = w.b.balances(w.owner.id()).await?;
    let recovered = rc1.is_success()
        && rc2.is_success()
        && ou1 - ou0 == mu
        && ow1 - ow0 == mw
        && w.balances().await? == (0, 0);
    steps.push(json!({"step": "recover", "recovered_all_units": recovered, "usdc": mu.to_string(), "wnear": mw.to_string()}));

    let passed = sha_matches
        && deployed_is_candidate
        && exports_equal
        && has_reconcile
        && g["status"] == "active"
        && filled
        && settled
        && removed
        && rejected
        && recovered;
    let diff: Vec<String> = cand_exports
        .symmetric_difference(&local_exports)
        .cloned()
        .collect();
    evidence::write(
        "DEPLOY",
        "candidate",
        passed,
        "sandbox",
        json!({
            "candidate_path": format!("fixtures/{rel}"),
            "candidate_sha256": file_sha,
            "manifest_sha256": manifest_sha,
            "sha256_matches_manifest": sha_matches,
            "deployed_code_hash": code_hash,
            "deployed_code_hash_is_candidate": deployed_is_candidate,
            "loaded_from": "fixtures/ (bytes read and deployed as-is; never from target/near, never compiled)",
            "local_build_sha256": hex::encode(Sha256::digest(&local)),
            "exports_equal_local_build": exports_equal,
            "export_difference": diff,
            "exports": cand_exports,
            "reconcile_registration_exported": has_reconcile,
            "steps": steps,
        }),
    );
    assert!(
        passed,
        "deployment candidate check failed: sha {sha_matches}, code {deployed_is_candidate}, exports {exports_equal} {diff:?}, reconcile {has_reconcile}, steps {steps:?}"
    );
    Ok(())
}
