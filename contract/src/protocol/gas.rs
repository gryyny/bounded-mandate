//! Static gas for every external call and callback. Unused attached gas is refunded, so margins
//! cost nothing on success; too little gas fails a receipt and leaves a reservation open.
//! Verifier figures are checked against measured `gas_burnt` in `tests/protocol_sandbox.rs`;
//! oracle and MPC figures are estimates with margin (their mainnet WASM is not run locally).

use near_sdk::Gas;

/// Maximum prepaid gas of one transaction (and one function call).
pub const MAX_TX_TGAS: u64 = 300;

// External calls.
/// `aggregate-oracle.near` `get_price_no_older_than`: a view over stored prices (estimate).
pub const ORACLE_PRICE_TGAS: u64 = 10;
/// `v1.signer` `derived_public_key`: one Ed25519 point derivation in WASM (estimate).
pub const MPC_DERIVED_PUBLIC_KEY_TGAS: u64 = 15;
/// `v1.signer` `sign`: the contract requires at least 15 TGas and reserves 7 TGas for the
/// yield-resume callback plus 2 TGas for timeout failure out of it.
pub const MPC_SIGN_TGAS: u64 = 30;
/// Verifier views: `current_salt`, `has_public_key`, `is_nonce_used`, `mt_balance_of`,
/// `mt_batch_balance_of`.
pub const VERIFIER_VIEW_TGAS: u64 = 10;
/// Verifier `add_public_key` / `remove_public_key`: one storage write and an event.
pub const VERIFIER_KEY_OP_TGAS: u64 = 10;
/// Verifier `mt_transfer` between Intents accounts: internal balances and an event, no
/// cross-contract notification.
pub const VERIFIER_MT_TRANSFER_TGAS: u64 = 15;

// Our callbacks: own execution plus whatever they attach to further calls.
/// Re-checks and builds/hashes the payload; emits no signature.
pub const ON_PRICED_SELF_TGAS: u64 = 20;
/// Records the signature and emits `order_signed` with the full MultiPayload (~1.5 KB log).
pub const ON_SIGNED_TGAS: u64 = 15;
/// Grant valuation callback before registering the key.
pub const ON_GRANT_PRICED_SELF_TGAS: u64 = 20;
/// Key registration/removal result. Removal may release every reservation of the epoch, so this
/// is the largest callback; W1 must bound the per-call work accordingly.
pub const ON_KEY_OP_TGAS: u64 = 50;
/// Settlement (`is_nonce_used`) result: releases one reservation.
pub const ON_NONCE_CHECKED_TGAS: u64 = 10;
/// Recovery balance read: issues `mt_transfer`.
pub const ON_RECOVERY_BALANCE_SELF_TGAS: u64 = 10;
/// Recovery transfer result.
pub const ON_RECOVERY_TRANSFER_TGAS: u64 = 10;

// Entry points: own execution before the first external call.
pub const PROPOSE_SELF_TGAS: u64 = 20;
pub const GRANT_SELF_TGAS: u64 = 20;
pub const REVOKE_SELF_TGAS: u64 = 10;
pub const SETTLE_SELF_TGAS: u64 = 10;
pub const RECOVER_SELF_TGAS: u64 = 10;

const fn sum(parts: &[u64]) -> u64 {
    let mut total = 0u64;
    let mut i = 0;
    while i < parts.len() {
        total = match total.checked_add(parts[i]) {
            Some(t) => t,
            None => panic!("gas overflow"),
        };
        i = match i.checked_add(1) {
            Some(n) => n,
            None => panic!("index overflow"),
        };
    }
    total
}

/// Attached to `on_priced`: its own work, the MPC `sign`, and `on_signed`.
pub const ON_PRICED_TGAS: u64 = sum(&[ON_PRICED_SELF_TGAS, MPC_SIGN_TGAS, ON_SIGNED_TGAS]);
/// Minimum prepaid gas for `propose_order`: two prices, salt, balances (one batch view), then
/// `on_priced`.
pub const PROPOSE_ORDER_TGAS: u64 = sum(&[
    PROPOSE_SELF_TGAS,
    ORACLE_PRICE_TGAS,
    ORACLE_PRICE_TGAS,
    VERIFIER_VIEW_TGAS,
    VERIFIER_VIEW_TGAS,
    ON_PRICED_TGAS,
]);
/// Attached to the grant valuation callback: its work, `add_public_key` and its result callback.
pub const ON_GRANT_PRICED_TGAS: u64 = sum(&[
    ON_GRANT_PRICED_SELF_TGAS,
    VERIFIER_KEY_OP_TGAS,
    ON_KEY_OP_TGAS,
]);
/// `grant`: derived key, two prices, balances, then valuation and registration.
pub const GRANT_TGAS: u64 = sum(&[
    GRANT_SELF_TGAS,
    MPC_DERIVED_PUBLIC_KEY_TGAS,
    ORACLE_PRICE_TGAS,
    ORACLE_PRICE_TGAS,
    VERIFIER_VIEW_TGAS,
    ON_GRANT_PRICED_TGAS,
]);
/// `revoke`: `remove_public_key` and its result callback.
pub const REVOKE_TGAS: u64 = sum(&[REVOKE_SELF_TGAS, VERIFIER_KEY_OP_TGAS, ON_KEY_OP_TGAS]);
/// `settle_order`: `is_nonce_used` and its callback.
pub const SETTLE_TGAS: u64 = sum(&[SETTLE_SELF_TGAS, VERIFIER_VIEW_TGAS, ON_NONCE_CHECKED_TGAS]);
/// Attached to the recovery balance callback: its work, `mt_transfer`, and the result callback.
pub const ON_RECOVERY_BALANCE_TGAS: u64 = sum(&[
    ON_RECOVERY_BALANCE_SELF_TGAS,
    VERIFIER_MT_TRANSFER_TGAS,
    ON_RECOVERY_TRANSFER_TGAS,
]);
/// `recover`: balance read, then transfer.
pub const RECOVER_TGAS: u64 = sum(&[
    RECOVER_SELF_TGAS,
    VERIFIER_VIEW_TGAS,
    ON_RECOVERY_BALANCE_TGAS,
]);

const _: () = {
    assert!(
        MPC_SIGN_TGAS >= 15,
        "v1.signer rejects sign with less than 15 TGas"
    );
    assert!(PROPOSE_ORDER_TGAS <= MAX_TX_TGAS);
    assert!(GRANT_TGAS <= MAX_TX_TGAS);
    assert!(REVOKE_TGAS <= MAX_TX_TGAS);
    assert!(SETTLE_TGAS <= MAX_TX_TGAS);
    assert!(RECOVER_TGAS <= MAX_TX_TGAS);
};

pub const fn tgas(t: u64) -> Gas {
    Gas::from_tgas(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_are_sums_of_parts() {
        assert_eq!(ON_PRICED_TGAS, 65);
        assert_eq!(PROPOSE_ORDER_TGAS, 125);
        assert_eq!(GRANT_TGAS, 145);
        assert_eq!(REVOKE_TGAS, 70);
        assert_eq!(SETTLE_TGAS, 30);
        assert_eq!(RECOVER_TGAS, 55);
        assert_eq!(tgas(PROPOSE_ORDER_TGAS).as_gas(), 125_000_000_000_000);
    }
}
