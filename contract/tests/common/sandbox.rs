//! near-workspaces sandbox world: the pinned verifier WASM, labelled stub dependencies, the mandate,
//! and the actors (owner, restricted agent, filler, unrelated relayer, verifier DAO).

use super::intents::{self, DecodedOrder, FillerKey};
use anyhow::{Context, Result, anyhow, bail};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};
use std::path::PathBuf;

pub const FEE_PIPS: u128 = 1;
pub const USDC_DECIMALS: u8 = 6;
pub const WNEAR_DECIMALS: u8 = 24;
pub const MAX_GAS: Gas = Gas::from_tgas(300);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

pub fn repo_path(rel: &str) -> PathBuf {
    super::evidence::repo_root().join(rel)
}

/// WASM built by `cargo near build` (the Makefile builds every crate before `cargo test`).
pub fn built_wasm(crate_underscored: &str) -> Result<Vec<u8>> {
    let p = repo_path(&format!(
        "target/near/{crate_underscored}/{crate_underscored}.wasm"
    ));
    std::fs::read(&p).with_context(|| {
        format!(
            "missing {} - build with `cargo near build non-reproducible-wasm --locked --manifest-path <crate>/Cargo.toml`",
            p.display()
        )
    })
}

pub fn verifier_wasm() -> Result<Vec<u8>> {
    let p = repo_path("fixtures/verifier/defuse-0.4.5.wasm");
    std::fs::read(&p).with_context(|| format!("missing {}", p.display()))
}

/// Outcome of a transaction that may be refused before execution (e.g. access-key permission or
/// allowance errors are RPC-level rejections, not receipt failures).
#[derive(Debug)]
pub enum TxOutcome {
    Rejected(String),
    Executed(Box<ExecutionFinalResult>),
}

impl TxOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Executed(r) if r.is_success())
    }

    /// Joined failure text from rejection or any failed receipt.
    pub fn failure_text(&self) -> String {
        match self {
            Self::Rejected(e) => e.clone(),
            Self::Executed(r) => r
                .receipt_failures()
                .iter()
                .map(|o| format!("{:?}", (*o).clone().into_result()))
                .chain(
                    r.is_failure()
                        .then(|| format!("{:?}", r.clone().into_result().err())),
                )
                .collect::<Vec<_>>()
                .join(" | "),
        }
    }

    pub fn logs(&self) -> Vec<String> {
        match self {
            Self::Rejected(_) => Vec::new(),
            Self::Executed(r) => r.logs().into_iter().map(str::to_owned).collect(),
        }
    }

    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        match self {
            Self::Rejected(e) => bail!("rejected: {e}"),
            Self::Executed(r) => Ok(r.clone().json()?),
        }
    }
}

pub async fn call(
    from: &Account,
    to: &AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
    gas: Gas,
) -> TxOutcome {
    match from
        .call(to, method)
        .args_json(args)
        .deposit(deposit)
        .gas(gas)
        .transact()
        .await
    {
        Ok(r) => TxOutcome::Executed(Box::new(r)),
        Err(e) => TxOutcome::Rejected(format!("{e:?}")),
    }
}

/// NEP-297 events from logs, filtered by standard.
pub fn events(logs: &[String], standard: &str) -> Vec<Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|e| e["standard"] == standard)
        .collect()
}

pub struct Verifier {
    pub contract: Contract,
}

impl Verifier {
    pub fn id(&self) -> &AccountId {
        self.contract.id()
    }

    pub async fn has_public_key(&self, account: &AccountId, pk: &str) -> Result<bool> {
        Ok(self
            .contract
            .view("has_public_key")
            .args_json(json!({"account_id": account, "public_key": pk}))
            .await?
            .json()?)
    }

    pub async fn public_keys_of(&self, account: &AccountId) -> Result<Vec<String>> {
        Ok(self
            .contract
            .view("public_keys_of")
            .args_json(json!({"account_id": account}))
            .await?
            .json()?)
    }

    pub async fn is_nonce_used(&self, account: &AccountId, nonce: &[u8; 32]) -> Result<bool> {
        Ok(self
            .contract
            .view("is_nonce_used")
            .args_json(json!({"account_id": account, "nonce": intents::b64(nonce)}))
            .await?
            .json()?)
    }

    pub async fn auth_by_predecessor_enabled(&self, account: &AccountId) -> Result<bool> {
        Ok(self
            .contract
            .view("is_auth_by_predecessor_id_enabled")
            .args_json(json!({"account_id": account}))
            .await?
            .json()?)
    }

    pub async fn current_salt(&self) -> Result<[u8; 4]> {
        let s: String = self.contract.view("current_salt").await?.json()?;
        hex::decode(&s)?
            .try_into()
            .map_err(|_| anyhow!("salt length"))
    }

    pub async fn balance(&self, account: &AccountId, token: &AccountId) -> Result<u128> {
        let v: String = self
            .contract
            .view("mt_balance_of")
            .args_json(
                json!({"account_id": account, "token_id": intents::token_id(token.as_str())}),
            )
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    pub async fn execute_intents(&self, relayer: &Account, signed: Vec<Value>) -> TxOutcome {
        call(
            relayer,
            self.id(),
            "execute_intents",
            json!({"signed": signed}),
            NearToken::from_yoctonear(0),
            MAX_GAS,
        )
        .await
    }

    /// Verifier DAO actions used to create honest failure conditions.
    pub async fn dao(&self, dao: &Account, method: &str, args: Value) -> TxOutcome {
        call(dao, self.id(), method, args, ONE_YOCTO, MAX_GAS).await
    }
}

pub async fn block_time_ns(worker: &Worker<Sandbox>) -> Result<u64> {
    Ok(worker.view_block().await?.timestamp())
}

/// Advances the sandbox clock past `target_ns` (fast-forward produces blocks without waiting).
pub async fn advance_past(worker: &Worker<Sandbox>, target_ns: u64) -> Result<u64> {
    for _ in 0..200 {
        let now = block_time_ns(worker).await?;
        if now > target_ns {
            return Ok(now);
        }
        let secs = (target_ns - now) / 1_000_000_000 + 1;
        worker.fast_forward(secs.clamp(1, 500)).await?;
    }
    bail!("clock did not pass {target_ns}")
}

pub async fn subaccount(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

/// Creates `name` whose only key is a function-call key for `methods` on `receiver` with a finite
/// `allowance`; the creation key is deleted. Returns the account signed by the restricted key.
pub async fn restricted_account(
    root: &Account,
    worker: &Worker<Sandbox>,
    name: &str,
    receiver: &AccountId,
    methods: &[&str],
    allowance: NearToken,
) -> Result<Account> {
    let full = subaccount(root, name, 5).await?;
    let fc_sk = SecretKey::from_random(KeyType::ED25519);
    full.batch(full.id())
        .add_key(
            fc_sk.public_key(),
            AccessKey::function_call_access(receiver, methods, Some(allowance)),
        )
        .delete_key(full.secret_key().public_key())
        .transact()
        .await?
        .into_result()?;
    let keys = worker.view_access_keys(full.id()).await?;
    if keys.len() != 1 {
        bail!(
            "restricted account must have exactly one key, has {}",
            keys.len()
        );
    }
    Ok(Account::from_secret_key(full.id().clone(), fc_sk, worker))
}

/// Deploys and initializes the pinned verifier with `fee` pips and `dao` holding the DAO role.
pub async fn deploy_verifier(
    root: &Account,
    wnear: &AccountId,
    fee_collector: &AccountId,
    dao: &AccountId,
) -> Result<Verifier> {
    let acct = subaccount(root, "intents", 50).await?;
    let contract = acct.deploy(&verifier_wasm()?).await?.into_result()?;
    contract
        .call("new")
        .args_json(json!({"config": {
            "wnear_id": wnear,
            "fees": {"fee": FEE_PIPS, "fee_collector": fee_collector},
            "roles": {"super_admins": [dao], "admins": {}, "grantees": {"DAO": [dao]}},
        }}))
        .gas(MAX_GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(Verifier { contract })
}

/// Fills a decoded mandate order with the filler's signed counter-intent, relayed by `relayer`.
pub async fn fill(
    verifier: &Verifier,
    relayer: &Account,
    filler: &Account,
    key: &FillerKey,
    order_payload: &Value,
    random: [u8; 15],
) -> Result<(TxOutcome, DecodedOrder)> {
    let order = DecodedOrder::from_multipayload(order_payload);
    let salt = verifier.current_salt().await?;
    let nonce = intents::versioned_nonce(
        salt,
        i64::try_from(order.deadline_ns).context("deadline")?,
        random,
    );
    let counter = key.counter_for(
        filler.id().as_str(),
        verifier.id().as_str(),
        &order,
        FEE_PIPS,
        nonce,
    );
    let out = verifier
        .execute_intents(relayer, vec![order_payload.clone(), counter])
        .await;
    Ok((out, order))
}

/// Deploys a labelled mock NEP-141 token owned (mint authority) by `minter`.
pub async fn deploy_token(
    root: &Account,
    name: &str,
    symbol: &str,
    decimals: u8,
    minter: &AccountId,
) -> Result<Contract> {
    let acct = subaccount(root, name, 10).await?;
    let c = acct.deploy(&built_wasm("mock_ft")?).await?.into_result()?;
    c.call("new")
        .args_json(
            json!({"owner_id": minter, "name": name, "symbol": symbol, "decimals": decimals}),
        )
        .transact()
        .await?
        .into_result()?;
    Ok(c)
}

pub async fn storage_register(payer: &Account, token: &AccountId, who: &AccountId) -> Result<()> {
    payer
        .call(token, "storage_deposit")
        .args_json(json!({"account_id": who, "registration_only": true}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn mint(minter: &Account, token: &AccountId, to: &AccountId, amount: u128) -> Result<()> {
    minter
        .call(token, "mint")
        .args_json(json!({"account_id": to, "amount": amount.to_string()}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Deposits `amount` of `token` held by `from` into `receiver`'s Intents account.
pub async fn deposit(
    from: &Account,
    token: &AccountId,
    verifier: &AccountId,
    receiver: &AccountId,
    amount: u128,
) -> Result<()> {
    let r = from
        .call(token, "ft_transfer_call")
        .args_json(json!({"receiver_id": verifier, "amount": amount.to_string(), "msg": receiver}))
        .deposit(ONE_YOCTO)
        .gas(MAX_GAS)
        .transact()
        .await?;
    if !r.is_success() || !r.receipt_failures().is_empty() {
        bail!("deposit failed: {:?}", r.receipt_failures());
    }
    Ok(())
}

pub async fn register_filler_key(
    filler: &Account,
    verifier: &AccountId,
    key: &FillerKey,
) -> Result<()> {
    filler
        .call(verifier, "add_public_key")
        .args_json(json!({"public_key": key.public_key_str()}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Base world without the mandate: verifier (fee 1 pip), two tokens, DAO, fee collector, filler
/// with registered key and deposited inventory, unrelated relayer.
pub struct Base {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub minter: Account,
    pub dao: Account,
    pub fee_collector: Account,
    pub filler: Account,
    pub filler_key: FillerKey,
    pub relayer: Account,
    pub verifier: Verifier,
    pub usdc: Contract,
    pub wnear: Contract,
}

impl Base {
    pub async fn new(filler_usdc: u128, filler_wnear: u128) -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let minter = subaccount(&root, "minter", 20).await?;
        let dao = subaccount(&root, "dao", 20).await?;
        let fee_collector = subaccount(&root, "fees", 5).await?;
        let filler = subaccount(&root, "filler", 20).await?;
        let relayer = subaccount(&root, "relayer", 20).await?;
        let usdc = deploy_token(&root, "usdc", "USDC", USDC_DECIMALS, minter.id()).await?;
        let wnear = deploy_token(&root, "wnear", "wNEAR", WNEAR_DECIMALS, minter.id()).await?;
        let verifier = deploy_verifier(&root, wnear.id(), fee_collector.id(), dao.id()).await?;
        for t in [usdc.id(), wnear.id()] {
            storage_register(&minter, t, verifier.id()).await?;
        }
        let filler_key = FillerKey::from_seed(7);
        register_filler_key(&filler, verifier.id(), &filler_key).await?;
        let base = Self {
            worker,
            root,
            minter,
            dao,
            fee_collector,
            filler,
            filler_key,
            relayer,
            verifier,
            usdc,
            wnear,
        };
        base.fund_intents(&base.filler, filler_usdc, filler_wnear)
            .await?;
        Ok(base)
    }

    /// Mints to `who` and deposits into `who`'s own Intents account... or another receiver.
    pub async fn fund_intents_for(
        &self,
        holder: &Account,
        receiver: &AccountId,
        usdc: u128,
        wnear: u128,
    ) -> Result<()> {
        for (t, a) in [(self.usdc.id(), usdc), (self.wnear.id(), wnear)] {
            if a > 0 {
                mint(&self.minter, t, holder.id(), a).await?;
                deposit(holder, t, self.verifier.id(), receiver, a).await?;
            }
        }
        Ok(())
    }

    pub async fn fund_intents(&self, who: &Account, usdc: u128, wnear: u128) -> Result<()> {
        self.fund_intents_for(who, who.id(), usdc, wnear).await
    }

    pub fn token_ids(&self) -> (String, String) {
        (
            intents::token_id(self.usdc.id().as_str()),
            intents::token_id(self.wnear.id().as_str()),
        )
    }

    pub async fn balances(&self, who: &AccountId) -> Result<(u128, u128)> {
        Ok((
            self.verifier.balance(who, self.usdc.id()).await?,
            self.verifier.balance(who, self.wnear.id()).await?,
        ))
    }

    pub async fn now_ns(&self) -> Result<u64> {
        block_time_ns(&self.worker).await
    }
}

/// Authority check against the real verifier without executing: `simulate_intents` with the
/// mandate's payload alone runs signature, key, deadline, nonce and salt checks before the
/// (expectedly unbalanced) settlement. Returns Ok(true) when the authority is live, Ok(false) with
/// the reason when the verifier rejects the authority itself.
pub async fn authority_live(verifier: &Verifier, payload: &Value) -> Result<(bool, String)> {
    match verifier
        .contract
        .view("simulate_intents")
        .args_json(json!({"signed": [payload]}))
        .await
    {
        Ok(_) => Ok((true, "simulated".into())),
        Err(e) => {
            let msg = format!("{e:?}");
            // A balance shortfall is not a lack of authority: the order could execute once funded.
            let live = msg.contains("insufficient balance or overflow");
            Ok((live, msg.chars().take(300).collect()))
        }
    }
}
