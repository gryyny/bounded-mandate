//! NEAR Intents verifier (`intents.near`, defuse v0.4.5, near/intents@16d04f6).
//!
//! `add_public_key`, `remove_public_key` and `mt_transfer` are predecessor-authorized and need
//! exactly 1 yocto. `add_public_key` panics if the key is already registered; `remove_public_key`
//! panics if it is absent. Expired versioned nonces may be garbage-collected, after which
//! `is_nonce_used` can read `false` again: it is settlement evidence only before the deadline.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{AccountId, NearToken, PublicKey, ext_contract};

use super::ProtocolError;

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[allow(dead_code)]
#[ext_contract(ext_verifier)]
pub trait Verifier {
    fn add_public_key(&mut self, public_key: PublicKey);
    fn remove_public_key(&mut self, public_key: PublicKey);
    fn has_public_key(&self, account_id: AccountId, public_key: PublicKey) -> bool;
    /// `nonce` is the 32-byte nonce, base64.
    fn is_nonce_used(&self, account_id: AccountId, nonce: Base64VecU8) -> bool;
    /// Returns the current 4-byte salt as a hex string.
    fn current_salt(&self) -> String;
    fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128;
    fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128>;
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

/// `current_salt` result: a JSON string of 8 hex digits.
pub fn parse_salt(bytes: &[u8]) -> Result<[u8; 4], ProtocolError> {
    let s: String = serde_json::from_slice(bytes).map_err(|_| ProtocolError::Malformed("salt"))?;
    hex::decode(s)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(ProtocolError::Malformed("salt"))
}

/// `mt_balance_of` result: a decimal string.
pub fn parse_u128(bytes: &[u8]) -> Result<u128, ProtocolError> {
    serde_json::from_slice::<U128>(bytes)
        .map(|v| v.0)
        .map_err(|_| ProtocolError::Malformed("u128"))
}

/// `mt_batch_balance_of` result, in request order.
pub fn parse_u128_list(bytes: &[u8]) -> Result<Vec<u128>, ProtocolError> {
    serde_json::from_slice::<Vec<U128>>(bytes)
        .map(|v| v.into_iter().map(|x| x.0).collect())
        .map_err(|_| ProtocolError::Malformed("u128 list"))
}

/// `has_public_key` / `is_nonce_used` result.
pub fn parse_bool(bytes: &[u8]) -> Result<bool, ProtocolError> {
    serde_json::from_slice(bytes).map_err(|_| ProtocolError::Malformed("bool"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn salt() {
        assert_eq!(parse_salt(br#""0a1b2c3d""#), Ok([0x0a, 0x1b, 0x2c, 0x3d]));
        assert_eq!(parse_salt(br#""0A1B2C3D""#), Ok([0x0a, 0x1b, 0x2c, 0x3d]));
        for bad in [
            &br#""0a1b2c""#[..],
            br#""0a1b2c3d4e""#,
            br#""zz1b2c3d""#,
            b"[10,27,44,61]",
            b"",
        ] {
            assert_eq!(parse_salt(bad), Err(ProtocolError::Malformed("salt")));
        }
    }

    #[test]
    fn u128_values() {
        assert_eq!(parse_u128(br#""0""#), Ok(0));
        assert_eq!(
            parse_u128(format!("\"{}\"", u128::MAX).as_bytes()),
            Ok(u128::MAX)
        );
        for bad in [
            &b"5"[..],
            br#""-1""#,
            br#""340282366920938463463374607431768211456""#,
            b"null",
        ] {
            assert!(parse_u128(bad).is_err());
        }
        assert_eq!(parse_u128_list(br#"["1","2"]"#), Ok(vec![1, 2]));
        assert!(parse_u128_list(br#"["1",2]"#).is_err());
    }

    #[test]
    fn bools() {
        assert_eq!(parse_bool(b"true"), Ok(true));
        assert_eq!(parse_bool(b"false"), Ok(false));
        for bad in [&b"\"true\""[..], b"1", b"null", b""] {
            assert!(parse_bool(bad).is_err());
        }
    }
}
