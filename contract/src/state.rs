//! Persistent grant, order and recovery records and their public views.

use near_sdk::json_types::{U64, U128};
use near_sdk::{PublicKey, near};

use crate::types::{
    Asset, AssetRecoveryView, BreakerTrip, GrantStatus, GrantView, Nep413Payload, OrderState,
    OrderView, Policy, Reference,
};

/// Where the grant's verifier key is in its lifecycle. Registration and removal are serialized:
/// removal is issued only once registration is confirmed, and no registration is issued after
/// revocation was requested.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyState {
    /// Key derivation and initial valuation are in flight; no registration was issued.
    Deriving,
    /// `add_public_key` is in flight.
    Adding,
    /// Registration confirmed.
    Added,
    /// No key was ever registered for this grant.
    NeverAdded,
    /// Removal confirmed.
    Removed,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub epoch: u64,
    pub path: String,
    pub policy: Policy,
    pub status: GrantStatus,
    pub key: KeyState,
    pub public_key: Option<PublicKey>,
    pub initial_reference: Option<Reference>,
    pub initial_value: Option<u128>,
    pub turnover_used: u128,
    pub outstanding: u128,
    pub breaker: Option<BreakerTrip>,
    /// Latest issued removal attempt; any attempt that confirms removal finalizes revocation.
    pub removal_attempt: u32,
    pub removal_pending: bool,
    /// Orders whose reservation is not yet released, in creation order.
    pub open_orders: Vec<u64>,
}

impl Grant {
    pub fn new(epoch: u64, policy: Policy) -> Self {
        Self {
            epoch,
            path: format!("mandate/v1/{epoch}"),
            policy,
            status: GrantStatus::Activating,
            key: KeyState::Deriving,
            public_key: None,
            initial_reference: None,
            initial_value: None,
            turnover_used: 0,
            outstanding: 0,
            breaker: None,
            removal_attempt: 0,
            removal_pending: false,
            open_orders: Vec::new(),
        }
    }

    pub fn view(&self) -> GrantView {
        GrantView {
            epoch: self.epoch,
            path: self.path.clone(),
            public_key: self.public_key.clone(),
            status: self.status,
            policy: self.policy,
            initial_reference: self.initial_reference.clone(),
            initial_value: self.initial_value.map(U128),
            turnover_used: U128(self.turnover_used),
            outstanding: U128(self.outstanding),
            breaker: self.breaker.clone(),
            key_op_in_flight: self.key == KeyState::Adding || self.removal_pending,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: u64,
    pub epoch: u64,
    pub sell: Asset,
    pub sell_amount: u128,
    pub buy_amount: Option<u128>,
    pub concession_bps: u16,
    /// Conservative exposure counted against the outstanding cap.
    pub reserved_value: u128,
    /// Turnover charged for this order; refunded only on rejection before a sign request.
    pub turnover_charged: u128,
    pub deadline_ns: Option<u64>,
    pub reference: Option<Reference>,
    pub payload: Option<Nep413Payload>,
    pub payload_hash: Option<[u8; 32]>,
    pub signature: Option<String>,
    pub state: OrderState,
    pub created_at_ns: u64,
    pub sign_requested_at_ns: Option<u64>,
    pub signed_at_ns: Option<u64>,
}

impl Order {
    /// A signature may exist for this order and its reservation has not been released.
    pub fn authority_may_exist(&self) -> bool {
        matches!(
            self.state,
            OrderState::Signing | OrderState::Signed | OrderState::SignUnknown
        )
    }

    pub fn is_open(&self) -> bool {
        self.state == OrderState::Pricing || self.authority_may_exist()
    }

    pub fn view(&self) -> OrderView {
        OrderView {
            id: U64(self.id),
            epoch: self.epoch,
            sell: self.sell,
            sell_amount: U128(self.sell_amount),
            buy: self.sell.other(),
            buy_amount: self.buy_amount.map(U128),
            concession_bps: self.concession_bps,
            reserved_value: U128(self.reserved_value),
            deadline_ns: self.deadline_ns.map(U64),
            reference: self.reference.clone(),
            payload: self.payload.clone(),
            payload_hash: self.payload_hash.map(hex::encode),
            signature: self.signature.clone(),
            state: self.state.clone(),
            created_at_ns: U64(self.created_at_ns),
            sign_requested_at_ns: self.sign_requested_at_ns.map(U64),
            signed_at_ns: self.signed_at_ns.map(U64),
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssetRecovery {
    /// Attempt id and start time of the in-flight attempt.
    pub in_flight: Option<(u32, u64)>,
    pub attempts: u32,
    pub recovered: u128,
}

impl AssetRecovery {
    pub fn view(&self, asset: Asset) -> AssetRecoveryView {
        AssetRecoveryView {
            asset,
            in_flight: self.in_flight.is_some(),
            attempts: self.attempts,
            recovered: U128(self.recovered),
        }
    }
}
