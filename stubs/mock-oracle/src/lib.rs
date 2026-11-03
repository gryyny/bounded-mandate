//! TEST DOUBLE of `aggregate-oracle.near`. Never deploy to a public network; never present
//! its prices as oracle output.
//!
//! # Pinned real interface
//!
//! Source: `contract_source_metadata` of `aggregate-oracle.near` reports version 0.4.1,
//! `https://github.com/rhea-finance/agg-oracle/tree/ba866eb500af7c4c5c7599a83c503a479432ca50`,
//! contract_path `contracts/agg_oracle`. That repository is not publicly readable (GitHub 404 on
//! 2026-11-03), so the interface below is pinned from the deployed code instead: the embedded
//! ABI returned by the `__contract_abi` view (zstd JSON, metadata `agg_oracle` 0.4.1, rustc 1.97.0,
//! cargo-near-build 0.11.5) of code hash `9vafnXzrPYQ4ErDqt2triRkQJHdxtG7tfkyb24t5Ttrg`
//! (sha256 849758fdb9b6a6d3172a0501c43e161b625fa9aa3439bc6c8baee63f1edc4fdd, block 222915636),
//! plus read-only mainnet view calls.
//!
//! - `get_price_no_older_than({"price_id": String, "age": u64})` (view; `age` is a JSON
//!   number of seconds) returns `Option<PythCompatPrice>`:
//!   `{"price": "<i64 string>", "conf": "<u64 string>", "expo": <i32>, "publish_time": <i64 unix s>}`
//!   or `null`. Observed: `{"price":"100032948","conf":"59085","expo":-8,"publish_time":1793732756}`.
//! - Price identifiers are Pyth Core feed ids, hex; `0x` prefix and upper case are accepted.
//!   Unknown or non-hex ids return `null` (no panic). From `get_pyth_core_price_feed_token_ids_paged`:
//!   - USDC (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`):
//!     `eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a`
//!   - NEAR (`wrap.near`): `c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750`
//!   - Both token configs use `price_expo` -8.
//! - Age: a value is returned iff `floor(block_timestamp_ns / 1e9) - publish_time <= age`
//!   (inclusive; probed at blocks 222915716 and 222915823: at `age = now_s - publish_time` the value
//!   is returned, at `age - 1` it is not; `age = 0` returned `null`).
//! - `list_prices_no_older_than({"price_ids": [String], "age": u64})` returns an object keyed by the
//!   input strings verbatim with `PythCompatPrice | null` values.
//!
//! # Deliberate simplifications
//!
//! The real contract aggregates several sources and the result depends on `age`: a larger window
//! can include older reports, and the returned `publish_time` is then the oldest included report.
//! This double stores one observation per id. Behavior for a `publish_time` in the future of
//! block time was not observable on mainnet; this double returns such a value as fresh.

use near_sdk::json_types::{I64, U64};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, PanicOnDefault, env, near, require};
use std::collections::HashMap;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythCompatPrice {
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time: i64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOracle {
    owner_id: AccountId,
    prices: LookupMap<String, PythCompatPrice>,
    fail: bool,
}

fn normalize(price_id: &str) -> String {
    let s = price_id
        .strip_prefix("0x")
        .or_else(|| price_id.strip_prefix("0X"))
        .unwrap_or(price_id);
    s.to_ascii_lowercase()
}

#[near]
impl MockOracle {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            prices: LookupMap::new(b"p"),
            fail: false,
        }
    }

    pub fn get_price_no_older_than(&self, price_id: String, age: u64) -> Option<PythCompatPrice> {
        require!(!self.fail, "mock-oracle: fail mode");
        let price = self.prices.get(&normalize(&price_id))?;
        let now_s = i128::from(env::block_timestamp() / 1_000_000_000);
        let elapsed = now_s.checked_sub(i128::from(price.publish_time))?;
        (elapsed <= i128::from(age)).then(|| price.clone())
    }

    pub fn list_prices_no_older_than(
        &self,
        price_ids: Vec<String>,
        age: u64,
    ) -> HashMap<String, Option<PythCompatPrice>> {
        price_ids
            .into_iter()
            .map(|id| {
                let price = self.get_price_no_older_than(id.clone(), age);
                (id, price)
            })
            .collect()
    }

    // Test controls (owner only).

    pub fn set_price(
        &mut self,
        price_id: String,
        price: I64,
        conf: U64,
        expo: i32,
        publish_time: i64,
    ) {
        self.assert_owner();
        self.prices.insert(
            normalize(&price_id),
            PythCompatPrice {
                price,
                conf,
                expo,
                publish_time,
            },
        );
    }

    pub fn set_unavailable(&mut self, price_id: String) {
        self.assert_owner();
        self.prices.remove(&normalize(&price_id));
    }

    /// While set, every price read panics, modelling a failing oracle call.
    pub fn set_fail(&mut self, fail: bool) {
        self.assert_owner();
        self.fail = fail;
    }

    pub fn is_mock(&self) -> bool {
        true
    }
}

impl MockOracle {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "mock-oracle: owner only"
        );
    }
}
