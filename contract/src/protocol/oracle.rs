//! Reference oracle `aggregate-oracle.near` (rhea-finance/agg-oracle v0.4.1 @ ba866eb). The source
//! repository is not public; the interface is pinned from the deployed contract's embedded ABI
//! (`__contract_abi`, code hash 9vafnXzrPYQ4ErDqt2triRkQJHdxtG7tfkyb24t5Ttrg) and mainnet view
//! responses recorded in `fixtures/vectors/oracle.json` (block 222916824).

use core::fmt;

use near_sdk::json_types::U64;
use near_sdk::{ext_contract, near};

use crate::types::{AssetConfig, PriceObservation};

/// Clock skew tolerated between an oracle `publish_time` and block time. A later publish time
/// is rejected: it would otherwise stretch the reference validity window.
pub const FUTURE_TOLERANCE_SEC: u64 = 5;
/// Accepted exponents. Both pinned feeds use -8; anything outside cannot be valued safely.
pub const MIN_EXPO: i32 = -18;
pub const MAX_EXPO: i32 = 0;

/// `PythCompatPrice`: `{"price": "<i64>", "conf": "<u64>", "expo": i32, "publish_time": i64}`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PythCompatPrice {
    pub price: String,
    pub conf: String,
    pub expo: i32,
    pub publish_time: i64,
}

#[allow(dead_code)]
#[ext_contract(ext_oracle)]
pub trait AggregateOracle {
    /// View. `null` when the feed is unknown or older than `age` seconds.
    fn get_price_no_older_than(&self, price_id: String, age: u64) -> Option<PythCompatPrice>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriceError {
    /// `null`: unknown feed or nothing fresh enough for the oracle.
    Missing,
    Malformed,
    NonPositive,
    InvalidExponent,
    Stale,
    FromFuture,
    ConfidenceTooWide,
}

impl fmt::Display for PriceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Missing => "price missing",
            Self::Malformed => "price malformed",
            Self::NonPositive => "price not positive",
            Self::InvalidExponent => "price exponent out of range",
            Self::Stale => "price stale",
            Self::FromFuture => "price published in the future",
            Self::ConfidenceTooWide => "price confidence too wide",
        })
    }
}

impl std::error::Error for PriceError {}

/// Validates a `get_price_no_older_than` result against block time `now_sec`.
///
/// Rejects `null`, malformed values, non-positive prices, exponents outside
/// [`MIN_EXPO`]..=[`MAX_EXPO`], `now_sec - publish_time > max_age_sec`, publish times more than
/// [`FUTURE_TOLERANCE_SEC`] ahead, and `conf / price > max_confidence_bps / 10_000`.
pub fn validate(
    result: &[u8],
    asset: &AssetConfig,
    now_sec: u64,
    max_age_sec: u64,
    max_confidence_bps: u16,
) -> Result<PriceObservation, PriceError> {
    let raw: Option<PythCompatPrice> =
        serde_json::from_slice(result).map_err(|_| PriceError::Malformed)?;
    let raw = raw.ok_or(PriceError::Missing)?;
    let price: i64 = raw.price.parse().map_err(|_| PriceError::Malformed)?;
    let conf: u64 = raw.conf.parse().map_err(|_| PriceError::Malformed)?;
    let publish = u64::try_from(raw.publish_time).map_err(|_| PriceError::Malformed)?;
    let price = u64::try_from(price)
        .ok()
        .filter(|p| *p > 0)
        .ok_or(PriceError::NonPositive)?;
    if !(MIN_EXPO..=MAX_EXPO).contains(&raw.expo) {
        return Err(PriceError::InvalidExponent);
    }
    match now_sec.checked_sub(publish) {
        Some(age) if age > max_age_sec => return Err(PriceError::Stale),
        Some(_) => {}
        None if publish.checked_sub(now_sec) > Some(FUTURE_TOLERANCE_SEC) => {
            return Err(PriceError::FromFuture);
        }
        None => {}
    }
    let lhs = u128::from(conf).checked_mul(10_000);
    let rhs = u128::from(price).checked_mul(u128::from(max_confidence_bps));
    match (lhs, rhs) {
        (Some(l), Some(r)) if l <= r => {}
        _ => return Err(PriceError::ConfidenceTooWide),
    }
    Ok(PriceObservation {
        price_id: asset.price_id.clone(),
        price: U64(price),
        conf: U64(conf),
        expo: raw.expo,
        publish_time_sec: U64(publish),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_793_735_320;

    fn usdc() -> AssetConfig {
        AssetConfig {
            token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
                .parse()
                .unwrap(),
            decimals: 6,
            price_id: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a".into(),
        }
    }

    fn body(price: &str, conf: &str, expo: i32, publish_time: i64) -> Vec<u8> {
        serde_json::json!({"price": price, "conf": conf, "expo": expo, "publish_time": publish_time})
            .to_string()
            .into_bytes()
    }

    fn check(b: &[u8], now: u64, max_age: u64, bps: u16) -> Result<PriceObservation, PriceError> {
        validate(b, &usdc(), now, max_age, bps)
    }

    #[test]
    fn accepts_fresh_price() {
        let obs = check(&body("99977763", "98904", -8, 1_793_735_286), NOW, 60, 50).unwrap();
        assert_eq!(
            obs,
            PriceObservation {
                price_id: usdc().price_id,
                price: U64(99_977_763),
                conf: U64(98_904),
                expo: -8,
                publish_time_sec: U64(1_793_735_286),
            }
        );
    }

    #[test]
    fn rejects_missing_and_malformed() {
        assert_eq!(check(b"null", NOW, 60, 50), Err(PriceError::Missing));
        for bad in [
            &b""[..],
            b"{}",
            br#"{"price":99977763,"conf":"1","expo":-8,"publish_time":1}"#,
            br#"{"price":"1.5","conf":"1","expo":-8,"publish_time":1}"#,
            br#"{"price":"1","conf":"-1","expo":-8,"publish_time":1}"#,
            br#"{"price":"1","conf":"1","expo":-8,"publish_time":-1}"#,
            br#"{"price":"99999999999999999999","conf":"1","expo":-8,"publish_time":1}"#,
        ] {
            assert_eq!(
                check(bad, NOW, 60, 50),
                Err(PriceError::Malformed),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
    }

    #[test]
    fn rejects_non_positive_and_bad_exponent() {
        assert_eq!(
            check(&body("0", "0", -8, 1_793_735_300), NOW, 60, 50),
            Err(PriceError::NonPositive)
        );
        assert_eq!(
            check(&body("-5", "0", -8, 1_793_735_300), NOW, 60, 50),
            Err(PriceError::NonPositive)
        );
        assert_eq!(
            check(&body("5", "0", -19, 1_793_735_300), NOW, 60, 50),
            Err(PriceError::InvalidExponent)
        );
        assert_eq!(
            check(&body("5", "0", 1, 1_793_735_300), NOW, 60, 50),
            Err(PriceError::InvalidExponent)
        );
        assert!(check(&body("5", "0", -18, 1_793_735_300), NOW, 60, 50).is_ok());
        assert!(check(&body("5", "0", 0, 1_793_735_300), NOW, 60, 50).is_ok());
    }

    #[test]
    fn staleness_boundaries() {
        let at = |publish: i64| check(&body("100", "0", -8, publish), NOW, 60, 50);
        assert!(at(1_793_735_260).is_ok()); // age exactly 60
        assert_eq!(at(1_793_735_259), Err(PriceError::Stale));
        assert_eq!(at(0), Err(PriceError::Stale));
        assert!(at(1_793_735_325).is_ok()); // 5 s ahead
        assert_eq!(at(1_793_735_326), Err(PriceError::FromFuture));
        assert_eq!(at(i64::MAX), Err(PriceError::FromFuture));
        assert_eq!(
            check(&body("100", "0", -8, 1_793_735_320), NOW, 0, 50).map(|o| o.price),
            Ok(U64(100))
        );
    }

    #[test]
    fn confidence_boundaries() {
        // conf / price == 50 bps exactly is accepted; one unit more is rejected.
        assert!(check(&body("1000000", "5000", -8, 1_793_735_300), NOW, 60, 50).is_ok());
        assert_eq!(
            check(&body("1000000", "5001", -8, 1_793_735_300), NOW, 60, 50),
            Err(PriceError::ConfidenceTooWide)
        );
        assert_eq!(
            check(&body("1000000", "1", -8, 1_793_735_300), NOW, 60, 0),
            Err(PriceError::ConfidenceTooWide)
        );
        assert!(check(&body("1000000", "0", -8, 1_793_735_300), NOW, 60, 0).is_ok());
        // No overflow at the extremes.
        let max = i64::MAX.to_string();
        assert!(
            check(
                &body(&max, &u64::MAX.to_string(), -8, 1_793_735_300),
                NOW,
                60,
                50
            )
            .is_err()
        );
        assert!(check(&body(&max, "0", -8, 1_793_735_300), NOW, 60, u16::MAX).is_ok());
    }
}
