//! TEST DOUBLE NEP-141 fungible token standing in for USDC
//! (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, 6 decimals) and wNEAR
//! (`wrap.near`, 24 decimals) in sandbox tests. Never deploy to a public network.
//!
//! Standard `near-contract-standards` NEP-141/NEP-145/NEP-148 behavior, plus an owner-only
//! `mint` that registers the receiver if needed. wNEAR's `near_deposit`/`near_withdraw` are not
//! modelled.
//!
//! # Verifier deposit format (near/intents @ 16d04f6ec4401263f8914638710260da50bb46b0,
//! `contracts/defuse/src/contract/tokens/nep141/deposit.rs`, `contracts/defuse/src/tokens/mod.rs`)
//!
//! `ft_transfer_call({"receiver_id": <verifier>, "amount": "<u128>", "msg": <msg>})` with 1 yocto,
//! where `msg` is the receiving Intents account id as a plain string (e.g. `"mandate.test.near"`);
//! an empty `msg` credits `sender_id`; a `msg` starting with `{` is parsed as JSON
//! `{"receiver_id", "execute_intents", "refund_if_fails"}`. `amount` must be > 0. The credit is to
//! multi-token id `nep141:<token account id>`, readable via verifier
//! `mt_balance_of({"account_id", "token_id": "nep141:<token>"})`. The verifier returns `"0"` unused,
//! so nothing is refunded. As with any NEP-141 token, the verifier account must be registered
//! (`storage_deposit`) on the token first.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, PanicOnDefault, PromiseOrValue, env, near, require};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    owner_id: AccountId,
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(owner_id: AccountId, name: String, symbol: String, decimals: u8) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();
        Self {
            owner_id,
            token: FungibleToken::new(b"t"),
            metadata,
        }
    }

    /// Owner only. Registers `account_id` from the contract balance if it is not registered.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "mock-ft: owner only"
        );
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("mock-ft test mint"),
        }
        .emit();
    }

    pub fn is_mock(&self) -> bool {
        true
    }
}

#[near]
impl FungibleTokenCore for MockFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockFt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            env::log_str(&format!("mock-ft: {burned} burned on closed account"));
        }
        used.into()
    }
}

#[near]
impl StorageManagement for MockFt {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            env::log_str(&format!(
                "mock-ft: closed {account_id} with balance {balance}"
            ));
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockFt {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}
