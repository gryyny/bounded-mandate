//! gate: T4 (registration-reconcile) and RESCUE (owner-key, reported separately, never T4)
//!
//! A grant whose `on_key_added` callback failed leaves its registration unresolved and blocks
//! revocation and recovery. The labelled fault-injection build of the mandate
//! (`target/near/bounded_mandate_fault`, feature `fault-injection`) makes that callback panic;
//! every other path, and the verifier, is the production code.
//!
//! - registration-reconcile: the add executed but its callback failed. With no access key on the
//!   mandate account, the owner's `reconcile_registration` proves the key present, the removal
//!   is confirmed and every unit is recovered.
//! - owner-key: the add itself failed (verifier DAO locked the account) and its callback failed.
//!   Reconcile cannot resolve absence. The owner confirms from RPC that the grant transaction's
//!   receipts are all terminal, re-adds the key as the mandate account using its full-access
//!   key (trusted upgrade authority), then reconciles, revokes and recovers.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use anyhow::{Context, Result, bail};
use common::evidence;
use common::sandbox::{MAX_GAS, ONE_YOCTO, TxOutcome, built_wasm, call};
use common::world::{Side, USDC, World, WorldOpts, demo_policy};
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use std::io::{Read, Write};

const FAULT_WASM: &str = "bounded_mandate_fault";
const FAULT_EXPORT: &[u8] = b"fault_fail_key_added";

#[derive(Default)]
struct Checks {
    items: Vec<(String, bool)>,
}

impl Checks {
    fn check(&mut self, name: &str, ok: bool) {
        self.items.push((name.to_owned(), ok));
    }
    fn passed(&self) -> bool {
        !self.items.is_empty() && self.items.iter().all(|(_, ok)| *ok)
    }
    fn json(&self) -> Value {
        self.items
            .iter()
            .map(|(n, ok)| json!({"check": n, "ok": ok}))
            .collect()
    }
    fn assert_all(&self) {
        for (n, ok) in &self.items {
            assert!(ok, "check failed: {n}");
        }
    }
}

/// The production WASM exports no fault-injection method and its ABI lists none; the fault
/// build does (so the check is not vacuous).
fn production_is_fault_free() -> Result<bool> {
    let root = evidence::repo_root();
    let prod = std::fs::read(root.join("target/near/bounded_mandate/bounded_mandate.wasm"))?;
    let abi: Value = serde_json::from_slice(&std::fs::read(
        root.join("target/near/bounded_mandate/bounded_mandate_abi.json"),
    )?)?;
    let fault = built_wasm(FAULT_WASM)?;
    let contains = |hay: &[u8]| hay.windows(FAULT_EXPORT.len()).any(|w| w == FAULT_EXPORT);
    let abi_has_fault = abi["body"]["functions"]
        .as_array()
        .context("abi functions")?
        .iter()
        .any(|f| f["name"].as_str().is_some_and(|n| n.starts_with("fault")));
    Ok(!contains(&prod) && !abi_has_fault && contains(&fault))
}

#[test]
fn production_wasm_contains_no_fault_injection() {
    assert!(production_is_fault_free().expect("built WASMs and ABI"));
}

async fn world_with_fault_build() -> Result<World> {
    let mut w = World::new(WorldOpts::default()).await?;
    // Same state layout: the fault flag lives under its own storage key.
    w.mandate = w
        .mandate
        .as_account()
        .deploy(&built_wasm(FAULT_WASM)?)
        .await?
        .into_result()?;
    let f = owner_call(&w, "fault_fail_key_added", json!({"epoch": 1})).await;
    if !f.is_success() {
        bail!("set fault: {}", f.failure_text());
    }
    Ok(w)
}

async fn owner_call(w: &World, method: &str, args: Value) -> TxOutcome {
    call(
        &w.owner,
        w.mandate.id(),
        method,
        args,
        NearToken::from_yoctonear(0),
        MAX_GAS,
    )
    .await
}

fn events_named(out: &TxOutcome, name: &str) -> usize {
    common::sandbox::events(&out.logs(), "bounded_mandate")
        .iter()
        .filter(|e| e["event"] == name)
        .count()
}

/// Mandate-side view of the stuck state: neither ordinary revocation nor recovery can finish.
async fn assert_blocked(w: &World, c: &mut Checks, label: &str) -> Result<()> {
    let r = w.recover(Side::Usdc, None).await;
    c.check(&format!("{label}: recover refused"), !r.is_success());
    let again = owner_call(w, "revoke", json!({})).await;
    c.check(
        &format!("{label}: revoke cannot issue removal"),
        !again.is_success() && again.failure_text().contains("registration in flight"),
    );
    let p = w.propose(Side::Usdc, 10 * USDC, 0).await;
    c.check(&format!("{label}: no proposal accepted"), !p.is_success());
    Ok(())
}

async fn recover_all(w: &World, c: &mut Checks) -> Result<Value> {
    let (mu, mw) = w.b.balances(w.mandate.id()).await?;
    let (ou, ow) = w.b.balances(w.owner.id()).await?;
    for side in [Side::Usdc, Side::Wnear] {
        let r = w.recover(side, None).await;
        c.check(
            &format!("recover {} succeeds", side.as_str()),
            r.is_success() && events_named(&r, "recovery_transferred") == 1,
        );
    }
    let (mu2, mw2) = w.b.balances(w.mandate.id()).await?;
    let (ou2, ow2) = w.b.balances(w.owner.id()).await?;
    c.check("mandate emptied", (mu2, mw2) == (0, 0));
    c.check(
        "every unit reached the owner's Intents account",
        (ou2 - ou, ow2 - ow) == (mu, mw),
    );
    Ok(json!({
        "mandate_before": [mu.to_string(), mw.to_string()],
        "owner_gain": [(ou2 - ou).to_string(), (ow2 - ow).to_string()],
    }))
}

/// gate: T4
#[tokio::test]
async fn t4_registration_reconcile_keyless() -> Result<()> {
    let w = world_with_fault_build().await?;
    let mut c = Checks::default();
    let mut notes: Vec<Value> = Vec::new();

    // Remove every access key: from here on nothing can act as the mandate account.
    let acct = w.mandate.as_account();
    let d = acct
        .batch(w.mandate.id())
        .delete_key(acct.secret_key().public_key())
        .transact()
        .await?;
    c.check("mandate key deleted", d.is_success());
    let keys = w.b.worker.view_access_keys(w.mandate.id()).await?;
    c.check("mandate account is keyless", keys.is_empty());

    let g_out = owner_call(&w, "grant", json!({"policy": demo_policy()})).await;
    let g = w.grant_view().await?;
    let pk = g["public_key"].as_str().context("public key")?.to_owned();
    c.check(
        "on_key_added failed by injection",
        g_out.failure_text().contains("fault injection"),
    );
    c.check(
        "grant stuck activating with key op in flight",
        g["status"] == "activating" && g["key_op_in_flight"] == true,
    );
    c.check("add executed: key present", w.has_grant_key(&pk).await?);
    c.check("no orders exist", w.orders().await?.is_empty());

    let r = owner_call(&w, "revoke", json!({})).await;
    c.check(
        "revoke stops authorization (revoking)",
        r.is_success() && w.grant_view().await?["status"] == "revoking",
    );
    assert_blocked(&w, &mut c, "before reconcile").await?;

    let rec = owner_call(&w, "reconcile_registration", json!({})).await;
    let g = w.settle_key_ops().await?;
    notes
        .push(json!({"reconcile_events": common::sandbox::events(&rec.logs(), "bounded_mandate")}));
    c.check(
        "reconcile proves presence",
        rec.is_success() && events_named(&rec, "registration_reconciled") == 1,
    );
    c.check(
        "removal confirmed: revoked",
        g["status"] == "revoked" && g["key_op_in_flight"] == false,
    );
    c.check(
        "grant key absent after removal",
        !w.has_grant_key(&pk).await?,
    );
    c.check(
        "never activated",
        events_named(&g_out, "grant_activated") == 0 && events_named(&rec, "grant_activated") == 0,
    );
    let rec2 = owner_call(&w, "reconcile_registration", json!({})).await;
    c.check("reconcile refused once resolved", !rec2.is_success());

    let recovered = recover_all(&w, &mut c).await?;
    c.check(
        "still keyless",
        w.b.worker
            .view_access_keys(w.mandate.id())
            .await?
            .is_empty(),
    );
    let fault_free = production_is_fault_free()?;
    c.check("production WASM has no fault injection", fault_free);

    let passed = c.passed();
    evidence::write(
        "T4",
        "registration-reconcile",
        passed,
        "sandbox",
        json!({
            "scenario": "add_public_key executed; on_key_added panicked (fault-injection build); mandate account keyless",
            "fault_injection_wasm": FAULT_WASM,
            "public_key": pk,
            "checks": c.json(),
            "recovery": recovered,
            "notes": notes,
        }),
    );
    c.assert_all();
    Ok(())
}

// ------------------------------------------------------------------ RPC

/// Minimal JSON-RPC POST to the sandbox node (independent of the workspaces client).
fn rpc(addr: &str, body: &Value) -> Result<Value> {
    let hostport = addr
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_owned();
    let payload = body.to_string();
    let mut s = std::net::TcpStream::connect(&hostport)?;
    write!(
        s,
        "POST / HTTP/1.1\r\nHost: {hostport}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    )?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw)?;
    let text = String::from_utf8(raw)?;
    let (head, body) = text.split_once("\r\n\r\n").context("http response")?;
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut out = String::new();
        let mut rest = body;
        loop {
            let (len, tail) = rest.split_once("\r\n").context("chunk")?;
            let n = usize::from_str_radix(len.trim(), 16)?;
            if n == 0 {
                break;
            }
            out.push_str(&tail[..n]);
            rest = &tail[n + 2..];
        }
        out
    } else {
        body.to_owned()
    };
    Ok(serde_json::from_str(&body)?)
}

/// Every receipt of the grant transaction is terminal; the add and `on_key_added` both failed.
fn terminal_registration(
    tx: &Value,
    verifier: &str,
    mandate: &str,
) -> Result<(bool, bool, bool, Value)> {
    let r = &tx["result"];
    let final_status = r["final_execution_status"].as_str().unwrap_or_default();
    let outcomes = r["receipts_outcome"]
        .as_array()
        .context("receipts_outcome")?;
    let terminal = |o: &Value| {
        let st = &o["outcome"]["status"];
        st.get("SuccessValue").is_some()
            || st.get("SuccessReceiptId").is_some()
            || st.get("Failure").is_some()
    };
    let all_terminal = !outcomes.is_empty() && outcomes.iter().all(terminal);
    let failed = |exec: &str, needle: &str| {
        outcomes.iter().any(|o| {
            o["outcome"]["executor_id"] == exec
                && o["outcome"]["status"].get("Failure").is_some()
                && o["outcome"]["status"].to_string().contains(needle)
        })
    };
    let add_failed = failed(verifier, "is locked");
    let callback_failed = failed(mandate, "fault injection");
    let summary = json!({
        "final_execution_status": final_status,
        "receipts": outcomes.len(),
        "all_terminal": all_terminal,
        "add_public_key_failed": add_failed,
        "on_key_added_failed": callback_failed,
    });
    Ok((
        all_terminal && matches!(final_status, "FINAL" | "EXECUTED"),
        add_failed,
        callback_failed,
        summary,
    ))
}

/// gate: RESCUE (emergency owner-key path; never counted toward T4)
#[tokio::test]
async fn rescue_owner_key_after_failed_add_and_callback() -> Result<()> {
    let w = world_with_fault_build().await?;
    let mut c = Checks::default();
    let verifier = w.b.verifier.id().to_string();
    let mandate = w.mandate.id().to_string();

    // The verifier DAO locks the mandate's Intents account: the add will fail.
    let lk = w
        .dao("force_lock_account", json!({"account_id": w.mandate.id()}))
        .await;
    c.check("account locked by verifier DAO", lk.is_success());
    let g_out = owner_call(&w, "grant", json!({"policy": demo_policy()})).await;
    let tx_hash = match &g_out {
        TxOutcome::Executed(r) => r.outcome().transaction_hash.to_string(),
        TxOutcome::Rejected(e) => bail!("grant rejected: {e}"),
    };
    let g = w.grant_view().await?;
    let pk = g["public_key"].as_str().context("public key")?.to_owned();
    c.check(
        "stuck activating",
        g["status"] == "activating" && g["key_op_in_flight"] == true,
    );
    c.check("key absent", !w.has_grant_key(&pk).await?);
    let r = owner_call(&w, "revoke", json!({})).await;
    c.check(
        "revoke stops authorization (revoking)",
        r.is_success() && w.grant_view().await?["status"] == "revoking",
    );
    assert_blocked(&w, &mut c, "after failed add").await?;

    // Reconcile alone cannot resolve absence: absence is never proof.
    let before = w.grant_view().await?;
    for _ in 0..2 {
        let rec = owner_call(&w, "reconcile_registration", json!({})).await;
        c.check(
            "reconcile reports unresolved",
            rec.is_success() && events_named(&rec, "registration_unresolved") == 1,
        );
        c.check("reconcile changed nothing", w.grant_view().await? == before);
    }

    // Emergency procedure step 1: RPC confirms the grant transaction is fully terminal, with the
    // add and its callback both failed, so no registration can still execute.
    let tx = rpc(
        &w.b.worker.rpc_addr(),
        &json!({"jsonrpc": "2.0", "id": "rescue", "method": "tx",
                "params": {"tx_hash": tx_hash, "sender_account_id": w.owner.id(), "wait_until": "FINAL"}}),
    )?;
    let (terminal, add_failed, cb_failed, rpc_summary) =
        terminal_registration(&tx, &verifier, &mandate)?;
    c.check("rpc: grant transaction terminal", terminal);
    c.check("rpc: add_public_key failed", add_failed);
    c.check("rpc: on_key_added failed", cb_failed);

    // The external cause is lifted.
    let ul = w
        .dao(
            "force_unlock_account",
            json!({"account_id": w.mandate.id()}),
        )
        .await;
    c.check("account unlocked", ul.is_success());

    // Step 2: acting as the mandate account with the owner-held full-access key.
    let add = call(
        w.mandate.as_account(),
        w.b.verifier.id(),
        "add_public_key",
        json!({"public_key": pk}),
        ONE_YOCTO,
        MAX_GAS,
    )
    .await;
    c.check(
        "owner re-adds the key as the mandate account",
        add.is_success() && w.has_grant_key(&pk).await?,
    );

    // Step 3: reconcile is now provable; the pending revocation issues removal.
    let rec = owner_call(&w, "reconcile_registration", json!({})).await;
    let g = w.settle_key_ops().await?;
    c.check(
        "reconcile proves presence",
        events_named(&rec, "registration_reconciled") == 1,
    );
    c.check(
        "removal confirmed: revoked",
        g["status"] == "revoked" && g["key_op_in_flight"] == false,
    );
    c.check("grant key absent", !w.has_grant_key(&pk).await?);
    c.check("no orders exist", w.orders().await?.is_empty());
    let recovered = recover_all(&w, &mut c).await?;
    c.check(
        "production WASM has no fault injection",
        production_is_fault_free()?,
    );

    let passed = c.passed();
    evidence::write(
        "RESCUE",
        "owner-key",
        passed,
        "sandbox",
        json!({
            "scenario": "add_public_key failed (verifier DAO locked the account) and on_key_added panicked (fault-injection build)",
            "trust": "emergency path: uses the owner's full-access key on the mandate account (trusted upgrade authority); not keyless, not T4",
            "fault_injection_wasm": FAULT_WASM,
            "public_key": pk,
            "grant_tx": tx_hash,
            "rpc_terminal_check": rpc_summary,
            "checks": c.json(),
            "recovery": recovered,
        }),
    );
    c.assert_all();
    Ok(())
}
