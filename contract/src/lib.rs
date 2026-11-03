//! Bounded trading mandate over USDC and wNEAR on NEAR Intents.
//!
//! # Design note
//!
//! **Roles.** `owner_id` calls `grant`, `revoke` and `recover`; `agent_id` calls only
//! `propose_order`; `settle_order`/`expire_order` are permissionless and can only release a
//! reservation on trusted evidence. Callbacks are `#[private]`. No method builds anything but a
//! single contract-built `token_diff` for signing, and no method disables predecessor auth.
//!
//! **Grant lifecycle.** `grant` (allowed with no grant, or the current grant `Revoked`, and no
//! recovery in flight) allocates epoch `n+1` and the never-reused path `mandate/v1/<n+1>`, then
//! reads the derived key, both prices and both balances. `on_grant_prepared` records the initial
//! reference and value and issues `add_public_key`; `on_key_added` makes the grant `Active`.
//! Key operations are serialized ([`state::KeyState`]): removal is only issued after
//! registration is confirmed, and registration is never issued after revocation was requested.
//! `revoke` during derivation is immediately `Revoked` (no registration was or can be issued);
//! during registration it marks `Revoking` and `on_key_added` issues the removal; when `Active`
//! it issues removal at once. While `Revoking`, `revoke` may be called again to retry removal.
//! A removal is confirmed by a successful `remove_public_key` receipt or, after a failed one, by
//! `has_public_key == false`. Confirmation makes the grant `Revoked` and releases every open
//! reservation of that epoch (`key_removed`). A failed registration also ends in `Revoked`
//! (no key exists). Every continuation checks epoch, order id, state and deadline; stale or
//! duplicate callbacks are no-ops.
//!
//! **Orders.** `propose_order` validates the proposal, reserves the order's value at the grant's
//! initial reference and charges `max(that value, proposal floor)` to turnover before any
//! external call, where the floor is `ceil(initial_value * proposal_charge_bps / 10000)`; then it
//! reads both prices, the verifier salt and both balances. `on_order_priced` re-checks the grant,
//! breaker, pricing delay, caps and balance, raises the reservation to
//! `max(initial-reference value, current value)` (turnover is charged only for the part above
//! the order's existing charge), builds the order and requests the MPC signature (`Signing`). `on_signed` records a valid
//! signature (`Signed`) or marks `SignUnknown`; neither releases anything.
//!
//! **Release rules.** A reservation is released exactly once, only when: the verifier reports the
//! order's exact nonce used (`settled`); block time is strictly greater than the signed deadline
//! (`expired`; the verifier accepts a nonce at its deadline); removal of the covering key is
//! confirmed (`key_removed`); or a `Pricing` order is older than `max_pricing_delay_sec` and can
//! no longer be signed (`unsigned`). Release never refunds turnover. Only when `on_order_priced`
//! rejects the order before any signature request (`Rejected`) is its charge refunded, and then
//! only the part above the proposal floor.
//!
//! **Record bound.** Every proposal leaves an order record paid from the mandate's storage
//! balance. Because the floor is never refunded and `proposal_charge_bps <= turnover_cap_bps`,
//! one grant accepts at most `turnover_cap_bps / proposal_charge_bps` proposals (200 with the
//! demo policy), whether they are tiny, rejected or executed. The owner funds storage for that
//! many records plus the grant; further records need a new grant, which only the owner can make.
//!
//! **Valuation and rounding.** Values are USD * 10^12 at the oracle mid price; confidence is
//! bounded by policy rather than folded in. Reservations round up; holdings (initial value and
//! breaker observations) round down; caps round down; the breaker threshold rounds up. The signed
//! buy amount is `ceil(sell * p_sell / p_buy * (10000 - concession) / 10000)` computed as one exact
//! rational with a 256-bit intermediate, so the realised concession never exceeds the request.
//! Any overflow or missing price rejects the order: unknown valuation is never treated as zero.
//! The deadline is `min(now + order_ttl, oldest publish_time + oracle_max_age)` and the order is
//! refused when less than `min_remaining_sec` remains.
//!
//! **Breaker.** On pricing, holdings at current prices `<=` the threshold trips the breaker once:
//! observation time, observed value and the count/value of orders whose authority may exist
//! (`Signing`/`Signed`/`SignUnknown`, unreleased) are recorded; no further order is signed.
//!
//! **Recovery.** With no grant or a `Revoked` grant, `recover(asset)` reads the verifier balance
//! and `mt_transfer`s it to `owner_id` inside the verifier. One attempt per asset is in flight at
//! a time; a lock older than [`RECOVERY_LOCK_TIMEOUT_NS`] may be superseded because the verifier
//! cannot overdraw and the destination is fixed. Only confirmed transfers are counted.
//!
//! **Residual risks.** A callback that runs out of gas leaves its state unchanged: a lost
//! `on_order_priced`/`on_signed` keeps the reservation until the pricing delay or deadline; a lost
//! removal callback is recoverable by calling `revoke` again; a lost `on_key_added` leaves the
//! registration unresolved and blocks removal (registration could still be pending, so it is
//! never presumed). Callback gas is fixed and open orders are capped at [`MAX_OPEN_ORDERS`] to
//! bound the work in revocation. Order records are never deleted: storage grows by at most the
//! record bound per grant, and an underfunded mandate stops accepting proposals (owner actions
//! that write little state, such as `revoke`, keep working) until the owner adds NEAR.

pub mod events;
mod ext;
pub mod math;
pub mod policy;
pub mod protocol;
pub mod state;
pub mod types;

#[cfg(test)]
mod tests;

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{BorshStorageKey, Gas, PanicOnDefault, Promise, PublicKey, env, near, require};

use crate::events::emit;
use crate::math::{Price, Round, value_of};
use crate::policy::Caps;
use crate::protocol::gas::{self, tgas};
use crate::state::{AssetRecovery, Grant, KeyState, Order};
use crate::types::{
    Asset, AssetConfig, AssetRecoveryView, BreakerTrip, GrantStatus, GrantView, MandateConfig,
    OrderState, OrderView, Policy, PriceObservation, Proposal, Reference, ReleaseReason,
};

/// Bounds the per-transaction work of releasing all reservations on revocation.
pub const MAX_OPEN_ORDERS: usize = 32;
pub const RECOVERY_LOCK_TIMEOUT_NS: u64 = 600_000_000_000;
pub const MAX_LIST_LIMIT: u32 = 100;
/// Upper bound for owner-supplied gas overrides on key removal and recovery transfers.
pub const MAX_OVERRIDE_TGAS: u64 = 100;
const NS_PER_SEC: u64 = 1_000_000_000;

/// Callback budgets: own work plus everything each callback attaches further down its chain.
/// Removal confirmation may release up to [`MAX_OPEN_ORDERS`] reservations.
pub const GAS_ON_KEY_PRESENCE: Gas = tgas(gas::ON_KEY_OP_TGAS);
pub const GAS_ON_KEY_REMOVED: Gas = tgas(gas::ON_KEY_OP_TGAS)
    .saturating_add(ext::GAS_VIEW)
    .saturating_add(GAS_ON_KEY_PRESENCE);
pub const GAS_ON_KEY_ADDED: Gas = tgas(15)
    .saturating_add(ext::GAS_KEY_OP)
    .saturating_add(GAS_ON_KEY_REMOVED);
pub const GAS_ON_GRANT_PREPARED: Gas = tgas(gas::ON_GRANT_PRICED_SELF_TGAS)
    .saturating_add(ext::GAS_KEY_OP)
    .saturating_add(GAS_ON_KEY_ADDED);
pub const GAS_ON_SIGNED: Gas = tgas(gas::ON_SIGNED_TGAS);
pub const GAS_ON_ORDER_PRICED: Gas = tgas(gas::ON_PRICED_SELF_TGAS)
    .saturating_add(ext::GAS_SIGN)
    .saturating_add(GAS_ON_SIGNED);
pub const GAS_ON_SETTLE_CHECKED: Gas = tgas(gas::ON_NONCE_CHECKED_TGAS);
pub const GAS_ON_RECOVERY_TRANSFERRED: Gas = tgas(gas::ON_RECOVERY_TRANSFER_TGAS);
/// Plus the transfer gas, which the owner may override.
pub const GAS_ON_RECOVERY_BALANCE: Gas =
    tgas(gas::ON_RECOVERY_BALANCE_SELF_TGAS).saturating_add(GAS_ON_RECOVERY_TRANSFERRED);
/// Minimum prepaid gas for `propose_order`: its own work, four reads and the pricing chain.
pub const GAS_PROPOSE_REQUIRED: Gas = tgas(gas::PROPOSE_SELF_TGAS)
    .saturating_add(GAS_ORACLE_X2)
    .saturating_add(ext::GAS_VIEW)
    .saturating_add(ext::GAS_VIEW)
    .saturating_add(GAS_ON_ORDER_PRICED);
/// Prepaid gas `grant` needs for its full chain, including removal if revoked mid-registration.
pub const GAS_GRANT_REQUIRED: Gas = tgas(gas::GRANT_SELF_TGAS)
    .saturating_add(ext::GAS_DERIVE)
    .saturating_add(GAS_ORACLE_X2)
    .saturating_add(ext::GAS_VIEW)
    .saturating_add(GAS_ON_GRANT_PREPARED);
/// Prepaid gas `revoke` needs with the default removal gas.
pub const GAS_REVOKE_REQUIRED: Gas = tgas(gas::REVOKE_SELF_TGAS)
    .saturating_add(ext::GAS_KEY_OP)
    .saturating_add(GAS_ON_KEY_REMOVED);
/// Prepaid gas `recover` needs with the default transfer gas.
pub const GAS_RECOVER_REQUIRED: Gas = tgas(gas::RECOVER_SELF_TGAS)
    .saturating_add(ext::GAS_VIEW)
    .saturating_add(GAS_ON_RECOVERY_BALANCE)
    .saturating_add(ext::GAS_TRANSFER);
const GAS_ORACLE_X2: Gas = ext::GAS_ORACLE.saturating_add(ext::GAS_ORACLE);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Orders,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mandate {
    config: MandateConfig,
    /// Last allocated epoch; paths are derived from it and never reused.
    last_epoch: u64,
    grant: Option<Grant>,
    orders: LookupMap<u64, Order>,
    next_order_id: u64,
    recovery_usdc: AssetRecovery,
    recovery_wnear: AssetRecovery,
}

fn now_ns() -> u64 {
    env::block_timestamp()
}

fn price(obs: &PriceObservation) -> Price {
    Price {
        mantissa: obs.price.0,
        expo: obs.expo,
    }
}

fn secs_to_ns(sec: u64) -> Option<u64> {
    sec.checked_mul(NS_PER_SEC)
}

/// Raw result bytes of promise `i`, or `None` when it failed or is oversized.
fn result(i: u64) -> Option<Vec<u8>> {
    env::promise_result_checked(i, ext::MAX_RESULT_LEN).ok()
}

/// Validates an owner gas override and that the attached gas covers `required` with it.
fn override_gas(default: Gas, tgas: Option<u64>, required: Gas) -> Gas {
    let gas = match tgas {
        None => default,
        Some(t) => {
            require!(
                t >= default.as_tgas() && t <= MAX_OVERRIDE_TGAS,
                "gas override out of bounds"
            );
            Gas::from_tgas(t)
        }
    };
    require!(
        env::prepaid_gas() >= required.saturating_sub(default).saturating_add(gas),
        "insufficient gas attached"
    );
    gas
}

#[near]
impl Mandate {
    #[init]
    pub fn new(config: MandateConfig) -> Self {
        let me = env::current_account_id();
        require!(
            config.owner_id != config.agent_id,
            "owner and agent must differ"
        );
        require!(
            config.owner_id != me && config.agent_id != me,
            "roles must be external accounts"
        );
        require!(
            config.usdc.token != config.wnear.token,
            "asset tokens must differ"
        );
        for a in [&config.usdc, &config.wnear] {
            require!(a.decimals <= 30, "unsupported decimals");
            require!(!a.price_id.is_empty(), "missing price id");
        }
        Self {
            config,
            last_epoch: 0,
            grant: None,
            orders: LookupMap::new(StorageKey::Orders),
            next_order_id: 0,
            recovery_usdc: AssetRecovery::default(),
            recovery_wnear: AssetRecovery::default(),
        }
    }

    // ---------------------------------------------------------------- owner

    /// Starts a new grant under a fresh epoch and derivation path.
    pub fn grant(&mut self, policy: Policy) -> Promise {
        self.assert_owner();
        require!(
            env::prepaid_gas() >= GAS_GRANT_REQUIRED,
            "insufficient gas attached"
        );
        if let Err(e) = policy::validate(&policy) {
            env::panic_str(e);
        }
        require!(
            self.grant
                .as_ref()
                .is_none_or(|g| g.status == GrantStatus::Revoked),
            "current grant is not revoked"
        );
        require!(
            self.recovery_usdc.in_flight.is_none() && self.recovery_wnear.in_flight.is_none(),
            "recovery in flight"
        );
        let epoch = self.last_epoch.checked_add(1).expect("epoch overflow");
        self.last_epoch = epoch;
        let grant = Grant::new(epoch, policy);
        emit(
            "grant_requested",
            json!({ "epoch": epoch, "path": grant.path, "policy": policy }),
        );
        let path = grant.path.clone();
        self.grant = Some(grant);
        let c = &self.config;
        ext::derive_public_key(c, &path)
            .and(ext::get_price(c, &c.usdc, policy.oracle_max_age_sec))
            .and(ext::get_price(c, &c.wnear, policy.oracle_max_age_sec))
            .and(ext::balances(c))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_GRANT_PREPARED)
                    .on_grant_prepared(epoch),
            )
    }

    /// Stops new authorization at once and removes the grant key. Call again while `Revoking`
    /// to retry a failed removal. Depends only on the verifier.
    pub fn revoke(&mut self, gas_tgas: Option<u64>) {
        self.assert_owner();
        let gas = override_gas(ext::GAS_KEY_OP, gas_tgas, GAS_REVOKE_REQUIRED);
        let g = self
            .grant
            .as_mut()
            .unwrap_or_else(|| env::panic_str("no grant"));
        let epoch = g.epoch;
        match (g.status, g.key) {
            (GrantStatus::Revoked, _) => env::panic_str("already revoked"),
            (GrantStatus::Activating, KeyState::Deriving) => {
                // No registration was issued and none will be: there is no key to remove.
                g.key = KeyState::NeverAdded;
                emit("revocation_requested", json!({ "epoch": epoch }));
                self.finalize_revocation(false);
            }
            (GrantStatus::Activating, KeyState::Adding) => {
                g.status = GrantStatus::Revoking;
                emit("revocation_requested", json!({ "epoch": epoch }));
            }
            (GrantStatus::Revoking, KeyState::Adding) => {
                env::panic_str("key registration in flight; removal follows its confirmation")
            }
            (GrantStatus::Active | GrantStatus::Revoking, KeyState::Added) => {
                if g.status == GrantStatus::Active {
                    g.status = GrantStatus::Revoking;
                    emit("revocation_requested", json!({ "epoch": epoch }));
                }
                self.issue_removal(gas);
            }
            _ => env::panic_str("inconsistent grant state"),
        }
    }

    /// Transfers the full verifier balance of `asset` to the owner's Intents account.
    pub fn recover(&mut self, asset: Asset, gas_tgas: Option<u64>) -> Promise {
        self.assert_owner();
        let gas = override_gas(ext::GAS_TRANSFER, gas_tgas, GAS_RECOVER_REQUIRED);
        require!(
            self.grant
                .as_ref()
                .is_none_or(|g| g.status == GrantStatus::Revoked),
            "recovery requires no grant or a revoked grant"
        );
        let now = now_ns();
        let rec = self.recovery_mut(asset);
        if let Some((_, started)) = rec.in_flight {
            require!(
                now.saturating_sub(started) > RECOVERY_LOCK_TIMEOUT_NS,
                "recovery in flight"
            );
        }
        let attempt = rec.attempts.checked_add(1).expect("attempt overflow");
        rec.attempts = attempt;
        rec.in_flight = Some((attempt, now));
        emit(
            "recovery_requested",
            json!({ "asset": asset, "attempt": attempt }),
        );
        let tgas = gas.as_tgas();
        ext::mt_balance_of(&self.config, self.asset_config(asset)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_RECOVERY_BALANCE.saturating_add(gas))
                .on_recovery_balance(asset, attempt, tgas),
        )
    }

    // ---------------------------------------------------------------- agent

    /// Reserves capacity for a proposal and requests the data needed to sign it.
    pub fn propose_order(&mut self, proposal: Proposal) -> U64 {
        require!(
            env::predecessor_account_id() == self.config.agent_id,
            "only the agent may propose"
        );
        require!(
            env::prepaid_gas() >= GAS_PROPOSE_REQUIRED,
            "insufficient gas attached"
        );
        let sell_amount = proposal.sell_amount.0;
        require!(sell_amount > 0, "sell_amount must be positive");
        require!(i128::try_from(sell_amount).is_ok(), "sell_amount too large");
        let decimals = self.asset_config(proposal.sell).decimals;
        let id = self.next_order_id;
        let now = now_ns();
        let g = self
            .grant
            .as_mut()
            .unwrap_or_else(|| env::panic_str("no grant"));
        require!(g.status == GrantStatus::Active, "grant is not active");
        require!(g.breaker.is_none(), "loss breaker tripped");
        require!(
            proposal.max_concession_bps <= g.policy.max_concession_bps,
            "concession above policy maximum"
        );
        require!(
            g.open_orders.len() < MAX_OPEN_ORDERS,
            "too many open orders"
        );
        let (Some(reference), Some(initial_value)) = (&g.initial_reference, g.initial_value) else {
            env::panic_str("grant has no initial reference");
        };
        let p = price(match proposal.sell {
            Asset::Usdc => &reference.usdc,
            Asset::Wnear => &reference.wnear,
        });
        let reserved = value_of(sell_amount, decimals, p, Round::Up)
            .unwrap_or_else(|| env::panic_str("order value overflow"));
        let caps =
            Caps::new(&g.policy, initial_value).unwrap_or_else(|| env::panic_str("cap overflow"));
        // Tiny orders stay allowed but always cost at least the never-refunded floor.
        let charged = reserved.max(caps.proposal_floor);
        if let Err(e) = reserve(g, &caps, reserved, charged, Some(reserved)) {
            env::panic_str(e);
        }
        g.open_orders.push(id);
        let epoch = g.epoch;
        let max_age = g.policy.oracle_max_age_sec;
        self.next_order_id = id.checked_add(1).expect("order id overflow");
        let order = Order {
            id,
            epoch,
            sell: proposal.sell,
            sell_amount,
            buy_amount: None,
            concession_bps: proposal.max_concession_bps,
            reserved_value: reserved,
            turnover_charged: charged,
            deadline_ns: None,
            reference: None,
            payload: None,
            payload_hash: None,
            signature: None,
            state: OrderState::Pricing,
            created_at_ns: now,
            sign_requested_at_ns: None,
            signed_at_ns: None,
        };
        emit("order_proposed", json!({ "order": order.view() }));
        self.orders.insert(id, order);
        let c = &self.config;
        ext::get_price(c, &c.usdc, max_age)
            .and(ext::get_price(c, &c.wnear, max_age))
            .and(ext::current_salt(c))
            .and(ext::balances(c))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_ORDER_PRICED)
                    .on_order_priced(U64(id), epoch),
            )
            .detach();
        U64(id)
    }

    // ---------------------------------------------------------------- permissionless

    /// Asks the verifier whether the order's exact nonce was used; releases once if so.
    pub fn settle_order(&mut self, order_id: U64) -> Promise {
        let order = self
            .order(order_id.0)
            .unwrap_or_else(|| env::panic_str("unknown order"));
        require!(
            order.authority_may_exist(),
            "order has no outstanding authority"
        );
        let nonce = order
            .payload
            .as_ref()
            .map(|p| p.nonce.clone())
            .expect("signing order has payload");
        ext::is_nonce_used(&self.config, nonce).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_SETTLE_CHECKED)
                .on_settle_checked(order_id, order.epoch),
        )
    }

    /// Releases an order past its signed deadline, or a `Pricing` order past the pricing delay.
    pub fn expire_order(&mut self, order_id: U64) {
        let order = self
            .order(order_id.0)
            .unwrap_or_else(|| env::panic_str("unknown order"));
        let now = now_ns();
        let reason = match order.state {
            OrderState::Pricing => {
                require!(
                    now > self.pricing_cutoff(&order),
                    "pricing delay not exceeded"
                );
                ReleaseReason::Unsigned
            }
            _ if order.authority_may_exist() => {
                let deadline = order.deadline_ns.expect("signing order has deadline");
                require!(now > deadline, "deadline not passed");
                ReleaseReason::Expired
            }
            _ => env::panic_str("order already final"),
        };
        self.release(order, reason);
    }

    // ---------------------------------------------------------------- callbacks

    #[private]
    pub fn on_grant_prepared(&mut self, epoch: u64) {
        let Some(g) = self.grant.as_mut() else { return };
        if g.epoch != epoch || g.status != GrantStatus::Activating || g.key != KeyState::Deriving {
            emit(
                "stale_callback",
                json!({ "callback": "on_grant_prepared", "epoch": epoch }),
            );
            return;
        }
        let c = &self.config;
        let prepared = (|| -> Result<(PublicKey, Reference, u128), String> {
            let pk = result(0)
                .and_then(|b| ext::parse_public_key(&b))
                .ok_or("derived key unavailable")?;
            let now = now_ns();
            let usdc = ext::parse_price(result(1).as_deref(), &c.usdc, &g.policy, now)?;
            let wnear = ext::parse_price(result(2).as_deref(), &c.wnear, &g.policy, now)?;
            let (bu, bw) = result(3)
                .and_then(|b| ext::parse_balances(&b))
                .ok_or("balances unavailable")?;
            let reference = Reference {
                usdc,
                wnear,
                observed_at_ns: U64(now),
            };
            let value = holdings_value(c, &reference, bu, bw).ok_or("valuation overflow")?;
            if value == 0 {
                return Err("initial value is zero".into());
            }
            Caps::new(&g.policy, value).ok_or("cap overflow")?;
            Ok((pk, reference, value))
        })();
        match prepared {
            Err(reason) => {
                g.key = KeyState::NeverAdded;
                g.status = GrantStatus::Revoked;
                emit("grant_failed", json!({ "epoch": epoch, "reason": reason }));
            }
            Ok((pk, reference, value)) => {
                g.key = KeyState::Adding;
                g.public_key = Some(pk.clone());
                emit(
                    "grant_key_registering",
                    json!({ "epoch": epoch, "public_key": pk, "initial_reference": reference, "initial_value": U128(value) }),
                );
                g.initial_reference = Some(reference);
                g.initial_value = Some(value);
                ext::add_public_key(c, pk)
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_ON_KEY_ADDED)
                            .on_key_added(epoch),
                    )
                    .detach();
            }
        }
    }

    #[private]
    pub fn on_key_added(&mut self, epoch: u64) {
        let Some(g) = self.grant.as_mut() else { return };
        if g.epoch != epoch || g.key != KeyState::Adding {
            emit(
                "stale_callback",
                json!({ "callback": "on_key_added", "epoch": epoch }),
            );
            return;
        }
        if result(0).is_none() {
            // A failed receipt left verifier state unchanged: no key exists for this path.
            g.key = KeyState::NeverAdded;
            emit(
                "grant_failed",
                json!({ "epoch": epoch, "reason": "key registration failed" }),
            );
            self.finalize_revocation(false);
            return;
        }
        g.key = KeyState::Added;
        match g.status {
            GrantStatus::Activating => {
                g.status = GrantStatus::Active;
                emit(
                    "grant_activated",
                    json!({ "epoch": epoch, "public_key": g.public_key }),
                );
            }
            GrantStatus::Revoking => self.issue_removal(ext::GAS_KEY_OP),
            _ => env::panic_str("inconsistent grant state"),
        }
    }

    #[private]
    pub fn on_key_removed(&mut self, epoch: u64, attempt: u32) {
        let Some(g) = self.grant.as_mut() else { return };
        if g.epoch != epoch || g.status != GrantStatus::Revoking || g.key != KeyState::Added {
            emit(
                "stale_callback",
                json!({ "callback": "on_key_removed", "epoch": epoch, "attempt": attempt }),
            );
            return;
        }
        if result(0).is_some() {
            self.finalize_revocation(true);
            return;
        }
        // The key may already be gone (an earlier attempt succeeded but its callback was lost).
        let pk = g.public_key.clone().expect("added key is recorded");
        ext::has_public_key(&self.config, pk)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_KEY_PRESENCE)
                    .on_key_presence(epoch, attempt),
            )
            .detach();
    }

    #[private]
    pub fn on_key_presence(&mut self, epoch: u64, attempt: u32) {
        let Some(g) = self.grant.as_mut() else { return };
        if g.epoch != epoch || g.status != GrantStatus::Revoking || g.key != KeyState::Added {
            emit(
                "stale_callback",
                json!({ "callback": "on_key_presence", "epoch": epoch, "attempt": attempt }),
            );
            return;
        }
        if result(0).and_then(|b| ext::parse_bool(&b)) == Some(false) {
            self.finalize_revocation(true);
            return;
        }
        if attempt == g.removal_attempt {
            g.removal_pending = false;
        }
        emit(
            "key_removal_failed",
            json!({ "epoch": epoch, "attempt": attempt }),
        );
    }

    #[private]
    pub fn on_order_priced(&mut self, order_id: U64, epoch: u64) {
        let id = order_id.0;
        let Some(order) = self
            .order(id)
            .filter(|o| o.epoch == epoch && o.state == OrderState::Pricing)
        else {
            emit(
                "stale_callback",
                json!({ "callback": "on_order_priced", "order_id": order_id }),
            );
            return;
        };
        if now_ns() > self.pricing_cutoff(&order) {
            self.release(order, ReleaseReason::Unsigned);
            return;
        }
        match self.authorize(order.clone()) {
            Ok(promise) => promise.detach(),
            Err(reason) => self.reject(order, reason),
        }
    }

    #[private]
    pub fn on_signed(&mut self, order_id: U64, epoch: u64) {
        let id = order_id.0;
        let Some(mut order) = self
            .order(id)
            .filter(|o| o.epoch == epoch && o.state == OrderState::Signing)
        else {
            emit(
                "stale_callback",
                json!({ "callback": "on_signed", "order_id": order_id }),
            );
            return;
        };
        let pk = self.grant.as_ref().and_then(|g| g.public_key.clone());
        let hash = order.payload_hash.expect("signing order has hash");
        let payload = order.payload.clone().expect("signing order has payload");
        let signed = pk.and_then(|pk| {
            let sig = result(0).and_then(|b| ext::verified_signature(&b, &pk, &hash))?;
            Some((sig, ext::multi_payload_json(&payload, &pk, &sig)?))
        });
        match signed {
            Some((sig, multi_payload)) => {
                order.signature = Some(ext::signature_string(&sig));
                order.signed_at_ns = Some(now_ns());
                order.state = OrderState::Signed;
                emit(
                    "order_signed",
                    json!({ "order_id": order_id, "epoch": epoch, "signature": order.signature, "multi_payload": multi_payload }),
                );
            }
            None => {
                // The MPC may still have published a valid signature: authority may exist.
                order.state = OrderState::SignUnknown;
                emit(
                    "order_sign_unknown",
                    json!({ "order_id": order_id, "epoch": epoch }),
                );
            }
        }
        self.orders.insert(id, order);
    }

    #[private]
    pub fn on_settle_checked(&mut self, order_id: U64, epoch: u64) {
        let Some(order) = self
            .order(order_id.0)
            .filter(|o| o.epoch == epoch && o.authority_may_exist())
        else {
            emit(
                "stale_callback",
                json!({ "callback": "on_settle_checked", "order_id": order_id }),
            );
            return;
        };
        if result(0).and_then(|b| ext::parse_bool(&b)) == Some(true) {
            self.release(order, ReleaseReason::Settled);
        } else {
            emit("order_not_settled", json!({ "order_id": order_id }));
        }
    }

    #[private]
    pub fn on_recovery_balance(&mut self, asset: Asset, attempt: u32, gas_tgas: u64) {
        let revoked = self
            .grant
            .as_ref()
            .is_none_or(|g| g.status == GrantStatus::Revoked);
        let rec = self.recovery_mut(asset);
        if rec.in_flight.map(|(a, _)| a) != Some(attempt) {
            emit(
                "stale_callback",
                json!({ "callback": "on_recovery_balance", "asset": asset, "attempt": attempt }),
            );
            return;
        }
        let balance = result(0).and_then(|b| ext::parse_u128(&b));
        match balance {
            Some(amount) if amount > 0 && revoked => {
                let token = self.asset_config(asset).clone();
                ext::mt_transfer(&self.config, &token, amount, Gas::from_tgas(gas_tgas))
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_ON_RECOVERY_TRANSFERRED)
                            .on_recovery_transferred(asset, attempt, U128(amount)),
                    )
                    .detach();
            }
            _ => {
                rec.in_flight = None;
                let outcome = match balance {
                    None => "balance unavailable",
                    Some(_) if !revoked => "grant not revoked",
                    _ => "nothing to recover",
                };
                emit(
                    "recovery_finished",
                    json!({ "asset": asset, "attempt": attempt, "outcome": outcome }),
                );
            }
        }
    }

    #[private]
    pub fn on_recovery_transferred(&mut self, asset: Asset, attempt: u32, amount: U128) {
        let ok = result(0).is_some();
        let rec = self.recovery_mut(asset);
        if ok {
            rec.recovered = rec
                .recovered
                .checked_add(amount.0)
                .expect("recovered overflow");
        }
        if rec.in_flight.map(|(a, _)| a) == Some(attempt) {
            rec.in_flight = None;
        }
        let event = if ok {
            "recovery_transferred"
        } else {
            "recovery_failed"
        };
        emit(
            event,
            json!({ "asset": asset, "attempt": attempt, "amount": amount }),
        );
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> MandateConfig {
        self.config.clone()
    }

    pub fn get_grant(&self) -> Option<GrantView> {
        self.grant.as_ref().map(Grant::view)
    }

    pub fn get_order(&self, order_id: U64) -> Option<OrderView> {
        self.orders.get(&order_id.0).map(Order::view)
    }

    pub fn list_orders(&self, from_index: Option<U64>, limit: Option<u32>) -> Vec<OrderView> {
        let from = from_index.map_or(0, |i| i.0);
        let limit = limit.unwrap_or(MAX_LIST_LIMIT).min(MAX_LIST_LIMIT);
        (from..self.next_order_id)
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .filter_map(|id| self.orders.get(&id).map(Order::view))
            .collect()
    }

    pub fn get_recovery(&self) -> Vec<AssetRecoveryView> {
        vec![
            self.recovery_usdc.view(Asset::Usdc),
            self.recovery_wnear.view(Asset::Wnear),
        ]
    }
}

/// Holdings at `reference` prices, rounded down.
fn holdings_value(c: &MandateConfig, r: &Reference, usdc: u128, wnear: u128) -> Option<u128> {
    value_of(usdc, c.usdc.decimals, price(&r.usdc), Round::Down)?.checked_add(value_of(
        wnear,
        c.wnear.decimals,
        price(&r.wnear),
        Round::Down,
    )?)
}

/// Charges `outstanding_delta` and `turnover_delta` after checking every cap. `order_value` is the
/// order's full reservation after the change.
fn reserve(
    g: &mut Grant,
    caps: &Caps,
    outstanding_delta: u128,
    turnover_delta: u128,
    order_value: Option<u128>,
) -> Result<(), &'static str> {
    let order_value = order_value.unwrap_or(outstanding_delta);
    if order_value > caps.per_order {
        return Err("per-order cap exceeded");
    }
    let outstanding = g
        .outstanding
        .checked_add(outstanding_delta)
        .ok_or("overflow")?;
    if outstanding > caps.outstanding {
        return Err("outstanding cap exceeded");
    }
    let turnover = g
        .turnover_used
        .checked_add(turnover_delta)
        .ok_or("overflow")?;
    if turnover > caps.turnover {
        return Err("turnover cap exceeded");
    }
    g.outstanding = outstanding;
    g.turnover_used = turnover;
    Ok(())
}

impl Mandate {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.config.owner_id,
            "only the owner"
        );
    }

    fn asset_config(&self, asset: Asset) -> &AssetConfig {
        match asset {
            Asset::Usdc => &self.config.usdc,
            Asset::Wnear => &self.config.wnear,
        }
    }

    fn recovery_mut(&mut self, asset: Asset) -> &mut AssetRecovery {
        match asset {
            Asset::Usdc => &mut self.recovery_usdc,
            Asset::Wnear => &mut self.recovery_wnear,
        }
    }

    fn order(&self, id: u64) -> Option<Order> {
        self.orders.get(&id).cloned()
    }

    fn pricing_cutoff(&self, order: &Order) -> u64 {
        let delay = self
            .grant
            .as_ref()
            .filter(|g| g.epoch == order.epoch)
            .map_or(0, |g| u64::from(g.policy.max_pricing_delay_sec));
        order
            .created_at_ns
            .saturating_add(secs_to_ns(delay).unwrap_or(u64::MAX))
    }

    fn issue_removal(&mut self, gas: Gas) {
        let g = self.grant.as_mut().expect("grant exists");
        let attempt = g.removal_attempt.checked_add(1).expect("attempt overflow");
        g.removal_attempt = attempt;
        g.removal_pending = true;
        let epoch = g.epoch;
        let pk = g.public_key.clone().expect("added key is recorded");
        emit(
            "key_removal_requested",
            json!({ "epoch": epoch, "attempt": attempt }),
        );
        ext::remove_public_key(&self.config, pk, gas)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_KEY_REMOVED)
                    .on_key_removed(epoch, attempt),
            )
            .detach();
    }

    /// Marks the grant `Revoked` and releases every open reservation of its epoch.
    fn finalize_revocation(&mut self, key_removed: bool) {
        let g = self.grant.as_mut().expect("grant exists");
        g.status = GrantStatus::Revoked;
        g.removal_pending = false;
        if key_removed {
            g.key = KeyState::Removed;
        }
        let epoch = g.epoch;
        let open = g.open_orders.clone();
        for id in &open {
            if let Some(order) = self.order(*id) {
                self.release(order, ReleaseReason::KeyRemoved);
            }
        }
        emit(
            "grant_revoked",
            json!({ "epoch": epoch, "key_removed": key_removed, "released_orders": open }),
        );
    }

    /// Releases an open order's reservation exactly once. Never refunds turnover.
    fn release(&mut self, mut order: Order, reason: ReleaseReason) {
        require!(order.is_open(), "order already final");
        let g = self
            .grant
            .as_mut()
            .expect("open orders belong to the current grant");
        require!(g.epoch == order.epoch, "open order outside current epoch");
        g.outstanding = g
            .outstanding
            .checked_sub(order.reserved_value)
            .expect("outstanding underflow");
        g.open_orders.retain(|id| *id != order.id);
        order.state = OrderState::Released { reason };
        emit(
            "order_released",
            json!({ "order_id": U64(order.id), "epoch": order.epoch, "reason": reason, "reserved_value": U128(order.reserved_value) }),
        );
        self.orders.insert(order.id, order);
    }

    /// Rejects a `Pricing` order before any sign request: frees its reservation and refunds its
    /// turnover charge above the per-proposal floor.
    fn reject(&mut self, mut order: Order, reason: String) {
        require!(
            order.state == OrderState::Pricing,
            "only pricing orders can be rejected"
        );
        let g = self
            .grant
            .as_mut()
            .expect("open orders belong to the current grant");
        require!(g.epoch == order.epoch, "open order outside current epoch");
        let floor = g
            .initial_value
            .and_then(|v| Caps::new(&g.policy, v))
            .expect("active grant has caps")
            .proposal_floor;
        let refund = order.turnover_charged.saturating_sub(floor);
        g.outstanding = g
            .outstanding
            .checked_sub(order.reserved_value)
            .expect("outstanding underflow");
        g.turnover_used = g
            .turnover_used
            .checked_sub(refund)
            .expect("turnover underflow");
        g.open_orders.retain(|id| *id != order.id);
        emit(
            "order_rejected",
            json!({ "order_id": U64(order.id), "epoch": order.epoch, "reason": reason }),
        );
        order.state = OrderState::Rejected { reason };
        self.orders.insert(order.id, order);
    }

    /// Records a breaker trip with the orders whose authority may still exist.
    fn trip_breaker(&mut self, observed_value: u128) -> Result<(), String> {
        let g = self.grant.as_ref().expect("grant exists");
        let mut count: u32 = 0;
        let mut value: u128 = 0;
        for id in &g.open_orders {
            let o = self.orders.get(id).ok_or("missing open order")?;
            if o.authority_may_exist() {
                count = count.checked_add(1).ok_or("overflow")?;
                value = value.checked_add(o.reserved_value).ok_or("overflow")?;
            }
        }
        let trip = BreakerTrip {
            observed_at_ns: U64(now_ns()),
            observed_value: U128(observed_value),
            executable_orders: count,
            executable_value: U128(value),
        };
        emit("breaker_tripped", json!({ "epoch": g.epoch, "trip": trip }));
        self.grant.as_mut().expect("grant exists").breaker = Some(trip);
        Ok(())
    }

    /// Re-checks a `Pricing` order against fresh data and requests its signature. Mutates state
    /// only on success, except that an observed drawdown trips the breaker.
    fn authorize(&mut self, mut order: Order) -> Result<Promise, String> {
        let now = now_ns();
        let c = self.config.clone();
        let g = self.grant.as_ref().ok_or("no grant")?;
        if g.epoch != order.epoch || g.status != GrantStatus::Active || g.key != KeyState::Added {
            return Err("grant is not active".into());
        }
        if g.breaker.is_some() {
            return Err("loss breaker tripped".into());
        }
        let (policy, path, epoch) = (g.policy, g.path.clone(), g.epoch);
        let open_orders = g.open_orders.clone();
        let initial_value = g.initial_value.ok_or("no initial value")?;
        let caps = Caps::new(&policy, initial_value).ok_or("cap overflow")?;
        let usdc = ext::parse_price(result(0).as_deref(), &c.usdc, &policy, now)?;
        let wnear = ext::parse_price(result(1).as_deref(), &c.wnear, &policy, now)?;
        let salt = result(2)
            .and_then(|b| ext::parse_salt(&b))
            .ok_or("salt unavailable")?;
        let (bu, bw) = result(3)
            .and_then(|b| ext::parse_balances(&b))
            .ok_or("balances unavailable")?;
        let reference = Reference {
            usdc,
            wnear,
            observed_at_ns: U64(now),
        };

        let holdings = holdings_value(&c, &reference, bu, bw).ok_or("valuation overflow")?;
        if holdings <= caps.breaker_threshold {
            self.trip_breaker(holdings)?;
            return Err("loss breaker tripped".into());
        }

        let (sell_cfg, buy_cfg, sell_obs, buy_obs, balance) = match order.sell {
            Asset::Usdc => (&c.usdc, &c.wnear, &reference.usdc, &reference.wnear, bu),
            Asset::Wnear => (&c.wnear, &c.usdc, &reference.wnear, &reference.usdc, bw),
        };
        let current = value_of(
            order.sell_amount,
            sell_cfg.decimals,
            price(sell_obs),
            Round::Up,
        )
        .ok_or("order value overflow")?;
        let reserved = order.reserved_value.max(current);
        let delta = reserved
            .checked_sub(order.reserved_value)
            .ok_or("overflow")?;

        // Every other open order selling the same asset may still execute or be signed.
        let mut committed = order.sell_amount;
        for id in open_orders.iter().filter(|id| **id != order.id) {
            let o = self.orders.get(id).ok_or("missing open order")?;
            if o.sell == order.sell {
                committed = committed.checked_add(o.sell_amount).ok_or("overflow")?;
            }
        }
        if committed > balance {
            return Err("insufficient balance".into());
        }

        let buy_amount = math::buy_amount(
            order.sell_amount,
            sell_cfg.decimals,
            price(sell_obs),
            buy_cfg.decimals,
            price(buy_obs),
            order.concession_bps,
            Round::Up,
        )
        .ok_or("buy amount overflow")?;
        if buy_amount == 0 || i128::try_from(buy_amount).is_err() {
            return Err("buy amount out of range".into());
        }

        let oldest = reference
            .usdc
            .publish_time_sec
            .0
            .min(reference.wnear.publish_time_sec.0);
        let valid_until = oldest
            .checked_add(u64::from(policy.oracle_max_age_sec))
            .and_then(secs_to_ns)
            .ok_or("deadline overflow")?;
        let ttl_end = secs_to_ns(u64::from(policy.order_ttl_sec))
            .and_then(|t| now.checked_add(t))
            .ok_or("deadline overflow")?;
        let deadline = ttl_end.min(valid_until);
        let min_remaining = secs_to_ns(u64::from(policy.min_remaining_sec)).ok_or("overflow")?;
        if deadline <= now || deadline.saturating_sub(now) < min_remaining {
            return Err("insufficient time before deadline".into());
        }

        // Block randomness can repeat within a block; epoch and order id make each nonce unique.
        let mut seed = env::random_seed();
        seed.extend_from_slice(&epoch.to_le_bytes());
        seed.extend_from_slice(&order.id.to_le_bytes());
        let mut random = [0u8; 15];
        random.copy_from_slice(&env::sha256_array(&seed)[..15]);
        let (payload, hash) = ext::build_order(
            &c,
            sell_cfg,
            order.sell_amount,
            buy_cfg,
            buy_amount,
            deadline,
            salt,
            random,
        )?;
        // Turnover pays only for the increase above what this order was already charged.
        let turnover_delta = reserved.saturating_sub(order.turnover_charged);
        let turnover_charged = order.turnover_charged.max(reserved);

        let g = self.grant.as_mut().ok_or("no grant")?;
        reserve(g, &caps, delta, turnover_delta, Some(reserved)).map_err(String::from)?;

        order.reserved_value = reserved;
        order.turnover_charged = turnover_charged;
        order.buy_amount = Some(buy_amount);
        order.deadline_ns = Some(deadline);
        order.reference = Some(reference);
        order.payload = Some(payload);
        order.payload_hash = Some(hash);
        order.state = OrderState::Signing;
        order.sign_requested_at_ns = Some(now);
        emit("order_sign_requested", json!({ "order": order.view() }));
        let id = order.id;
        self.orders.insert(id, order);
        Ok(ext::sign(&c, &path, &hash).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_SIGNED)
                .on_signed(U64(id), epoch),
        ))
    }
}
