//! MPC signer (`v1.signer`), pinned to near/mpc v3.17.0 @ d0fc87b (`crates/contract/src/api`,
//! `crates/near-mpc-crypto-types`).
//!
//! `sign` requires exactly 1 yocto and at least 15 TGas attached (mainnet config
//! `sign_call_gas_attachment_requirement_tera_gas`). It yields until the nodes respond; the
//! signature is public in the MPC's `respond` receipt before our callback runs.

use near_sdk::{AccountId, NearToken, PublicKey, ext_contract, near};
use serde::Deserialize;
use serde::de::IgnoredAny;

use super::ProtocolError;

/// Ed25519 domain on the recorded deployment.
pub const DOMAIN_ID_ED25519: u64 = 1;
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// `EDDSA_PAYLOAD_SIZE_UPPER_BOUND_BYTES`; our payload is always a 32-byte prehash.
pub const EDDSA_PAYLOAD_MAX_BYTES: usize = 1232;

/// `SignRequestArgs` wire form: `{"path","payload_v2":{"Eddsa":"<hex>"},"domain_id":1}`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: SignPayload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignPayload {
    /// Lowercase hex of the exact bytes the Ed25519 key signs.
    Eddsa(String),
}

#[allow(dead_code)]
#[ext_contract(ext_mpc)]
pub trait MpcSigner {
    /// Returns `SignatureResponse` JSON; see [`parse_signature`].
    fn sign(&mut self, request: SignRequest);
    /// View. Returns `"ed25519:<base58>"` for an Ed25519 domain; see [`parse_public_key`].
    fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String;
}

/// Ed25519 sign request over a NEP-413 prehash.
pub fn sign_args(path: String, prehash: &[u8; 32]) -> SignRequest {
    SignRequest {
        path,
        payload_v2: SignPayload::Eddsa(hex::encode(prehash)),
        domain_id: DOMAIN_ID_ED25519,
    }
}

/// `SignatureResponse`, `#[serde(tag = "scheme")]`; `Ed25519Signature` is a JSON array of 64 bytes.
#[derive(Deserialize)]
#[serde(tag = "scheme")]
enum SignatureResponse {
    Ed25519 { signature: Vec<u8> },
    Secp256k1(IgnoredAny),
}

/// Parses the value `sign` resolves with: `{"scheme":"Ed25519","signature":[u8; 64]}`.
pub fn parse_signature(bytes: &[u8]) -> Result<[u8; 64], ProtocolError> {
    match serde_json::from_slice(bytes) {
        Ok(SignatureResponse::Ed25519 { signature }) => signature
            .try_into()
            .map_err(|_| ProtocolError::Malformed("signature: 64 bytes required")),
        Ok(SignatureResponse::Secp256k1(_)) => Err(ProtocolError::UnsupportedCurve),
        Err(_) => Err(ProtocolError::Malformed("signature response")),
    }
}

/// Parses `derived_public_key`'s result, accepting only `ed25519:<base58 of 32 bytes>`.
pub fn parse_public_key(bytes: &[u8]) -> Result<PublicKey, ProtocolError> {
    let s: String =
        serde_json::from_slice(bytes).map_err(|_| ProtocolError::Malformed("public key"))?;
    match s.split_once(':') {
        Some(("ed25519", _)) => s
            .parse()
            .map_err(|_| ProtocolError::Malformed("public key")),
        Some(_) => Err(ProtocolError::UnsupportedCurve),
        None => Err(ProtocolError::Malformed("public key")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::CurveType;

    #[test]
    fn sign_args_wire_format() {
        let req = sign_args("mandate/v1/7".into(), &[0xab; 32]);
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "path": "mandate/v1/7",
                "payload_v2": {"Eddsa": "ab".repeat(32)},
                "domain_id": 1
            })
        );
        // The argument object the MPC's `sign(request)` receives.
        let args = serde_json::to_string(&serde_json::json!({ "request": req })).unwrap();
        assert!(args.starts_with("{\"request\":{"));
    }

    #[test]
    fn parses_ed25519_signature() {
        let sig: Vec<u8> = (0u8..64).collect();
        let body = serde_json::json!({"scheme": "Ed25519", "signature": sig}).to_string();
        assert_eq!(parse_signature(body.as_bytes()).unwrap().to_vec(), sig);
    }

    #[test]
    fn rejects_bad_signature_responses() {
        let cases: [(&str, ProtocolError); 6] = [
            (
                r#"{"scheme":"Ed25519","signature":[1,2,3]}"#,
                ProtocolError::Malformed("signature: 64 bytes required"),
            ),
            (
                r#"{"scheme":"Secp256k1","big_r":{"affine_point":"02"},"s":{"scalar":"01"},"recovery_id":0}"#,
                ProtocolError::UnsupportedCurve,
            ),
            (
                r#"{"scheme":"Bls12381","signature":[]}"#,
                ProtocolError::Malformed("signature response"),
            ),
            (
                r#"{"signature":[0]}"#,
                ProtocolError::Malformed("signature response"),
            ),
            ("null", ProtocolError::Malformed("signature response")),
            ("", ProtocolError::Malformed("signature response")),
        ];
        for (body, err) in cases {
            assert_eq!(parse_signature(body.as_bytes()), Err(err), "{body}");
        }
        let too_big = format!(
            r#"{{"scheme":"Ed25519","signature":[256{}]}}"#,
            ",0".repeat(63)
        );
        assert!(parse_signature(too_big.as_bytes()).is_err());
        let too_long = serde_json::json!({"scheme": "Ed25519", "signature": vec![0u8; 65]});
        assert!(parse_signature(too_long.to_string().as_bytes()).is_err());
    }

    // Recorded by a mainnet view call: v1.signer `derived_public_key` for
    // ("mandate/v1/1", example.near, domain 1) on 2026-11-03.
    #[test]
    fn parses_ed25519_public_key() {
        let pk =
            parse_public_key(br#""ed25519:4Cec3dBXFCQw5ruGa9adywPihKGSMQidVpBWwqmiwGF9""#).unwrap();
        assert_eq!(pk.curve_type(), CurveType::ED25519);
        assert_eq!(pk.as_bytes().len(), 33);
    }

    #[test]
    fn rejects_non_ed25519_public_keys() {
        let secp = format!(
            "\"secp256k1:{}\"",
            near_sdk::bs58::encode([3u8; 64]).into_string()
        );
        assert_eq!(
            parse_public_key(secp.as_bytes()),
            Err(ProtocolError::UnsupportedCurve)
        );
        let bls = format!(
            "\"bls12381g2:{}\"",
            near_sdk::bs58::encode([1u8; 96]).into_string()
        );
        assert_eq!(
            parse_public_key(bls.as_bytes()),
            Err(ProtocolError::UnsupportedCurve)
        );
        for bad in [
            r#""ed25519:short""#,
            r#""4Cec3dBXFCQw5ruGa9adywPihKGSMQidVpBWwqmiwGF9""#,
            r#"{"Ed25519":"x"}"#,
            "",
        ] {
            assert_eq!(
                parse_public_key(bad.as_bytes()),
                Err(ProtocolError::Malformed("public key")),
                "{bad}"
            );
        }
    }
}
