//! gate: T2
//!
//! Seeded randomized interleavings of the REAL mandate contract code (near-sdk unit-testing VM)
//! against an independent world model of the verifier, MPC signer and oracle. The driver reacts
//! only to the receipts the contract actually creates; each external call is executed by the model
//! at a randomly chosen later point, and callbacks are delivered (or lost, or replayed) in random
//! order. Every transaction runs on a storage snapshot and is discarded if it panics, as the
//! runtime would. Invariants are derived from SPEC.md, with caps recomputed from the values the
//! model itself returned.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use bounded_mandate::Mandate;
use bounded_mandate::types::{
    Asset, AssetConfig, GrantStatus, GrantView, MandateConfig, OrderState, OrderView, Policy,
    Proposal, ReleaseReason,
};
use common::intents::{self as wire, Nep413Payload};
use common::valuation::{Px, bps_floor, concession_within, value_units};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::{U64, U128};
use near_sdk::mock::{MockAction, MockedBlockchain, Receipt};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
use near_sdk::{AccountId, Gas, env};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::panic::{AssertUnwindSafe, catch_unwind};

/// Clonable promise result; converted to near-sdk's at delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PromiseResult {
    Successful(Vec<u8>),
    Failed,
}

impl From<PromiseResult> for near_sdk::PromiseResult {
    fn from(r: PromiseResult) -> Self {
        match r {
            PromiseResult::Successful(b) => Self::Successful(b),
            PromiseResult::Failed => Self::Failed,
        }
    }
}

thread_local! {
    static CACHE: std::cell::RefCell<Option<Box<dyn std::any::Any>>> = const { std::cell::RefCell::new(None) };
    static QUIET: Cell<bool> = const { Cell::new(false) };
}

/// `test_vm_config` rebuilds the runtime config store on every call; build it once per thread.
fn cached<T: Clone + 'static>(f: fn() -> T) -> T {
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        c.get_or_insert_with(|| Box::new(f()))
            .downcast_ref::<T>()
            .expect("one cached type")
            .clone()
    })
}

fn install_quiet_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if !QUIET.with(Cell::get) {
            default(info);
        }
    }));
}

const SEEDS: u64 = 220;
const STEPS: usize = 250;
const T0_NS: u64 = 1_793_700_000_000_000_000;
const USDC_PRICE_ID: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
const NEAR_PRICE_ID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

#[derive(Clone, Debug)]
struct PriceState {
    price: i64,
    conf: u64,
    expo: i32,
    publish_time: i64,
}

#[derive(Clone, Debug)]
struct ExtCall {
    receiver: AccountId,
    method: String,
    args: Value,
    deposit: u128,
    gas: u64,
    result: Option<PromiseResult>,
    /// For oracle/balance/salt reads: the values returned, for independent recomputation.
    returned: Option<Value>,
}

#[derive(Clone, Debug)]
struct Callback {
    method: String,
    args: Value,
    deps: Vec<usize>,
    delivered: bool,
    dropped: bool,
    /// Results used at first delivery, for identical replays.
    results: Option<Vec<PromiseResult>>,
}

#[derive(Clone, Debug)]
struct Disclosed {
    path: String,
    hash: [u8; 32],
    sig: [u8; 64],
}

#[derive(Default, Clone, Debug, serde::Serialize)]
struct Stats {
    steps: usize,
    txs_ok: usize,
    txs_panicked: usize,
    proposals_ok: usize,
    grants: usize,
    revokes_ok: usize,
    sign_requests: usize,
    signatures_disclosed: usize,
    fills: usize,
    fills_while_revoking: usize,
    callbacks_delivered: usize,
    callbacks_dropped: usize,
    duplicate_replays: usize,
    stale_epoch_deliveries: usize,
    releases: BTreeMap<String, usize>,
    rejections: usize,
    settle_true_deliveries: usize,
    breaker_trips: usize,
    removal_failures_induced: usize,
    panic_reasons: BTreeMap<String, usize>,
}

struct GrantRecord {
    my_initial: u128,
    init_usdc: Px,
    init_wnear: Px,
    policy: Policy,
    path: String,
}

/// Deliberately wrong external behavior, used only to show the checker detects unsafe outcomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sabotage {
    None,
    /// The verifier reports removal success but keeps the key.
    LyingRemoval,
    /// The verifier reports every nonce as used.
    LyingNonce,
}

struct Sim {
    sabotage: Sabotage,
    rng: ChaCha8Rng,
    seed: u64,
    storage: HashMap<Vec<u8>, Vec<u8>>,
    now: u64,
    cfg: MandateConfig,
    mandate: AccountId,
    // world model
    keys: BTreeSet<String>,
    used_nonces: BTreeSet<[u8; 32]>,
    bal: [u128; 2],
    owner_bal: [u128; 2],
    salt: [u8; 4],
    valid_salts: BTreeSet<[u8; 4]>,
    px: [Option<PriceState>; 2],
    oracle_fail: bool,
    auth_disabled: bool,
    disclosed: Vec<Disclosed>,
    paths_seen: BTreeSet<String>,
    // receipts
    calls: Vec<ExtCall>,
    callbacks: Vec<Callback>,
    // bookkeeping
    grants: BTreeMap<u64, GrantRecord>,
    /// Order id -> sign call index; an order with a sign call has issued authority.
    sign_calls: BTreeMap<u64, usize>,
    /// Order id -> my conservative value at signing.
    signed_value: BTreeMap<u64, u128>,
    prev_grant: Option<GrantView>,
    prev_orders: BTreeMap<u64, OrderView>,
    stats: Stats,
    violations: Vec<String>,
    log: Vec<String>,
}

fn path_key(seed: u64, path: &str) -> SigningKey {
    let h: [u8; 32] = Sha256::digest(format!("t2-model-mpc:{seed}:{path}")).into();
    SigningKey::from_bytes(&h)
}

fn px_of(p: &near_sdk::serde_json::Value) -> Px {
    Px {
        mantissa: p["price"].as_str().unwrap().parse().unwrap(),
        expo: i32::try_from(p["expo"].as_i64().unwrap()).unwrap(),
    }
}

fn obs_px(o: &bounded_mandate::types::PriceObservation) -> Px {
    Px {
        mantissa: o.price.0,
        expo: o.expo,
    }
}

impl Sim {
    fn new(seed: u64) -> Self {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let cfg = MandateConfig {
            owner_id: acc("owner.test.near"),
            agent_id: acc("agent.test.near"),
            verifier_id: acc("intents.test.near"),
            signer_id: acc("mpc.test.near"),
            oracle_id: acc("oracle.test.near"),
            usdc: AssetConfig {
                token: acc("usdc.test.near"),
                decimals: 6,
                price_id: USDC_PRICE_ID.into(),
            },
            wnear: AssetConfig {
                token: acc("wnear.test.near"),
                decimals: 24,
                price_id: NEAR_PRICE_ID.into(),
            },
        };
        let usdc = rng.random_range(2_000u128..20_000) * 1_000_000;
        let wnear = rng.random_range(500u128..6_000) * 10u128.pow(24);
        let salt = rng.random::<[u8; 4]>();
        let mut s = Self {
            sabotage: Sabotage::None,
            rng,
            seed,
            storage: HashMap::new(),
            now: T0_NS,
            mandate: acc("mandate.test.near"),
            cfg,
            keys: BTreeSet::new(),
            used_nonces: BTreeSet::new(),
            bal: [usdc, wnear],
            owner_bal: [0, 0],
            salt,
            valid_salts: BTreeSet::from([salt]),
            px: [
                Some(PriceState {
                    price: 99_990_000,
                    conf: 40_000,
                    expo: -8,
                    publish_time: (T0_NS / 1_000_000_000) as i64,
                }),
                Some(PriceState {
                    price: 300_000_000,
                    conf: 300_000,
                    expo: -8,
                    publish_time: (T0_NS / 1_000_000_000) as i64,
                }),
            ],
            oracle_fail: false,
            auth_disabled: false,
            disclosed: Vec::new(),
            paths_seen: BTreeSet::new(),
            calls: Vec::new(),
            callbacks: Vec::new(),
            grants: BTreeMap::new(),
            sign_calls: BTreeMap::new(),
            signed_value: BTreeMap::new(),
            prev_grant: None,
            prev_orders: BTreeMap::new(),
            stats: Stats::default(),
            violations: Vec::new(),
            log: Vec::new(),
        };
        let cfg = s.cfg.clone();
        s.raw_tx(&acc("deployer.test.near"), vec![], move |_| {
            env::state_write(&Mandate::new(cfg));
        })
        .expect("init");
        s
    }

    fn violation(&mut self, msg: String) {
        if self.violations.is_empty() {
            self.log.push(format!("VIOLATION: {msg}"));
        }
        self.violations.push(msg);
    }

    fn set_env(&mut self, predecessor: &AccountId, results: Vec<PromiseResult>, view: bool) {
        let seed: [u8; 32] = self.rng.random();
        let ctx = VMContextBuilder::new()
            .current_account_id(self.mandate.clone())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor.clone())
            .block_timestamp(self.now)
            .prepaid_gas(Gas::from_tgas(300))
            .random_seed(seed)
            .is_view(view)
            .build();
        env::set_blockchain_interface(MockedBlockchain::new(
            ctx,
            cached(near_sdk::test_vm_config),
            near_sdk::RuntimeFeesConfig::test(),
            results.into_iter().map(Into::into).collect(),
            self.storage.clone(),
            Default::default(),
            None,
        ));
    }

    /// Runs `f` as one receipt; commits storage only on success.
    fn raw_tx<R>(
        &mut self,
        predecessor: &AccountId,
        results: Vec<PromiseResult>,
        f: impl FnOnce(Option<Mandate>) -> R,
    ) -> Result<(R, Vec<Receipt>), String> {
        self.set_env(predecessor, results, false);
        QUIET.with(|q| q.set(true));
        let out = catch_unwind(AssertUnwindSafe(|| f(env::state_read::<Mandate>())));
        QUIET.with(|q| q.set(false));
        match out {
            Ok(r) => {
                let receipts = get_created_receipts();
                self.storage = near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
                Ok((r, receipts))
            }
            Err(e) => Err(e
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                .unwrap_or_default()),
        }
    }

    fn tx<R>(
        &mut self,
        predecessor: &AccountId,
        results: Vec<PromiseResult>,
        label: &str,
        f: impl FnOnce(&mut Mandate) -> R,
    ) -> Result<R, String> {
        let r = self.raw_tx(predecessor, results, |m| {
            let mut m = m.expect("state");
            let r = f(&mut m);
            env::state_write(&m);
            r
        });
        match r {
            Ok((r, receipts)) => {
                self.stats.txs_ok += 1;
                self.log.push(format!("t={} ok {label}", self.now));
                self.ingest(receipts);
                self.check(label);
                Ok(r)
            }
            Err(e) => {
                self.stats.txs_panicked += 1;
                let key = format!(
                    "{}: {}",
                    label.split([' ', '(']).next().unwrap_or(""),
                    e.chars().take(200).collect::<String>()
                );
                *self.stats.panic_reasons.entry(key).or_default() += 1;
                self.log.push(format!("t={} panic {label}: {e}", self.now));
                Err(e)
            }
        }
    }

    fn snapshot(&mut self) -> (Option<GrantView>, BTreeMap<u64, OrderView>) {
        self.set_env(&self.mandate.clone(), vec![], true);
        let m = env::state_read::<Mandate>().expect("state");
        let g = m.get_grant();
        let mut orders = BTreeMap::new();
        let mut from = 0u64;
        loop {
            let page = m.list_orders(Some(U64(from)), Some(100));
            if page.is_empty() {
                break;
            }
            for o in page {
                from = o.id.0 + 1;
                orders.insert(o.id.0, o);
            }
        }
        std::mem::forget(m);
        (g, orders)
    }

    /// Parses receipts created by a contract execution into model calls and pending callbacks.
    fn ingest(&mut self, receipts: Vec<Receipt>) {
        // Receipt indices are positions in the mocked action log.
        let mut index_map: HashMap<u64, usize> = HashMap::new();
        for r in receipts {
            let mut fc = None;
            for a in &r.actions {
                match a {
                    MockAction::FunctionCallWeight {
                        receipt_index,
                        method_name,
                        args,
                        attached_deposit,
                        prepaid_gas,
                        ..
                    } => {
                        fc = Some((
                            *receipt_index,
                            String::from_utf8(method_name.clone()).unwrap(),
                            serde_json::from_slice::<Value>(args).unwrap_or(Value::Null),
                            attached_deposit.as_yoctonear(),
                            prepaid_gas.as_gas(),
                        ))
                    }
                    MockAction::CreateReceipt { .. } => {}
                    other => self.violation(format!("unexpected action {other:?}")),
                }
            }
            let Some((ridx, method, args, deposit, gas)) = fc else {
                self.violation(format!(
                    "receipt without a function call to {}",
                    r.receiver_id
                ));
                continue;
            };
            if r.receiver_id == self.mandate {
                let deps: Vec<usize> = r
                    .receipt_indices
                    .iter()
                    .map(|i| *index_map.get(i).expect("dependency is an external call"))
                    .collect();
                self.callbacks.push(Callback {
                    method,
                    args,
                    deps,
                    delivered: false,
                    dropped: false,
                    results: None,
                });
            } else {
                self.check_ext_target(&r.receiver_id, &method, &args, deposit);
                if method == "sign" {
                    self.on_sign_issued(self.calls.len(), &args);
                }
                index_map.insert(ridx, self.calls.len());
                self.calls.push(ExtCall {
                    receiver: r.receiver_id.clone(),
                    method,
                    args,
                    deposit,
                    gas,
                    result: None,
                    returned: None,
                });
            }
        }
    }

    fn check_ext_target(&mut self, to: &AccountId, method: &str, args: &Value, deposit: u128) {
        let c = &self.cfg;
        let ok = match method {
            "derived_public_key" | "sign" => *to == c.signer_id,
            "get_price_no_older_than" => *to == c.oracle_id,
            "mt_balance_of"
            | "mt_batch_balance_of"
            | "current_salt"
            | "has_public_key"
            | "is_nonce_used"
            | "add_public_key"
            | "remove_public_key" => *to == c.verifier_id,
            "mt_transfer" => *to == c.verifier_id && args["receiver_id"] == json!(c.owner_id),
            _ => false,
        };
        if !ok {
            self.violation(format!("forbidden external call {to}.{method}({args})"));
        }
        let needs_yocto = matches!(
            method,
            "add_public_key" | "remove_public_key" | "mt_transfer" | "sign"
        );
        if needs_yocto && deposit != 1 {
            self.violation(format!(
                "{method} attached {deposit} yocto, expected exactly 1"
            ));
        }
        for k in ["account_id", "predecessor"] {
            if let Some(a) = args.get(k)
                && !a.is_null()
                && *a != json!(self.mandate)
            {
                self.violation(format!("{method} for foreign account {a}"));
            }
        }
    }

    /// Validates a newly issued sign request against the recorded order, independently.
    fn on_sign_issued(&mut self, call_idx: usize, args: &Value) {
        self.stats.sign_requests += 1;
        let req = &args["request"];
        let path = req["path"].as_str().unwrap_or_default().to_owned();
        let hex_payload = req["payload_v2"]["Eddsa"].as_str().unwrap_or_default();
        let bytes = hex::decode(hex_payload).unwrap_or_default();
        if req["domain_id"] != json!(1) {
            self.violation(format!("sign domain {}", req["domain_id"]));
        }
        let (g, orders) = self.snapshot();
        let Some(g) = g else {
            self.violation("sign without grant".into());
            return;
        };
        if path != g.path {
            self.violation(format!("sign path {path} != grant path {}", g.path));
        }
        let Some(o) = orders
            .values()
            .find(|o| o.payload_hash.as_deref() == Some(hex_payload))
        else {
            self.violation(format!(
                "MPC asked to sign bytes {hex_payload} matching no order"
            ));
            return;
        };
        let o = o.clone();
        if self.sign_calls.insert(o.id.0, call_idx).is_some() {
            self.violation(format!("second sign request for order {}", o.id.0));
        }
        // Spec: only an active grant authorizes; no authorization at/after the breaker.
        if self.prev_grant.as_ref().map(|p| p.status) != Some(GrantStatus::Active)
            || g.status != GrantStatus::Active
        {
            self.violation(format!("sign issued while grant {:?}", g.status));
        }
        let p = o.payload.clone().expect("payload");
        let payload = Nep413Payload {
            message: p.message.clone(),
            nonce: p.nonce.0.clone().try_into().expect("32-byte nonce"),
            recipient: p.recipient.to_string(),
            callback_url: None,
        };
        if wire::nep413_prehash(&payload).to_vec() != bytes {
            self.violation(format!("order {} prehash mismatch", o.id.0));
        }
        let multi = wire::multipayload(&payload, &[0; 32], &[0; 64]);
        let d = wire::DecodedOrder::from_multipayload(&multi);
        let (sell_cfg, buy_cfg, si, bi) = match o.sell {
            Asset::Usdc => (&self.cfg.usdc, &self.cfg.wnear, 0, 1),
            Asset::Wnear => (&self.cfg.wnear, &self.cfg.usdc, 1, 0),
        };
        let buy = o.buy_amount.map(|b| b.0).unwrap_or_default();
        let expected = vec![
            (
                wire::token_id(sell_cfg.token.as_str()),
                -(o.sell_amount.0 as i128),
            ),
            (wire::token_id(buy_cfg.token.as_str()), buy as i128),
        ];
        let mut got = d.diff.clone();
        got.sort();
        let mut exp = expected.clone();
        exp.sort();
        if got != exp
            || d.signer_id != self.mandate.as_str()
            || payload.recipient != self.cfg.verifier_id.as_str()
        {
            self.violation(format!(
                "order {} signs unexpected content: {}",
                o.id.0, payload.message
            ));
        }
        let deadline = o.deadline_ns.map(|d| d.0).unwrap_or_default();
        if d.deadline_ns != deadline {
            self.violation(format!("order {} message deadline != recorded", o.id.0));
        }
        if d.nonce_deadline_ns.map(|n| n as u64) != Some(deadline)
            || d.nonce_salt != Some(self.salt_returned_for(o.id.0))
        {
            self.violation(format!("order {} nonce not bound to deadline/salt", o.id.0));
        }
        let r = o.reference.clone().expect("reference");
        let returned = self.prices_returned_for(o.id.0);
        let (up, wp) = (obs_px(&r.usdc), obs_px(&r.wnear));
        if returned != Some((up, wp)) {
            self.violation(format!(
                "order {} reference differs from returned prices",
                o.id.0
            ));
        }
        let pol = g.policy;
        let oldest = r.usdc.publish_time_sec.0.min(r.wnear.publish_time_sec.0);
        let now = self.now;
        if deadline > now + u64::from(pol.order_ttl_sec) * 1_000_000_000
            || deadline > (oldest + u64::from(pol.oracle_max_age_sec)) * 1_000_000_000
            || deadline < now + u64::from(pol.min_remaining_sec) * 1_000_000_000
        {
            self.violation(format!(
                "order {} deadline {deadline} outside policy at {now}",
                o.id.0
            ));
        }
        for obs in [&r.usdc, &r.wnear] {
            let age = (now / 1_000_000_000).saturating_sub(obs.publish_time_sec.0);
            if age > u64::from(pol.oracle_max_age_sec)
                || u128::from(obs.conf.0) * 10_000
                    > u128::from(obs.price.0) * u128::from(pol.max_confidence_bps)
                || obs.price.0 == 0
            {
                self.violation(format!(
                    "order {} authorized on stale/low-confidence price",
                    o.id.0
                ));
            }
        }
        let pxs = [up, wp];
        let decs = [self.cfg.usdc.decimals, self.cfg.wnear.decimals];
        if !concession_within(
            o.sell_amount.0,
            decs[si],
            pxs[si],
            buy,
            decs[bi],
            pxs[bi],
            u128::from(o.concession_bps.min(pol.max_concession_bps)),
        ) {
            self.violation(format!(
                "order {} concession above limit at its reference",
                o.id.0
            ));
        }
        // Breaker: holdings observed at this authorization must exceed (1 - drawdown) * initial.
        let (my_initial, init_usdc, init_wnear) = {
            let r = &self.grants[&g.epoch];
            (r.my_initial, r.init_usdc, r.init_wnear)
        };
        if let Some(bals) = self.balances_returned_for(o.id.0) {
            let hold =
                value_units(bals[0], decs[0], up, false) + value_units(bals[1], decs[1], wp, false);
            if hold * 10_000 <= my_initial * (10_000 - u128::from(pol.breaker_drawdown_bps)) {
                self.violation(format!(
                    "order {} signed after observing breaker drawdown",
                    o.id.0
                ));
            }
        }
        let v_init = value_units(o.sell_amount.0, decs[si], [init_usdc, init_wnear][si], true);
        let v_now = value_units(o.sell_amount.0, decs[si], pxs[si], true);
        self.signed_value.insert(o.id.0, v_init.max(v_now));
    }

    fn priced_callback_results(&self, order_id: u64) -> Option<&Callback> {
        self.callbacks.iter().find(|c| {
            c.method == "on_order_priced"
                && c.args["order_id"] == json!(order_id.to_string())
                && c.delivered
        })
    }

    fn returned_by(&self, order_id: u64, method: &str) -> Vec<Value> {
        self.priced_callback_results(order_id)
            .map(|c| {
                c.deps
                    .iter()
                    .filter(|d| self.calls[**d].method == method)
                    .filter_map(|d| self.calls[*d].returned.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn prices_returned_for(&self, order_id: u64) -> Option<(Px, Px)> {
        let cb = self.priced_callback_results(order_id)?;
        let mut u = None;
        let mut w = None;
        for d in &cb.deps {
            let c = &self.calls[*d];
            if c.method == "get_price_no_older_than" {
                let v = c.returned.clone()?;
                if v.is_null() {
                    return None;
                }
                if c.args["price_id"] == json!(USDC_PRICE_ID) {
                    u = Some(px_of(&v));
                } else {
                    w = Some(px_of(&v));
                }
            }
        }
        Some((u?, w?))
    }

    fn salt_returned_for(&self, order_id: u64) -> [u8; 4] {
        self.returned_by(order_id, "current_salt")
            .first()
            .and_then(|v| v.as_str().and_then(|s| hex::decode(s).ok()))
            .and_then(|b| b.try_into().ok())
            .unwrap_or_default()
    }

    fn balances_returned_for(&self, order_id: u64) -> Option<[u128; 2]> {
        let cb = self.priced_callback_results(order_id)?;
        balances_from(self, &cb.deps)
    }

    // ------------------------------------------------------------------ model execution

    fn exec_call(&mut self, i: usize) {
        let c = self.calls[i].clone();
        let now_s = (self.now / 1_000_000_000) as i64;
        let ok = |v: Value| PromiseResult::Successful(serde_json::to_vec(&v).unwrap());
        let void = PromiseResult::Successful(vec![]);
        let (res, returned) = match c.method.as_str() {
            "derived_public_key" => {
                let path = c.args["path"].as_str().unwrap().to_owned();
                if !self.paths_seen.insert(path.clone()) {
                    self.violation(format!("derivation path {path} reused"));
                }
                let pk = path_key(self.seed, &path).verifying_key().to_bytes();
                (ok(json!(wire::ed25519_str(&pk))), None)
            }
            "get_price_no_older_than" => {
                let idx = usize::from(c.args["price_id"] != json!(USDC_PRICE_ID));
                let age = c.args["age"].as_i64().unwrap_or(0);
                if self.oracle_fail {
                    (PromiseResult::Failed, None)
                } else {
                    let v = self.px[idx]
                        .as_ref()
                        .filter(|p| now_s - p.publish_time <= age)
                        .map_or(Value::Null, |p| {
                            json!({"price": p.price.to_string(), "conf": p.conf.to_string(), "expo": p.expo, "publish_time": p.publish_time})
                        });
                    (ok(v.clone()), Some(v))
                }
            }
            "mt_balance_of" => {
                let idx = usize::from(
                    c.args["token_id"] != json!(wire::token_id(self.cfg.usdc.token.as_str())),
                );
                let v = json!(self.bal[idx].to_string());
                (ok(v.clone()), Some(v))
            }
            "mt_batch_balance_of" => {
                let v = json!(
                    c.args["token_ids"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|t| {
                            let idx = usize::from(
                                *t != json!(wire::token_id(self.cfg.usdc.token.as_str())),
                            );
                            self.bal[idx].to_string()
                        })
                        .collect::<Vec<_>>()
                );
                (ok(v.clone()), Some(v))
            }
            "current_salt" => {
                let v = json!(hex::encode(self.salt));
                (ok(v.clone()), Some(v))
            }
            "has_public_key" => {
                let pk = c.args["public_key"].as_str().unwrap().to_owned();
                (ok(json!(self.keys.contains(&pk))), None)
            }
            "is_nonce_used" => {
                let n: [u8; 32] = wire::unb64(c.args["nonce"].as_str().unwrap())
                    .try_into()
                    .unwrap();
                let used = self.used_nonces.contains(&n) || self.sabotage == Sabotage::LyingNonce;
                (ok(json!(used)), None)
            }
            "add_public_key" => {
                let pk = c.args["public_key"].as_str().unwrap().to_owned();
                if self.auth_disabled || c.deposit != 1 || !self.keys.insert(pk) {
                    (PromiseResult::Failed, None)
                } else {
                    (void, None)
                }
            }
            "remove_public_key" => {
                let pk = c.args["public_key"].as_str().unwrap().to_owned();
                if self.sabotage == Sabotage::LyingRemoval && self.keys.contains(&pk) {
                    (void, None)
                } else if self.auth_disabled || c.deposit != 1 || !self.keys.remove(&pk) {
                    (PromiseResult::Failed, None)
                } else {
                    (void, None)
                }
            }
            "mt_transfer" => {
                let idx = usize::from(
                    c.args["token_id"] != json!(wire::token_id(self.cfg.usdc.token.as_str())),
                );
                let amount: u128 = c.args["amount"].as_str().unwrap().parse().unwrap();
                if self.auth_disabled || amount > self.bal[idx] || amount == 0 {
                    (PromiseResult::Failed, None)
                } else {
                    self.bal[idx] -= amount;
                    self.owner_bal[idx] += amount;
                    (void, None)
                }
            }
            "sign" => {
                let req = &c.args["request"];
                let path = req["path"].as_str().unwrap().to_owned();
                let payload = hex::decode(req["payload_v2"]["Eddsa"].as_str().unwrap()).unwrap();
                if c.gas < Gas::from_tgas(15).as_gas() {
                    self.violation("sign attached less than the MPC's 15 TGas minimum".into());
                }
                let key = path_key(self.seed, &path);
                let sig = key.sign(&payload).to_bytes();
                let roll = self.rng.random_range(0..100);
                let disclose = roll < 75;
                if disclose {
                    self.stats.signatures_disclosed += 1;
                    self.disclosed.push(Disclosed {
                        path,
                        hash: payload.clone().try_into().unwrap_or([0; 32]),
                        sig,
                    });
                }
                let res = match roll {
                    0..60 => ok(json!({"scheme": "Ed25519", "signature": sig.to_vec()})),
                    // Disclosed but the yield timed out / our callback sees a failure.
                    60..75 => PromiseResult::Failed,
                    75..85 => PromiseResult::Failed,
                    85..92 => {
                        let mut bad = sig;
                        bad[0] ^= 1;
                        ok(json!({"scheme": "Ed25519", "signature": bad.to_vec()}))
                    }
                    _ => PromiseResult::Successful(
                        br#"{"scheme":"Ed25519","signature":"x"}"#.to_vec(),
                    ),
                };
                (res, None)
            }
            m => {
                self.violation(format!("model cannot execute {m}"));
                (PromiseResult::Failed, None)
            }
        };
        self.calls[i].result = Some(res);
        self.calls[i].returned = returned;
        self.log
            .push(format!("t={} exec {}.{}", self.now, c.receiver, c.method));
    }

    fn deliver(&mut self, cb_idx: usize, replay: bool) {
        let cb = self.callbacks[cb_idx].clone();
        let results: Vec<PromiseResult> = if replay {
            cb.results.clone().unwrap()
        } else {
            cb.deps
                .iter()
                .map(|d| self.calls[*d].result.clone().unwrap())
                .collect()
        };
        if !replay {
            self.callbacks[cb_idx].delivered = true;
            self.callbacks[cb_idx].results = Some(results.clone());
            self.stats.callbacks_delivered += 1;
        } else {
            self.stats.duplicate_replays += 1;
        }
        let a = cb.args.clone();
        let epoch = a["epoch"].as_u64();
        if let (Some(e), Some(g)) = (epoch, self.prev_grant.as_ref())
            && e != g.epoch
        {
            self.stats.stale_epoch_deliveries += 1;
        }
        let order_id = a["order_id"].as_str().map(|s| U64(s.parse().unwrap()));
        let me = self.mandate.clone();
        let before = self.snapshot();
        let settle_true = cb.method == "on_settle_checked"
            && matches!(results.first(), Some(PromiseResult::Successful(b)) if b == b"true");
        let label = format!("{}{}({a})", if replay { "replay " } else { "" }, cb.method);
        let r = match cb.method.as_str() {
            "on_grant_prepared" => self.tx(&me, results, &label, |m| {
                m.on_grant_prepared(epoch.unwrap())
            }),
            "on_key_added" => self.tx(&me, results, &label, |m| m.on_key_added(epoch.unwrap())),
            "on_key_removed" => {
                let at = u32::try_from(a["attempt"].as_u64().unwrap()).unwrap();
                self.tx(&me, results, &label, |m| {
                    m.on_key_removed(epoch.unwrap(), at)
                })
            }
            "on_key_presence" => {
                let at = u32::try_from(a["attempt"].as_u64().unwrap()).unwrap();
                self.tx(&me, results, &label, |m| {
                    m.on_key_presence(epoch.unwrap(), at)
                })
            }
            "on_order_priced" => self.tx(&me, results, &label, |m| {
                m.on_order_priced(order_id.unwrap(), epoch.unwrap())
            }),
            "on_signed" => self.tx(&me, results, &label, |m| {
                m.on_signed(order_id.unwrap(), epoch.unwrap())
            }),
            "on_settle_checked" => self.tx(&me, results, &label, |m| {
                m.on_settle_checked(order_id.unwrap(), epoch.unwrap())
            }),
            other => {
                self.violation(format!("driver does not know callback {other}"));
                Ok(())
            }
        };
        if let Err(e) = r {
            self.violation(format!("callback {label} panicked: {e}"));
        }
        let after = self.snapshot();
        if replay
            && (before.0.as_ref().map(state_key) != after.0.as_ref().map(state_key)
                || before
                    .1
                    .iter()
                    .map(|(k, o)| (*k, o.state.clone(), o.reserved_value))
                    .collect::<Vec<_>>()
                    != after
                        .1
                        .iter()
                        .map(|(k, o)| (*k, o.state.clone(), o.reserved_value))
                        .collect::<Vec<_>>())
        {
            self.violation(format!("identical replay of {label} changed state"));
        }
        if settle_true && !replay {
            self.stats.settle_true_deliveries += 1;
            let id = order_id.unwrap().0;
            let was_open = before.1.get(&id).is_some_and(|o| authority_open(&o.state));
            let released = after
                .1
                .get(&id)
                .is_some_and(|o| matches!(o.state, OrderState::Released { .. }));
            if was_open && !released {
                self.violation(format!(
                    "order {id}: verifier reported nonce used, capacity not returned"
                ));
            }
        }
    }

    fn executable(&self, o: &OrderView) -> Option<[u8; 32]> {
        let p = o.payload.as_ref()?;
        let hash: [u8; 32] = hex::decode(o.payload_hash.as_ref()?)
            .ok()?
            .try_into()
            .ok()?;
        let d = self.disclosed.iter().find(|d| d.hash == hash)?;
        let pk = wire::ed25519_str(&path_key(self.seed, &d.path).verifying_key().to_bytes());
        let _ = d.sig;
        let nonce: [u8; 32] = p.nonce.0.clone().try_into().ok()?;
        let (salt, nonce_deadline) = wire::parse_versioned_nonce(&nonce)?;
        let deadline = o.deadline_ns?.0;
        (self.keys.contains(&pk)
            && !self.used_nonces.contains(&nonce)
            && self.now <= deadline
            && (self.now as i64) <= nonce_deadline
            && self.valid_salts.contains(&salt))
        .then_some(nonce)
    }

    fn pending_add_for(&self, pk: &str) -> bool {
        self.calls.iter().any(|c| {
            c.method == "add_public_key" && c.result.is_none() && c.args["public_key"] == json!(pk)
        })
    }

    // ------------------------------------------------------------------ invariants

    fn check(&mut self, label: &str) {
        let (g, orders) = self.snapshot();
        let prev_g = self.prev_grant.clone();
        let prev_o = self.prev_orders.clone();

        // Grant lifecycle and epoch/path rules.
        if let Some(g) = &g {
            if g.path != format!("mandate/v1/{}", g.epoch) {
                self.violation(format!("grant path {} for epoch {}", g.path, g.epoch));
            }
            match &prev_g {
                Some(p) if p.epoch != g.epoch => {
                    if p.status != GrantStatus::Revoked || g.epoch != p.epoch + 1 {
                        self.violation(format!(
                            "new grant {} over unresolved {:?} {}",
                            g.epoch, p.status, p.epoch
                        ));
                    }
                }
                Some(p) if p.status == GrantStatus::Revoked && g.status != GrantStatus::Revoked => {
                    self.violation(format!("grant {} left Revoked", g.epoch));
                }
                _ => {}
            }
            if g.status == GrantStatus::Active {
                match &g.public_key {
                    Some(pk) if self.keys.contains(&String::from(pk)) => {}
                    _ => {
                        self.violation(format!("grant {} Active without a registered key", g.epoch))
                    }
                }
            }
            if g.status == GrantStatus::Revoked
                && let Some(pk) = &g.public_key
            {
                let pk = String::from(pk);
                if self.keys.contains(&pk) || self.pending_add_for(&pk) {
                    self.violation(format!(
                        "grant {} Revoked while its key can still be registered",
                        g.epoch
                    ));
                }
            }
            if let (Some(iv), None) = (g.initial_value, self.grants.get(&g.epoch)) {
                self.record_grant(g, iv.0);
            }
        }

        // Accounting consistency and independent caps.
        if let Some(g) = &g
            && let Some(rec) = self.grants.get(&g.epoch)
        {
            let pol = rec.policy;
            let per_cap = bps_floor(rec.my_initial, u128::from(pol.per_order_cap_bps));
            let out_cap = bps_floor(rec.my_initial, u128::from(pol.outstanding_cap_bps));
            let turn_cap = bps_floor(rec.my_initial, u128::from(pol.turnover_cap_bps));
            // Documented charge rule: every proposal permanently charges
            // max(reserved_value, ceil(initial_value * proposal_charge_bps / 10000)); a rejection
            // refunds only the part above that floor; releases refund nothing.
            let charge = u128::from(pol.proposal_charge_bps);
            let floor_mine = (rec.my_initial * charge).div_ceil(10_000);
            let floor_contract = g
                .initial_value
                .map_or(0, |iv| (iv.0 * charge).div_ceil(10_000));
            let mut expected_turnover = 0u128;
            let mut sum_reserved = 0u128;
            let mut my_outstanding = 0u128;
            let mut my_turnover = 0u128;
            let mut msgs = Vec::new();
            for o in orders.values().filter(|o| o.epoch == g.epoch) {
                let (si, dec) = match o.sell {
                    Asset::Usdc => (0, self.cfg.usdc.decimals),
                    Asset::Wnear => (1, self.cfg.wnear.decimals),
                };
                let v_init = value_units(
                    o.sell_amount.0,
                    dec,
                    [rec.init_usdc, rec.init_wnear][si],
                    true,
                );
                let v = self
                    .signed_value
                    .get(&o.id.0)
                    .copied()
                    .unwrap_or(v_init)
                    .max(v_init);
                let rejected = matches!(o.state, OrderState::Rejected { .. });
                // Independent valuation: issued authority at its conservative value, every
                // proposal at least the floor.
                my_turnover += if rejected {
                    floor_mine
                } else if self.sign_calls.contains_key(&o.id.0) {
                    v.max(floor_mine)
                } else {
                    v_init.max(floor_mine)
                };
                expected_turnover += if rejected {
                    floor_contract
                } else {
                    o.reserved_value.0.max(floor_contract)
                };
                if is_open(&o.state) {
                    sum_reserved += o.reserved_value.0;
                    my_outstanding += v;
                    if v > o.reserved_value.0 {
                        msgs.push(format!(
                            "order {} reserves {} < conservative value {v}",
                            o.id.0, o.reserved_value.0
                        ));
                    }
                }
                if !matches!(o.state, OrderState::Rejected { .. }) && v > per_cap {
                    msgs.push(format!(
                        "order {} value {v} exceeds per-order cap {per_cap}",
                        o.id.0
                    ));
                }
            }
            if sum_reserved != g.outstanding.0 {
                msgs.push(format!(
                    "outstanding {} != sum of open reservations {sum_reserved}",
                    g.outstanding.0
                ));
            }
            if my_outstanding > out_cap {
                msgs.push(format!(
                    "outstanding {my_outstanding} exceeds cap {out_cap}"
                ));
            }
            if my_turnover > turn_cap {
                msgs.push(format!(
                    "issued turnover {my_turnover} exceeds cap {turn_cap}"
                ));
            }
            if my_turnover > g.turnover_used.0 {
                msgs.push(format!(
                    "turnover_used {} below issued authority {my_turnover}",
                    g.turnover_used.0
                ));
            }
            if expected_turnover != g.turnover_used.0 {
                msgs.push(format!(
                    "turnover_used {} != documented charge rule {expected_turnover}",
                    g.turnover_used.0
                ));
            }
            for m in msgs {
                self.violation(m);
            }
        }
        if let Some(g) = &g {
            for o in orders.values() {
                if is_open(&o.state) && o.epoch != g.epoch {
                    self.violation(format!("open order {} of old epoch {}", o.id.0, o.epoch));
                }
            }
        }

        // No executable authority omitted.
        for o in orders.values() {
            if self.executable(o).is_some() {
                let counted = authority_open(&o.state)
                    && g.as_ref()
                        .is_some_and(|g| g.epoch == o.epoch && g.status != GrantStatus::Revoked);
                if !counted {
                    self.violation(format!(
                        "order {} executable but {:?} (grant {:?})",
                        o.id.0,
                        o.state,
                        g.as_ref().map(|g| g.status)
                    ));
                }
            }
        }
        for d in self.disclosed.clone() {
            if !orders
                .values()
                .any(|o| o.payload_hash.as_deref() == Some(&hex::encode(d.hash)))
            {
                self.violation("disclosed signature for no recorded order".into());
            }
        }

        // Transitions: release at most once, only on trusted evidence.
        for (id, o) in &orders {
            let prev = prev_o.get(id).map(|p| p.state.clone());
            if prev.as_ref() == Some(&o.state) {
                continue;
            }
            if let Some(p) = &prev
                && is_final(p)
            {
                self.violation(format!(
                    "order {id} left final state {p:?} -> {:?}",
                    o.state
                ));
                continue;
            }
            match &o.state {
                OrderState::Released { reason } => {
                    *self
                        .stats
                        .releases
                        .entry(format!("{reason:?}"))
                        .or_default() += 1;
                    let nonce: Option<[u8; 32]> = o
                        .payload
                        .as_ref()
                        .and_then(|p| p.nonce.0.clone().try_into().ok());
                    let ok = match reason {
                        ReleaseReason::Settled => {
                            nonce.is_some_and(|n| self.used_nonces.contains(&n))
                        }
                        ReleaseReason::Expired => o.deadline_ns.is_some_and(|d| self.now > d.0),
                        ReleaseReason::KeyRemoved => {
                            let pk = self.grant_key(o.epoch, &g);
                            pk.is_some_and(|pk| {
                                !self.keys.contains(&pk) && !self.pending_add_for(&pk)
                            }) || (!self.sign_calls.contains_key(id)
                                && self.executable(o).is_none())
                        }
                        ReleaseReason::Unsigned => !self.sign_calls.contains_key(id),
                    };
                    if !ok || self.executable(o).is_some() {
                        self.violation(format!(
                            "order {id} released ({reason:?}) without trusted evidence"
                        ));
                    }
                }
                OrderState::Rejected { reason } => {
                    self.stats.rejections += 1;
                    let r: String = reason
                        .chars()
                        .filter(|c| !c.is_ascii_digit())
                        .take(60)
                        .collect();
                    *self
                        .stats
                        .panic_reasons
                        .entry(format!("rejected: {r}"))
                        .or_default() += 1;
                    if self.sign_calls.contains_key(id) {
                        self.violation(format!("order {id} rejected after a sign request"));
                    }
                }
                _ => {}
            }
        }
        if let (Some(g), Some(p)) = (&g, &prev_g)
            && g.breaker.is_some()
            && p.breaker.is_none()
            && g.epoch == p.epoch
        {
            self.stats.breaker_trips += 1;
        }
        let _ = label;
        self.prev_grant = g;
        self.prev_orders = orders;
    }

    fn grant_key(&self, epoch: u64, g: &Option<GrantView>) -> Option<String> {
        if let Some(g) = g
            && g.epoch == epoch
        {
            return g.public_key.as_ref().map(String::from);
        }
        self.grants
            .get(&epoch)
            .map(|r| wire::ed25519_str(&path_key(self.seed, &r.path).verifying_key().to_bytes()))
    }

    fn record_grant(&mut self, g: &GrantView, contract_initial: u128) {
        let cb = self
            .callbacks
            .iter()
            .find(|c| {
                c.method == "on_grant_prepared" && c.args["epoch"] == json!(g.epoch) && c.delivered
            })
            .cloned();
        let Some(cb) = cb else {
            self.violation(format!(
                "grant {} valued without a delivered preparation",
                g.epoch
            ));
            return;
        };
        let mut pxs = (None, None);
        for d in &cb.deps {
            let c = &self.calls[*d];
            if c.method == "get_price_no_older_than"
                && let Some(v) = c.returned.clone().filter(|v| !v.is_null())
            {
                if c.args["price_id"] == json!(USDC_PRICE_ID) {
                    pxs.0 = Some(px_of(&v));
                } else {
                    pxs.1 = Some(px_of(&v));
                }
            }
        }
        let bals = balances_from(self, &cb.deps);
        let (Some(u), Some(w), Some(b)) = (pxs.0, pxs.1, bals) else {
            self.violation(format!("grant {} valued from missing data", g.epoch));
            return;
        };
        let mine = value_units(b[0], self.cfg.usdc.decimals, u, false)
            + value_units(b[1], self.cfg.wnear.decimals, w, false);
        if contract_initial > mine {
            self.violation(format!(
                "initial value {contract_initial} above independent {mine}"
            ));
        }
        let r = g.initial_reference.clone().unwrap();
        if (obs_px(&r.usdc), obs_px(&r.wnear)) != (u, w) {
            self.violation("initial reference differs from returned prices".into());
        }
        self.grants.insert(
            g.epoch,
            GrantRecord {
                my_initial: mine,
                init_usdc: u,
                init_wnear: w,
                policy: g.policy,
                path: g.path.clone(),
            },
        );
    }

    // ------------------------------------------------------------------ actions

    fn random_policy(&mut self) -> Policy {
        let mut p = Policy::DEMO;
        if self.rng.random_bool(0.4) {
            p.per_order_cap_bps = self.rng.random_range(300..=2_000);
            p.outstanding_cap_bps = self.rng.random_range(p.per_order_cap_bps..=4_000);
            p.turnover_cap_bps = self.rng.random_range(1_000..=20_000);
            p.max_pricing_delay_sec = self.rng.random_range(5..=60);
            p.proposal_charge_bps = self.rng.random_range(1..=p.per_order_cap_bps.min(400));
        }
        p
    }

    fn propose(&mut self) {
        let sell = if self.rng.random_bool(0.5) {
            Asset::Usdc
        } else {
            Asset::Wnear
        };
        let (dec, usd_per_unit_e8) = match sell {
            Asset::Usdc => (6u32, 100_000_000u128),
            Asset::Wnear => (24u32, 300_000_000u128),
        };
        let usd: u128 = match self.rng.random_range(0..100) {
            0..5 => 0,
            5..10 => u128::MAX / 1_000_000,
            10..80 => self.rng.random_range(1..800),
            _ => self.rng.random_range(1..6_000),
        };
        let amount = match usd {
            0 => self.rng.random_range(0..3),
            u if u > 1_000_000_000 => u,
            u => u * 10u128.pow(dec) * 100_000_000 / usd_per_unit_e8,
        };
        let concession = match self.rng.random_range(0..10) {
            0 => 51,
            1 => 0,
            _ => self.rng.random_range(0..=50),
        };
        let p = Proposal {
            sell,
            sell_amount: U128(amount),
            max_concession_bps: concession,
        };
        let agent = self.cfg.agent_id.clone();
        if self
            .tx(&agent, vec![], &format!("propose {p:?}"), move |m| {
                m.propose_order(p)
            })
            .is_ok()
        {
            self.stats.proposals_ok += 1;
        }
    }

    fn fill(&mut self) {
        let (_, orders) = self.snapshot();
        let mut cands: Vec<(OrderView, [u8; 32])> = orders
            .values()
            .filter_map(|o| self.executable(o).map(|n| (o.clone(), n)))
            .collect();
        if cands.is_empty() {
            return;
        }
        let k = self.rng.random_range(0..cands.len());
        let (o, nonce) = cands.swap_remove(k);
        let (si, bi) = match o.sell {
            Asset::Usdc => (0, 1),
            Asset::Wnear => (1, 0),
        };
        if self.bal[si] < o.sell_amount.0 {
            return;
        }
        self.used_nonces.insert(nonce);
        self.bal[si] -= o.sell_amount.0;
        self.bal[bi] += o.buy_amount.unwrap().0;
        self.stats.fills += 1;
        if self
            .prev_grant
            .as_ref()
            .is_some_and(|g| g.status == GrantStatus::Revoking)
        {
            self.stats.fills_while_revoking += 1;
        }
        self.log
            .push(format!("t={} FILL order {}", self.now, o.id.0));
        self.check("fill");
    }

    fn move_prices(&mut self) {
        let now_s = (self.now / 1_000_000_000) as i64;
        for i in 0..2 {
            let roll = self.rng.random_range(0..100);
            let Some(p) = self.px[i].as_mut() else {
                if roll < 50 {
                    self.px[i] = Some(PriceState {
                        price: [100_000_000, 300_000_000][i],
                        conf: 10_000,
                        expo: -8,
                        publish_time: now_s,
                    });
                }
                continue;
            };
            match roll {
                0..50 => {
                    let bps: i64 = self.rng.random_range(-300..=300);
                    p.price = (p.price + p.price * bps / 10_000).max(1);
                    p.publish_time = now_s;
                }
                50..60 => {
                    p.price = p.price * self.rng.random_range(80..95) / 100;
                    p.publish_time = now_s;
                }
                60..70 => p.publish_time = now_s - self.rng.random_range(40..=75),
                70..78 => p.conf = (p.price as u64) / 100,
                78..85 => p.conf = (p.price as u64) / 10_000,
                85..88 => self.px[i] = None,
                88..90 => p.price = -p.price.abs(),
                _ => {
                    p.price = p.price.abs().max(1);
                    p.publish_time = now_s;
                }
            }
        }
        if self.rng.random_bool(0.05) {
            self.oracle_fail = !self.oracle_fail;
        }
    }

    fn step(&mut self) {
        self.stats.steps += 1;
        let can_grant = self
            .prev_grant
            .as_ref()
            .is_none_or(|g| g.status == GrantStatus::Revoked);
        let mut roll = self.rng.random_range(0..1000);
        // Re-weight owner actions so grants spend meaningful time active.
        if can_grant && self.rng.random_bool(0.15) {
            roll = 0;
        } else if roll < 60 && !self.rng.random_bool(0.2) {
            roll += 330;
        } else if (60..100).contains(&roll) && !self.rng.random_bool(0.35) {
            roll += 560;
        }
        let owner = self.cfg.owner_id.clone();
        match roll {
            0..60 => {
                let p = self.random_policy();
                if self
                    .tx(&owner, vec![], "grant", move |m| {
                        m.grant(p).detach();
                    })
                    .is_ok()
                {
                    self.stats.grants += 1;
                }
            }
            60..100 => {
                if self
                    .tx(&owner, vec![], "revoke", |m| m.revoke(None))
                    .is_ok()
                {
                    self.stats.revokes_ok += 1;
                }
            }
            100..330 => self.propose(),
            330..600 => {
                for _ in 0..self.rng.random_range(1..=5) {
                    let ready: Vec<usize> = (0..self.calls.len())
                        .filter(|i| self.calls[*i].result.is_none())
                        .collect();
                    if ready.is_empty() {
                        break;
                    }
                    let i = ready[self.rng.random_range(0..ready.len())];
                    self.exec_call(i);
                    self.check("exec");
                }
            }
            600..800 => {
                for _ in 0..self.rng.random_range(1..=3) {
                    let ready: Vec<usize> = (0..self.callbacks.len())
                        .filter(|i| {
                            let c = &self.callbacks[*i];
                            !c.delivered
                                && !c.dropped
                                && c.deps.iter().all(|d| self.calls[*d].result.is_some())
                        })
                        .collect();
                    if !ready.is_empty() {
                        let i = ready[self.rng.random_range(0..ready.len())];
                        if self.rng.random_bool(0.01) {
                            self.callbacks[i].dropped = true;
                            self.stats.callbacks_dropped += 1;
                        } else {
                            self.deliver(i, false);
                        }
                    }
                }
            }
            800..830 => {
                let done: Vec<usize> = (0..self.callbacks.len())
                    .filter(|i| self.callbacks[*i].delivered)
                    .collect();
                if !done.is_empty() {
                    let i = done[self.rng.random_range(0..done.len())];
                    self.deliver(i, true);
                }
            }
            830..880 => self.fill(),
            880..910 => {
                let (_, orders) = self.snapshot();
                let prefer: Vec<u64> = orders
                    .values()
                    .filter(|o| authority_open(&o.state) || self.rng.random_bool(0.1))
                    .map(|o| o.id.0)
                    .collect();
                if let Some(id) = pick(&mut self.rng, prefer) {
                    let who = acc("anyone.test.near");
                    let _ = self.tx(&who, vec![], &format!("settle {id}"), move |m| {
                        m.settle_order(U64(id)).detach();
                    });
                }
            }
            910..940 => {
                let (_, orders) = self.snapshot();
                if let Some(id) = pick(&mut self.rng, orders.keys().copied().collect()) {
                    let who = acc("anyone.test.near");
                    let _ = self.tx(&who, vec![], &format!("expire {id}"), move |m| {
                        m.expire_order(U64(id))
                    });
                }
            }
            940..970 => {
                self.now += self.rng.random_range(1..=40) * 1_000_000_000;
                self.check("time");
            }
            970..990 => self.move_prices(),
            990..995 => {
                self.auth_disabled = !self.auth_disabled;
                self.stats.removal_failures_induced += usize::from(self.auth_disabled);
            }
            _ => {
                // Negative controls: role checks independent of the access key.
                let p = Proposal {
                    sell: Asset::Usdc,
                    sell_amount: U128(1_000_000),
                    max_concession_bps: 0,
                };
                if self
                    .tx(&owner, vec![], "owner proposes", move |m| {
                        m.propose_order(p)
                    })
                    .is_ok()
                {
                    self.violation("owner could call propose_order".into());
                }
                let agent = self.cfg.agent_id.clone();
                if self
                    .tx(&agent, vec![], "agent revokes", |m| m.revoke(None))
                    .is_ok()
                {
                    self.violation("agent could revoke".into());
                }
                let pol = Policy::DEMO;
                if self
                    .tx(&agent, vec![], "agent grants", move |m| {
                        m.grant(pol).detach();
                    })
                    .is_ok()
                {
                    self.violation("agent could grant".into());
                }
            }
        }
        self.now += self.rng.random_range(0..=600) * 1_000_000;
        // Live feeds publish continuously; shocks and staleness come from `move_prices`.
        let now_s = (self.now / 1_000_000_000) as i64;
        for i in 0..2 {
            if self.rng.random_bool(0.3)
                && let Some(p) = self.px[i].as_mut()
            {
                p.publish_time = now_s;
            }
        }
    }
}

fn balances_from(s: &Sim, deps: &[usize]) -> Option<[u128; 2]> {
    let usdc_id = json!(wire::token_id(s.cfg.usdc.token.as_str()));
    let mut b = [None, None];
    for d in deps {
        let c = &s.calls[*d];
        match c.method.as_str() {
            "mt_balance_of" => {
                let v: u128 = c.returned.as_ref()?.as_str()?.parse().ok()?;
                b[usize::from(c.args["token_id"] != usdc_id)] = Some(v);
            }
            "mt_batch_balance_of" => {
                let arr = c.returned.as_ref()?.as_array()?;
                for (t, v) in c.args["token_ids"].as_array()?.iter().zip(arr) {
                    b[usize::from(*t != usdc_id)] = v.as_str()?.parse().ok();
                }
            }
            _ => {}
        }
    }
    Some([b[0]?, b[1]?])
}

fn pick(rng: &mut ChaCha8Rng, v: Vec<u64>) -> Option<u64> {
    (!v.is_empty()).then(|| v[rng.random_range(0..v.len())])
}

fn is_final(s: &OrderState) -> bool {
    matches!(s, OrderState::Released { .. } | OrderState::Rejected { .. })
}

fn is_open(s: &OrderState) -> bool {
    !is_final(s)
}

fn authority_open(s: &OrderState) -> bool {
    matches!(
        s,
        OrderState::Signing | OrderState::Signed | OrderState::SignUnknown
    )
}

fn state_key(g: &GrantView) -> (u64, GrantStatus, u128, u128, bool) {
    (
        g.epoch,
        g.status,
        g.outstanding.0,
        g.turnover_used.0,
        g.breaker.is_some(),
    )
}

#[derive(serde::Serialize)]
struct SeedResult {
    seed: u64,
    passed: bool,
    first_violation: Option<String>,
    violations: usize,
    stats: Stats,
    final_status: Option<GrantStatus>,
    tail: Vec<String>,
}

fn run_seed(seed: u64) -> SeedResult {
    run_seed_with(seed, Sabotage::None)
}

fn run_seed_with(seed: u64, sabotage: Sabotage) -> SeedResult {
    let mut s = Sim::new(seed);
    s.sabotage = sabotage;
    for _ in 0..STEPS {
        s.step();
        if !s.violations.is_empty() {
            break;
        }
    }
    let final_status = s.prev_grant.as_ref().map(|g| g.status);
    let passed = s.violations.is_empty();
    let tail = if passed {
        Vec::new()
    } else {
        s.log.iter().rev().take(40).rev().cloned().collect()
    };
    SeedResult {
        seed,
        passed,
        first_violation: s.violations.first().cloned(),
        violations: s.violations.len(),
        stats: s.stats,
        final_status,
        tail,
    }
}

/// gate: T2
#[test]
fn t2_seeded_interleavings_unit_vm() {
    install_quiet_hook();
    // Fixed seed list; T2_SEED_LIMIT only shortens local debugging runs and is recorded.
    let limit = std::env::var("T2_SEED_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(SEEDS);
    let seeds: Vec<u64> = (0..SEEDS.min(limit)).map(|i| 0x7a2_0000 + i).collect();
    let results: Vec<SeedResult> = seeds.iter().map(|s| run_seed(*s)).collect();
    let failing: Vec<&SeedResult> = results.iter().filter(|r| !r.passed).collect();
    let mut agg = Stats::default();
    let mut statuses: BTreeMap<String, usize> = BTreeMap::new();
    for r in &results {
        let st = &r.stats;
        agg.steps += st.steps;
        agg.txs_ok += st.txs_ok;
        agg.txs_panicked += st.txs_panicked;
        agg.proposals_ok += st.proposals_ok;
        agg.grants += st.grants;
        agg.revokes_ok += st.revokes_ok;
        agg.sign_requests += st.sign_requests;
        agg.signatures_disclosed += st.signatures_disclosed;
        agg.fills += st.fills;
        agg.fills_while_revoking += st.fills_while_revoking;
        agg.callbacks_delivered += st.callbacks_delivered;
        agg.callbacks_dropped += st.callbacks_dropped;
        agg.duplicate_replays += st.duplicate_replays;
        agg.stale_epoch_deliveries += st.stale_epoch_deliveries;
        agg.rejections += st.rejections;
        agg.settle_true_deliveries += st.settle_true_deliveries;
        agg.breaker_trips += st.breaker_trips;
        agg.removal_failures_induced += st.removal_failures_induced;
        for (k, v) in &st.panic_reasons {
            *agg.panic_reasons.entry(k.clone()).or_default() += v;
        }
        for (k, v) in &st.releases {
            *agg.releases.entry(k.clone()).or_default() += v;
        }
        *statuses.entry(format!("{:?}", r.final_status)).or_default() += 1;
    }
    // Meaningfulness: the interleavings must exercise the interesting paths, not one path.
    let coverage_ok = seeds.len() >= 200
        && agg.fills > 0
        && agg.revokes_ok > 0
        && agg.grants > seeds.len()
        && agg.duplicate_replays > 0
        && agg.stale_epoch_deliveries > 0
        && agg.releases.contains_key("KeyRemoved")
        && agg.releases.contains_key("Settled")
        && agg.releases.contains_key("Expired");
    let passed = failing.is_empty() && coverage_ok;
    common::evidence::write(
        "T2",
        "unit-interleavings",
        passed,
        "unit-vm",
        json!({
            "environment": "near-sdk unit-testing VM driving the real contract code; verifier, MPC and oracle are an independent model",
            "seeds": seeds,
            "steps_per_seed": STEPS,
            "failing_seeds": failing.iter().map(|r| json!({"seed": r.seed, "first_violation": r.first_violation, "violations": r.violations, "tail": r.tail})).collect::<Vec<_>>(),
            "aggregate": agg,
            "final_grant_status_counts": statuses,
            "coverage_ok": coverage_ok,
        }),
    );
    assert!(
        coverage_ok,
        "interleavings did not cover required paths: {agg:?}"
    );
    assert!(
        failing.is_empty(),
        "{} of {} seeds violated T2 invariants; first: seed {:#x}: {:?}\n{}",
        failing.len(),
        results.len(),
        failing[0].seed,
        failing[0].first_violation,
        failing[0].tail.join("\n")
    );
}

/// Checker sensitivity: a lying verifier must produce detected violations; otherwise a passing T2
/// would mean nothing.
#[test]
fn t2_checker_detects_unsafe_releases() {
    install_quiet_hook();
    for sabotage in [Sabotage::LyingRemoval, Sabotage::LyingNonce] {
        let caught = (0..40u64)
            .map(|i| run_seed_with(0x5ab_0000 + i, sabotage))
            .filter(|r| !r.passed)
            .count();
        assert!(caught > 0, "checker missed {sabotage:?} in 40 seeds");
    }
}
