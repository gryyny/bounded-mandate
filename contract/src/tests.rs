//! Unit tests of state, policy and callback interleavings. Callbacks are driven directly with
//! explicit promise results; receipts the contract would create are inspected, not executed.
#![allow(clippy::arithmetic_side_effects, clippy::unwrap_used)]

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{AccountId, Gas, NearToken, PromiseResult, testing_env};

use super::*;

const NOW_SEC: u64 = 1_800_000_000;
const NOW: u64 = NOW_SEC * NS_PER_SEC;
const USDC: u128 = 1_000_000; // one USDC in units
const NEAR: u128 = 1_000_000_000_000_000_000_000_000; // one wNEAR in units
const USD: u128 = 1_000_000_000_000; // one USD in value units

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn config() -> MandateConfig {
    MandateConfig {
        owner_id: acc("owner.near"),
        agent_id: acc("agent.near"),
        verifier_id: acc("intents.near"),
        signer_id: acc("v1.signer"),
        oracle_id: acc("oracle.near"),
        usdc: AssetConfig {
            token: acc("usdc.near"),
            decimals: 6,
            price_id: "usdc-id".into(),
        },
        wnear: AssetConfig {
            token: acc("wrap.near"),
            decimals: 24,
            price_id: "near-id".into(),
        },
    }
}

fn set(predecessor: &str, now: u64, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("mandate.near"))
        .predecessor_account_id(acc(predecessor))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn ok(v: Value) -> PromiseResult {
    PromiseResult::Successful(v.to_string().into_bytes())
}

fn fail() -> PromiseResult {
    PromiseResult::Failed
}

/// `PythCompatPrice` JSON with exponent -8.
fn px(mantissa: u64, publish_sec: u64) -> PromiseResult {
    ok(
        json!({ "price": mantissa.to_string(), "conf": "10000", "expo": -8, "publish_time": publish_sec }),
    )
}

fn balances(usdc: u128, wnear: u128) -> PromiseResult {
    ok(json!([usdc.to_string(), wnear.to_string()]))
}

#[derive(Debug)]
struct Call {
    receiver: String,
    method: String,
    args: Value,
    deposit: NearToken,
}

fn calls() -> Vec<Call> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } => Some(Call {
                    receiver: receiver.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: serde_json::from_slice(&args).unwrap_or(Value::Null),
                    deposit: attached_deposit,
                }),
                _ => None,
            })
        })
        .collect()
}

fn methods() -> Vec<String> {
    calls()
        .into_iter()
        .map(|c| format!("{}.{}", c.receiver, c.method))
        .collect()
}

fn events(name: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|e| e["standard"] == "bounded_mandate" && e["event"] == name)
        .map(|e| e["data"].clone())
        .collect()
}

struct H {
    c: Mandate,
    key: SigningKey,
    now: u64,
}

impl H {
    fn new() -> Self {
        set("owner.near", NOW, vec![]);
        Self {
            c: Mandate::new(config()),
            key: SigningKey::from_bytes(&[7; 32]),
            now: NOW,
        }
    }

    fn pk(&self) -> PublicKey {
        let b58 = near_sdk::bs58::encode(self.key.verifying_key().as_bytes()).into_string();
        format!("ed25519:{b58}").parse().unwrap()
    }

    fn pk_result(&self) -> PromiseResult {
        ok(json!(String::from(&self.pk())))
    }

    fn epoch(&self) -> u64 {
        self.c.get_grant().unwrap().epoch
    }

    fn grant(&mut self) {
        set("owner.near", self.now, vec![]);
        let _ = self.c.grant(Policy::DEMO);
    }

    /// Grant valuation: $1 USDC, $3 wNEAR, published 10 s ago; 1000 USDC and 0 wNEAR held.
    fn prepare(&mut self) {
        let results = vec![
            self.pk_result(),
            px(100_000_000, self.now / NS_PER_SEC - 10),
            px(300_000_000, self.now / NS_PER_SEC - 10),
            balances(1_000 * USDC, 0),
        ];
        set("mandate.near", self.now, results);
        self.c.on_grant_prepared(self.epoch());
    }

    fn key_added(&mut self, result: PromiseResult) {
        set("mandate.near", self.now, vec![result]);
        self.c.on_key_added(self.epoch());
    }

    fn activate(&mut self) {
        self.grant();
        self.prepare();
        self.key_added(ok(Value::Null));
        assert_eq!(self.c.get_grant().unwrap().status, GrantStatus::Active);
    }

    fn propose(&mut self, sell: Asset, amount: u128, bps: u16) -> U64 {
        set("agent.near", self.now, vec![]);
        self.c.propose_order(Proposal {
            sell,
            sell_amount: U128(amount),
            max_concession_bps: bps,
        })
    }

    fn priced_with(&mut self, id: U64, results: Vec<PromiseResult>) {
        let epoch = self.c.get_order(id).unwrap().epoch;
        set("mandate.near", self.now, results);
        self.c.on_order_priced(id, epoch);
    }

    /// Prices unchanged from the grant, published 10 s ago.
    fn priced(&mut self, id: U64) {
        let t = self.now / NS_PER_SEC - 10;
        self.priced_with(
            id,
            vec![
                px(100_000_000, t),
                px(300_000_000, t),
                ok(json!("0a0b0c0d")),
                balances(1_000 * USDC, 0),
            ],
        );
    }

    fn signature_result(&self, id: U64) -> PromiseResult {
        let hash = hex::decode(self.c.get_order(id).unwrap().payload_hash.unwrap()).unwrap();
        let sig = self.key.sign(&hash).to_bytes();
        ok(json!({ "scheme": "Ed25519", "signature": sig.to_vec() }))
    }

    fn signed_with(&mut self, id: U64, result: PromiseResult) {
        let epoch = self.c.get_order(id).unwrap().epoch;
        set("mandate.near", self.now, vec![result]);
        self.c.on_signed(id, epoch);
    }

    fn signed(&mut self, id: U64) {
        let r = self.signature_result(id);
        self.signed_with(id, r);
    }

    fn settle_checked(&mut self, id: U64, result: PromiseResult) {
        let epoch = self.c.get_order(id).unwrap().epoch;
        set("mandate.near", self.now, vec![result]);
        self.c.on_settle_checked(id, epoch);
    }

    fn revoke(&mut self) {
        set("owner.near", self.now, vec![]);
        self.c.revoke(None);
    }

    fn removed(&mut self, attempt: u32, result: PromiseResult) {
        set("mandate.near", self.now, vec![result]);
        self.c.on_key_removed(self.epoch(), attempt);
    }

    fn presence(&mut self, attempt: u32, result: PromiseResult) {
        set("mandate.near", self.now, vec![result]);
        self.c.on_key_presence(self.epoch(), attempt);
    }

    fn state(&self, id: U64) -> OrderState {
        self.c.get_order(id).unwrap().state
    }

    fn grant_view(&self) -> GrantView {
        self.c.get_grant().unwrap()
    }

    /// Activates, proposes 30 USDC -> wNEAR at 50 bps, prices and signs it.
    fn signed_order(&mut self) -> U64 {
        let id = self.propose(Asset::Usdc, 30 * USDC, 50);
        self.priced(id);
        self.signed(id);
        assert_eq!(self.state(id), OrderState::Signed);
        id
    }
}

// ------------------------------------------------------------------ roles

#[test]
#[should_panic(expected = "only the owner")]
fn agent_cannot_grant() {
    let mut h = H::new();
    set("agent.near", NOW, vec![]);
    let _ = h.c.grant(Policy::DEMO);
}

#[test]
#[should_panic(expected = "only the owner")]
fn agent_cannot_revoke() {
    let mut h = H::new();
    h.activate();
    set("agent.near", NOW, vec![]);
    h.c.revoke(None);
}

#[test]
#[should_panic(expected = "only the owner")]
fn agent_cannot_recover() {
    let mut h = H::new();
    set("agent.near", NOW, vec![]);
    let _ = h.c.recover(Asset::Usdc, None);
}

#[test]
#[should_panic(expected = "only the agent may propose")]
fn owner_cannot_propose() {
    let mut h = H::new();
    h.activate();
    set("owner.near", NOW, vec![]);
    h.c.propose_order(Proposal {
        sell: Asset::Usdc,
        sell_amount: U128(USDC),
        max_concession_bps: 0,
    });
}

#[test]
#[should_panic(expected = "per_order_cap_bps")]
fn grant_validates_policy() {
    let mut h = H::new();
    set("owner.near", NOW, vec![]);
    let _ = h.c.grant(Policy {
        per_order_cap_bps: 0,
        ..Policy::DEMO
    });
}

#[test]
#[should_panic(expected = "insufficient gas attached")]
fn propose_requires_full_chain_gas() {
    let mut h = H::new();
    h.activate();
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("mandate.near"))
        .predecessor_account_id(acc("agent.near"))
        .prepaid_gas(GAS_PROPOSE_REQUIRED.saturating_sub(Gas::from_gas(1)));
    testing_env!(b.build());
    h.c.propose_order(Proposal {
        sell: Asset::Usdc,
        sell_amount: U128(USDC),
        max_concession_bps: 0,
    });
}

#[test]
fn gas_budgets_fit_one_transaction() {
    for g in [
        GAS_GRANT_REQUIRED,
        GAS_PROPOSE_REQUIRED,
        GAS_REVOKE_REQUIRED,
        GAS_RECOVER_REQUIRED,
    ] {
        assert!(g <= Gas::from_tgas(gas::MAX_TX_TGAS), "{g:?}");
    }
    let max_revoke = GAS_REVOKE_REQUIRED
        .saturating_sub(ext::GAS_KEY_OP)
        .saturating_add(Gas::from_tgas(MAX_OVERRIDE_TGAS));
    assert!(max_revoke <= Gas::from_tgas(gas::MAX_TX_TGAS));
    let max_recover = GAS_RECOVER_REQUIRED
        .saturating_sub(ext::GAS_TRANSFER)
        .saturating_add(Gas::from_tgas(MAX_OVERRIDE_TGAS));
    assert!(max_recover <= Gas::from_tgas(gas::MAX_TX_TGAS));
}

// ------------------------------------------------------------------ grant lifecycle

#[test]
fn grant_activates_after_confirmed_registration() {
    // gate: T1
    let mut h = H::new();
    h.grant();
    assert_eq!(
        methods(),
        [
            "v1.signer.derived_public_key",
            "oracle.near.get_price_no_older_than",
            "oracle.near.get_price_no_older_than",
            "intents.near.mt_batch_balance_of",
            "mandate.near.on_grant_prepared"
        ]
    );
    let derive = &calls()[0];
    assert_eq!(
        derive.args,
        json!({ "path": "mandate/v1/1", "predecessor": "mandate.near", "domain_id": 1 })
    );
    assert_eq!(h.grant_view().status, GrantStatus::Activating);

    h.prepare();
    let g = h.grant_view();
    assert_eq!(g.status, GrantStatus::Activating);
    assert!(g.key_op_in_flight);
    assert_eq!(g.initial_value, Some(U128(1_000 * USD)));
    let add = calls()
        .into_iter()
        .find(|c| c.method == "add_public_key")
        .unwrap();
    assert_eq!(add.receiver, "intents.near");
    assert_eq!(add.deposit, NearToken::from_yoctonear(1));
    assert_eq!(add.args["public_key"], json!(String::from(&h.pk())));

    // Proposals are refused until registration is confirmed.
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        set("agent.near", NOW, vec![]);
        h.c.propose_order(Proposal {
            sell: Asset::Usdc,
            sell_amount: U128(USDC),
            max_concession_bps: 0,
        })
    }));
    assert!(early.is_err());

    h.key_added(ok(Value::Null));
    let g = h.grant_view();
    assert_eq!(g.status, GrantStatus::Active);
    assert!(!g.key_op_in_flight);
    assert_eq!(events("grant_activated").len(), 1);

    // A duplicate registration callback changes nothing.
    h.key_added(ok(Value::Null));
    assert_eq!(h.grant_view(), g);
    assert!(calls().is_empty());
}

#[test]
fn grant_fails_closed_on_bad_inputs() {
    type Case = Box<dyn Fn(&H) -> Vec<PromiseResult>>;
    let cases: Vec<Case> = vec![
        Box::new(|_| {
            vec![
                fail(),
                px(100_000_000, NOW_SEC),
                px(300_000_000, NOW_SEC),
                balances(USDC, 0),
            ]
        }),
        Box::new(|h| {
            vec![
                h.pk_result(),
                ok(Value::Null),
                px(300_000_000, NOW_SEC),
                balances(USDC, 0),
            ]
        }),
        Box::new(|h| {
            vec![
                h.pk_result(),
                px(100_000_000, NOW_SEC - 61),
                px(300_000_000, NOW_SEC),
                balances(USDC, 0),
            ]
        }),
        Box::new(|h| {
            vec![
                h.pk_result(),
                px(100_000_000, NOW_SEC),
                px(300_000_000, NOW_SEC),
                fail(),
            ]
        }),
        Box::new(|h| {
            vec![
                h.pk_result(),
                px(100_000_000, NOW_SEC),
                px(300_000_000, NOW_SEC),
                balances(0, 0),
            ]
        }),
        Box::new(|_| {
            vec![
                ok(json!("secp256k1:abc")),
                px(100_000_000, NOW_SEC),
                px(300_000_000, NOW_SEC),
                balances(USDC, 0),
            ]
        }),
    ];
    for (i, case) in cases.iter().enumerate() {
        let mut h = H::new();
        h.grant();
        set("mandate.near", NOW, case(&h));
        h.c.on_grant_prepared(1);
        let g = h.grant_view();
        assert_eq!(g.status, GrantStatus::Revoked, "case {i}");
        assert!(g.public_key.is_none(), "case {i}");
        assert!(
            calls().is_empty(),
            "case {i}: no registration may be issued"
        );
        assert_eq!(events("grant_failed").len(), 1, "case {i}");
    }
}

#[test]
fn failed_registration_leaves_no_authority() {
    // gate: T1
    let mut h = H::new();
    h.grant();
    h.prepare();
    h.key_added(fail());
    let g = h.grant_view();
    assert_eq!(g.status, GrantStatus::Revoked);
    assert!(!g.key_op_in_flight);
    // A fresh grant uses a fresh path.
    h.grant();
    assert_eq!(h.grant_view().path, "mandate/v1/2");
}

#[test]
fn revoke_during_derivation_is_immediate_and_stale_preparation_is_ignored() {
    // gate: T1
    let mut h = H::new();
    h.grant();
    h.revoke();
    assert_eq!(h.grant_view().status, GrantStatus::Revoked);
    assert!(calls().is_empty(), "no key exists, nothing to remove");
    // The delayed valuation arrives: it must not register the key.
    h.prepare();
    assert!(calls().is_empty());
    assert_eq!(events("stale_callback").len(), 1);
    assert_eq!(h.grant_view().status, GrantStatus::Revoked);
}

#[test]
fn revoke_during_registration_removes_after_confirmation() {
    // gate: T1
    let mut h = H::new();
    h.grant();
    h.prepare();
    h.revoke();
    assert_eq!(h.grant_view().status, GrantStatus::Revoking);
    assert!(
        calls().is_empty(),
        "removal must wait for the in-flight registration"
    );
    // Retrying while registration is in flight cannot issue a racing removal.
    let retry = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.revoke()));
    assert!(retry.is_err());

    // Delayed registration succeeds: removal is issued from the callback, never activation.
    h.key_added(ok(Value::Null));
    assert_eq!(h.grant_view().status, GrantStatus::Revoking);
    assert_eq!(
        methods(),
        [
            "intents.near.remove_public_key",
            "mandate.near.on_key_removed"
        ]
    );
    assert!(events("grant_activated").is_empty());
    assert!(h.grant_view().key_op_in_flight);

    h.removed(1, ok(Value::Null));
    let g = h.grant_view();
    assert_eq!(g.status, GrantStatus::Revoked);
    assert!(!g.key_op_in_flight);
}

#[test]
fn revoke_during_registration_with_failed_registration() {
    let mut h = H::new();
    h.grant();
    h.prepare();
    h.revoke();
    h.key_added(fail());
    assert_eq!(h.grant_view().status, GrantStatus::Revoked);
    assert!(calls().is_empty());
}

#[test]
fn failed_removal_retries_and_confirms_absence() {
    // gate: T1
    let mut h = H::new();
    h.activate();
    let id = h.signed_order();
    h.revoke();
    assert_eq!(
        methods(),
        [
            "intents.near.remove_public_key",
            "mandate.near.on_key_removed"
        ]
    );
    assert_eq!(h.grant_view().status, GrantStatus::Revoking);
    // New authorization stops at once.
    let p = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.propose(Asset::Usdc, USDC, 0)
    }));
    assert!(p.is_err());

    // Removal fails: presence is checked; the key is still there.
    h.removed(1, fail());
    assert_eq!(
        methods(),
        [
            "intents.near.has_public_key",
            "mandate.near.on_key_presence"
        ]
    );
    h.presence(1, ok(json!(true)));
    let g = h.grant_view();
    assert_eq!(g.status, GrantStatus::Revoking);
    assert!(!g.key_op_in_flight);
    assert_eq!(
        h.state(id),
        OrderState::Signed,
        "signed authority stays accounted"
    );
    assert_eq!(g.outstanding, U128(30 * USD));

    // Owner retries with a larger gas budget.
    set("owner.near", NOW, vec![]);
    h.c.revoke(Some(40));
    let rm = calls()
        .into_iter()
        .find(|c| c.method == "remove_public_key")
        .unwrap();
    assert_eq!(rm.deposit, NearToken::from_yoctonear(1));
    // The retry's receipt failed because an earlier removal already applied: absence confirms.
    h.removed(2, fail());
    h.presence(2, ok(json!(false)));
    let g = h.grant_view();
    assert_eq!(g.status, GrantStatus::Revoked);
    assert_eq!(g.outstanding, U128(0));
    assert_eq!(
        g.turnover_used,
        U128(30 * USD),
        "release never refunds turnover"
    );
    assert_eq!(
        h.state(id),
        OrderState::Released {
            reason: ReleaseReason::KeyRemoved
        }
    );

    // Late callbacks of the first attempt are no-ops and never resurrect authority.
    h.removed(1, ok(Value::Null));
    h.presence(1, ok(json!(true)));
    assert_eq!(h.grant_view(), g);
}

#[test]
#[should_panic(expected = "gas override out of bounds")]
fn gas_override_is_bounded() {
    let mut h = H::new();
    h.activate();
    set("owner.near", NOW, vec![]);
    h.c.revoke(Some(MAX_OVERRIDE_TGAS + 1));
}

#[test]
fn regrant_requires_confirmed_revocation_and_uses_fresh_path() {
    // gate: T1
    let mut h = H::new();
    h.activate();
    let old = h.signed_order();
    for _ in 0..2 {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.grant()));
        assert!(r.is_err(), "no new grant may overlap unresolved authority");
        h.revoke();
    }
    h.removed(1, ok(Value::Null));
    assert_eq!(h.grant_view().status, GrantStatus::Revoked);

    h.activate();
    let g = h.grant_view();
    assert_eq!((g.epoch, g.path.as_str()), (2, "mandate/v1/2"));
    assert_eq!(g.outstanding, U128(0));
    assert_eq!(g.turnover_used, U128(0));
    // Stale callbacks of epoch 1 cannot touch epoch 2 or revive the old order.
    set("mandate.near", NOW, vec![ok(Value::Null)]);
    h.c.on_key_removed(1, 1);
    set("mandate.near", NOW, vec![ok(json!(true))]);
    h.c.on_settle_checked(old, 1);
    set("mandate.near", NOW, vec![h.signature_result(old)]);
    h.c.on_signed(old, 1);
    assert_eq!(h.grant_view(), g);
    assert_eq!(
        h.state(old),
        OrderState::Released {
            reason: ReleaseReason::KeyRemoved
        }
    );
}

// ------------------------------------------------------------------ orders

#[test]
fn order_reserves_before_any_external_call_and_signs_exact_payload() {
    // gate: T2
    let mut h = H::new();
    h.activate();
    let id = h.propose(Asset::Usdc, 30 * USDC, 50);
    let g = h.grant_view();
    assert_eq!(g.outstanding, U128(30 * USD));
    assert_eq!(g.turnover_used, U128(30 * USD));
    assert_eq!(h.state(id), OrderState::Pricing);
    assert_eq!(
        methods(),
        [
            "oracle.near.get_price_no_older_than",
            "oracle.near.get_price_no_older_than",
            "intents.near.current_salt",
            "intents.near.mt_batch_balance_of",
            "mandate.near.on_order_priced"
        ]
    );

    h.priced(id);
    let o = h.c.get_order(id).unwrap();
    assert_eq!(o.state, OrderState::Signing);
    // 30 USD / 3 USD = 10 wNEAR; less 0.5% = 9.95 wNEAR.
    assert_eq!(o.buy_amount, Some(U128(995 * NEAR / 100)));
    // min(now + 60 s, publish (now - 10 s) + 60 s) = now + 50 s.
    assert_eq!(o.deadline_ns, Some(U64(NOW + 50 * NS_PER_SEC)));
    let payload = o.payload.clone().unwrap();
    assert_eq!(payload.recipient, acc("intents.near"));
    let msg: Value = serde_json::from_str(&payload.message).unwrap();
    assert_eq!(msg["signer_id"], "mandate.near");
    assert_eq!(msg["intents"][0]["intent"], "token_diff");
    assert_eq!(msg["intents"][0]["diff"]["nep141:usdc.near"], "-30000000");
    assert_eq!(
        msg["intents"][0]["diff"]["nep141:wrap.near"],
        (995 * NEAR / 100).to_string()
    );
    let nonce = payload.nonce.0.clone();
    assert_eq!(
        &nonce[..9],
        &[0x56, 0x28, 0xf6, 0xc6, 0, 0x0a, 0x0b, 0x0c, 0x0d]
    );
    assert_eq!(&nonce[9..17], &(NOW + 50 * NS_PER_SEC).to_le_bytes());
    let expected_hash = protocol::nep413::prehash(&payload).unwrap();
    assert_eq!(o.payload_hash, Some(hex::encode(expected_hash)));
    let sign = calls().into_iter().find(|c| c.method == "sign").unwrap();
    assert_eq!(sign.receiver, "v1.signer");
    assert_eq!(sign.deposit, NearToken::from_yoctonear(1));
    assert_eq!(
        sign.args,
        json!({ "request": { "path": "mandate/v1/1", "payload_v2": { "Eddsa": hex::encode(expected_hash) }, "domain_id": 1 } })
    );

    h.signed(id);
    let o = h.c.get_order(id).unwrap();
    assert_eq!(o.state, OrderState::Signed);
    let ev = events("order_signed");
    assert_eq!(ev.len(), 1);
    let mp: Value = serde_json::from_str(ev[0]["multi_payload"].as_str().unwrap()).unwrap();
    assert_eq!(mp["standard"], "nep413");
    assert_eq!(mp["public_key"], json!(String::from(&h.pk())));
    assert_eq!(mp["signature"], json!(o.signature.clone().unwrap()));
    assert_eq!(mp["payload"]["message"], json!(payload.message));
}

#[test]
fn proposal_bounds_are_enforced_at_propose() {
    // gate: BOUNDARY
    let mut h = H::new();
    h.activate();
    let attempt = |h: &mut H, sell, amount, bps| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            h.propose(sell, amount, bps)
        }))
        .map_err(|e| e.downcast_ref::<String>().cloned().unwrap_or_default())
    };
    assert!(
        attempt(&mut h, Asset::Usdc, 0, 0)
            .unwrap_err()
            .contains("positive")
    );
    assert!(
        attempt(&mut h, Asset::Usdc, USDC, 51)
            .unwrap_err()
            .contains("concession")
    );
    // Per-order cap: 20% of $1000 = $200.
    assert!(
        attempt(&mut h, Asset::Usdc, 200 * USDC + 1, 0)
            .unwrap_err()
            .contains("per-order")
    );
    assert!(
        attempt(&mut h, Asset::Wnear, u128::MAX, 0)
            .unwrap_err()
            .contains("too large")
    );
    // Outstanding cap counts pending proposals: $150 then $60 exceeds $200.
    attempt(&mut h, Asset::Usdc, 150 * USDC, 0).unwrap();
    assert!(
        attempt(&mut h, Asset::Usdc, 60 * USDC, 0)
            .unwrap_err()
            .contains("outstanding")
    );
    attempt(&mut h, Asset::Usdc, 50 * USDC, 0).unwrap();
    assert_eq!(h.grant_view().outstanding, U128(200 * USD));
}

#[test]
fn turnover_is_never_refunded_by_release() {
    // gate: T2
    let mut h = H::new();
    h.activate();
    // Five settled $200 orders exhaust the $1000 turnover cap.
    for _ in 0..5 {
        let id = h.propose(Asset::Usdc, 200 * USDC, 0);
        h.priced(id);
        h.signed(id);
        set("anyone.near", NOW, vec![]);
        let _ = h.c.settle_order(id);
        h.settle_checked(id, ok(json!(true)));
        assert_eq!(
            h.state(id),
            OrderState::Released {
                reason: ReleaseReason::Settled
            }
        );
    }
    let g = h.grant_view();
    assert_eq!(g.outstanding, U128(0));
    assert_eq!(g.turnover_used, U128(1_000 * USD));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.propose(Asset::Usdc, USDC, 0)
    }));
    assert!(r.is_err());
}

#[test]
fn settlement_releases_exactly_once_on_verifier_evidence() {
    // gate: T2
    let mut h = H::new();
    h.activate();
    let id = h.signed_order();
    set("filler.near", NOW, vec![]);
    let _ = h.c.settle_order(id);
    let check = calls()
        .into_iter()
        .find(|c| c.method == "is_nonce_used")
        .unwrap();
    assert_eq!(check.args["account_id"], "mandate.near");
    let nonce = h.c.get_order(id).unwrap().payload.unwrap().nonce;
    assert_eq!(check.args["nonce"], json!(nonce));

    // Not used yet, or a failed read: nothing is released.
    h.settle_checked(id, ok(json!(false)));
    h.settle_checked(id, fail());
    assert_eq!(h.state(id), OrderState::Signed);
    assert_eq!(h.grant_view().outstanding, U128(30 * USD));

    h.settle_checked(id, ok(json!(true)));
    assert_eq!(h.grant_view().outstanding, U128(0));
    // Duplicate evidence and expiry after settlement are no-ops.
    h.settle_checked(id, ok(json!(true)));
    assert_eq!(events("order_released").len(), 0);
    h.now = NOW + 3_600 * NS_PER_SEC;
    set("anyone.near", h.now, vec![]);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.c.expire_order(id)));
    assert!(r.is_err());
    assert_eq!(h.grant_view().outstanding, U128(0));
}

#[test]
fn expiry_requires_block_time_strictly_after_deadline() {
    // gate: T2
    let mut h = H::new();
    h.activate();
    let id = h.signed_order();
    let deadline = h.c.get_order(id).unwrap().deadline_ns.unwrap().0;
    set("anyone.near", deadline, vec![]);
    let at = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.c.expire_order(id)));
    assert!(
        at.is_err(),
        "the verifier still accepts the nonce at its deadline"
    );
    set("anyone.near", deadline + 1, vec![]);
    h.c.expire_order(id);
    assert_eq!(
        h.state(id),
        OrderState::Released {
            reason: ReleaseReason::Expired
        }
    );
    let g = h.grant_view();
    assert_eq!(g.outstanding, U128(0));
    assert_eq!(g.turnover_used, U128(30 * USD));
}

#[test]
fn unknown_signature_keeps_reservation() {
    // gate: T2b
    let mut h = H::new();
    h.activate();
    let a = h.propose(Asset::Usdc, 30 * USDC, 0);
    h.priced(a);
    h.signed_with(a, fail());
    assert_eq!(h.state(a), OrderState::SignUnknown);
    // A signature that does not verify under the grant key is not recorded either.
    let b = h.propose(Asset::Usdc, 30 * USDC, 0);
    h.priced(b);
    let hash = hex::decode(h.c.get_order(b).unwrap().payload_hash.unwrap()).unwrap();
    let wrong = SigningKey::from_bytes(&[9; 32]).sign(&hash).to_bytes();
    h.signed_with(
        b,
        ok(json!({ "scheme": "Ed25519", "signature": wrong.to_vec() })),
    );
    assert_eq!(h.state(b), OrderState::SignUnknown);
    assert!(h.c.get_order(b).unwrap().signature.is_none());
    assert_eq!(h.grant_view().outstanding, U128(60 * USD));

    // Settlement evidence still releases an order whose callback lost the signature.
    set("relayer.near", NOW, vec![]);
    let _ = h.c.settle_order(a);
    h.settle_checked(a, ok(json!(true)));
    assert_eq!(
        h.state(a),
        OrderState::Released {
            reason: ReleaseReason::Settled
        }
    );
    // A later valid response for an order already marked SignUnknown is not a continuation.
    let sig = h.signature_result(b);
    h.signed_with(b, sig);
    assert_eq!(h.state(b), OrderState::SignUnknown);
}

#[test]
fn rejection_before_sign_request_refunds_turnover() {
    // gate: T3
    let mut h = H::new();
    h.activate();
    let t = NOW_SEC - 10;
    let salt = || ok(json!("0a0b0c0d"));
    let bal = || balances(1_000 * USDC, 0);
    let cases: Vec<(&str, Vec<PromiseResult>)> = vec![
        (
            "stale",
            vec![
                px(100_000_000, NOW_SEC - 61),
                px(300_000_000, t),
                salt(),
                bal(),
            ],
        ),
        (
            "missing",
            vec![ok(Value::Null), px(300_000_000, t), salt(), bal()],
        ),
        ("failed", vec![px(100_000_000, t), fail(), salt(), bal()]),
        (
            "confidence",
            vec![
                px(100_000_000, t),
                ok(
                    json!({ "price": "300000000", "conf": "1500001", "expo": -8, "publish_time": t }),
                ),
                salt(),
                bal(),
            ],
        ),
        (
            "salt",
            vec![px(100_000_000, t), px(300_000_000, t), fail(), bal()],
        ),
        (
            "balance",
            vec![
                px(100_000_000, t),
                px(300_000_000, t),
                salt(),
                balances(29 * USDC, 400 * NEAR),
            ],
        ),
        (
            "deadline",
            vec![
                px(100_000_000, NOW_SEC - 50),
                px(300_000_000, t),
                salt(),
                bal(),
            ],
        ),
    ];
    for (name, results) in cases {
        let id = h.propose(Asset::Usdc, 30 * USDC, 0);
        h.priced_with(id, results);
        assert!(matches!(h.state(id), OrderState::Rejected { .. }), "{name}");
        assert!(calls().is_empty(), "{name}: no sign request");
        let g = h.grant_view();
        assert_eq!(
            (g.outstanding, g.turnover_used),
            (U128(0), U128(0)),
            "{name}"
        );
    }
}

#[test]
fn reservation_uses_the_higher_of_initial_and_current_value() {
    // gate: T3
    let mut h = H::new();
    h.activate();
    let id = h.propose(Asset::Usdc, 150 * USDC, 0);
    assert_eq!(h.grant_view().outstanding, U128(150 * USD));
    // USDC at $1.10 makes the order worth $165; wNEAR at $3.30.
    let t = NOW_SEC - 10;
    h.priced_with(
        id,
        vec![
            px(110_000_000, t),
            px(330_000_000, t),
            ok(json!("0a0b0c0d")),
            balances(1_000 * USDC, 0),
        ],
    );
    let o = h.c.get_order(id).unwrap();
    assert_eq!(o.reserved_value, U128(165 * USD));
    let g = h.grant_view();
    assert_eq!(
        (g.outstanding, g.turnover_used),
        (U128(165 * USD), U128(165 * USD))
    );
    // 150 USDC * 1.10 / 3.30 = 50 wNEAR exactly at zero concession.
    assert_eq!(o.buy_amount, Some(U128(50 * NEAR)));

    // At $1.40 a $30 proposal is worth $42: $165 + $42 exceeds the $200 outstanding cap.
    let id2 = h.propose(Asset::Usdc, 30 * USDC, 0);
    h.priced_with(
        id2,
        vec![
            px(140_000_000, t),
            px(330_000_000, t),
            ok(json!("0a0b0c0d")),
            balances(1_000 * USDC, 0),
        ],
    );
    assert!(matches!(h.state(id2), OrderState::Rejected { .. }));
    assert_eq!(h.grant_view().outstanding, U128(165 * USD));
}

#[test]
fn concession_boundary_rounds_in_the_mandates_favour() {
    // gate: T3
    let mut h = H::new();
    h.activate();
    // Selling 333_333_333_333_333_333 yocto-wNEAR at $3 is worth 0.999999999999999999 USDC units.
    let t = NOW_SEC - 10;
    let id = h.propose(Asset::Wnear, 333_333_333_333_333_333, 50);
    h.priced_with(
        id,
        vec![
            px(100_000_000, t),
            px(300_000_000, t),
            ok(json!("0a0b0c0d")),
            balances(1_000 * USDC, NEAR),
        ],
    );
    let o = h.c.get_order(id).unwrap();
    // With 50 bps that is 0.99499.. units, rounded up to 1 in the mandate's favour.
    assert_eq!(o.buy_amount, Some(U128(1)));
    let sell = 333_333_333_333_333_333u128;
    let buy = o.buy_amount.unwrap().0;
    // Realised concession: buy * 1e24 * 1 >= sell * 3 * 1e6 * (10000 - 50) / 10000.
    assert!(buy * NEAR * 10_000 >= sell * 3 * USDC * 9_950);
}

#[test]
fn breaker_trips_on_drawdown_and_reports_executable_orders() {
    // gate: T3
    let mut h = H::new();
    h.activate();
    let signed = h.signed_order();
    let pending = h.propose(Asset::Usdc, 10 * USDC, 0);
    // Holdings: 970 USDC + 3 wNEAR at $3 = $979 <= $980 threshold.
    let t = NOW_SEC - 10;
    h.priced_with(
        pending,
        vec![
            px(100_000_000, t),
            px(300_000_000, t),
            ok(json!("0a0b0c0d")),
            balances(970 * USDC, 3 * NEAR),
        ],
    );
    assert!(matches!(h.state(pending), OrderState::Rejected { .. }));
    let trip = h.grant_view().breaker.unwrap();
    assert_eq!(trip.observed_at_ns, U64(NOW));
    assert_eq!(trip.observed_value, U128(979 * USD));
    assert_eq!(trip.executable_orders, 1);
    assert_eq!(trip.executable_value, U128(30 * USD));
    assert_eq!(events("breaker_tripped").len(), 1);
    assert_eq!(h.state(signed), OrderState::Signed);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.propose(Asset::Usdc, USDC, 0)
    }));
    assert!(r.is_err());
}

#[test]
fn breaker_threshold_is_inclusive_and_above_it_signs() {
    // gate: T3
    let mut h = H::new();
    h.activate();
    let t = NOW_SEC - 10;
    let id = h.propose(Asset::Usdc, 10 * USDC, 0);
    // $980.000001 is above the threshold.
    h.priced_with(
        id,
        vec![
            px(100_000_000, t),
            px(300_000_000, t),
            ok(json!("0a0b0c0d")),
            balances(980 * USDC + 1, 0),
        ],
    );
    assert_eq!(h.state(id), OrderState::Signing);
    let id = h.propose(Asset::Usdc, 10 * USDC, 0);
    h.priced_with(
        id,
        vec![
            px(100_000_000, t),
            px(300_000_000, t),
            ok(json!("0a0b0c0d")),
            balances(980 * USDC, 0),
        ],
    );
    assert!(matches!(h.state(id), OrderState::Rejected { .. }));
    assert!(h.grant_view().breaker.is_some());
}

#[test]
fn pricing_timeout_releases_without_refund_and_late_pricing_is_ignored() {
    // gate: T2
    let mut h = H::new();
    h.activate();
    let id = h.propose(Asset::Usdc, 30 * USDC, 0);
    set("anyone.near", NOW + 30 * NS_PER_SEC, vec![]);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.c.expire_order(id)));
    assert!(early.is_err());
    set("anyone.near", NOW + 30 * NS_PER_SEC + 1, vec![]);
    h.c.expire_order(id);
    assert_eq!(
        h.state(id),
        OrderState::Released {
            reason: ReleaseReason::Unsigned
        }
    );
    let g = h.grant_view();
    assert_eq!((g.outstanding, g.turnover_used), (U128(0), U128(30 * USD)));
    h.priced(id);
    assert!(calls().is_empty(), "a released order is never signed");
    assert_eq!(h.grant_view(), g);
}

#[test]
fn late_pricing_callback_beyond_delay_is_not_signed() {
    let mut h = H::new();
    h.activate();
    let id = h.propose(Asset::Usdc, 30 * USDC, 0);
    h.now = NOW + 31 * NS_PER_SEC;
    h.priced(id);
    assert!(calls().is_empty());
    assert_eq!(
        h.state(id),
        OrderState::Released {
            reason: ReleaseReason::Unsigned
        }
    );
}

#[test]
fn revocation_releases_every_open_order_once() {
    // gate: T1
    let mut h = H::new();
    h.activate();
    let signed = h.signed_order();
    let signing = h.propose(Asset::Usdc, 30 * USDC, 0);
    h.priced(signing);
    let pricing = h.propose(Asset::Usdc, 30 * USDC, 0);
    let settled = h.signed_order();
    set("anyone.near", NOW, vec![]);
    let _ = h.c.settle_order(settled);
    h.settle_checked(settled, ok(json!(true)));
    assert_eq!(h.grant_view().outstanding, U128(90 * USD));

    h.revoke();
    // Revoking keeps signed authority accounted.
    assert_eq!(h.grant_view().outstanding, U128(90 * USD));
    h.removed(1, ok(Value::Null));
    for id in [signed, signing, pricing] {
        assert_eq!(
            h.state(id),
            OrderState::Released {
                reason: ReleaseReason::KeyRemoved
            }
        );
    }
    assert_eq!(
        h.state(settled),
        OrderState::Released {
            reason: ReleaseReason::Settled
        }
    );
    let g = h.grant_view();
    assert_eq!(g.outstanding, U128(0));
    assert_eq!(events("order_released").len(), 3);

    // Late continuations of released orders do nothing.
    h.priced(pricing);
    let sig = h.signature_result(signing);
    h.signed_with(signing, sig);
    h.settle_checked(signed, ok(json!(true)));
    assert!(calls().is_empty());
    assert_eq!(h.grant_view(), g);
}

#[test]
fn open_orders_are_bounded() {
    let mut h = H::new();
    h.activate();
    for _ in 0..MAX_OPEN_ORDERS {
        h.propose(Asset::Usdc, 1, 0);
    }
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        h.propose(Asset::Usdc, 1, 0)
    }));
    assert!(r.is_err());
}

#[test]
fn nonces_differ_for_orders_priced_in_one_block() {
    let mut h = H::new();
    h.activate();
    let a = h.propose(Asset::Usdc, 10 * USDC, 0);
    let b = h.propose(Asset::Usdc, 10 * USDC, 0);
    h.priced(a);
    h.priced(b);
    let na = h.c.get_order(a).unwrap().payload.unwrap().nonce;
    let nb = h.c.get_order(b).unwrap().payload.unwrap().nonce;
    assert_ne!(na, nb);
}

#[test]
fn list_orders_pages() {
    let mut h = H::new();
    h.activate();
    for _ in 0..3 {
        h.propose(Asset::Usdc, USDC, 0);
    }
    let ids: Vec<u64> =
        h.c.list_orders(Some(U64(1)), Some(5))
            .iter()
            .map(|o| o.id.0)
            .collect();
    assert_eq!(ids, [1, 2]);
    assert_eq!(h.c.list_orders(None, None).len(), 3);
}

// ------------------------------------------------------------------ recovery

fn recover(h: &mut H, asset: Asset) {
    set("owner.near", h.now, vec![]);
    let _ = h.c.recover(asset, None);
}

#[test]
fn recovery_requires_confirmed_revocation() {
    // gate: T4
    let mut h = H::new();
    h.activate();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        recover(&mut h, Asset::Usdc)
    }));
    assert!(r.is_err());
    h.revoke();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        recover(&mut h, Asset::Usdc)
    }));
    assert!(r.is_err(), "revoking is not enough");
    h.removed(1, ok(Value::Null));
    recover(&mut h, Asset::Usdc);
    assert_eq!(
        methods(),
        [
            "intents.near.mt_balance_of",
            "mandate.near.on_recovery_balance"
        ]
    );
}

#[test]
fn recovery_pays_owner_once_and_retries_after_failure() {
    // gate: T4
    let mut h = H::new();
    recover(&mut h, Asset::Wnear);
    let tgas = ext::GAS_TRANSFER.as_tgas();
    // A concurrent attempt is refused while one is in flight.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        recover(&mut h, Asset::Wnear)
    }));
    assert!(r.is_err());
    // The other asset is independent.
    recover(&mut h, Asset::Usdc);

    set("mandate.near", NOW, vec![ok(json!((5 * NEAR).to_string()))]);
    h.c.on_recovery_balance(Asset::Wnear, 1, tgas);
    let t = calls()
        .into_iter()
        .find(|c| c.method == "mt_transfer")
        .unwrap();
    assert_eq!(t.receiver, "intents.near");
    assert_eq!(t.deposit, NearToken::from_yoctonear(1));
    assert_eq!(t.args["receiver_id"], "owner.near");
    assert_eq!(t.args["token_id"], "nep141:wrap.near");
    assert_eq!(t.args["amount"], (5 * NEAR).to_string());
    assert!(
        !methods()
            .iter()
            .any(|m| m.starts_with("oracle") || m.starts_with("v1.signer"))
    );

    // The transfer receipt fails (e.g. paused): the lock clears and nothing is counted.
    set("mandate.near", NOW, vec![fail()]);
    h.c.on_recovery_transferred(Asset::Wnear, 1, U128(5 * NEAR));
    let v = &h.c.get_recovery()[1];
    assert_eq!((v.in_flight, v.recovered), (false, U128(0)));
    assert_eq!(events("recovery_failed").len(), 1);

    // Retry reads a fresh balance and succeeds.
    recover(&mut h, Asset::Wnear);
    set("mandate.near", NOW, vec![ok(json!((5 * NEAR).to_string()))]);
    h.c.on_recovery_balance(Asset::Wnear, 2, tgas);
    set("mandate.near", NOW, vec![ok(Value::Null)]);
    h.c.on_recovery_transferred(Asset::Wnear, 2, U128(5 * NEAR));
    // Duplicate or stale balance callbacks issue nothing.
    set("mandate.near", NOW, vec![ok(json!((5 * NEAR).to_string()))]);
    h.c.on_recovery_balance(Asset::Wnear, 2, tgas);
    h.c.on_recovery_balance(Asset::Wnear, 1, tgas);
    assert!(calls().is_empty());
    let v = &h.c.get_recovery()[1];
    assert_eq!(
        (v.in_flight, v.attempts, v.recovered),
        (false, 2, U128(5 * NEAR))
    );

    // Empty balance finishes without a transfer.
    recover(&mut h, Asset::Wnear);
    set("mandate.near", NOW, vec![ok(json!("0"))]);
    h.c.on_recovery_balance(Asset::Wnear, 3, tgas);
    assert!(calls().is_empty());
    assert!(!h.c.get_recovery()[1].in_flight);
}

#[test]
fn stale_recovery_lock_can_be_superseded() {
    // gate: T4
    let mut h = H::new();
    recover(&mut h, Asset::Usdc);
    h.now = NOW + RECOVERY_LOCK_TIMEOUT_NS + 1;
    recover(&mut h, Asset::Usdc);
    assert_eq!(h.c.get_recovery()[0].attempts, 2);
    // A grant cannot start while recovery is in flight.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| h.grant()));
    assert!(r.is_err());
}

#[test]
fn every_event_uses_the_standard() {
    let mut h = H::new();
    h.activate();
    let logs = get_logs();
    assert!(!logs.is_empty());
    for l in logs {
        let e: Value = serde_json::from_str(l.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(
            (e["standard"].as_str(), e["version"].as_str()),
            (Some("bounded_mandate"), Some("1.0.0"))
        );
    }
}
