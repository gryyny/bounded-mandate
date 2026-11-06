// gate: T5
// Applies the mandate's threat model to our re-implementation of the Claw Guard design, adapted to
// the pinned Intents verifier WASM, in a local sandbox. Outcomes describe that re-implementation, not
// the deployed Claw Guard product. Every outcome is classified from executed chain state (balances,
// nonce use, receipts), never asserted in advance; the report is out/evidence/tests/T5.baseline.json (never overwritten).
#![allow(
    clippy::arithmetic_side_effects,
    clippy::as_conversions,
    clippy::too_many_arguments,
    reason = "test harness arithmetic on small sandbox amounts and a flat report helper; contract code stays checked"
)]

use std::future::IntoFuture;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail, ensure};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use near_sdk::base64::Engine;
use near_sdk::base64::engine::general_purpose::STANDARD as B64;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const CLAW_GUARD_REPO: &str = "https://github.com/metafrogmeme-droid/claw-guard-near";
const CLAW_GUARD_COMMIT: &str = "225d37d3c1b04959947fa7c18544fa50e273dcd8";
const FEE_PIPS: u128 = 1;
const USDC: u128 = 1_000_000;
const WNEAR: u128 = 1_000_000_000_000_000_000_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const PER_ORDER_USDC: u128 = 400 * USDC;
const DAILY_CAP_USDC: u128 = 2_000 * USDC;
const ORDER_TTL_SEC: u64 = 60;
const AGENT_GAS_ALLOWANCE: NearToken = NearToken::from_near(20);

fn root_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read_wasm(rel: &str) -> Result<Vec<u8>> {
    let path = root_dir().join(rel);
    std::fs::read(&path).with_context(|| {
        format!(
            "missing {}: build it first with `cargo near build non-reproducible-wasm --locked --manifest-path <crate>/Cargo.toml`",
            path.display()
        )
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn fee(amount: u128) -> u128 {
    (amount * FEE_PIPS).div_ceil(1_000_000)
}

/// Smallest `y` with `y - fee(y) >= want`: what the filler must give so the owner receives `want`.
fn gross_for_net(want: u128) -> u128 {
    // Start just below the closed-form answer, then step up to the exact minimum.
    let mut y = (want * 1_000_000 / (1_000_000 - FEE_PIPS))
        .saturating_sub(2)
        .max(want);
    while y - fee(y) < want {
        y += 1;
    }
    y
}

fn nep413_hash(message: &str, nonce: [u8; 32], recipient: &str) -> [u8; 32] {
    let bytes = near_sdk::borsh::to_vec(&(
        2_147_484_061u32,
        message,
        nonce,
        recipient,
        Option::<String>::None,
    ))
    .expect("borsh");
    Sha256::digest(bytes).into()
}

fn rfc3339_plus(ts_ns: u64, secs: u64) -> String {
    // Reuse the verifier-compatible format by asking `date`; independent of the contract code.
    let t = ts_ns / 1_000_000_000 + secs;
    let out = Command::new("date")
        .args(["-u", "-r", &t.to_string(), "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .or_else(|_| {
            Command::new("date")
                .args(["-u", "-d", &format!("@{t}"), "+%Y-%m-%dT%H:%M:%SZ"])
                .output()
        })
        .expect("date");
    String::from_utf8(out.stdout)
        .expect("utf8")
        .trim()
        .to_owned()
}

fn failure_text(result: &ExecutionFinalResult) -> String {
    let text = result
        .receipt_failures()
        .first()
        .and_then(|o| (*o).clone().into_result().err())
        .map_or_else(|| "no failed receipt".to_owned(), |e| format!("{e:?}"));
    text.chars().take(400).collect()
}

struct Env {
    worker: Worker<Sandbox>,
    intents: Contract,
    mpc: Contract,
    guard: Contract,
    owner: Account,
    owner_cold: Account,
    filler: Account,
    filler_key: SigningKey,
    agent: Account,
    relayer: Account,
    usdc: Account,
    wnear: Account,
    filler_nonce: u64,
    /// sha256 of the target/near WASMs this run loaded, keyed by file stem (envelope v2 `wasm_sha256`).
    wasm_sha256: serde_json::Map<String, Value>,
    verifier_sha256: String,
}

#[derive(Clone, Debug)]
struct Signed {
    receipt_id: u64,
    multipayload: Value,
    message: Value,
    nonce_b64: String,
}

impl Env {
    fn token(&self, account: &Account) -> String {
        format!("nep141:{}", account.id())
    }

    async fn balance(&self, owner: &AccountId, token: &Account) -> Result<u128> {
        let v: String = self
            .intents
            .view("mt_balance_of")
            .args_json(json!({ "account_id": owner, "token_id": self.token(token) }))
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    async fn owner_balances(&self) -> Result<(u128, u128)> {
        Ok((
            self.balance(self.owner.id(), &self.usdc).await?,
            self.balance(self.owner.id(), &self.wnear).await?,
        ))
    }

    async fn now_ns(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    async fn derived_key(&self) -> Result<String> {
        Ok(self
            .mpc
            .view("derived_public_key")
            .args_json(
                json!({ "path": "intents-1", "predecessor": self.guard.id(), "domain_id": 1 }),
            )
            .await?
            .json()?)
    }

    async fn owner_call(
        &self,
        receiver: &AccountId,
        method: &str,
        args: Value,
        yocto: bool,
    ) -> Result<ExecutionFinalResult> {
        let call = self.owner.call(receiver, method).args_json(args).max_gas();
        let call = if yocto { call.deposit(ONE_YOCTO) } else { call };
        Ok(call.transact().await?)
    }

    async fn owner_must(
        &self,
        receiver: &AccountId,
        method: &str,
        args: Value,
        yocto: bool,
    ) -> Result<()> {
        let r = self.owner_call(receiver, method, args, yocto).await?;
        ensure!(
            r.is_success(),
            "owner {method} failed: {}",
            failure_text(&r)
        );
        Ok(())
    }

    async fn register_agent(&self) -> Result<()> {
        let expires = self.now_ns().await? + 86_400 * 1_000_000_000;
        let rules = json!({
            "max_sell_usdc": PER_ORDER_USDC.to_string(),
            "max_sell_wnear": (PER_ORDER_USDC / 3 * WNEAR / USDC).to_string(),
            "max_order_notional": PER_ORDER_USDC.to_string(),
            "daily_cap": DAILY_CAP_USDC.to_string(),
            "max_orders_per_day": 50,
            "expires_at_ns": expires.to_string(),
            "order_ttl_sec": ORDER_TTL_SEC,
        });
        self.owner_must(
            self.guard.id(),
            "register_agent",
            json!({ "agent_id": self.agent.id(), "rules": rules }),
            true,
        )
        .await
    }

    async fn rules_view(&self) -> Result<Value> {
        Ok(self
            .guard
            .view("get_rules")
            .args_json(json!({ "agent_id": self.agent.id() }))
            .await?
            .json()?)
    }

    async fn receipt(&self, id: u64) -> Result<Value> {
        Ok(self
            .guard
            .view("get_receipt")
            .args_json(json!({ "id": id.to_string() }))
            .await?
            .json()?)
    }

    async fn receipts_count(&self) -> Result<u64> {
        let s: Value = self.guard.view("get_status").await?.json()?;
        Ok(s["receipts_count"].as_str().context("count")?.parse()?)
    }

    fn propose_call(
        &self,
        sell: &str,
        sell_amount: u128,
        min_buy: u128,
    ) -> near_workspaces::operations::CallTransaction {
        self.agent
            .call(self.guard.id(), "propose_order")
            .args_json(json!({ "proposal": {
                "sell": sell, "sell_amount": sell_amount.to_string(), "min_buy_amount": min_buy.to_string()
            }}))
            .gas(near_workspaces::types::Gas::from_tgas(300))
    }

    /// Builds the publishable MultiPayload from a stored receipt plus an externally obtained signature.
    async fn signed_from_receipt(&self, id: u64, signature: &str) -> Result<Signed> {
        let r = self.receipt(id).await?;
        let payload = r["payload"].clone();
        let message: Value = serde_json::from_str(payload["message"].as_str().context("message")?)?;
        Ok(Signed {
            receipt_id: id,
            multipayload: json!({
                "standard": "nep413",
                "payload": payload,
                "public_key": self.derived_key().await?,
                "signature": signature,
            }),
            nonce_b64: message["nonce"].as_str().context("nonce")?.to_owned(),
            message,
        })
    }

    /// Agent proposes; expects the guard to sign. Checks the published payload hash and signature
    /// independently (our NEP-413 hash and ed25519 verification against the MPC-derived key).
    async fn propose_signed(&self, sell: &str, sell_amount: u128, min_buy: u128) -> Result<Signed> {
        let r = self
            .propose_call(sell, sell_amount, min_buy)
            .transact()
            .await?;
        ensure!(r.is_success(), "propose failed: {}", failure_text(&r));
        let decision: Value = r.json()?;
        ensure!(
            decision["allowed"] == json!(true),
            "not allowed: {decision}"
        );
        let id: u64 = decision["receipt_id"].as_str().context("id")?.parse()?;
        let receipt = self.receipt(id).await?;
        let sig = receipt["signature"]
            .as_str()
            .context("signature")?
            .to_owned();
        let signed = self.signed_from_receipt(id, &sig).await?;
        self.verify_signature(&signed)?;
        Ok(signed)
    }

    fn verify_signature(&self, s: &Signed) -> Result<()> {
        let p = &s.multipayload["payload"];
        let nonce: [u8; 32] = B64
            .decode(p["nonce"].as_str().context("nonce")?)?
            .try_into()
            .map_err(|_| anyhow!("nonce len"))?;
        let hash = nep413_hash(
            p["message"].as_str().context("m")?,
            nonce,
            p["recipient"].as_str().context("r")?,
        );
        let pk = s.multipayload["public_key"].as_str().context("pk")?;
        let pk: [u8; 32] = near_sdk::bs58::decode(pk.trim_start_matches("ed25519:"))
            .into_vec()?
            .try_into()
            .map_err(|_| anyhow!("pk"))?;
        let sig = s.multipayload["signature"].as_str().context("sig")?;
        let sig: [u8; 64] = near_sdk::bs58::decode(sig.trim_start_matches("ed25519:"))
            .into_vec()?
            .try_into()
            .map_err(|_| anyhow!("sig"))?;
        VerifyingKey::from_bytes(&pk)?
            .verify(&hash, &ed25519_dalek::Signature::from_bytes(&sig))?;
        Ok(())
    }

    /// The filler's matching side for an owner order, signed with the filler's own key.
    fn filler_side(&mut self, order: &Signed) -> Result<Value> {
        let diff = order.message["intents"][0]["diff"]
            .as_object()
            .context("diff")?;
        let mut counter = serde_json::Map::new();
        for (token, delta) in diff {
            let d: i128 = delta.as_str().context("delta")?.parse()?;
            let amount = d.unsigned_abs();
            let mine = if d < 0 {
                (amount - fee(amount)).to_string()
            } else {
                format!("-{}", gross_for_net(amount))
            };
            counter.insert(token.clone(), Value::String(mine));
        }
        self.filler_nonce += 1;
        let nonce: [u8; 32] =
            Sha256::digest(format!("t5 filler nonce {}", self.filler_nonce)).into();
        let message = json!({
            "signer_id": self.filler.id(),
            "verifying_contract": self.intents.id(),
            "deadline": order.message["deadline"],
            "nonce": B64.encode(nonce),
            "intents": [{ "intent": "token_diff", "diff": counter }],
        })
        .to_string();
        let recipient = self.intents.id().to_string();
        let sig = self
            .filler_key
            .sign(&nep413_hash(&message, nonce, &recipient));
        Ok(json!({
            "standard": "nep413",
            "payload": { "message": message, "nonce": B64.encode(nonce), "recipient": recipient },
            "public_key": format!("ed25519:{}", near_sdk::bs58::encode(self.filler_key.verifying_key().as_bytes()).into_string()),
            "signature": format!("ed25519:{}", near_sdk::bs58::encode(sig.to_bytes()).into_string()),
        }))
    }

    /// An unrelated account relays the owner order with a fresh filler side via permissionless
    /// `execute_intents`. Returns whether it executed, the owner's balance deltas and the error.
    async fn relay(&mut self, order: &Signed) -> Result<Relay> {
        let before = self.owner_balances().await?;
        let filler = self.filler_side(order)?;
        let r = self
            .relayer
            .call(self.intents.id(), "execute_intents")
            .args_json(json!({ "signed": [order.multipayload, filler] }))
            .max_gas()
            .transact()
            .await?;
        let after = self.owner_balances().await?;
        let used: bool = self
            .intents
            .view("is_nonce_used")
            .args_json(json!({ "account_id": self.owner.id(), "nonce": order.nonce_b64 }))
            .await?
            .json()?;
        Ok(Relay {
            executed: r.is_success(),
            nonce_used: used,
            usdc_delta: after.0 as i128 - before.0 as i128,
            wnear_delta: after.1 as i128 - before.1 as i128,
            error: (!r.is_success()).then(|| failure_text(&r)),
        })
    }
}

#[derive(Debug)]
struct Relay {
    executed: bool,
    nonce_used: bool,
    usdc_delta: i128,
    wnear_delta: i128,
    error: Option<String>,
}

impl Relay {
    /// Execution is classified from chain state: the order's exact diff applied and its nonce
    /// consumed, or nothing changed and the nonce still free. Anything else is inconsistent.
    fn classify(&self, order: &Signed, usdc: &str, wnear: &str) -> Result<bool> {
        let diff = &order.message["intents"][0]["diff"];
        let want = |t: &str| -> Result<i128> { Ok(diff[t].as_str().context("delta")?.parse()?) };
        let (du, dw) = (want(usdc)?, want(wnear)?);
        if self.executed && self.nonce_used && self.usdc_delta == du && self.wnear_delta == dw {
            Ok(true)
        } else if !self.executed
            && !self.nonce_used
            && self.usdc_delta == 0
            && self.wnear_delta == 0
        {
            Ok(false)
        } else {
            bail!("inconsistent relay result {self:?} for diff {diff}")
        }
    }

    fn observed(&self) -> Value {
        json!({
            "execute_intents_succeeded": self.executed,
            "nonce_used_after": self.nonce_used,
            "owner_usdc_delta": self.usdc_delta.to_string(),
            "owner_wnear_delta": self.wnear_delta.to_string(),
            "error": self.error,
        })
    }
}

struct Report {
    cases: Vec<Value>,
    assertions: Vec<Value>,
}

impl Report {
    fn case(
        &mut self,
        id: &str,
        threat: &str,
        compare_gate: &str,
        outcome: &str,
        summary: &str,
        consistent: bool,
        observed: Value,
    ) {
        self.assertions.push(json!({
            "id": format!("T5.{id}"),
            "gate": "T5",
            "description": format!("{threat}: executed against the baseline and classified from chain state"),
            "passed": consistent,
            "observed": { "baseline_outcome": outcome },
        }));
        self.cases.push(json!({
            "id": id, "threat": threat, "compare_gate": compare_gate,
            "baseline_outcome": outcome, "summary": summary, "observed": observed,
        }));
    }
}

fn outcome(attack_executed: bool) -> &'static str {
    if attack_executed {
        "attack_succeeded"
    } else {
        "blocked"
    }
}

async fn setup() -> Result<Env> {
    let verifier_wasm = read_wasm("fixtures/verifier/defuse-0.4.5.wasm")?;
    let mpc_wasm = read_wasm("target/near/mock_mpc/mock_mpc.wasm")?;
    let guard_wasm = read_wasm("target/near/claw_guard_adapted/claw_guard_adapted.wasm")?;

    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(near))
                .keys(SecretKey::from_random(KeyType::ED25519))
                .transact()
                .await?
                .into_result()
                .map_err(anyhow::Error::from)
        }
    };
    let owner = sub("owner", 50).await?;
    let owner_cold = sub("owner-cold", 5).await?;
    let filler = sub("filler", 50).await?;
    let relayer = sub("relayer", 50).await?;
    let usdc = sub("usdc", 10).await?;
    let wnear = sub("wnear", 10).await?;
    let intents = sub("intents", 100)
        .await?
        .deploy(&verifier_wasm)
        .await?
        .into_result()?;
    let mpc = sub("mpc", 30)
        .await?
        .deploy(&mpc_wasm)
        .await?
        .into_result()?;
    let guard = sub("claw-guard", 30)
        .await?
        .deploy(&guard_wasm)
        .await?
        .into_result()?;

    intents
        .call("new")
        .args_json(json!({ "config": {
            "wnear_id": wnear.id(),
            "fees": { "fee": FEE_PIPS as u32, "fee_collector": root.id() },
            "roles": { "super_admins": [root.id()], "admins": {}, "grantees": {} },
        }}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    mpc.call("new")
        .args_json(json!({ "owner_id": root.id() }))
        .transact()
        .await?
        .into_result()?;
    guard
        .call("new")
        .args_json(json!({ "config": {
            "owner_id": owner.id(), "mpc_contract_id": mpc.id(), "verifier_id": intents.id(),
            "usdc_id": usdc.id(), "wnear_id": wnear.id(),
            "sign_deposit_yocto": "1", "sign_gas_tgas": 100,
        }}))
        .transact()
        .await?
        .into_result()?;

    // Agent: one function-call key for `propose_order` on the guard, finite allowance, no full key.
    let agent_sk = SecretKey::from_random(KeyType::ED25519);
    let agent_id: AccountId = format!("agent.{}", root.id()).parse()?;
    root.batch(&agent_id)
        .create_account()
        .transfer(NearToken::from_near(30))
        .add_key(
            agent_sk.public_key(),
            AccessKey::function_call_access(
                guard.id(),
                &["propose_order"],
                Some(AGENT_GAS_ALLOWANCE),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let agent = Account::from_secret_key(agent_id, agent_sk, &worker);

    // Setup only: token-named accounts credit deposits through the verifier's NEP-141 receiver.
    for (token, to, amount) in [
        (&usdc, owner.id(), 5_000 * USDC),
        (&wnear, filler.id(), 5_000 * WNEAR),
        (&usdc, filler.id(), 5_000 * USDC),
    ] {
        token
            .call(intents.id(), "ft_on_transfer")
            .args_json(json!({ "sender_id": to, "amount": amount.to_string(), "msg": "" }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }

    let filler_key =
        SigningKey::from_bytes(&Sha256::digest(b"t5 filler TEST KEY, sandbox only").into());
    let filler_pk = format!(
        "ed25519:{}",
        near_sdk::bs58::encode(filler_key.verifying_key().as_bytes()).into_string()
    );
    filler
        .call(intents.id(), "add_public_key")
        .args_json(json!({ "public_key": filler_pk }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;

    let env = Env {
        worker,
        intents,
        mpc,
        guard,
        owner,
        owner_cold,
        filler,
        filler_key,
        agent,
        relayer,
        usdc,
        wnear,
        filler_nonce: 0,
        wasm_sha256: [("claw_guard_adapted", &guard_wasm), ("mock_mpc", &mpc_wasm)]
            .into_iter()
            .map(|(stem, bytes)| (stem.to_owned(), Value::String(sha256_hex(bytes))))
            .collect(),
        verifier_sha256: sha256_hex(&verifier_wasm),
    };
    env.register_agent().await?;
    // Claw Guard's Hyperliquid step "approve the derived address as an API wallet": the owner
    // registers the guard's derived key on the owner's own Intents account.
    let derived = env.derived_key().await?;
    env.owner_must(
        env.intents.id(),
        "add_public_key",
        json!({ "public_key": derived }),
        true,
    )
    .await?;
    Ok(env)
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root_dir())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[tokio::test]
async fn t5_baseline_threat_model() -> Result<()> {
    // gate: T5
    // `run.ts start` clears earlier runs' reports; nothing is removed here, so a second emission
    // in one run stays visible to acceptance as a duplicate.
    let mut env = setup().await?;
    let (u, w) = (env.token(&env.usdc), env.token(&env.wnear));
    let mut rep = Report {
        cases: vec![],
        assertions: vec![],
    };
    let buy_wnear = |usdc_amount: u128| usdc_amount / 3 * WNEAR / USDC;

    // Control: a permitted order is signed and settles; proves the harness can execute trades.
    let p0 = env
        .propose_signed("usdc", 100 * USDC, buy_wnear(100 * USDC))
        .await?;
    let r0 = env.relay(&p0).await?;
    let executed = r0.classify(&p0, &u, &w)?;
    rep.case(
        "control_permitted_trade",
        "Permitted order signed by the guard and relayed",
        "T3",
        if executed { "executed" } else { "failed" },
        "Harness control: a permitted USDC->wNEAR order executes on the pinned verifier.",
        executed,
        r0.observed(),
    );

    // Over-cap: per-order notional above the owner's cap.
    let before_count = env.receipts_count().await?;
    let r = env
        .propose_call("usdc", PER_ORDER_USDC + 1, buy_wnear(PER_ORDER_USDC + 1))
        .transact()
        .await?;
    let decision: Value = r.json()?;
    let rc = env.receipt(before_count + 1).await?;
    let blocked = decision["allowed"] == json!(false)
        && rc["signature"].is_null()
        && rc["status"] == json!("Blocked");
    rep.case("over_cap_order", "Over-cap order (per-order notional cap + 1 unit)", "BOUNDARY", outcome(!blocked),
        "The guard evaluates the per-order cap before requesting a signature.",
        blocked || (decision["allowed"] == json!(true) && !rc["signature"].is_null()),
        json!({ "decision": decision, "receipt_status": rc["status"], "rule_code": rc["rule_code"] }));

    // Agent key compromise / injected withdrawal or transfer request.
    let keys_before: Value = env
        .intents
        .view("public_keys_of")
        .args_json(json!({ "account_id": env.owner.id() }))
        .await?
        .json()?;
    let bal_before = env.owner_balances().await?;
    let attempts = [
        ("propose_withdrawal_shape", env.agent.call(env.guard.id(), "propose_order")
            .args_json(json!({ "proposal": { "intent": "ft_withdraw", "token": u, "receiver_id": env.agent.id(), "amount": "1" }}))
            .max_gas().transact().await),
        ("verifier_mt_transfer", env.agent.call(env.intents.id(), "mt_transfer")
            .args_json(json!({ "receiver_id": env.agent.id(), "token_id": u, "amount": "1" }))
            .deposit(ONE_YOCTO).max_gas().transact().await),
        ("verifier_execute_intents_no_deposit", env.agent.call(env.intents.id(), "execute_intents")
            .args_json(json!({ "signed": [] }))
            .max_gas().transact().await),
        ("verifier_add_public_key",env.agent.call(env.intents.id(), "add_public_key")
            .args_json(json!({ "public_key": "ed25519:11111111111111111111111111111111" }))
            .deposit(ONE_YOCTO).max_gas().transact().await),
        ("mpc_sign_direct", env.agent.call(env.mpc.id(), "sign")
            .args_json(json!({ "request": { "path": "intents-1", "payload_v2": { "Eddsa": "00" }, "domain_id": 1 }}))
            .deposit(ONE_YOCTO).max_gas().transact().await),
    ];
    let mut attempt_obs = serde_json::Map::new();
    let mut any_succeeded = false;
    for (name, res) in &attempts {
        let obs = match res {
            Ok(r) => {
                any_succeeded |= r.is_success();
                json!({ "rejected_at": if r.is_success() { "none" } else { "execution" }, "error": failure_text(r) })
            }
            Err(e) => {
                let debug = format!("{e:?}");
                let reason = [
                    "ReceiverMismatch",
                    "MethodNameMismatch",
                    "DepositWithFunctionCall",
                    "NotEnoughAllowance",
                ]
                .into_iter()
                .find(|r| debug.contains(r));
                json!({ "rejected_at": "transaction validation", "reason": reason, "error": debug.chars().take(400).collect::<String>() })
            }
        };
        attempt_obs.insert((*name).to_owned(), obs);
    }
    let keys_after: Value = env
        .intents
        .view("public_keys_of")
        .args_json(json!({ "account_id": env.owner.id() }))
        .await?
        .json()?;
    let unchanged = keys_after == keys_before && env.owner_balances().await? == bal_before;
    rep.case(
        "agent_injected_withdrawal",
        "Compromised agent key: withdrawal/transfer request, direct verifier and MPC calls",
        "BOUNDARY",
        outcome(any_succeeded || !unchanged),
        "Function-call key restricted to propose_order; the guard only builds token_diff payloads.",
        true,
        json!({ "attempts": attempt_obs, "owner_keys_and_balances_unchanged": unchanged }),
    );

    // T2b analog: the signer discloses a valid signature, the guard's callback sees a failure
    // (yield timeout), the guard releases the reservation, and the disclosed order is relayed.
    env.worker
        .root_account()?
        .call(env.mpc.id(), "set_mode")
        .args_json(json!({ "mode": "disclose_only" }))
        .transact()
        .await?
        .into_result()?;
    let spent_before: u128 = env.rules_view().await?["spent_today"]
        .as_str()
        .context("spent")?
        .parse()?;
    let pending_tx = env
        .propose_call("usdc", PER_ORDER_USDC, buy_wnear(PER_ORDER_USDC))
        .transact_async()
        .await?;
    let mut polls = 0;
    let c_id = loop {
        polls += 1;
        ensure!(polls < 200, "order C never reached PendingSignature");
        let count = env.receipts_count().await?;
        if count > before_count + 1
            && env.receipt(count).await?["status"] == json!("PendingSignature")
        {
            break count;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    };
    let c_hash = env.receipt(c_id).await?["payload_hash"]
        .as_str()
        .context("hash")?
        .to_owned();
    let pending: Vec<Value> = env.mpc.view("list_pending").await?.json()?;
    let request_id = pending
        .iter()
        .find(|p| p["payload_hex"] == json!(c_hash))
        .and_then(|p| p["request_id"].as_u64())
        .context("pending sign request for C")?;
    let disclosed: Value = env
        .mpc
        .view("get_disclosed_signature")
        .args_json(json!({ "request_id": request_id }))
        .await?
        .json()?;
    let sig_bytes: Vec<u8> = serde_json::from_value(disclosed["signature"].clone())?;
    let c_sig = format!(
        "ed25519:{}",
        near_sdk::bs58::encode(sig_bytes).into_string()
    );
    let c = env.signed_from_receipt(c_id, &c_sig).await?;
    env.verify_signature(&c)?;
    let spent_reserved: u128 = env.rules_view().await?["spent_today"]
        .as_str()
        .context("spent")?
        .parse()?;
    let rc_relay = env.relay(&c).await?;
    let c_executed = rc_relay.classify(&c, &u, &w)?;
    env.worker.fast_forward(250).await?;
    let final_c = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        pending_tx.into_future(),
    )
    .await
    .context("signer yield did not time out after fast_forward")??;
    let c_receipt = env.receipt(c_id).await?;
    let rules_after = env.rules_view().await?;
    let spent_after: u128 = rules_after["spent_today"]
        .as_str()
        .context("spent")?
        .parse()?;
    env.worker
        .root_account()?
        .call(env.mpc.id(), "set_mode")
        .args_json(json!({ "mode": "immediate" }))
        .transact()
        .await?
        .into_result()?;
    // Use the released capacity: sign and settle up to the daily cap again.
    let mut follow_on = 0u128;
    let mut follow_obs = vec![];
    loop {
        let res = env
            .propose_call("usdc", PER_ORDER_USDC, buy_wnear(PER_ORDER_USDC))
            .transact()
            .await?;
        let d: Value = res.json()?;
        if d["allowed"] != json!(true) {
            follow_obs.push(json!({ "blocked": d }));
            break;
        }
        let id: u64 = d["receipt_id"].as_str().context("id")?.parse()?;
        let sig = env.receipt(id).await?["signature"]
            .as_str()
            .context("sig")?
            .to_owned();
        let s = env.signed_from_receipt(id, &sig).await?;
        let rr = env.relay(&s).await?;
        if rr.classify(&s, &u, &w)? {
            follow_on += PER_ORDER_USDC;
        }
        follow_obs.push(json!({ "receipt_id": id, "executed": rr.executed }));
    }
    let c_notional = if c_executed { PER_ORDER_USDC } else { 0 };
    let executed_since = c_notional + follow_on;
    let released = c_receipt["status"] == json!("SignFailed") && spent_after < spent_reserved;
    let cap_exceeded = spent_before + executed_since > DAILY_CAP_USDC;
    let t2b_attack = c_executed && released && cap_exceeded;
    let t2b_consistent = final_c.is_success()
        && (c_receipt["status"] == json!("SignFailed") || c_receipt["status"] == json!("Signed"));
    rep.case("t2b_disclosed_signature_failed_callback",
        "Published signature with a failed signer callback, relayed independently", "T2b", outcome(t2b_attack),
        "Our re-implementation follows Claw Guard's design of releasing a reservation when on_signed sees a failure; a signature disclosed by the signer still executes, so executed notional is no longer counted.",
        t2b_consistent,
        json!({
            "relay_of_disclosed_order": rc_relay.observed(),
            "guard_receipt_status_after_timeout": c_receipt["status"],
            "spent_today_before_usdc_units": spent_before.to_string(),
            "spent_today_while_pending": spent_reserved.to_string(),
            "spent_today_after_failed_callback": spent_after.to_string(),
            "daily_cap_usdc_units": DAILY_CAP_USDC.to_string(),
            "executed_notional_since_disclosure": executed_since.to_string(),
            "executed_today_including_control": (spent_before + executed_since).to_string(),
            "follow_on_orders": follow_obs,
            "rules_day": rules_after["day"],
        }));

    // T1 analog: withhold a signed order, then use Claw Guard's own revocation controls.
    env.owner_must(
        env.guard.id(),
        "remove_agent",
        json!({ "agent_id": env.agent.id() }),
        true,
    )
    .await?;
    env.register_agent().await?;
    let a = env
        .propose_signed("usdc", 100 * USDC, buy_wnear(100 * USDC))
        .await?;
    env.owner_must(env.guard.id(), "pause", json!({}), false)
        .await?;
    env.owner_must(
        env.guard.id(),
        "remove_agent",
        json!({ "agent_id": env.agent.id() }),
        true,
    )
    .await?;
    let ra = env.relay(&a).await?;
    let a_exec = ra.classify(&a, &u, &w)?;
    rep.case("t1_withheld_after_guard_revocation",
        "Withheld signed order relayed after the guard's revocation (pause + remove_agent)", "T1", outcome(a_exec),
        "As documented in Claw Guard's Q-45 and re-implemented here: pause and remove_agent stop later proposals only; issued signatures stay valid.",
        true, json!({ "receipt_id": a.receipt_id, "relay": ra.observed() }));

    // T1 analog with venue-side revocation: the owner also removes the derived key on Intents.
    env.register_agent().await?;
    env.owner_must(env.guard.id(), "unpause", json!({}), true)
        .await?;
    let b = env
        .propose_signed("usdc", 100 * USDC, buy_wnear(100 * USDC))
        .await?;
    let derived = env.derived_key().await?;
    env.owner_must(env.guard.id(), "pause", json!({}), false)
        .await?;
    env.owner_must(
        env.guard.id(),
        "remove_agent",
        json!({ "agent_id": env.agent.id() }),
        true,
    )
    .await?;
    env.owner_must(
        env.intents.id(),
        "remove_public_key",
        json!({ "public_key": derived }),
        true,
    )
    .await?;
    let rb = env.relay(&b).await?;
    let b_exec = rb.classify(&b, &u, &w)?;
    rep.case("t1_withheld_after_key_removal",
        "Withheld signed order relayed after the owner removes the derived key from the Intents account", "T1",
        outcome(b_exec),
        "Venue-side key removal (the Intents analog of Claw Guard's documented Q-45 mitigation on Hyperliquid) makes the withheld order fail.",
        true, json!({ "receipt_id": b.receipt_id, "relay": rb.observed() }));

    // Regrant: the path is fixed per target, so re-enabling trading re-registers the same key.
    env.register_agent().await?;
    env.owner_must(env.guard.id(), "unpause", json!({}), true)
        .await?;
    let derived_again = env.derived_key().await?;
    env.owner_must(
        env.intents.id(),
        "add_public_key",
        json!({ "public_key": derived_again }),
        true,
    )
    .await?;
    let now = env.now_ns().await?;
    let deadline_ok =
        b.message["deadline"].as_str().unwrap_or_default() >= rfc3339_plus(now, 0).as_str();
    let rb2 = env.relay(&b).await?;
    let b2_exec = rb2.classify(&b, &u, &w)?;
    rep.case("t1_withheld_after_regrant",
        "The same withheld order relayed after regrant", "T1", outcome(b2_exec),
        "Fixed derivation path: regrant restores the identical key, so withheld pre-revocation orders become executable again while unexpired.",
        true,
        json!({
            "receipt_id": b.receipt_id,
            "same_key_after_regrant": derived_again == derived,
            "order_deadline": b.message["deadline"],
            "deadline_not_passed_at_relay": deadline_ok,
            "relay": rb2.observed(),
        }));

    // T1 variants that need a key-operation lifecycle inside the guard.
    for (id, threat) in [
        (
            "t1_revoke_during_pending_registration",
            "Revocation during a pending key-registration callback",
        ),
        (
            "t1_failed_removal_and_retry",
            "Failed key removal and retry",
        ),
    ] {
        rep.cases.push(json!({
            "id": id, "threat": threat, "compare_gate": "T1", "baseline_outcome": "unsupported_by_design",
            "summary": "The guard has no key lifecycle: the owner registers and removes the derived key directly on the verifier, outside the guard. Not executed.",
            "observed": null,
        }));
    }
    rep.cases.push(json!({
        "id": "outstanding_exposure_cap", "threat": "Aggregate outstanding exposure of signed-but-unsettled orders",
        "compare_gate": "T2", "baseline_outcome": "unsupported_by_design",
        "summary": "The guard counts signed notional per UTC day only; it has no outstanding-exposure accounting or settlement-based release. Not executed.",
        "observed": null,
    }));

    // T4 analog: agent removed, signer failing; the owner moves every unit with its own key.
    env.worker
        .root_account()?
        .call(env.mpc.id(), "set_mode")
        .args_json(json!({ "mode": "immediate_error" }))
        .transact()
        .await?
        .into_result()?;
    let _ = env
        .owner_call(
            env.guard.id(),
            "remove_agent",
            json!({ "agent_id": env.agent.id() }),
            true,
        )
        .await?;
    let (bu, bw) = env.owner_balances().await?;
    let mut moved = serde_json::Map::new();
    for (token, amount) in [(&u, bu), (&w, bw)] {
        if amount == 0 {
            continue;
        }
        let r = env
            .owner_call(env.intents.id(), "mt_transfer",
                json!({ "receiver_id": env.owner_cold.id(), "token_id": token, "amount": amount.to_string() }), true)
            .await?;
        moved.insert(
            token.clone(),
            json!({ "amount": amount.to_string(), "succeeded": r.is_success() }),
        );
    }
    let cold = (
        env.balance(env.owner_cold.id(), &env.usdc).await?,
        env.balance(env.owner_cold.id(), &env.wnear).await?,
    );
    let left = env.owner_balances().await?;
    let recovered = cold == (bu, bw) && left == (0, 0);
    rep.case("t4_recovery_without_agent_or_signer",
        "Strand owner assets by disabling the agent and the signer", "T4", outcome(!recovered),
        "Assets stay in the owner's own Intents account; the owner's predecessor-authorized mt_transfer needs no agent, signer or oracle.",
        true, json!({ "transfers": moved, "owner_cold_received": [cold.0.to_string(), cold.1.to_string()], "owner_left": [left.0.to_string(), left.1.to_string()] }));

    let passed = rep.assertions.iter().all(|a| a["passed"] == json!(true));
    let data = json!({
        "command": "cargo test -p claw-guard-adapted --test t5_baseline",
        "hashes": {
            "verifier_wasm_sha256": env.verifier_sha256,
            "claw_guard_adapted_wasm_sha256": env.wasm_sha256["claw_guard_adapted"],
            "mock_mpc_wasm_sha256": env.wasm_sha256["mock_mpc"],
        },
        "environment": { "sandbox": "near-workspaces 0.23.0", "signer": "stubs/mock-mpc TEST DOUBLE (not MPC)", "fee_pips": FEE_PIPS.to_string() },
        "baseline": {
            "name": "Our re-implementation of the Claw Guard design, adapted to NEAR Intents token_diff (not the deployed Claw Guard product)",
            "repository": CLAW_GUARD_REPO,
            "commit": CLAW_GUARD_COMMIT,
            "license": "MIT, Copyright (c) 2026 Patrick Baur (RUNECLAW)",
            "adaptations": [
                "Venue: the owner's own Intents account holds the assets; the owner registers the guard's derived Ed25519 key there with add_public_key (Claw Guard: owner approves the derived address as a Hyperliquid API wallet). Unlike an API wallet, an Intents key is not trade-only; only the guard's payload construction restricts it.",
                "Payload: NEP-413 token_diff over exactly USDC and wNEAR, signer = owner, built by the guard; Ed25519 domain 1 instead of secp256k1 domain 0.",
                "Deadline: finite order TTL of 60 s, the mandate's value (Claw Guard's Hyperliquid orders carry no expiry).",
                "Nonce: 32-byte legacy (non-versioned) nonce derived from the receipt id, accepted by verifier v0.4.5.",
                "Caps in USDC units: per-order token and notional caps, daily notional cap, daily order count, permission expiry; notional of a wNEAR sell is the agent's minimum USDC (Claw Guard Q-42 analog).",
                "Omitted as irrelevant to these cases: guardian role, set_rules loosening delay, receipt ring buffer, storage reserve rule, mainnet refusal, Hyperliquid/EVM encoders.",
            ],
        },
        "assertions": rep.assertions,
        "cases": rep.cases,
    });
    // Gate report envelope v2 (shared with contract/tests/common/evidence.rs and tools/src/evidence/report.ts).
    let report = json!({
        "schema": "bounded-mandate/gate-report/2",
        "gate": "T5",
        "case": "baseline",
        "passed": passed,
        "mode": "sandbox",
        "run_id": std::env::var("MANDATE_RUN_ID").ok(),
        "source": {
            "revision": git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_owned()),
            "dirty": git(&["status", "--porcelain"]).is_none_or(|s| !s.is_empty()),
        },
        "spec_sha256": sha256_hex(&std::fs::read(root_dir().join("SPEC.md"))?),
        "fixture_manifest_sha256": sha256_hex(&std::fs::read(root_dir().join("fixtures/manifest.json"))?),
        "wasm_sha256": env.wasm_sha256,
        "command": portable_command(&root_dir()),
        "generated_at_unix": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default(),
        "data": data,
    });
    write_report(
        &evidence_dir(),
        "T5",
        "baseline",
        &serde_json::to_vec_pretty(&report)?,
    )?;

    let failed: Vec<&Value> = report["data"]["assertions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["passed"] != json!(true))
        .collect();
    ensure!(failed.is_empty(), "T5 assertions failed: {failed:?}");
    Ok(())
}

fn evidence_dir() -> PathBuf {
    root_dir().join("out/evidence/tests")
}

/// Same naming rule as contract/tests/common/evidence.rs: creates `<gate>.<case>.json` atomically
/// (`create_new`), falling back to `<gate>.<case>.duplicate-N.json` (N = 2, 3, ...). Never overwrites.
fn write_report(dir: &Path, gate: &str, case: &str, bytes: &[u8]) -> Result<PathBuf> {
    use std::io::Write;
    std::fs::create_dir_all(dir).context("create evidence dir")?;
    for n in 1u32.. {
        let name = if n == 1 {
            format!("{gate}.{case}.json")
        } else {
            format!("{gate}.{case}.duplicate-{n}.json")
        };
        let path = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
                f.write_all(bytes)?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).with_context(|| format!("create {}", path.display())),
        }
    }
    unreachable!("report name space exhausted")
}

#[test]
fn t5_report_writer_never_overwrites() -> Result<()> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("bm-t5-evidence-{}-{nanos}", std::process::id()));
    let a = write_report(&dir, "T5", "baseline", br#"{"n":1}"#)?;
    let b = write_report(&dir, "T5", "baseline", br#"{"n":2}"#)?;
    ensure!(
        a.file_name() == Some("T5.baseline.json".as_ref()),
        "first name {a:?}"
    );
    ensure!(
        b.file_name() == Some("T5.baseline.duplicate-2.json".as_ref()),
        "second name {b:?}"
    );
    ensure!(
        std::fs::read(&a)? == br#"{"n":1}"#,
        "first report was overwritten"
    );
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let dir = dir.clone();
            std::thread::spawn(move || {
                write_report(&dir, "T5", "baseline", format!("{{\"t\":{i}}}").as_bytes())
            })
        })
        .collect();
    let mut paths = vec![a, b];
    for h in handles {
        paths.push(h.join().map_err(|_| anyhow!("writer thread panicked"))??);
    }
    paths.sort();
    paths.dedup();
    ensure!(
        paths.len() == 10,
        "concurrent writers collided: {} distinct files",
        paths.len()
    );
    ensure!(
        std::fs::read_dir(&dir)?.count() == 10,
        "every emission is kept"
    );
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}

/// The invoking command with machine-local paths removed: an absolute argument inside the repository is
/// shown relative to it, any other absolute argument by its file name.
fn portable_command(root: &std::path::Path) -> String {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    std::env::args()
        .map(|a| {
            let p = std::path::Path::new(&a);
            if !p.is_absolute() {
                return a.clone();
            }
            let resolved = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            match resolved.strip_prefix(&canonical) {
                Ok(rel) => rel.display().to_string(),
                Err(_) => p
                    .file_name()
                    .map_or_else(|| a.clone(), |f| f.to_string_lossy().into_owned()),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
