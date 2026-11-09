//! gate: SIGNER — conformance of the contract's MPC adapter with a real mainnet `v1.signer`
//! response. `fixtures/signer/v1-signer-eddsa-sign.json` records a third-party `sign` request
//! (domain 1, `payload_v2.Eddsa`), the value the signer resolved it with and the
//! `derived_public_key` view for that predecessor and path; provenance is in
//! `v1-signer-eddsa-sign.provenance.json`. Every expected value is read from the fixture.
//!
//! `on_signed` accepts a signature through `ext::verified_signature`, which is
//! `mpc::parse_signature` followed by `env::ed25519_verify` against the key from
//! `mpc::parse_public_key`. `ext` is private, so the same two adapter calls and the same host
//! function are exercised here directly, with `ed25519-dalek` as an independent verifier.

use std::path::PathBuf;

use bounded_mandate::protocol::ProtocolError;
use bounded_mandate::protocol::mpc::{
    DOMAIN_ID_ED25519, SIGN_DEPOSIT, SignPayload, SignRequest, parse_public_key, parse_signature,
    sign_args,
};
use ed25519_dalek::{Signature, VerifyingKey};
use near_sdk::json_types::Base64VecU8;
use near_sdk::{CurveType, PublicKey, env};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/signer")
}

fn fixture() -> Value {
    serde_json::from_slice(
        &std::fs::read(fixtures_dir().join("v1-signer-eddsa-sign.json")).unwrap(),
    )
    .unwrap()
}

fn b64(v: &Value) -> Vec<u8> {
    serde_json::from_value::<Base64VecU8>(v.clone()).unwrap().0
}

struct Recorded {
    request: SignRequest,
    payload: Vec<u8>,
    response: Vec<u8>,
    key: PublicKey,
    sibling_key: PublicKey,
}

fn key_for(doc: &Value, role: &str) -> PublicKey {
    let entry = doc["derived_public_key"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["role"] == role)
        .unwrap();
    parse_public_key(entry["result_utf8"].as_str().unwrap().as_bytes()).unwrap()
}

fn recorded() -> Recorded {
    let doc = fixture();
    let receipt = &doc["sign_receipt"];
    let args: Value = serde_json::from_slice(&b64(&receipt["args_base64"])).unwrap();
    let request: SignRequest = serde_json::from_value(args["request"].clone()).unwrap();
    let SignPayload::Eddsa(hex_payload) = &request.payload_v2;
    let payload = hex::decode(hex_payload).unwrap();
    let response = b64(&doc["response_receipt"]["success_value_base64"]);
    Recorded {
        payload,
        response,
        key: key_for(&doc, "signing key"),
        sibling_key: key_for(&doc, "wrong-key control (sibling path)"),
        request,
    }
}

fn dalek_key(pk: &PublicKey) -> VerifyingKey {
    assert_eq!(pk.curve_type(), CurveType::ED25519);
    VerifyingKey::from_bytes(pk.as_bytes()[1..].try_into().unwrap()).unwrap()
}

/// What `ext::verified_signature` does, from the same adapter functions and host call.
fn contract_accepts(response: &[u8], pk: &PublicKey, payload: &[u8]) -> bool {
    let Ok(sig) = parse_signature(response) else {
        return false;
    };
    let Ok(prehash) = <[u8; 32]>::try_from(payload) else {
        return false;
    };
    pk.curve_type() == CurveType::ED25519
        && env::ed25519_verify(&sig, prehash, pk.as_bytes()[1..].try_into().unwrap())
}

fn independent_verify(response: &[u8], pk: &PublicKey, payload: &[u8]) -> bool {
    let sig = parse_signature(response).unwrap();
    dalek_key(pk)
        .verify_strict(payload, &Signature::from_bytes(&sig))
        .is_ok()
}

/// The provenance record binds the fixture bytes it describes.
#[test]
fn provenance_matches_fixture() {
    let prov: Value = serde_json::from_slice(
        &std::fs::read(fixtures_dir().join("v1-signer-eddsa-sign.provenance.json")).unwrap(),
    )
    .unwrap();
    let bytes = std::fs::read(fixtures_dir().join("v1-signer-eddsa-sign.json")).unwrap();
    assert_eq!(
        prov["sha256"].as_str().unwrap(),
        hex::encode(Sha256::digest(&bytes))
    );
    let doc = fixture();
    assert_eq!(prov["transaction"]["hash"], doc["transaction"]["hash"]);
}

/// The recorded request has the shape the contract sends: same JSON wrapper, domain, deposit and
/// 32-byte Eddsa payload; `sign_args` reproduces it from the recorded path and payload.
#[test]
fn recorded_request_matches_contract_wire_format() {
    let doc = fixture();
    let receipt = &doc["sign_receipt"];
    assert_eq!(receipt["receiver_id"], doc["signer"]["account_id"]);
    assert_eq!(receipt["method_name"], "sign");
    assert_eq!(
        receipt["deposit_yocto"].as_str().unwrap(),
        SIGN_DEPOSIT.as_yoctonear().to_string()
    );
    let r = recorded();
    assert_eq!(r.request.domain_id, DOMAIN_ID_ED25519);
    let prehash: [u8; 32] = r.payload.as_slice().try_into().unwrap();
    assert_eq!(sign_args(r.request.path.clone(), &prehash), r.request);
    let args: Value = serde_json::from_slice(&b64(&receipt["args_base64"])).unwrap();
    assert_eq!(
        serde_json::to_value(
            serde_json::json!({ "request": sign_args(r.request.path.clone(), &prehash) })
        )
        .unwrap(),
        args
    );
    // The key view used for the signature is the one for this predecessor, path and domain.
    let view = doc["derived_public_key"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["role"] == "signing key")
        .unwrap();
    assert_eq!(view["args"]["predecessor"], receipt["predecessor_id"]);
    assert_eq!(view["args"]["path"].as_str().unwrap(), r.request.path);
    assert_eq!(
        view["args"]["domain_id"].as_u64().unwrap(),
        r.request.domain_id
    );
    assert_eq!(view["block_height"], receipt["block_height"]);
}

/// The signer's resolved value decodes with the contract's decoder and verifies under the derived
/// key over the recorded payload, both through the contract's host call and independently.
#[test]
fn recorded_response_decodes_and_verifies() {
    let r = recorded();
    let doc = fixture();
    assert_eq!(
        r.response,
        doc["response_receipt"]["success_value_utf8"]
            .as_str()
            .unwrap()
            .as_bytes()
    );
    let sig = parse_signature(&r.response).unwrap();
    assert_eq!(sig.len(), 64);
    assert!(contract_accepts(&r.response, &r.key, &r.payload));
    assert!(independent_verify(&r.response, &r.key, &r.payload));
    // The derived key did not change between the sign block and recording time.
    assert_eq!(key_for(&doc, "signing key, recording time"), r.key);
}

/// Negative controls: each single alteration of the fixture is refused.
#[test]
fn corrupted_fixture_fails() {
    let r = recorded();
    let sig = parse_signature(&r.response).unwrap();

    // Altered signature byte, re-encoded in the signer's own JSON form.
    for i in [0usize, 31, 32, 63] {
        let mut bad = sig;
        bad[i] ^= 0x01;
        let body = serde_json::json!({"scheme": "Ed25519", "signature": bad.to_vec()}).to_string();
        assert!(
            !contract_accepts(body.as_bytes(), &r.key, &r.payload),
            "sig byte {i}"
        );
        assert!(
            !independent_verify(body.as_bytes(), &r.key, &r.payload),
            "sig byte {i}"
        );
    }

    // Altered payload byte.
    for i in [0usize, 31] {
        let mut bad = r.payload.clone();
        bad[i] ^= 0x01;
        assert!(
            !contract_accepts(&r.response, &r.key, &bad),
            "payload byte {i}"
        );
        assert!(
            !independent_verify(&r.response, &r.key, &bad),
            "payload byte {i}"
        );
    }

    // Wrong key: the signer's real derived key for a sibling path of the same predecessor.
    assert_ne!(r.sibling_key, r.key);
    assert!(!contract_accepts(&r.response, &r.sibling_key, &r.payload));
    assert!(!independent_verify(&r.response, &r.sibling_key, &r.payload));

    // Altered response encoding: truncated signature, wrong scheme tag, cut-off body.
    let mut short: Value = serde_json::from_slice(&r.response).unwrap();
    short["signature"].as_array_mut().unwrap().pop();
    assert_eq!(
        parse_signature(short.to_string().as_bytes()),
        Err(ProtocolError::Malformed("signature: 64 bytes required"))
    );
    let mut scheme: Value = serde_json::from_slice(&r.response).unwrap();
    scheme["scheme"] = "Ed448".into();
    assert_eq!(
        parse_signature(scheme.to_string().as_bytes()),
        Err(ProtocolError::Malformed("signature response"))
    );
    let cut = &r.response[..r.response.len().checked_sub(1).unwrap()];
    assert_eq!(
        parse_signature(cut),
        Err(ProtocolError::Malformed("signature response"))
    );
    assert!(!contract_accepts(cut, &r.key, &r.payload));
}
