//! Full sandbox world with the mandate contract, labelled stub oracle/MPC and the actors.

use super::intents::{self, DecodedOrder};
use super::sandbox::{
    Base, MAX_GAS, ONE_YOCTO, TxOutcome, built_wasm, call, events, restricted_account, subaccount,
};
use anyhow::{Context, Result, anyhow, bail};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{Value, json};

pub const USDC_PRICE_ID: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
pub const NEAR_PRICE_ID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
pub const USDC: u128 = 1_000_000;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const GRANT_GAS: Gas = Gas::from_tgas(300);
pub const PROPOSE_GAS: Gas = Gas::from_tgas(150);
pub const STANDARD: &str = "bounded_mandate";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Usdc,
    Wnear,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Usdc => "usdc",
            Self::Wnear => "wnear",
        }
    }
}

pub struct WorldOpts {
    pub mandate_usdc: u128,
    pub mandate_wnear: u128,
    pub agent_allowance: NearToken,
    pub usdc_price: i64,
    pub near_price: i64,
    /// NEAR balance of the mandate account (pays its own storage).
    pub mandate_near: u128,
    /// Exact initial balance of the mandate account in yocto; overrides `mandate_near`.
    pub mandate_yocto: Option<u128>,
}

impl Default for WorldOpts {
    fn default() -> Self {
        Self {
            mandate_usdc: 10_000 * USDC,
            mandate_wnear: 3_000 * NEAR,
            agent_allowance: NearToken::from_near(2),
            usdc_price: 100_000_000,
            near_price: 300_000_000,
            mandate_near: 50,
            mandate_yocto: None,
        }
    }
}

pub struct World {
    pub b: Base,
    /// Controls the labelled stubs (oracle prices, MPC modes).
    pub ctl: Account,
    pub owner: Account,
    /// Signs only with its function-call key restricted to `propose_order` on the mandate.
    pub agent: Account,
    pub mandate: Contract,
    pub oracle: Contract,
    pub mpc: Contract,
}

pub fn demo_policy() -> Value {
    json!({
        "per_order_cap_bps": 2000, "outstanding_cap_bps": 2000, "max_concession_bps": 50,
        "oracle_max_age_sec": 60, "max_confidence_bps": 50, "breaker_drawdown_bps": 200,
        "turnover_cap_bps": 10000, "order_ttl_sec": 60, "min_remaining_sec": 15,
        "max_pricing_delay_sec": 30, "proposal_charge_bps": 50,
    })
}

impl World {
    pub async fn new(o: WorldOpts) -> Result<Self> {
        let b = Base::new(1_000_000 * USDC, 300_000 * NEAR).await?;
        let ctl = subaccount(&b.root, "ctl", 20).await?;
        let owner = subaccount(&b.root, "owner", 50).await?;
        let oracle = subaccount(&b.root, "oracle", 10)
            .await?
            .deploy(&built_wasm("mock_oracle")?)
            .await?
            .into_result()?;
        oracle
            .call("new")
            .args_json(json!({"owner_id": ctl.id()}))
            .transact()
            .await?
            .into_result()?;
        let mpc = subaccount(&b.root, "mpc", 10)
            .await?
            .deploy(&built_wasm("mock_mpc")?)
            .await?
            .into_result()?;
        mpc.call("new")
            .args_json(json!({"owner_id": ctl.id()}))
            .transact()
            .await?
            .into_result()?;
        let mandate_acct = match o.mandate_yocto {
            Some(y) => b
                .root
                .create_subaccount("mandate")
                .initial_balance(NearToken::from_yoctonear(y))
                .transact()
                .await?
                .into_result()?,
            None => subaccount(&b.root, "mandate", o.mandate_near).await?,
        };
        let mandate = mandate_acct
            .deploy(&built_wasm("bounded_mandate")?)
            .await?
            .into_result()?;
        let agent_id: AccountId = format!("agent.{}", b.root.id()).parse()?;
        mandate
            .call("new")
            .args_json(json!({"config": {
                "owner_id": owner.id(),
                "agent_id": agent_id,
                "verifier_id": b.verifier.id(),
                "signer_id": mpc.id(),
                "oracle_id": oracle.id(),
                "usdc": {"token": b.usdc.id(), "decimals": 6, "price_id": USDC_PRICE_ID},
                "wnear": {"token": b.wnear.id(), "decimals": 24, "price_id": NEAR_PRICE_ID},
            }}))
            .transact()
            .await?
            .into_result()?;
        let agent = restricted_account(
            &b.root,
            &b.worker,
            "agent",
            mandate.id(),
            &["propose_order"],
            o.agent_allowance,
        )
        .await?;
        let w = Self {
            b,
            ctl,
            owner,
            agent,
            mandate,
            oracle,
            mpc,
        };
        w.b.fund_intents_for(&w.owner, w.mandate.id(), o.mandate_usdc, o.mandate_wnear)
            .await?;
        w.set_prices_now(o.usdc_price, o.near_price).await?;
        Ok(w)
    }

    // ------------------------------------------------------------ stub controls

    pub async fn set_price(
        &self,
        side: Side,
        price: i64,
        conf: u64,
        publish_time: i64,
    ) -> Result<()> {
        let id = match side {
            Side::Usdc => USDC_PRICE_ID,
            Side::Wnear => NEAR_PRICE_ID,
        };
        self.ctl
            .call(self.oracle.id(), "set_price")
            .args_json(json!({"price_id": id, "price": price.to_string(), "conf": conf.to_string(), "expo": -8, "publish_time": publish_time}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn now_s(&self) -> Result<i64> {
        Ok(i64::try_from(self.b.now_ns().await? / 1_000_000_000)?)
    }

    /// Fresh prices with confidence 0.02% (well inside the 0.5% policy bound).
    pub async fn set_prices_now(&self, usdc: i64, near: i64) -> Result<()> {
        let t = self.now_s().await?;
        self.set_price(Side::Usdc, usdc, (usdc / 5_000) as u64, t)
            .await?;
        self.set_price(Side::Wnear, near, (near / 5_000) as u64, t)
            .await
    }

    pub async fn oracle_ctl(&self, method: &str, args: Value) -> Result<()> {
        self.ctl
            .call(self.oracle.id(), method)
            .args_json(args)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn mpc_mode(&self, mode: &str) -> Result<()> {
        self.ctl
            .call(self.mpc.id(), "set_mode")
            .args_json(json!({"mode": mode}))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn mpc_pending(&self) -> Result<Vec<Value>> {
        Ok(self.mpc.view("list_pending").await?.json()?)
    }

    pub async fn mpc_respond(&self, request_id: u64, response: &str) -> Result<TxOutcome> {
        Ok(call(
            &self.ctl,
            self.mpc.id(),
            "respond",
            json!({"request_id": request_id, "response": response}),
            NearToken::from_yoctonear(0),
            MAX_GAS,
        )
        .await)
    }

    pub async fn mpc_disclosed(&self, request_id: u64) -> Result<Option<Vec<u8>>> {
        let v: Value = self
            .mpc
            .view("get_disclosed_signature")
            .args_json(json!({"request_id": request_id}))
            .await?
            .json()?;
        Ok(v.get("signature").and_then(Value::as_array).map(|a| {
            a.iter()
                .map(|x| u8::try_from(x.as_u64().unwrap_or(0)).unwrap_or(0))
                .collect()
        }))
    }

    pub async fn derived_key(&self, path: &str) -> Result<String> {
        Ok(self
            .mpc
            .view("derived_public_key")
            .args_json(json!({"path": path, "predecessor": self.mandate.id(), "domain_id": 1}))
            .await?
            .json()?)
    }

    // ------------------------------------------------------------ mandate actions

    /// Detached receipts (registration, removal) can still be in flight when the owner's
    /// transaction outcome returns; poll until no key operation is pending (bounded).
    pub async fn settle_key_ops(&self) -> Result<Value> {
        for _ in 0..100 {
            let g = self.grant_view().await?;
            if g.is_null() || g["key_op_in_flight"] == false {
                return Ok(g);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        self.grant_view().await
    }

    pub async fn grant(&self, policy: Value) -> TxOutcome {
        let out = call(
            &self.owner,
            self.mandate.id(),
            "grant",
            json!({"policy": policy}),
            NearToken::from_yoctonear(0),
            GRANT_GAS,
        )
        .await;
        let _ = self.settle_key_ops().await;
        out
    }

    pub async fn grant_ok(&self, policy: Value) -> Result<Value> {
        let out = self.grant(policy).await;
        let g = self.grant_view().await?;
        if g["status"] != "active" {
            bail!("grant not active: {g} / {}", out.failure_text());
        }
        Ok(g)
    }

    pub async fn revoke(&self, gas_tgas: Option<u64>) -> TxOutcome {
        let out = call(
            &self.owner,
            self.mandate.id(),
            "revoke",
            json!({"gas_tgas": gas_tgas}),
            NearToken::from_yoctonear(0),
            MAX_GAS,
        )
        .await;
        let _ = self.settle_key_ops().await;
        out
    }

    pub async fn recover(&self, asset: Side, gas_tgas: Option<u64>) -> TxOutcome {
        call(
            &self.owner,
            self.mandate.id(),
            "recover",
            json!({"asset": asset.as_str(), "gas_tgas": gas_tgas}),
            NearToken::from_yoctonear(0),
            MAX_GAS,
        )
        .await
    }

    pub async fn propose_as(
        &self,
        who: &Account,
        sell: Side,
        amount: u128,
        concession: u16,
    ) -> TxOutcome {
        call(
            who,
            self.mandate.id(),
            "propose_order",
            json!({"proposal": {"sell": sell.as_str(), "sell_amount": amount.to_string(), "max_concession_bps": concession}}),
            NearToken::from_yoctonear(0),
            PROPOSE_GAS,
        )
        .await
    }

    pub async fn propose(&self, sell: Side, amount: u128, concession: u16) -> TxOutcome {
        self.propose_as(&self.agent, sell, amount, concession).await
    }

    /// Proposes and returns the order id with the full outcome.
    pub async fn propose_id(
        &self,
        sell: Side,
        amount: u128,
        concession: u16,
    ) -> Result<(u64, TxOutcome)> {
        let out = self.propose(sell, amount, concession).await;
        let id: String = out
            .json()
            .with_context(|| format!("propose failed: {}", out.failure_text()))?;
        Ok((id.parse()?, out))
    }

    pub async fn settle(&self, who: &Account, order_id: u64) -> TxOutcome {
        call(
            who,
            self.mandate.id(),
            "settle_order",
            json!({"order_id": order_id.to_string()}),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(100),
        )
        .await
    }

    pub async fn expire(&self, who: &Account, order_id: u64) -> TxOutcome {
        call(
            who,
            self.mandate.id(),
            "expire_order",
            json!({"order_id": order_id.to_string()}),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(100),
        )
        .await
    }

    // ------------------------------------------------------------ views

    pub async fn grant_view(&self) -> Result<Value> {
        Ok(self.mandate.view("get_grant").await?.json()?)
    }

    pub async fn order(&self, id: u64) -> Result<Value> {
        let v: Value = self
            .mandate
            .view("get_order")
            .args_json(json!({"order_id": id.to_string()}))
            .await?
            .json()?;
        if v.is_null() {
            bail!("no order {id}");
        }
        Ok(v)
    }

    pub async fn orders(&self) -> Result<Vec<Value>> {
        let mut all = Vec::new();
        loop {
            let page: Vec<Value> = self
                .mandate
                .view("list_orders")
                .args_json(json!({"from_index": all.len().to_string(), "limit": 100}))
                .await?
                .json()?;
            if page.is_empty() {
                break;
            }
            all.extend(page);
        }
        Ok(all)
    }

    pub async fn recovery(&self) -> Result<Value> {
        Ok(self.mandate.view("get_recovery").await?.json()?)
    }

    pub async fn balances(&self) -> Result<(u128, u128)> {
        self.b.balances(self.mandate.id()).await
    }

    // ------------------------------------------------------------ signed orders

    /// The complete MultiPayload published in this outcome's `order_signed` event.
    pub fn signed_event(out: &TxOutcome, order_id: u64) -> Option<Value> {
        events(&out.logs(), STANDARD)
            .into_iter()
            .find(|e| {
                e["event"] == "order_signed" && e["data"]["order_id"] == json!(order_id.to_string())
            })
            .and_then(|e| {
                let mp = &e["data"]["multi_payload"];
                match mp {
                    Value::String(s) => serde_json::from_str(s).ok(),
                    v @ Value::Object(_) => Some(v.clone()),
                    _ => None,
                }
            })
    }

    /// Rebuilds a MultiPayload from the order's recorded payload and a signature obtained
    /// elsewhere (e.g. disclosed by the MPC), without using the mandate's own publication.
    pub async fn multipayload_from(&self, order: &Value, signature: &[u8]) -> Result<Value> {
        let p = &order["payload"];
        let payload = intents::Nep413Payload {
            message: p["message"].as_str().context("message")?.to_owned(),
            nonce: intents::unb64(p["nonce"].as_str().context("nonce")?)
                .try_into()
                .map_err(|_| anyhow!("nonce length"))?,
            recipient: p["recipient"].as_str().context("recipient")?.to_owned(),
            callback_url: None,
        };
        let g = self.grant_view().await?;
        let path = format!("mandate/v1/{}", order["epoch"]);
        let pk_str = if g["epoch"] == order["epoch"] && g["public_key"].is_string() {
            g["public_key"].as_str().unwrap_or_default().to_owned()
        } else {
            self.derived_key(&path).await?
        };
        let pk: [u8; 32] = intents::parse_ed25519_str(&pk_str)
            .try_into()
            .map_err(|_| anyhow!("pk"))?;
        let sig: [u8; 64] = signature
            .try_into()
            .map_err(|_| anyhow!("signature length"))?;
        Ok(intents::multipayload(&payload, &pk, &sig))
    }

    /// Relays `order` (a MultiPayload) with the filler's counter-intent from the unrelated relayer.
    pub async fn relay(&self, order: &Value, salt_random: u8) -> Result<(TxOutcome, DecodedOrder)> {
        super::sandbox::fill(
            &self.b.verifier,
            &self.b.relayer,
            &self.b.filler,
            &self.b.filler_key,
            order,
            [salt_random; 15],
        )
        .await
    }

    pub async fn has_grant_key(&self, pk: &str) -> Result<bool> {
        self.b.verifier.has_public_key(self.mandate.id(), pk).await
    }

    pub async fn dao(&self, method: &str, args: Value) -> TxOutcome {
        self.b.verifier.dao(&self.b.dao, method, args).await
    }

    pub fn one_yocto() -> NearToken {
        ONE_YOCTO
    }
}

pub fn order_state(o: &Value) -> String {
    let s = &o["state"];
    match s["state"].as_str() {
        Some("released") => format!("released:{}", s["reason"].as_str().unwrap_or("?")),
        Some(x) => x.to_owned(),
        None => s.to_string(),
    }
}

pub fn u(v: &Value) -> u128 {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| v.as_u64().map(u128::from))
        .unwrap_or_default()
}

impl World {
    /// Submits a proposal without waiting for its receipts (e.g. while the MPC holds).
    pub async fn propose_async(
        &self,
        sell: Side,
        amount: u128,
        concession: u16,
    ) -> Result<near_workspaces::operations::TransactionStatus> {
        Ok(self
            .agent
            .call(self.mandate.id(), "propose_order")
            .args_json(json!({"proposal": {"sell": sell.as_str(), "sell_amount": amount.to_string(), "max_concession_bps": concession}}))
            .gas(PROPOSE_GAS)
            .transact_async()
            .await?)
    }

    pub async fn grant_async(
        &self,
        policy: Value,
    ) -> Result<near_workspaces::operations::TransactionStatus> {
        Ok(self
            .owner
            .call(self.mandate.id(), "grant")
            .args_json(json!({"policy": policy}))
            .gas(GRANT_GAS)
            .transact_async()
            .await?)
    }

    /// Polls until `pred` holds on the grant view (or the attempts run out).
    pub async fn wait_grant(
        &self,
        pred: impl Fn(&Value) -> bool,
        attempts: usize,
    ) -> Result<Value> {
        for _ in 0..attempts {
            let g = self.grant_view().await?;
            if pred(&g) {
                return Ok(g);
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        bail!("grant condition not reached: {}", self.grant_view().await?)
    }

    pub async fn wait_pending_sign(&self, attempts: usize) -> Result<Value> {
        for _ in 0..attempts {
            if let Some(p) = self.mpc_pending().await?.into_iter().next() {
                return Ok(p);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        bail!("no pending MPC request")
    }

    pub async fn nonce_used(&self, order: &Value) -> Result<bool> {
        let n: [u8; 32] = intents::unb64(order["payload"]["nonce"].as_str().context("nonce")?)
            .try_into()
            .map_err(|_| anyhow!("nonce"))?;
        self.b.verifier.is_nonce_used(self.mandate.id(), &n).await
    }
}

impl World {
    /// Polls an order until its state differs from `from` (receipts after a yield resume land
    /// in later blocks than the resuming transaction's outcome).
    pub async fn wait_order_leaves(&self, id: u64, from: &str, attempts: usize) -> Result<Value> {
        for _ in 0..attempts {
            let o = self.order(id).await?;
            if order_state(&o) != from {
                return Ok(o);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        self.order(id).await
    }
}

impl World {
    /// The published MultiPayload for `id`: from the outcome's `order_signed` event, or, when the
    /// signing receipts landed after the outcome returned, from the order's recorded signature.
    pub async fn signed_payload(&self, out: &TxOutcome, id: u64) -> Result<Option<Value>> {
        if let Some(mp) = Self::signed_event(out, id) {
            return Ok(Some(mp));
        }
        let o = self.wait_order_leaves(id, "pricing", 30).await?;
        let o = if order_state(&o) == "signing" {
            self.wait_order_leaves(id, "signing", 30).await?
        } else {
            o
        };
        let Some(sig) = o["signature"].as_str() else {
            return Ok(None);
        };
        Ok(Some(
            self.multipayload_from(&o, &intents::parse_ed25519_str(sig))
                .await?,
        ))
    }
}
