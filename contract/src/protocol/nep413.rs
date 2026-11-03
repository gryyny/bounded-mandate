//! NEP-413 `token_diff` payloads exactly as the pinned NEAR Intents verifier
//! (near/intents@16d04f6, `defuse-core` / `defuse-nep413`) decodes and hashes them.

use std::collections::BTreeMap;

use near_sdk::json_types::Base64VecU8;
use near_sdk::{AccountId, CurveType, PublicKey, env, near};
use serde::Serialize;

use super::ProtocolError;
use crate::types::Nep413Payload;

/// NEP-461 off-chain prefix tag for NEP-413: `2^31 + 413`.
pub const NEP413_TAG: u32 = 2_147_484_061;
/// `VersionedNonce::VERSIONED_MAGIC_PREFIX`; the byte after it is the version (`V1` = 0).
pub const VERSIONED_NONCE_MAGIC: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];
const NONCE_V1: u8 = 0;

/// Intents token ID of a NEP-141 token.
pub fn token_id(token: &AccountId) -> String {
    format!("nep141:{token}")
}

/// Versioned nonce V1: `magic || 0 || salt || deadline_ns (i64 LE) || random`.
///
/// The verifier rejects the nonce after `deadline_ns` (strictly greater block time) or once the
/// salt is invalidated. `deadline_ns` must be at most `i64::MAX`; [`payload`] enforces that for the
/// matching message deadline, and a larger value would decode as a past deadline (fails closed).
pub fn versioned_nonce(salt: [u8; 4], deadline_ns: u64, random: [u8; 15]) -> [u8; 32] {
    let mut nonce = [0u8; 32];
    nonce[..4].copy_from_slice(&VERSIONED_NONCE_MAGIC);
    nonce[4] = NONCE_V1;
    nonce[5..9].copy_from_slice(&salt);
    nonce[9..17].copy_from_slice(&deadline_ns.to_le_bytes());
    nonce[17..].copy_from_slice(&random);
    nonce
}

/// One exact swap signed by `signer_id`: it loses `sell_amount` of `sell_token` and gains
/// `buy_amount` of `buy_token`. Verifier fees are charged only on negative deltas of the matching
/// counterparty side, so these amounts are exact for the signer.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenDiffOrder {
    pub signer_id: AccountId,
    /// NEP-413 recipient; must equal the verifier account.
    pub verifying_contract: AccountId,
    pub deadline_ns: u64,
    pub nonce: [u8; 32],
    pub sell_token: AccountId,
    pub sell_amount: u128,
    pub buy_token: AccountId,
    pub buy_amount: u128,
}

#[derive(Serialize)]
struct Message<'a> {
    signer_id: &'a AccountId,
    deadline: String,
    intents: [TokenDiffIntent; 1],
}

#[derive(Serialize)]
struct TokenDiffIntent {
    intent: &'static str,
    diff: BTreeMap<String, String>,
}

/// The NEP-413 `message`: `{"signer_id","deadline","intents":[{"intent":"token_diff","diff":{..}}]}`.
///
/// `verifying_contract` and `nonce` are not repeated here: the verifier takes them from the
/// NEP-413 envelope (`recipient`, `nonce`). Deltas are i128 decimal strings keyed by
/// `nep141:<token>` in sorted order; no memo or referral.
pub fn build_message(order: &TokenDiffOrder) -> Result<String, ProtocolError> {
    if order.sell_token == order.buy_token {
        return Err(ProtocolError::InvalidOrder("same token on both sides"));
    }
    let sell = signed_amount(order.sell_amount)?
        .checked_neg()
        .ok_or(ProtocolError::InvalidOrder("amount out of range"))?;
    let buy = signed_amount(order.buy_amount)?;
    let diff = BTreeMap::from([
        (token_id(&order.sell_token), sell.to_string()),
        (token_id(&order.buy_token), buy.to_string()),
    ]);
    let message = Message {
        signer_id: &order.signer_id,
        deadline: rfc3339_utc(order.deadline_ns)?,
        intents: [TokenDiffIntent {
            intent: "token_diff",
            diff,
        }],
    };
    serde_json::to_string(&message).map_err(|_| ProtocolError::Malformed("message"))
}

/// The payload the MPC signs (through [`prehash`]) and the verifier checks.
pub fn payload(order: &TokenDiffOrder) -> Result<Nep413Payload, ProtocolError> {
    Ok(Nep413Payload {
        message: build_message(order)?,
        nonce: Base64VecU8(order.nonce.to_vec()),
        recipient: order.verifying_contract.clone(),
    })
}

/// `sha256(borsh(NEP413_TAG, {message, nonce: [u8; 32], recipient, callback_url: None}))`, the
/// exact `defuse_nep413::Nep413::prehash`.
pub fn prehash(payload: &Nep413Payload) -> Result<[u8; 32], ProtocolError> {
    let nonce = nonce_bytes(payload)?;
    let bytes = borsh::to_vec(&(
        NEP413_TAG,
        &payload.message,
        &nonce,
        payload.recipient.as_str(),
        None::<String>,
    ))
    .map_err(|_| ProtocolError::Malformed("payload"))?;
    Ok(env::sha256_array(&bytes))
}

#[derive(Serialize)]
struct SignedNep413<'a> {
    standard: &'static str,
    payload: &'a Nep413Payload,
    public_key: &'a PublicKey,
    signature: String,
}

/// The `MultiPayload` NEP-413 arm accepted by `execute_intents(signed: Vec<MultiPayload>)`.
pub fn multi_payload_json(
    payload: &Nep413Payload,
    public_key: &PublicKey,
    signature: &[u8; 64],
) -> Result<String, ProtocolError> {
    if public_key.curve_type() != CurveType::ED25519 {
        return Err(ProtocolError::UnsupportedCurve);
    }
    nonce_bytes(payload)?;
    serde_json::to_string(&SignedNep413 {
        standard: "nep413",
        payload,
        public_key,
        signature: format!(
            "ed25519:{}",
            near_sdk::bs58::encode(signature).into_string()
        ),
    })
    .map_err(|_| ProtocolError::Malformed("multi payload"))
}

fn nonce_bytes(payload: &Nep413Payload) -> Result<[u8; 32], ProtocolError> {
    payload
        .nonce
        .0
        .as_slice()
        .try_into()
        .map_err(|_| ProtocolError::Malformed("nonce: 32 bytes required"))
}

fn signed_amount(amount: u128) -> Result<i128, ProtocolError> {
    if amount == 0 {
        return Err(ProtocolError::InvalidOrder("zero amount"));
    }
    i128::try_from(amount).map_err(|_| ProtocolError::InvalidOrder("amount out of range"))
}

const NANOS_PER_SEC: u64 = 1_000_000_000;
const SECS_PER_DAY: u64 = 86_400;

/// RFC 3339 UTC as `defuse_time::Timestamp` displays it: fraction omitted when zero, otherwise
/// nanoseconds with trailing zeros trimmed.
fn rfc3339_utc(ns: u64) -> Result<String, ProtocolError> {
    if i64::try_from(ns).is_err() {
        return Err(ProtocolError::InvalidOrder("deadline out of range"));
    }
    let secs = ns / NANOS_PER_SEC;
    let nanos = ns % NANOS_PER_SEC;
    let (year, month, day) = civil_from_days(secs / SECS_PER_DAY)
        .ok_or(ProtocolError::InvalidOrder("deadline out of range"))?;
    let sod = secs % SECS_PER_DAY;
    let mut out = format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        sod / 3_600,
        sod % 3_600 / 60,
        sod % 60
    );
    if nanos != 0 {
        let fraction = format!("{nanos:09}");
        out.push('.');
        out.push_str(fraction.trim_end_matches('0'));
    }
    out.push('Z');
    Ok(out)
}

/// Days since 1970-01-01 to (year, month, day); H. Hinnant's `civil_from_days` for z >= 0.
fn civil_from_days(days: u64) -> Option<(u64, u64, u64)> {
    let z = days.checked_add(719_468)?;
    let era = z / 146_097;
    let doe = z.checked_sub(era.checked_mul(146_097)?)?;
    let yoe = doe
        .checked_sub(doe / 1_460)?
        .checked_add(doe / 36_524)?
        .checked_sub(doe / 146_096)?
        / 365;
    let doy = doe.checked_sub(
        yoe.checked_mul(365)?
            .checked_add(yoe / 4)?
            .checked_sub(yoe / 100)?,
    )?;
    let mp = doy.checked_mul(5)?.checked_add(2)? / 153;
    let day = doy
        .checked_sub(mp.checked_mul(153)?.checked_add(2)? / 5)?
        .checked_add(1)?;
    let month = if mp < 10 {
        mp.checked_add(3)?
    } else {
        mp.checked_sub(9)?
    };
    let year = era
        .checked_mul(400)?
        .checked_add(yoe)?
        .checked_add(u64::from(month <= 2))?;
    Some((year, month, day))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn order() -> TokenDiffOrder {
        TokenDiffOrder {
            signer_id: acct("mandate.near"),
            verifying_contract: acct("intents.near"),
            deadline_ns: 1_793_735_328_123_456_789,
            nonce: versioned_nonce([1, 2, 3, 4], 1_793_735_328_123_456_789, [9; 15]),
            sell_token: acct("wrap.near"),
            sell_amount: 2_000_000_000_000_000_000_000_000,
            buy_token: acct("usdc.near"),
            buy_amount: 7_500_000,
        }
    }

    #[test]
    fn token_id_is_nep141_prefixed() {
        assert_eq!(token_id(&acct("wrap.near")), "nep141:wrap.near");
    }

    #[test]
    fn versioned_nonce_layout() {
        let n = versioned_nonce([0xaa, 0xbb, 0xcc, 0xdd], 0x0102_0304_0506_0708, [0xee; 15]);
        assert_eq!(hex::encode(&n[..5]), "5628f6c600");
        assert_eq!(hex::encode(&n[5..9]), "aabbccdd");
        assert_eq!(hex::encode(&n[9..17]), "0807060504030201");
        assert_eq!(n[17..], [0xee; 15]);
    }

    #[test]
    fn message_shape() {
        let m = build_message(&order()).unwrap();
        assert_eq!(
            m,
            "{\"signer_id\":\"mandate.near\",\"deadline\":\"2026-11-03T19:48:48.123456789Z\",\
             \"intents\":[{\"intent\":\"token_diff\",\"diff\":{\"nep141:usdc.near\":\"7500000\",\
             \"nep141:wrap.near\":\"-2000000000000000000000000\"}}]}"
        );
    }

    // Expected strings from Python `datetime.fromtimestamp(s, timezone.utc)` (independent).
    #[test]
    fn rfc3339_matches_calendar() {
        let cases = [
            (0, "1970-01-01T00:00:00Z"),
            (951_782_399_999_999_999, "2000-02-28T23:59:59.999999999Z"),
            (951_782_400_000_000_000, "2000-02-29T00:00:00Z"),
            (951_868_799_000_000_000, "2000-02-29T23:59:59Z"),
            (951_868_800_000_000_000, "2000-03-01T00:00:00Z"),
            (4_107_456_000_000_000_000, "2100-02-28T00:00:00Z"),
            (4_107_542_400_100_000_000, "2100-03-01T00:00:00.1Z"),
            (1_709_164_800_000_001_000, "2024-02-29T00:00:00.000001Z"),
            (i64::MAX.unsigned_abs(), "2262-04-11T23:47:16.854775807Z"),
        ];
        for (ns, expected) in cases {
            assert_eq!(rfc3339_utc(ns).unwrap(), expected, "{ns}");
        }
    }

    #[test]
    fn rejects_unencodable_orders() {
        let reject = |f: fn(&mut TokenDiffOrder)| {
            let mut o = order();
            f(&mut o);
            assert!(matches!(
                build_message(&o),
                Err(ProtocolError::InvalidOrder(_))
            ));
            assert!(payload(&o).is_err());
        };
        reject(|o| o.sell_amount = 0);
        reject(|o| o.buy_amount = 0);
        reject(|o| o.sell_amount = i128::MAX.unsigned_abs().checked_add(1).unwrap());
        reject(|o| o.buy_amount = u128::MAX);
        reject(|o| o.buy_token = o.sell_token.clone());
        reject(|o| o.deadline_ns = i64::MAX.unsigned_abs().checked_add(1).unwrap());
    }

    #[test]
    fn accepts_extreme_encodable_amounts() {
        let mut o = order();
        o.sell_amount = i128::MAX.unsigned_abs();
        o.buy_amount = 1;
        let m = build_message(&o).unwrap();
        assert!(m.contains(&format!("\"-{}\"", i128::MAX)));
        assert!(m.contains("\"nep141:usdc.near\":\"1\""));
    }

    #[test]
    fn payload_uses_verifier_as_recipient() {
        let o = order();
        let p = payload(&o).unwrap();
        assert_eq!(p.recipient, o.verifying_contract);
        assert_eq!(p.nonce.0, o.nonce);
        assert_eq!(p.message, build_message(&o).unwrap());
    }

    // Upstream `defuse-nep413` test vector (crates/signatures/nep413/src/lib.rs @ 16d04f6): the
    // published signature must verify against our prehash.
    #[test]
    fn prehash_matches_upstream_vector() {
        let p = Nep413Payload {
            message: "Hello, world!".into(),
            nonce: Base64VecU8(vec![0; 32]),
            recipient: acct("intents.near"),
        };
        let key: [u8; 32] =
            hex::decode("e2e9cb7ac57cb46d4da1ce1d1cc2c33bdfe17407c517916b522724a8ea2c6c50")
                .unwrap()
                .try_into()
                .unwrap();
        let sig: [u8; 64] = hex::decode(
            "e2ff6254871a3fec1853c167b42f0f14248c4cf7fef5452dc24d8dbdc5c4bf183ab707322b4d782d5f5a05571bae476c5f7ee41c473f3002e600865e46b75d0f",
        )
        .unwrap()
        .try_into()
        .unwrap();
        let vk = VerifyingKey::from_bytes(&key).unwrap();
        let h = prehash(&p).unwrap();
        assert!(vk.verify(&h, &Signature::from_bytes(&sig)).is_ok());
        let mut other = p.clone();
        other.recipient = acct("intents.nearx");
        assert!(
            vk.verify(&prehash(&other).unwrap(), &Signature::from_bytes(&sig))
                .is_err()
        );
    }

    #[test]
    fn prehash_requires_32_byte_nonce() {
        let mut p = payload(&order()).unwrap();
        p.nonce = Base64VecU8(vec![0; 31]);
        assert_eq!(
            prehash(&p),
            Err(ProtocolError::Malformed("nonce: 32 bytes required"))
        );
    }

    #[test]
    fn multi_payload_shape() {
        let p = payload(&order()).unwrap();
        let pk: PublicKey = "ed25519:4Cec3dBXFCQw5ruGa9adywPihKGSMQidVpBWwqmiwGF9"
            .parse()
            .unwrap();
        let sig = [7u8; 64];
        let v: serde_json::Value =
            serde_json::from_str(&multi_payload_json(&p, &pk, &sig).unwrap()).unwrap();
        assert_eq!(v["standard"], "nep413");
        assert_eq!(v["payload"]["message"], p.message.as_str());
        assert_eq!(
            v["payload"]["nonce"],
            near_sdk::base64::Engine::encode(
                &near_sdk::base64::engine::general_purpose::STANDARD,
                order().nonce
            )
        );
        assert_eq!(v["payload"]["recipient"], "intents.near");
        assert_eq!(v["public_key"], String::from(&pk));
        let s = v["signature"]
            .as_str()
            .unwrap()
            .strip_prefix("ed25519:")
            .unwrap();
        assert_eq!(near_sdk::bs58::decode(s).into_vec().unwrap(), sig);
        assert_eq!(v.as_object().unwrap().len(), 4);
        assert_eq!(v["payload"].as_object().unwrap().len(), 3);
    }

    #[test]
    fn multi_payload_rejects_non_ed25519() {
        let p = payload(&order()).unwrap();
        let pk = PublicKey::from_parts(CurveType::SECP256K1, vec![1u8; 64]).unwrap();
        assert_eq!(
            multi_payload_json(&p, &pk, &[0; 64]),
            Err(ProtocolError::UnsupportedCurve)
        );
    }
}
