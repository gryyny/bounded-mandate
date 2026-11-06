//! gate: DAO
//!
//! A real Sputnik v2 DAO as the mandate's fixed owner, in sandbox. The DAO code is the mainnet
//! `sputnik-dao.near` factory's default DAO code, pinned byte-for-byte under fixtures/sputnik/;
//! the mandate is the exact deployment candidate under fixtures/deploy/; the verifier is the
//! pinned mainnet WASM. The DAO account has no access key: every owner action is a FunctionCall
//! proposal that executes only when two of three council members approve it.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use bounded_mandate::{GAS_GRANT_REQUIRED, GAS_RECOVER_REQUIRED, GAS_REVOKE_REQUIRED};
use common::evidence::{self, repo_root, sha256_file};
use common::intents::b64;
use common::sandbox::{MAX_GAS, ONE_YOCTO, TxOutcome, call, receipt_gas, rpc, subaccount};
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy, order_state};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const DAO_WASM: &str = "sputnik/sputnikdao2-2.3.1.wasm";
const DAO_PROVENANCE: &str = "sputnik/sputnikdao2-2.3.1.provenance.json";
const PROPOSAL_BOND: NearToken = NearToken::from_millinear(100);
/// Covers the verifier's `ft_withdraw` chain (`ft_transfer` plus `ft_resolve_withdraw`).
const FT_WITHDRAW_GAS: Gas = Gas::from_tgas(100);
const VOTE_THRESHOLD: &str = "2";

/// Recorded sha256 and on-chain code hash of the DAO fixture: the fixture manifest entry once the
/// coordinator has added it, else the provenance record next to the binary.
fn recorded_dao_hashes() -> anyhow::Result<(String, String, &'static str)> {
    let fixtures = repo_root().join("fixtures");
    let manifest: Value = serde_json::from_slice(&std::fs::read(fixtures.join("manifest.json"))?)?;
    let prov: Value = serde_json::from_slice(&std::fs::read(fixtures.join(DAO_PROVENANCE))?)?;
    let code_hash = prov["onchain_code_hash"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("provenance code hash"))?
        .to_owned();
    let entry = &manifest["files"][DAO_WASM];
    if let Some(sha) = entry["sha256"].as_str() {
        anyhow::ensure!(
            prov["sha256"] == sha,
            "manifest and provenance disagree on {DAO_WASM}"
        );
        return Ok((sha.to_owned(), code_hash, "fixtures/manifest.json"));
    }
    let sha = prov["sha256"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("provenance sha256"))?
        .to_owned();
    Ok((sha, code_hash, DAO_PROVENANCE))
}

fn council_policy(council: &[&AccountId]) -> Value {
    let vote = json!({"weight_kind": "RoleWeight", "quorum": "0", "threshold": VOTE_THRESHOLD});
    json!({
        "roles": [{
            "name": "council",
            "kind": {"Group": council},
            "permissions": ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
            "vote_policy": {"call": vote},
        }],
        "default_vote_policy": vote,
        "proposal_bond": PROPOSAL_BOND.as_yoctonear().to_string(),
        "proposal_period": (86_400u64 * 1_000_000_000).to_string(),
        "bounty_bond": PROPOSAL_BOND.as_yoctonear().to_string(),
        "bounty_forgiveness_period": (86_400u64 * 1_000_000_000).to_string(),
    })
}

/// A `FunctionCall` proposal kind with one action.
fn call_kind(
    receiver: &AccountId,
    method: &str,
    args: &Value,
    deposit: NearToken,
    gas: Gas,
) -> Value {
    json!({"FunctionCall": {
        "receiver_id": receiver,
        "actions": [{
            "method_name": method,
            "args": b64(args.to_string().as_bytes()),
            "deposit": deposit.as_yoctonear().to_string(),
            "gas": gas.as_gas().to_string(),
        }],
    }})
}

struct Dao<'a> {
    w: &'a World,
    id: AccountId,
}

impl Dao<'_> {
    async fn add(&self, member: &Account, description: &str, kind: &Value) -> TxOutcome {
        call(
            member,
            &self.id,
            "add_proposal",
            json!({"proposal": {"description": description, "kind": kind}}),
            PROPOSAL_BOND,
            Gas::from_tgas(50),
        )
        .await
    }

    async fn add_ok(
        &self,
        member: &Account,
        description: &str,
        kind: &Value,
    ) -> anyhow::Result<u64> {
        let out = self.add(member, description, kind).await;
        out.json::<u64>().map_err(|e| {
            anyhow::anyhow!("add_proposal {description}: {e} / {}", out.failure_text())
        })
    }

    async fn act(&self, member: &Account, id: u64, action: &str, kind: &Value) -> TxOutcome {
        call(
            member,
            &self.id,
            "act_proposal",
            json!({"id": id, "action": action, "proposal": kind}),
            NearToken::from_yoctonear(0),
            MAX_GAS,
        )
        .await
    }

    /// The stored proposal, or `None` once it was removed.
    async fn proposal(&self, id: u64) -> anyhow::Result<Option<Value>> {
        match self
            .w
            .b
            .worker
            .view(&self.id, "get_proposal")
            .args_json(json!({"id": id}))
            .await
        {
            Ok(r) => Ok(Some(r.json()?)),
            Err(e) if format!("{e:?}").contains("ERR_NO_PROPOSAL") => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    async fn status(&self, id: u64) -> anyhow::Result<String> {
        Ok(self.proposal(id).await?.map_or_else(
            || "absent".to_owned(),
            |p| p["status"].as_str().unwrap_or("?").to_owned(),
        ))
    }

    /// Gas accounting of the approving vote that executed a proposal.
    async fn execution_gas(
        &self,
        label: &str,
        out: &TxOutcome,
        action_gas: Gas,
    ) -> anyhow::Result<Value> {
        let TxOutcome::Executed(r) = out else {
            anyhow::bail!("{label}: executing vote rejected: {}", out.failure_text());
        };
        let dao = receipt_gas(&self.w.b.worker, r, &self.id).await?;
        let mandate = receipt_gas(&self.w.b.worker, r, self.w.mandate.id()).await?;
        let verifier = receipt_gas(&self.w.b.worker, r, self.w.b.verifier.id()).await?;
        let fmt = |v: &[(String, u64, u64, bool)]| -> Vec<Value> {
            v.iter()
                .map(|(m, att, burnt, ok)| json!({"method": m, "attached_gas": att, "gas_burnt": burnt, "succeeded": ok}))
                .collect()
        };
        let act_burnt = dao
            .iter()
            .find(|(m, ..)| m == "act_proposal")
            .map_or(0, |(_, _, b, _)| *b);
        Ok(json!({
            "proposal": label,
            "action_gas": action_gas.as_gas(),
            "vote_prepaid_gas": MAX_GAS.as_gas(),
            "act_proposal_gas_burnt": act_burnt,
            "headroom_after_action_and_dao_callback": MAX_GAS.as_gas() as i128
                - act_burnt as i128
                - action_gas.as_gas() as i128
                - Gas::from_tgas(10).as_gas() as i128,
            "tx_total_gas_burnt": r.total_gas_burnt.as_gas(),
            "dao_receipts": fmt(&dao),
            "mandate_receipts": fmt(&mandate),
            "verifier_receipts": fmt(&verifier),
        }))
    }
}

fn panicked_with(out: &TxOutcome, needle: &str) -> bool {
    !out.is_success() && out.failure_text().contains(needle)
}

async fn ft_balance(w: &World, token: &AccountId, who: &AccountId) -> anyhow::Result<u128> {
    let v: String =
        w.b.worker
            .view(token, "ft_balance_of")
            .args_json(json!({"account_id": who}))
            .await?
            .json()?;
    Ok(v.parse()?)
}

/// gate: DAO
#[tokio::test]
async fn dao_sputnik_owner() -> anyhow::Result<()> {
    let root = repo_root();
    let started = std::time::Instant::now();
    let candidate = root.join("fixtures/deploy/bounded_mandate-163ccfa-reproducible.wasm");
    let w = World::new(WorldOpts {
        mandate_wasm: Some(candidate.clone()),
        ..WorldOpts::default()
    })
    .await?;
    let mut checks: Vec<(String, bool, Value)> = Vec::new();
    let mut check =
        |name: &str, ok: bool, detail: Value| checks.push((name.to_owned(), ok, detail));

    // ---------------------------------------------------------------- DAO deployment
    let dao_path = root.join("fixtures").join(DAO_WASM);
    evidence::note_wasm(&dao_path);
    let dao_code = std::fs::read(&dao_path)?;
    let (recorded_sha, recorded_code_hash, hash_source) = recorded_dao_hashes()?;
    let file_sha = hex::encode(Sha256::digest(&dao_code));
    let file_code_hash = near_sdk::bs58::encode(Sha256::digest(&dao_code)).into_string();

    let council = [
        subaccount(&w.b.root, "council1", 20).await?,
        subaccount(&w.b.root, "council2", 20).await?,
        subaccount(&w.b.root, "council3", 20).await?,
    ];
    let [c1, c2, c3] = &council;
    let outsider = &w.b.relayer;
    let council_ids: Vec<&AccountId> = council.iter().map(Account::id).collect();
    let policy = council_policy(&council_ids);

    // World funding minted to the owner (mock-ft auto-registers on mint) and deposited all of it.
    // Close the zero-balance USDC registration so the DAO starts unregistered there, like a fresh
    // factory DAO; wNEAR stays registered.
    let unreg = call(
        &w.owner,
        w.b.usdc.id(),
        "storage_unregister",
        json!({"force": false}),
        ONE_YOCTO,
        Gas::from_tgas(30),
    )
    .await;
    anyhow::ensure!(
        unreg.json::<bool>().ok() == Some(true),
        "owner USDC storage_unregister: {}",
        unreg.failure_text()
    );

    // The mandate's fixed owner account becomes the DAO; its only key is deleted in the same
    // transaction, as with a factory-created DAO.
    let owner_pk = w.owner.secret_key().public_key();
    w.owner
        .batch(w.owner.id())
        .deploy(&dao_code)
        .call(
            near_workspaces::operations::Function::new("new")
                .args_json(json!({
                    "config": {"name": "mandate-owner", "purpose": "bounded mandate owner", "metadata": ""},
                    "policy": policy,
                }))
                .gas(Gas::from_tgas(100)),
        )
        .delete_key(owner_pk)
        .transact()
        .await?
        .into_result()?;
    let dao = Dao {
        w: &w,
        id: w.owner.id().clone(),
    };
    let mandate_cfg: Value = w.mandate.view("get_config").await?.json()?;
    let account = rpc(
        &w.b.worker,
        "query",
        json!({"request_type": "view_account", "finality": "optimistic", "account_id": dao.id}),
    )
    .await?;
    let deployed_code_hash = account["code_hash"].as_str().unwrap_or_default().to_owned();
    let keys = w.b.worker.view_access_keys(&dao.id).await?;
    let source_meta: Value =
        w.b.worker
            .view(&dao.id, "contract_source_metadata")
            .await?
            .json()?;
    let dao_policy: Value = w.b.worker.view(&dao.id, "get_policy").await?.json()?;
    check(
        "dao_is_pinned_code_and_fixed_owner",
        file_sha == recorded_sha
            && file_code_hash == recorded_code_hash
            && deployed_code_hash == recorded_code_hash
            && keys.is_empty()
            && mandate_cfg["owner_id"] == json!(dao.id)
            && dao_policy["roles"][0]["vote_policy"]["call"]["threshold"] == VOTE_THRESHOLD,
        json!({
            "dao_fixture": format!("fixtures/{DAO_WASM}"),
            "sha256": file_sha,
            "recorded_sha256": recorded_sha,
            "recorded_from": hash_source,
            "code_hash": file_code_hash,
            "recorded_mainnet_code_hash": recorded_code_hash,
            "deployed_code_hash": deployed_code_hash,
            "dao_access_keys": keys.len(),
            "mandate_owner_id": mandate_cfg["owner_id"],
            "contract_source_metadata": source_meta,
            "council": council_ids,
            "call_vote_policy": dao_policy["roles"][0]["vote_policy"]["call"],
        }),
    );

    // ---------------------------------------------------------------- refusals before any grant
    let direct = [
        call(
            c1,
            w.mandate.id(),
            "grant",
            json!({"policy": demo_policy()}),
            NearToken::from_yoctonear(0),
            MAX_GAS,
        )
        .await,
        call(
            c1,
            w.mandate.id(),
            "revoke",
            json!({"gas_tgas": null}),
            NearToken::from_yoctonear(0),
            MAX_GAS,
        )
        .await,
        call(
            c1,
            w.mandate.id(),
            "recover",
            json!({"asset": "usdc", "gas_tgas": null}),
            NearToken::from_yoctonear(0),
            MAX_GAS,
        )
        .await,
    ];
    let direct_refused = direct.iter().all(|o| panicked_with(o, "only the owner"));
    check(
        "non_owner_direct_calls_refused",
        direct_refused && w.grant_view().await?.is_null(),
        json!({"caller": c1.id(), "methods": ["grant", "revoke", "recover"], "failures": direct.iter().map(TxOutcome::failure_text).collect::<Vec<_>>()}),
    );

    let grant_kind = call_kind(
        w.mandate.id(),
        "grant",
        &json!({"policy": demo_policy()}),
        NearToken::from_yoctonear(0),
        GAS_GRANT_REQUIRED,
    );
    let outsider_add = dao.add(outsider, "outsider grant", &grant_kind).await;
    check(
        "outsider_cannot_propose",
        panicked_with(&outsider_add, "ERR_PERMISSION_DENIED"),
        json!({"failure": outsider_add.failure_text()}),
    );

    // Grant proposal: one approval executes nothing; a duplicate vote and an outsider vote don't count.
    let p_grant = dao.add_ok(c1, "grant demo policy", &grant_kind).await?;
    let v1 = dao.act(c1, p_grant, "VoteApprove", &grant_kind).await;
    let dup = dao.act(c1, p_grant, "VoteApprove", &grant_kind).await;
    let foreign = dao.act(outsider, p_grant, "VoteApprove", &grant_kind).await;
    let one_of_three = v1.is_success()
        && panicked_with(&dup, "ERR_ALREADY_VOTED")
        && panicked_with(&foreign, "ERR_PERMISSION_DENIED")
        && dao.status(p_grant).await? == "InProgress"
        && w.grant_view().await?.is_null();
    check(
        "grant_one_of_three_executes_nothing",
        one_of_three,
        json!({"status": dao.status(p_grant).await?, "grant": w.grant_view().await?, "duplicate_vote": dup.failure_text(), "outsider_vote": foreign.failure_text()}),
    );

    // A rejected grant proposal executes nothing and cannot be revived.
    let p_rejected = dao.add_ok(c2, "grant to be rejected", &grant_kind).await?;
    let r1 = dao.act(c1, p_rejected, "VoteReject", &grant_kind).await;
    let r2 = dao.act(c3, p_rejected, "VoteReject", &grant_kind).await;
    let revive = dao.act(c2, p_rejected, "VoteApprove", &grant_kind).await;
    let rejected_status = dao.status(p_rejected).await?;
    check(
        "rejected_proposal_executes_nothing",
        r1.is_success()
            && r2.is_success()
            && rejected_status == "Rejected"
            && panicked_with(&revive, "ERR_PROPOSAL_NOT_READY_FOR_VOTE")
            && w.grant_view().await?.is_null(),
        json!({"status": rejected_status, "grant": w.grant_view().await?, "late_approve": revive.failure_text()}),
    );

    // Second approval executes the grant inside the DAO's function call.
    let v2 = dao.act(c2, p_grant, "VoteApprove", &grant_kind).await;
    let g = w.settle_key_ops().await?;
    let pk = g["public_key"].as_str().unwrap_or_default().to_owned();
    let grant_gas = dao.execution_gas("grant", &v2, GAS_GRANT_REQUIRED).await?;
    let late = dao.act(c3, p_grant, "VoteApprove", &grant_kind).await;
    let grant_ok = v2.is_success()
        && g["status"] == "active"
        && g["epoch"] == json!(1)
        && w.has_grant_key(&pk).await?
        && dao.status(p_grant).await? == "Approved"
        && panicked_with(&late, "ERR_PROPOSAL_NOT_READY_FOR_VOTE")
        && w.grant_view().await?["epoch"] == json!(1);
    check(
        "grant_two_of_three_executes",
        grant_ok,
        json!({"grant": g, "proposal_status": dao.status(p_grant).await?, "late_vote": late.failure_text(), "gas": grant_gas}),
    );

    // ---------------------------------------------------------------- agent trade under the DAO's grant
    let (id0, out) = w.propose_id(Side::Wnear, 10 * NEAR, 50).await?;
    let mp0 = w
        .signed_payload(&out, id0)
        .await?
        .ok_or_else(|| anyhow::anyhow!("order 0 not signed"))?;
    let before = w.balances().await?;
    let (fill, dec) = w.relay(&mp0, 1).await?;
    let after = w.balances().await?;
    let (usdc_t, wnear_t) = w.b.token_ids();
    let filled = fill.is_success()
        && after.0 as i128 - before.0 as i128 == dec.delta(&usdc_t)
        && after.1 as i128 - before.1 as i128 == dec.delta(&wnear_t);
    let settled = w.settle(&w.b.relayer, id0).await.is_success()
        && order_state(&w.order(id0).await?) == "released:settled";
    let (id1, out) = w.propose_id(Side::Usdc, 100 * USDC, 50).await?;
    let mp1 = w
        .signed_payload(&out, id1)
        .await?
        .ok_or_else(|| anyhow::anyhow!("order 1 not signed"))?;
    check(
        "agent_trade_under_dao_grant",
        filled && settled,
        json!({"order": id0, "filled": filled, "settled": settled, "withheld_order": id1}),
    );

    // ---------------------------------------------------------------- revoke
    let revoke_kind = call_kind(
        w.mandate.id(),
        "revoke",
        &json!({"gas_tgas": null}),
        NearToken::from_yoctonear(0),
        GAS_REVOKE_REQUIRED,
    );
    // A removed revoke proposal executes nothing and disappears.
    let p_removed = dao.add_ok(c1, "revoke to be removed", &revoke_kind).await?;
    let m1 = dao.act(c2, p_removed, "VoteRemove", &revoke_kind).await;
    let m2 = dao.act(c3, p_removed, "VoteRemove", &revoke_kind).await;
    let gv = w.grant_view().await?;
    check(
        "removed_proposal_executes_nothing",
        m1.is_success()
            && m2.is_success()
            && dao.proposal(p_removed).await?.is_none()
            && gv["status"] == "active"
            && w.has_grant_key(&pk).await?,
        json!({"proposal_after_remove": dao.status(p_removed).await?, "grant_status": gv["status"]}),
    );

    let p_revoke = dao.add_ok(c3, "revoke", &revoke_kind).await?;
    let a1 = dao.act(c3, p_revoke, "VoteApprove", &revoke_kind).await;
    let gv = w.grant_view().await?;
    check(
        "revoke_one_of_three_executes_nothing",
        a1.is_success()
            && dao.status(p_revoke).await? == "InProgress"
            && gv["status"] == "active"
            && w.has_grant_key(&pk).await?,
        json!({"status": dao.status(p_revoke).await?, "grant_status": gv["status"]}),
    );
    let a2 = dao.act(c1, p_revoke, "VoteApprove", &revoke_kind).await;
    let gv = w.settle_key_ops().await?;
    let revoke_gas = dao
        .execution_gas("revoke", &a2, GAS_REVOKE_REQUIRED)
        .await?;
    let key_removed = !w.has_grant_key(&pk).await?;
    let (relay1, _) = w.relay(&mp1, 2).await?;
    let withheld_state = order_state(&w.order(id1).await?);
    check(
        "revoke_two_of_three_removes_key",
        a2.is_success()
            && gv["status"] == "revoked"
            && key_removed
            && dao.status(p_revoke).await? == "Approved"
            && !relay1.is_success()
            && withheld_state == "released:key_removed",
        json!({"grant": gv, "key_on_verifier": !key_removed, "withheld_relay_rejected": !relay1.is_success(), "withheld_state": withheld_state, "gas": revoke_gas}),
    );

    // ---------------------------------------------------------------- recover both assets
    let (mu, mw) = w.balances().await?;
    let (du0, dw0) = w.b.balances(&dao.id).await?;
    let mut recover_gas = Vec::new();
    let mut recover_ok = true;
    for side in [Side::Usdc, Side::Wnear] {
        let kind = call_kind(
            w.mandate.id(),
            "recover",
            &json!({"asset": side.as_str(), "gas_tgas": null}),
            NearToken::from_yoctonear(0),
            GAS_RECOVER_REQUIRED,
        );
        let p = dao
            .add_ok(c2, &format!("recover {}", side.as_str()), &kind)
            .await?;
        let x1 = dao.act(c2, p, "VoteApprove", &kind).await;
        let x2 = dao.act(c3, p, "VoteApprove", &kind).await;
        recover_ok &= x1.is_success() && x2.is_success() && dao.status(p).await? == "Approved";
        recover_gas.push(
            dao.execution_gas(
                &format!("recover {}", side.as_str()),
                &x2,
                GAS_RECOVER_REQUIRED,
            )
            .await?,
        );
    }
    let (du1, dw1) = w.b.balances(&dao.id).await?;
    let mandate_after = w.balances().await?;
    let recovery = w.recovery().await?;
    check(
        "recover_both_assets_to_dao_intents_account",
        recover_ok
            && mu > 0
            && mw > 0
            && du1 - du0 == mu
            && dw1 - dw0 == mw
            && mandate_after == (0, 0),
        json!({
            "mandate_before": [mu.to_string(), mw.to_string()],
            "dao_intents_before": [du0.to_string(), dw0.to_string()],
            "dao_intents_after": [du1.to_string(), dw1.to_string()],
            "mandate_after": [mandate_after.0.to_string(), mandate_after.1.to_string()],
            "recovery": recovery,
            "gas": recover_gas,
        }),
    );

    // ---------------------------------------------------------------- DAO withdraws from Intents
    let withdraw_kind = |token: &AccountId, amount: u128| {
        call_kind(
            w.b.verifier.id(),
            "ft_withdraw",
            &json!({"token": token, "receiver_id": dao.id, "amount": amount.to_string(), "memo": null, "msg": null}),
            ONE_YOCTO,
            FT_WITHDRAW_GAS,
        )
    };
    let usdc = w.b.usdc.id();

    // USDC: the DAO has no storage on the token, so the verifier's ft_transfer fails and
    // ft_resolve_withdraw re-credits the Intents balance.
    let storage0: Value =
        w.b.worker
            .view(usdc, "storage_balance_of")
            .args_json(json!({"account_id": dao.id}))
            .await?
            .json()?;
    let kind = withdraw_kind(usdc, du1);
    let p_fail = dao
        .add_ok(c1, "withdraw usdc (unregistered)", &kind)
        .await?;
    let f1 = dao.act(c1, p_fail, "VoteApprove", &kind).await;
    let f2 = dao.act(c2, p_fail, "VoteApprove", &kind).await;
    let fail_gas = dao
        .execution_gas("ft_withdraw usdc (unregistered)", &f2, FT_WITHDRAW_GAS)
        .await?;
    let token_receipts: Vec<Value> = match &f2 {
        TxOutcome::Executed(r) => receipt_gas(&w.b.worker, r, usdc)
            .await?
            .into_iter()
            .map(|(m, _, _, ok)| json!({"method": m, "succeeded": ok}))
            .collect(),
        TxOutcome::Rejected(_) => Vec::new(),
    };
    let transfer_failed = token_receipts
        .iter()
        .any(|r| r["method"] == "ft_transfer" && r["succeeded"] == false);
    let ft_after_fail = ft_balance(&w, usdc, &dao.id).await?;
    let mt_after_fail = w.b.verifier.balance(&dao.id, usdc).await?;
    let fail_status = dao.status(p_fail).await?;
    check(
        "ft_withdraw_to_unregistered_dao_refunds",
        storage0.is_null()
            && f1.is_success()
            && transfer_failed
            && ft_after_fail == 0
            && mt_after_fail == du1,
        json!({
            "storage_balance_before": storage0,
            "proposal_status": fail_status,
            "token_receipts": token_receipts,
            "ft_balance_after": ft_after_fail.to_string(),
            "intents_balance_after": mt_after_fail.to_string(),
            "intents_balance_expected": du1.to_string(),
            "gas": fail_gas,
        }),
    );

    // Register the DAO on USDC through a threshold-approved storage_deposit, paid by the DAO.
    let bounds: Value =
        w.b.worker
            .view(usdc, "storage_balance_bounds")
            .await?
            .json()?;
    let storage_min: u128 = bounds["min"].as_str().unwrap_or_default().parse()?;
    let reg_gas = Gas::from_tgas(30);
    let reg_kind = call_kind(
        usdc,
        "storage_deposit",
        &json!({"account_id": dao.id, "registration_only": true}),
        NearToken::from_yoctonear(storage_min),
        reg_gas,
    );
    let p_reg = dao.add_ok(c3, "register on usdc", &reg_kind).await?;
    let s1 = dao.act(c3, p_reg, "VoteApprove", &reg_kind).await;
    let storage_one: Value =
        w.b.worker
            .view(usdc, "storage_balance_of")
            .args_json(json!({"account_id": dao.id}))
            .await?
            .json()?;
    let s2 = dao.act(c1, p_reg, "VoteApprove", &reg_kind).await;
    let reg_exec_gas = dao
        .execution_gas("storage_deposit usdc", &s2, reg_gas)
        .await?;
    let storage1: Value =
        w.b.worker
            .view(usdc, "storage_balance_of")
            .args_json(json!({"account_id": dao.id}))
            .await?
            .json()?;
    check(
        "storage_deposit_two_of_three_registers_dao",
        s1.is_success()
            && storage_one.is_null()
            && s2.is_success()
            && dao.status(p_reg).await? == "Approved"
            && !storage1.is_null(),
        json!({"storage_deposit_yocto": storage_min.to_string(), "after_one_approval": storage_one, "storage_balance_after": storage1, "gas": reg_exec_gas}),
    );

    // Retry USDC, then wNEAR (registered throughout): each lands exactly once.
    let mut withdraw_gas = Vec::new();
    let mut withdraw_detail = Vec::new();
    let mut withdraw_ok = true;
    for (token, amount) in [(usdc, mt_after_fail), (w.b.wnear.id(), dw1)] {
        let ft0 = ft_balance(&w, token, &dao.id).await?;
        let kind = withdraw_kind(token, amount);
        let p = dao.add_ok(c1, &format!("withdraw {token}"), &kind).await?;
        let y1 = dao.act(c1, p, "VoteApprove", &kind).await;
        let y2 = dao.act(c2, p, "VoteApprove", &kind).await;
        let ft1 = ft_balance(&w, token, &dao.id).await?;
        let mt1 = w.b.verifier.balance(&dao.id, token).await?;
        withdraw_ok &= y1.is_success()
            && y2.is_success()
            && dao.status(p).await? == "Approved"
            && ft1 - ft0 == amount
            && mt1 == 0;
        withdraw_gas.push(
            dao.execution_gas(&format!("ft_withdraw {token}"), &y2, FT_WITHDRAW_GAS)
                .await?,
        );
        withdraw_detail.push(json!({"token": token, "amount": amount.to_string(), "ft_before": ft0.to_string(), "ft_after": ft1.to_string(), "intents_after": mt1.to_string()}));
    }
    // No double count: across the refunded and the retried withdrawal, USDC owned by the DAO
    // (token balance plus Intents balance) equals what recovery delivered.
    let usdc_total =
        ft_balance(&w, usdc, &dao.id).await? + w.b.verifier.balance(&dao.id, usdc).await?;
    check(
        "dao_ft_withdraw_to_own_account",
        withdraw_ok && usdc_total == du1,
        json!({"withdrawals": withdraw_detail, "usdc_owned_total": usdc_total.to_string(), "usdc_recovered": du1.to_string(), "gas": withdraw_gas}),
    );

    let passed = checks.iter().all(|(_, ok, _)| *ok);
    let failed: Vec<&str> = checks
        .iter()
        .filter(|(_, ok, _)| !ok)
        .map(|(n, ..)| n.as_str())
        .collect();
    let steps: Vec<Value> = checks
        .iter()
        .map(|(n, ok, d)| json!({"check": n, "passed": ok, "detail": d}))
        .collect();
    evidence::write(
        "DAO",
        "sputnik-owner",
        passed,
        "sandbox",
        json!({
            "owner": "Sputnik DAO v2 (sputnikdao2 2.3.1, mainnet sputnik-dao.near default code) deployed at the mandate's fixed owner_id, no access keys",
            "mandate_candidate": "fixtures/deploy/bounded_mandate-163ccfa-reproducible.wasm",
            "mandate_candidate_sha256": sha256_file(&candidate),
            "verifier": "fixtures/verifier/defuse-0.4.5.wasm",
            "vote_policy": "council of 3, RoleWeight, threshold 2 for FunctionCall proposals",
            "elapsed_sec": started.elapsed().as_secs(),
            "steps": steps,
        }),
    );
    assert!(passed, "DAO owner checks failed: {failed:?}\n{steps:#?}");
    Ok(())
}
