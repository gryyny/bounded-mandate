//! Shared interface types for the mandate contract, its tools and its tests.
//!
//! Provisional: the coordinator changes these as integration requires. JSON amounts are decimal
//! strings; values are integer units with checked arithmetic.

use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{AccountId, PublicKey, near};

/// One of the two assets the mandate may trade. Exact token IDs and decimals live in [`AssetConfig`].
#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Asset {
    Usdc,
    Wnear,
}

impl Asset {
    pub const fn other(self) -> Self {
        match self {
            Self::Usdc => Self::Wnear,
            Self::Wnear => Self::Usdc,
        }
    }
}

/// The only input the agent can supply. It names no recipient, payload, key, path or token ID.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub sell: Asset,
    /// Integer units of the sold asset.
    pub sell_amount: U128,
    /// Requested price concession against the reference fair amount, in basis points.
    /// Rejected when above the grant's `max_concession_bps`.
    pub max_concession_bps: u16,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetConfig {
    /// NEP-141 token contract, e.g. `wrap.near`. The Intents token ID is `nep141:<token>`.
    pub token: AccountId,
    pub decimals: u8,
    /// Reference-oracle price identifier for this asset.
    pub price_id: String,
}

/// Fixed at initialization. The owner is trusted; the agent is not.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MandateConfig {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    /// NEAR Intents verifier, e.g. `intents.near`.
    pub verifier_id: AccountId,
    /// MPC signer, e.g. `v1.signer`.
    pub signer_id: AccountId,
    /// Reference price oracle, e.g. `aggregate-oracle.near`.
    pub oracle_id: AccountId,
    pub usdc: AssetConfig,
    pub wnear: AssetConfig,
}

/// Immutable per grant. Changing it requires confirmed revocation and a fresh grant.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Per-order cap as a share of the grant's initial reference value.
    pub per_order_cap_bps: u16,
    /// Cap on outstanding reservations as a share of the initial reference value.
    pub outstanding_cap_bps: u16,
    /// Maximum signed execution-price concession against the authorization reference.
    pub max_concession_bps: u16,
    pub oracle_max_age_sec: u32,
    /// Maximum oracle confidence interval relative to price.
    pub max_confidence_bps: u16,
    /// Stop new authorizations on observing this drawdown from the initial reference value.
    pub breaker_drawdown_bps: u16,
    /// Cumulative authorized turnover cap per grant as a share of the initial reference value.
    pub turnover_cap_bps: u32,
    /// Order deadline after authorization; also bounded by the references' validity window.
    pub order_ttl_sec: u32,
    /// Refuse to sign when less than this remains before the deadline.
    pub min_remaining_sec: u32,
    /// A proposal not priced within this delay can never be signed and may be released.
    pub max_pricing_delay_sec: u32,
}

impl Policy {
    /// Demonstration thresholds recorded before acceptance tests. Not proven production settings.
    pub const DEMO: Self = Self {
        per_order_cap_bps: 2_000,
        outstanding_cap_bps: 2_000,
        max_concession_bps: 50,
        oracle_max_age_sec: 60,
        max_confidence_bps: 50,
        breaker_drawdown_bps: 200,
        turnover_cap_bps: 10_000,
        order_ttl_sec: 60,
        min_remaining_sec: 15,
        max_pricing_delay_sec: 30,
    };
}

/// A validated oracle observation for one asset.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceObservation {
    pub price_id: String,
    /// Price mantissa; the USD price is `price * 10^expo`.
    pub price: U64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time_sec: U64,
}

/// Both reference prices and the block time at which they were accepted.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    pub usdc: PriceObservation,
    pub wnear: PriceObservation,
    pub observed_at_ns: U64,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantStatus {
    /// Key derivation, initial valuation or verifier registration is unresolved.
    Activating,
    Active,
    /// The owner requested removal: no new authorization; already-signed orders may still execute.
    Revoking,
    /// Removal of the grant key is confirmed: orders signed under it cannot execute.
    Revoked,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BreakerTrip {
    pub observed_at_ns: U64,
    /// Observed mark-to-market value, in [`ValueUnits`].
    pub observed_value: U128,
    pub executable_orders: u32,
    pub executable_value: U128,
}

/// USD values are integers in units of 10^-12 USD.
pub type ValueUnits = u128;
pub const VALUE_DECIMALS: u32 = 12;

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantView {
    pub epoch: u64,
    /// MPC derivation path, `mandate/v1/<epoch>`; never reused.
    pub path: String,
    pub public_key: Option<PublicKey>,
    pub status: GrantStatus,
    pub policy: Policy,
    pub initial_reference: Option<Reference>,
    pub initial_value: Option<U128>,
    pub turnover_used: U128,
    pub outstanding: U128,
    pub breaker: Option<BreakerTrip>,
    /// A verifier key registration or removal receipt is unresolved.
    pub key_op_in_flight: bool,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseReason {
    /// The verifier reported this exact nonce as used.
    Settled,
    /// Block time passed the signed deadline.
    Expired,
    /// Removal of the covering key was confirmed.
    KeyRemoved,
    /// No signature was ever requested.
    Unsigned,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case", tag = "state")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderState {
    /// Reserved; reference prices and account state requested.
    Pricing,
    /// Signature requested; authority may exist.
    Signing,
    /// Signature recorded by our callback.
    Signed,
    /// Our callback did not record a signature. A signature may still be public: authority may exist.
    SignUnknown,
    /// Rejected before any signature request.
    Rejected { reason: String },
    /// Reservation released exactly once.
    Released { reason: ReleaseReason },
}

/// The NEP-413 payload whose prehash the MPC signs.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Nep413Payload {
    /// JSON `DefusePayload<DefuseIntents>` with a single `token_diff` intent.
    pub message: String,
    /// 32-byte versioned nonce, base64.
    pub nonce: Base64VecU8,
    pub recipient: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderView {
    pub id: U64,
    pub epoch: u64,
    pub sell: Asset,
    pub sell_amount: U128,
    pub buy: Asset,
    pub buy_amount: Option<U128>,
    pub concession_bps: u16,
    /// Conservative exposure counted against the outstanding cap, in [`ValueUnits`].
    pub reserved_value: U128,
    pub deadline_ns: Option<U64>,
    pub reference: Option<Reference>,
    pub payload: Option<Nep413Payload>,
    /// Prehash signed by the MPC, hex.
    pub payload_hash: Option<String>,
    /// Ed25519 signature, `ed25519:<base58>`, when our callback recorded it.
    pub signature: Option<String>,
    pub state: OrderState,
    pub created_at_ns: U64,
    pub sign_requested_at_ns: Option<U64>,
    pub signed_at_ns: Option<U64>,
}
