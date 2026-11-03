//! Glue between contract state and the protocol adapters: promise construction with this
//! contract's gas/deposit choices, and result parsing mapped to rejection reasons.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{AccountId, CurveType, Gas, Promise, PublicKey, env};

use crate::protocol::gas::{self, tgas};
use crate::protocol::{mpc, nep413, oracle, verifier};
use crate::types::{AssetConfig, MandateConfig, Nep413Payload, Policy, PriceObservation};

pub const GAS_VIEW: Gas = tgas(gas::VERIFIER_VIEW_TGAS);
pub const GAS_ORACLE: Gas = tgas(gas::ORACLE_PRICE_TGAS);
pub const GAS_DERIVE: Gas = tgas(gas::MPC_DERIVED_PUBLIC_KEY_TGAS);
pub const GAS_KEY_OP: Gas = tgas(gas::VERIFIER_KEY_OP_TGAS);
pub const GAS_TRANSFER: Gas = tgas(gas::VERIFIER_MT_TRANSFER_TGAS);
pub const GAS_SIGN: Gas = tgas(gas::MPC_SIGN_TGAS);
/// Largest promise result read; every expected response is far smaller.
pub const MAX_RESULT_LEN: usize = 4_096;
const NS_PER_SEC: u64 = 1_000_000_000;
const RECOVERY_MEMO: &str = "bounded-mandate recovery";

fn me() -> AccountId {
    env::current_account_id()
}

pub fn derive_public_key(c: &MandateConfig, path: &str) -> Promise {
    mpc::ext_mpc::ext(c.signer_id.clone())
        .with_static_gas(GAS_DERIVE)
        .derived_public_key(path.to_owned(), Some(me()), Some(mpc::DOMAIN_ID_ED25519))
}

pub fn get_price(c: &MandateConfig, asset: &AssetConfig, max_age_sec: u32) -> Promise {
    oracle::ext_oracle::ext(c.oracle_id.clone())
        .with_static_gas(GAS_ORACLE)
        .get_price_no_older_than(asset.price_id.clone(), u64::from(max_age_sec))
}

/// Both balances in `[usdc, wnear]` order.
pub fn balances(c: &MandateConfig) -> Promise {
    verifier::ext_verifier::ext(c.verifier_id.clone())
        .with_static_gas(GAS_VIEW)
        .mt_batch_balance_of(
            me(),
            vec![
                nep413::token_id(&c.usdc.token),
                nep413::token_id(&c.wnear.token),
            ],
        )
}

pub fn mt_balance_of(c: &MandateConfig, asset: &AssetConfig) -> Promise {
    verifier::ext_verifier::ext(c.verifier_id.clone())
        .with_static_gas(GAS_VIEW)
        .mt_balance_of(me(), nep413::token_id(&asset.token))
}

pub fn current_salt(c: &MandateConfig) -> Promise {
    verifier::ext_verifier::ext(c.verifier_id.clone())
        .with_static_gas(GAS_VIEW)
        .current_salt()
}

pub fn add_public_key(c: &MandateConfig, pk: PublicKey) -> Promise {
    verifier::ext_verifier::ext(c.verifier_id.clone())
        .with_static_gas(GAS_KEY_OP)
        .with_attached_deposit(verifier::ONE_YOCTO)
        .add_public_key(pk)
}

pub fn remove_public_key(c: &MandateConfig, pk: PublicKey, gas: Gas) -> Promise {
    verifier::ext_verifier::ext(c.verifier_id.clone())
        .with_static_gas(gas)
        .with_attached_deposit(verifier::ONE_YOCTO)
        .remove_public_key(pk)
}

pub fn has_public_key(c: &MandateConfig, pk: PublicKey) -> Promise {
    verifier::ext_verifier::ext(c.verifier_id.clone())
        .with_static_gas(GAS_VIEW)
        .has_public_key(me(), pk)
}

pub fn is_nonce_used(c: &MandateConfig, nonce: Base64VecU8) -> Promise {
    verifier::ext_verifier::ext(c.verifier_id.clone())
        .with_static_gas(GAS_VIEW)
        .is_nonce_used(me(), nonce)
}

/// Transfers inside the verifier to the fixed owner; the recipient is never an argument.
pub fn mt_transfer(c: &MandateConfig, asset: &AssetConfig, amount: u128, gas: Gas) -> Promise {
    verifier::ext_verifier::ext(c.verifier_id.clone())
        .with_static_gas(gas)
        .with_attached_deposit(verifier::ONE_YOCTO)
        .mt_transfer(
            c.owner_id.clone(),
            nep413::token_id(&asset.token),
            U128(amount),
            None,
            Some(RECOVERY_MEMO.to_owned()),
        )
}

pub fn sign(c: &MandateConfig, path: &str, prehash: &[u8; 32]) -> Promise {
    mpc::ext_mpc::ext(c.signer_id.clone())
        .with_static_gas(GAS_SIGN)
        .with_attached_deposit(mpc::SIGN_DEPOSIT)
        .sign(mpc::sign_args(path.to_owned(), prehash))
}

pub fn parse_price(
    result: Option<&[u8]>,
    asset: &AssetConfig,
    policy: &Policy,
    now_ns: u64,
) -> Result<PriceObservation, String> {
    let bytes = result.ok_or_else(|| format!("{}: price unavailable", asset.price_id))?;
    let now_sec = now_ns.checked_div(NS_PER_SEC).unwrap_or(0);
    oracle::validate(
        bytes,
        asset,
        now_sec,
        u64::from(policy.oracle_max_age_sec),
        policy.max_confidence_bps,
    )
    .map_err(|e| format!("{}: {e}", asset.price_id))
}

pub fn parse_public_key(bytes: &[u8]) -> Option<PublicKey> {
    mpc::parse_public_key(bytes).ok()
}

pub fn parse_balances(bytes: &[u8]) -> Option<(u128, u128)> {
    match verifier::parse_u128_list(bytes).ok()?.as_slice() {
        [usdc, wnear] => Some((*usdc, *wnear)),
        _ => None,
    }
}

pub fn parse_u128(bytes: &[u8]) -> Option<u128> {
    verifier::parse_u128(bytes).ok()
}

pub fn parse_salt(bytes: &[u8]) -> Option<[u8; 4]> {
    verifier::parse_salt(bytes).ok()
}

pub fn parse_bool(bytes: &[u8]) -> Option<bool> {
    verifier::parse_bool(bytes).ok()
}

/// A signature from the MPC response that verifies against `pk` over `prehash`.
pub fn verified_signature(bytes: &[u8], pk: &PublicKey, prehash: &[u8; 32]) -> Option<[u8; 64]> {
    let sig = mpc::parse_signature(bytes).ok()?;
    if pk.curve_type() != CurveType::ED25519 {
        return None;
    }
    let key: [u8; 32] = pk.as_bytes().get(1..)?.try_into().ok()?;
    env::ed25519_verify(&sig, prehash, &key).then_some(sig)
}

pub fn signature_string(sig: &[u8; 64]) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(sig).into_string())
}

pub fn multi_payload_json(
    payload: &Nep413Payload,
    pk: &PublicKey,
    sig: &[u8; 64],
) -> Option<String> {
    nep413::multi_payload_json(payload, pk, sig).ok()
}

/// Builds the exact `token_diff` payload and its NEP-413 prehash.
#[allow(clippy::too_many_arguments)]
pub fn build_order(
    c: &MandateConfig,
    sell: &AssetConfig,
    sell_amount: u128,
    buy: &AssetConfig,
    buy_amount: u128,
    deadline_ns: u64,
    salt: [u8; 4],
    random: [u8; 15],
) -> Result<(Nep413Payload, [u8; 32]), String> {
    let order = nep413::TokenDiffOrder {
        signer_id: me(),
        verifying_contract: c.verifier_id.clone(),
        deadline_ns,
        nonce: nep413::versioned_nonce(salt, deadline_ns, random),
        sell_token: sell.token.clone(),
        sell_amount,
        buy_token: buy.token.clone(),
        buy_amount,
    };
    let payload = nep413::payload(&order).map_err(|e| e.to_string())?;
    let hash = nep413::prehash(&payload).map_err(|e| e.to_string())?;
    Ok((payload, hash))
}
