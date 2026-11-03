//! T5 baseline: the Claw Guard pattern adapted to NEAR Intents `token_diff` trading.
//!
//! Design source: Claw Guard, https://github.com/metafrogmeme-droid/claw-guard-near at commit
//! 225d37d3c1b04959947fa7c18544fa50e273dcd8, MIT License, Copyright (c) 2026 Patrick Baur
//! (RUNECLAW). This is a re-implementation of its authority model, not a copy of its code; the
//! adaptations are disclosed in `tests/t5_baseline.rs` and recorded in `out/evidence/tests/T5.json`.
//!
//! Kept from Claw Guard: the agent holds only a function-call key for `propose_order`; the
//! contract evaluates owner rules in a fixed order (first failure wins), stores a receipt for
//! every decision, builds the payload itself from owner data and asks the MPC to sign it under a
//! fixed per-target derivation path; `on_signed` records the signature, or on any failure marks
//! the receipt `SignFailed` and releases that day's reservation; `pause` / `remove_agent` stop
//! later proposals only (Claw Guard Q-45); counters are per UTC day; re-registration resets them.
//! Adapted: the venue is the owner's own Intents account (the Hyperliquid master-account analog)
//! on which the owner registers the derived key with `add_public_key`; the signed payload is a
//! NEP-413 `token_diff` over exactly USDC and wNEAR with a finite deadline.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, env, near, require,
};

/// Fixed MPC derivation path for the Intents target, like Claw Guard's `hl-testnet-1`.
pub const INTENTS_PATH: &str = "intents-1";
pub const ED25519_DOMAIN: u32 = 1;
const NEP413_TAG: u32 = 2_147_484_061;
const NS_PER_SEC: u64 = 1_000_000_000;
const SECS_PER_DAY: u64 = 86_400;
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const GAS_MARGIN: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Token {
    Usdc,
    Wnear,
}

/// The owner's rules for one agent. Amounts are raw token units; notional is USDC units.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    pub max_sell_usdc: U128,
    pub max_sell_wnear: U128,
    /// Per-order notional in USDC units: the USDC side of the order (for a wNEAR sell, the
    /// agent's minimum USDC, a lower bound like Claw Guard's sell notional, Q-42).
    pub max_order_notional: U128,
    /// Per UTC day, signed notional in USDC units.
    pub daily_cap: U128,
    pub max_orders_per_day: u32,
    pub expires_at_ns: U64,
    /// Adaptation: Intents payloads need a deadline; the baseline gets the mandate's finite TTL.
    pub order_ttl_sec: u64,
}

/// Agent input. Not `deny_unknown_fields`, like Claw Guard's `Proposal`.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub sell: Token,
    pub sell_amount: U128,
    pub min_buy_amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Blocked,
    PendingSignature,
    Signed,
    SignFailed,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nep413Payload {
    pub message: String,
    /// Base64 of the 32-byte nonce.
    pub nonce: String,
    pub recipient: String,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub id: U64,
    pub agent_id: AccountId,
    pub proposal: Proposal,
    pub status: Status,
    pub rule_code: Option<String>,
    pub notional: U128,
    pub payload: Option<Nep413Payload>,
    pub payload_hash: Option<String>,
    pub derivation_path: Option<String>,
    /// `ed25519:<base58>`; public once signed (Claw Guard: anyone can read it via `get_receipt`).
    pub signature: Option<String>,
    pub rules_version: u32,
    pub timestamp_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentState {
    pub rules: Rules,
    pub rules_version: u32,
    pub day: u64,
    pub spent_today: U128,
    pub orders_today: u32,
}

#[near(serializers = [json])]
pub struct Decision {
    pub allowed: bool,
    pub receipt_id: U64,
    pub rule_code: Option<String>,
}

#[near(serializers = [json])]
pub struct GuardStatus {
    pub owner: AccountId,
    pub paused: bool,
    pub verifier: AccountId,
    pub mpc: AccountId,
    pub receipts_count: U64,
}

#[near(serializers = [json])]
pub struct GuardConfig {
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub verifier_id: AccountId,
    pub usdc_id: AccountId,
    pub wnear_id: AccountId,
    pub sign_deposit_yocto: U128,
    pub sign_gas_tgas: u64,
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Receipts,
    PendingSigns,
}

#[near(serializers = [borsh])]
struct AgentRecord {
    state: AgentState,
    registration: u64,
}

#[near(serializers = [borsh])]
struct PendingSign {
    agent_id: AccountId,
    registration: u64,
    day: u64,
    spend: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ClawGuardAdapted {
    owner_id: AccountId,
    mpc_contract_id: AccountId,
    verifier_id: AccountId,
    usdc_id: AccountId,
    wnear_id: AccountId,
    sign_deposit_yocto: u128,
    sign_gas_tgas: u64,
    paused: bool,
    agents: LookupMap<AccountId, AgentRecord>,
    registrations: u64,
    receipts: LookupMap<u64, Receipt>,
    receipts_count: u64,
    pending_signs: LookupMap<u64, PendingSign>,
}

struct Approved {
    spend: u128,
}

fn day_of(ns: u64) -> u64 {
    ns.checked_div(NS_PER_SEC.saturating_mul(SECS_PER_DAY))
        .unwrap_or(0)
}

#[near]
impl ClawGuardAdapted {
    #[init]
    #[private]
    pub fn new(config: GuardConfig) -> Self {
        Self {
            owner_id: config.owner_id,
            mpc_contract_id: config.mpc_contract_id,
            verifier_id: config.verifier_id,
            usdc_id: config.usdc_id,
            wnear_id: config.wnear_id,
            sign_deposit_yocto: config.sign_deposit_yocto.0,
            sign_gas_tgas: config.sign_gas_tgas,
            paused: false,
            agents: LookupMap::new(StorageKey::Agents),
            registrations: 0,
            receipts: LookupMap::new(StorageKey::Receipts),
            receipts_count: 0,
            pending_signs: LookupMap::new(StorageKey::PendingSigns),
        }
    }

    pub fn propose_order(&mut self, proposal: Proposal) -> PromiseOrValue<Decision> {
        let agent_id = env::predecessor_account_id();
        let now_ns = env::block_timestamp();
        let record = self
            .agents
            .get(&agent_id)
            .unwrap_or_else(|| env::panic_str("ERR_NOT_AGENT"));
        let rules_version = record.state.rules_version;
        match self.evaluate(&record.state, now_ns, &proposal) {
            Err(code) => {
                let id = self.push_receipt(Receipt {
                    rule_code: Some(code.to_owned()),
                    ..self.new_receipt(agent_id, proposal, rules_version, Status::Blocked, 0)
                });
                PromiseOrValue::Value(Decision {
                    allowed: false,
                    receipt_id: U64(id),
                    rule_code: Some(code.to_owned()),
                })
            }
            Ok(approved) => PromiseOrValue::Promise(self.request_signature(
                agent_id,
                proposal,
                rules_version,
                approved,
                now_ns,
            )),
        }
    }

    #[private]
    pub fn on_signed(
        &mut self,
        receipt_id: U64,
        #[callback_result(max_bytes = 1024)] result: Result<Value, PromiseError>,
    ) -> Decision {
        let id = receipt_id.0;
        let pending = self
            .pending_signs
            .remove(&id)
            .unwrap_or_else(|| env::panic_str("ERR_NO_PENDING_SIGNATURE"));
        let signature = result.ok().as_ref().and_then(parse_ed25519_signature);
        let allowed = signature.is_some();
        if !allowed {
            self.release(&pending);
        }
        if let Some(receipt) = self.receipts.get_mut(&id) {
            receipt.status = if allowed {
                Status::Signed
            } else {
                Status::SignFailed
            };
            receipt.signature = signature;
        }
        Decision {
            allowed,
            receipt_id,
            rule_code: None,
        }
    }

    #[payable]
    pub fn register_agent(&mut self, agent_id: AccountId, rules: Rules) {
        self.assert_owner_one_yocto();
        require!(!self.agents.contains_key(&agent_id), "ERR_AGENT_EXISTS");
        self.registrations = self
            .registrations
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("overflow"));
        let state = AgentState {
            rules,
            rules_version: 1,
            day: day_of(env::block_timestamp()),
            spent_today: U128(0),
            orders_today: 0,
        };
        self.agents.insert(
            agent_id,
            AgentRecord {
                state,
                registration: self.registrations,
            },
        );
    }

    #[payable]
    pub fn remove_agent(&mut self, agent_id: AccountId) {
        self.assert_owner_one_yocto();
        require!(self.agents.remove(&agent_id).is_some(), "ERR_NOT_AGENT");
    }

    pub fn pause(&mut self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_NOT_OWNER"
        );
        self.paused = true;
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_one_yocto();
        self.paused = false;
    }

    pub fn get_status(&self) -> GuardStatus {
        GuardStatus {
            owner: self.owner_id.clone(),
            paused: self.paused,
            verifier: self.verifier_id.clone(),
            mpc: self.mpc_contract_id.clone(),
            receipts_count: U64(self.receipts_count),
        }
    }

    pub fn get_rules(&self, agent_id: AccountId) -> Option<AgentState> {
        let today = day_of(env::block_timestamp());
        self.agents.get(&agent_id).map(|record| {
            let (spent, orders) = counters_on(&record.state, today);
            AgentState {
                day: today,
                spent_today: U128(spent),
                orders_today: orders,
                ..record.state.clone()
            }
        })
    }

    pub fn get_receipt(&self, id: U64) -> Option<Receipt> {
        self.receipts.get(&id.0).cloned()
    }

    pub fn get_paths(&self) -> Vec<(String, String)> {
        vec![("Intents".to_owned(), INTENTS_PATH.to_owned())]
    }
}

fn counters_on(state: &AgentState, day: u64) -> (u128, u32) {
    if state.day == day {
        (state.spent_today.0, state.orders_today)
    } else {
        (0, 0)
    }
}

impl ClawGuardAdapted {
    fn assert_owner_one_yocto(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_NOT_OWNER"
        );
        near_sdk::assert_one_yocto();
    }

    /// Claw Guard's fixed rule order, restricted to the rules that apply to a token_diff:
    /// PAUSED, EXPIRED, MALFORMED, ORDER_ABOVE_CAP, DAILY_ORDER_COUNT, DAILY_CAP.
    fn evaluate(
        &self,
        agent: &AgentState,
        now_ns: u64,
        proposal: &Proposal,
    ) -> Result<Approved, &'static str> {
        let rules = &agent.rules;
        if self.paused {
            return Err("PAUSED");
        }
        if now_ns > rules.expires_at_ns.0 {
            return Err("EXPIRED");
        }
        let (sell, min_buy) = (proposal.sell_amount.0, proposal.min_buy_amount.0);
        if sell == 0 || min_buy == 0 || i128::try_from(sell.max(min_buy)).is_err() {
            return Err("MALFORMED");
        }
        let (token_cap, notional) = match proposal.sell {
            Token::Usdc => (rules.max_sell_usdc.0, sell),
            Token::Wnear => (rules.max_sell_wnear.0, min_buy),
        };
        if sell > token_cap || notional > rules.max_order_notional.0 {
            return Err("ORDER_ABOVE_CAP");
        }
        let (spent, orders) = counters_on(agent, day_of(now_ns));
        if orders >= rules.max_orders_per_day {
            return Err("DAILY_ORDER_COUNT");
        }
        if spent
            .checked_add(notional)
            .is_none_or(|v| v > rules.daily_cap.0)
        {
            return Err("DAILY_CAP");
        }
        Ok(Approved { spend: notional })
    }

    fn new_receipt(
        &self,
        agent_id: AccountId,
        proposal: Proposal,
        rules_version: u32,
        status: Status,
        notional: u128,
    ) -> Receipt {
        Receipt {
            id: U64(0),
            agent_id,
            proposal,
            status,
            rule_code: None,
            notional: U128(notional),
            payload: None,
            payload_hash: None,
            derivation_path: None,
            signature: None,
            rules_version,
            timestamp_ns: U64(env::block_timestamp()),
        }
    }

    fn push_receipt(&mut self, mut receipt: Receipt) -> u64 {
        self.receipts_count = self
            .receipts_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("overflow"));
        let id = self.receipts_count;
        receipt.id = U64(id);
        self.receipts.insert(id, receipt);
        id
    }

    fn request_signature(
        &mut self,
        agent_id: AccountId,
        proposal: Proposal,
        rules_version: u32,
        approved: Approved,
        now_ns: u64,
    ) -> Promise {
        let sign_gas = Gas::from_tgas(self.sign_gas_tgas);
        let required = sign_gas
            .checked_add(CALLBACK_GAS)
            .and_then(|g| g.checked_add(GAS_MARGIN))
            .unwrap_or_else(|| env::panic_str("ERR_NOT_ENOUGH_GAS"));
        let remaining = env::prepaid_gas().saturating_sub(env::used_gas());
        require!(remaining >= required, "ERR_NOT_ENOUGH_GAS");

        let day = day_of(now_ns);
        let record = self
            .agents
            .get_mut(&agent_id)
            .unwrap_or_else(|| env::panic_str("ERR_NOT_AGENT"));
        let (spent, orders) = counters_on(&record.state, day);
        record.state.day = day;
        record.state.spent_today = U128(spent.saturating_add(approved.spend));
        record.state.orders_today = orders.saturating_add(1);
        let registration = record.registration;
        let ttl_ns = record.state.rules.order_ttl_sec.saturating_mul(NS_PER_SEC);

        let id = self
            .receipts_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("overflow"));
        let payload = self.build_payload(&proposal, id, now_ns.saturating_add(ttl_ns));
        let hash = nep413_hash(&payload);
        let receipt = Receipt {
            payload: Some(payload),
            payload_hash: Some(hex::encode(hash)),
            derivation_path: Some(INTENTS_PATH.to_owned()),
            ..self.new_receipt(
                agent_id.clone(),
                proposal,
                rules_version,
                Status::PendingSignature,
                approved.spend,
            )
        };
        let id = self.push_receipt(receipt);
        self.pending_signs.insert(
            id,
            PendingSign {
                agent_id,
                registration,
                day,
                spend: approved.spend,
            },
        );
        let args = json!({ "request": {
            "path": INTENTS_PATH,
            "payload_v2": { "Eddsa": hex::encode(hash) },
            "domain_id": ED25519_DOMAIN,
        }});
        Promise::new(self.mpc_contract_id.clone())
            .function_call_weight(
                "sign",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(self.sign_deposit_yocto),
                sign_gas,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_signed(U64(id)),
            )
    }

    /// Claw Guard releases a failed request's reservation only on the same UTC day and the same
    /// registration; signed or not, the nonce (here: receipt id) stays consumed.
    fn release(&mut self, pending: &PendingSign) {
        let today = day_of(env::block_timestamp());
        if let Some(record) = self.agents.get_mut(&pending.agent_id)
            && record.registration == pending.registration
            && pending.day == today
            && record.state.day == today
        {
            record.state.spent_today =
                U128(record.state.spent_today.0.saturating_sub(pending.spend));
            record.state.orders_today = record.state.orders_today.saturating_sub(1);
        }
    }

    /// The signer is the owner's Intents account: the owner registered the derived key there.
    fn build_payload(
        &self,
        proposal: &Proposal,
        receipt_id: u64,
        deadline_ns: u64,
    ) -> Nep413Payload {
        let (sell_token, buy_token) = match proposal.sell {
            Token::Usdc => (&self.usdc_id, &self.wnear_id),
            Token::Wnear => (&self.wnear_id, &self.usdc_id),
        };
        let mut diff = near_sdk::serde_json::Map::new();
        diff.insert(
            format!("nep141:{sell_token}"),
            Value::String(format!("-{}", proposal.sell_amount.0)),
        );
        diff.insert(
            format!("nep141:{buy_token}"),
            Value::String(proposal.min_buy_amount.0.to_string()),
        );
        let nonce = env::sha256_array(
            format!(
                "claw-guard-adapted:{}:{receipt_id}",
                env::current_account_id()
            )
            .as_bytes(),
        );
        let message = json!({
            "signer_id": self.owner_id,
            "verifying_contract": self.verifier_id,
            "deadline": rfc3339(deadline_ns),
            "nonce": near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, nonce),
            "intents": [{ "intent": "token_diff", "diff": diff }],
        });
        Nep413Payload {
            message: message.to_string(),
            nonce: near_sdk::base64::Engine::encode(
                &near_sdk::base64::engine::general_purpose::STANDARD,
                nonce,
            ),
            recipient: self.verifier_id.to_string(),
        }
    }
}

/// NEP-413 prehash: sha256(borsh(tag) || borsh(message, nonce, recipient, callback_url=None)).
fn nep413_hash(payload: &Nep413Payload) -> [u8; 32] {
    let nonce: [u8; 32] = near_sdk::base64::Engine::decode(
        &near_sdk::base64::engine::general_purpose::STANDARD,
        &payload.nonce,
    )
    .ok()
    .and_then(|v| v.try_into().ok())
    .unwrap_or_else(|| env::panic_str("nonce"));
    let bytes = near_sdk::borsh::to_vec(&(
        NEP413_TAG,
        &payload.message,
        nonce,
        &payload.recipient,
        Option::<String>::None,
    ))
    .unwrap_or_else(|_| env::panic_str("borsh"));
    env::sha256_array(&bytes)
}

/// The MPC Ed25519 response `{"scheme":"Ed25519","signature":[64 bytes]}` as `ed25519:<base58>`.
fn parse_ed25519_signature(response: &Value) -> Option<String> {
    if response.get("scheme").and_then(Value::as_str) != Some("Ed25519") {
        return None;
    }
    let bytes = response
        .get("signature")?
        .as_array()?
        .iter()
        .map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok()))
        .collect::<Option<Vec<u8>>>()?;
    (bytes.len() == 64).then(|| format!("ed25519:{}", near_sdk::bs58::encode(bytes).into_string()))
}

/// `YYYY-MM-DDTHH:MM:SSZ` (whole seconds, rounded down) for a Unix time in nanoseconds.
fn rfc3339(ns: u64) -> String {
    let secs = ns.checked_div(NS_PER_SEC).unwrap_or(0);
    let days = secs.checked_div(SECS_PER_DAY).unwrap_or(0);
    let rem = secs.checked_rem(SECS_PER_DAY).unwrap_or(0);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (
        rem.checked_div(3600).unwrap_or(0),
        rem.checked_rem(3600)
            .and_then(|r| r.checked_div(60))
            .unwrap_or(0),
        rem.checked_rem(60).unwrap_or(0),
    );
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Howard Hinnant's days-to-civil algorithm for days since 1970-01-01 (non-negative only).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let calc = || -> Option<(u64, u64, u64)> {
        let z = days.checked_add(719_468)?;
        let era = z.checked_div(146_097)?;
        let doe = z.checked_sub(era.checked_mul(146_097)?)?;
        let yoe = doe
            .checked_sub(doe.checked_div(1460)?)?
            .checked_add(doe.checked_div(36_524)?)?
            .checked_sub(doe.checked_div(146_096)?)?
            .checked_div(365)?;
        let doy = doe.checked_sub(
            yoe.checked_mul(365)?
                .checked_add(yoe.checked_div(4)?)?
                .checked_sub(yoe.checked_div(100)?)?,
        )?;
        let mp = doy.checked_mul(5)?.checked_add(2)?.checked_div(153)?;
        let d = doy
            .checked_sub(mp.checked_mul(153)?.checked_add(2)?.checked_div(5)?)?
            .checked_add(1)?;
        let m = if mp < 10 {
            mp.checked_add(3)?
        } else {
            mp.checked_sub(9)?
        };
        let y = yoe
            .checked_add(era.checked_mul(400)?)?
            .checked_add(u64::from(m <= 2))?;
        Some((y, m, d))
    };
    calc().unwrap_or_else(|| env::panic_str("date"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_matches_known_instants() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        // 2026-11-03T19:46:40Z = 1793735200 s (independently: date -u -r 1793735200).
        assert_eq!(rfc3339(1_793_735_200_000_000_000), "2026-11-03T19:46:40Z");
        // Leap day: 2024-02-29T00:00:00Z = 1709164800 s.
        assert_eq!(rfc3339(1_709_164_800_999_999_999), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn parses_only_well_formed_ed25519_responses() {
        let sig: Vec<u8> = (0u8..64).collect();
        let ok = json!({ "scheme": "Ed25519", "signature": sig });
        assert!(parse_ed25519_signature(&ok).is_some());
        assert!(parse_ed25519_signature(&json!({ "scheme": "Secp256k1" })).is_none());
        assert!(
            parse_ed25519_signature(&json!({ "scheme": "Ed25519", "signature": [1, 2] })).is_none()
        );
    }
}
