//! Cross-checks `bounded_mandate::protocol::nep413` against the pinned verifier's own crates
//! (`defuse-core` / `defuse-nep413` at near/intents@16d04f6) and pins the canonical byte vectors in
//! `fixtures/vectors/nep413.json` for the TypeScript tools. Regenerate the file with
//! `UPDATE_VECTORS=1 cargo test -p bounded-mandate --test protocol_vectors`; the comparison below
//! then fails on any encoder change until the vectors are deliberately regenerated.

use std::path::PathBuf;

use bounded_mandate::protocol::nep413::{
    TokenDiffOrder, build_message, multi_payload_json, payload, prehash, token_id, versioned_nonce,
};
use bounded_mandate::protocol::oracle;
use bounded_mandate::types::{AssetConfig, Nep413Payload};
use defuse_core::intents::{DefuseIntents, Intent};
use defuse_core::nep413::{Nep413, Nep413Payload as DefuseNep413Payload};
use defuse_core::payload::multi::MultiPayload;
use defuse_core::payload::{DefusePayload, ExtractDefusePayload, Payload, SignedPayload};
use defuse_core::{ExpirableNonce, Salt, SaltedNonce, Timestamp, VersionedNonce};
use ed25519_dalek::{Signer, SigningKey, Verifier};
use near_sdk::{AccountId, PublicKey};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// NEP-461 prefix tag `2^31 + NEP number`, derived here rather than taken from our crate.
fn nep461_tag() -> u32 {
    1u32.checked_shl(31).unwrap().checked_add(413).unwrap()
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// TEST ONLY: public deterministic keys, never funded.
fn test_key(label: &str) -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(format!("bounded-mandate/test-key/{label}")).into())
}

fn near_pk(key: &SigningKey) -> PublicKey {
    format!(
        "ed25519:{}",
        near_sdk::bs58::encode(key.verifying_key().as_bytes()).into_string()
    )
    .parse()
    .unwrap()
}

struct Case {
    salt: [u8; 4],
    random: [u8; 15],
    order: TokenDiffOrder,
}

/// Everything the verifier's own code derives from our signed MultiPayload must equal the inputs.
fn cross_check(case: &Case, key: &SigningKey) -> Value {
    let order = &case.order;
    let message = build_message(order).unwrap();
    let p = payload(order).unwrap();
    let hash = prehash(&p).unwrap();

    let defuse_payload = DefuseNep413Payload {
        message: message.clone(),
        nonce: order.nonce,
        recipient: order.verifying_contract.to_string(),
        callback_url: None,
    };
    let preimage = borsh::to_vec(&(nep461_tag(), &defuse_payload)).unwrap();
    assert_eq!(
        Nep413::prehash(&defuse_payload),
        hash,
        "defuse-nep413 prehash"
    );
    assert_eq!(<[u8; 32]>::from(Sha256::digest(&preimage)), hash);

    let sig = key.sign(&hash).to_bytes();
    let pk = near_pk(key);
    let multi = multi_payload_json(&p, &pk, &sig).unwrap();
    let signed: MultiPayload = serde_json::from_str(&multi).expect("verifier parses MultiPayload");
    assert!(matches!(signed, MultiPayload::Nep413(_)));
    assert_eq!(signed.hash(), hash, "defuse-core MultiPayload hash");
    let verified = signed.verify().expect("verifier accepts the signature");
    assert_eq!(verified.to_string(), String::from(&pk));

    let DefusePayload::<DefuseIntents> {
        signer_id,
        verifying_contract,
        deadline,
        nonce,
        message: intents,
    } = signed
        .extract_defuse_payload()
        .expect("verifier parses message");
    assert_eq!(signer_id.as_str(), order.signer_id.as_str());
    assert_eq!(
        verifying_contract.as_str(),
        order.verifying_contract.as_str()
    );
    let expected_deadline =
        Timestamp::from_nanos(i128::from(i64::try_from(order.deadline_ns).unwrap())).unwrap();
    assert_eq!(deadline, expected_deadline);
    assert_eq!(nonce, order.nonce);
    assert!(
        message.contains(&format!("\"deadline\":\"{expected_deadline}\"")),
        "deadline string is defuse's canonical RFC 3339"
    );

    let [Intent::TokenDiff(diff)] = intents.intents.as_slice() else {
        panic!("exactly one token_diff intent");
    };
    assert_eq!(diff.memo, None);
    assert_eq!(diff.referral, None);
    let deltas: Vec<(String, i128)> = diff
        .diff
        .clone()
        .into_inner()
        .into_iter()
        .map(|(t, d)| (t.to_string(), d))
        .collect();
    let mut expected = vec![
        (
            token_id(&order.sell_token),
            i128::try_from(order.sell_amount)
                .unwrap()
                .checked_neg()
                .unwrap(),
        ),
        (
            token_id(&order.buy_token),
            i128::try_from(order.buy_amount).unwrap(),
        ),
    ];
    expected.sort();
    assert_eq!(deltas, expected);

    let Some(VersionedNonce::V1(SaltedNonce {
        salt,
        nonce:
            ExpirableNonce {
                deadline: nonce_deadline,
                nonce: random,
            },
    })) = VersionedNonce::maybe_from(order.nonce)
    else {
        panic!("nonce is versioned V1");
    };
    assert_eq!(salt, Salt(case.salt));
    assert_eq!(nonce_deadline, expected_deadline);
    assert_eq!(random, case.random);

    json!({
        "inputs": {
            "signer_id": order.signer_id,
            "verifying_contract": order.verifying_contract,
            "deadline_ns": order.deadline_ns.to_string(),
            "salt_hex": hex::encode(case.salt),
            "random_hex": hex::encode(case.random),
            "sell_token": order.sell_token,
            "sell_amount": order.sell_amount.to_string(),
            "buy_token": order.buy_token,
            "buy_amount": order.buy_amount.to_string(),
        },
        "nonce_hex": hex::encode(order.nonce),
        "nonce_base64": serde_json::to_value(&p.nonce).unwrap(),
        "message": message,
        "nep413_borsh_hex": hex::encode(preimage),
        "prehash_hex": hex::encode(hash),
        "public_key": pk,
        "signature_hex": hex::encode(sig),
        "multi_payload": serde_json::from_str::<Value>(&multi).unwrap(),
    })
}

fn case(
    signer: &str,
    deadline_ns: u64,
    salt: [u8; 4],
    random: [u8; 15],
    sell: (&str, u128),
    buy: (&str, u128),
) -> Case {
    Case {
        salt,
        random,
        order: TokenDiffOrder {
            signer_id: acct(signer),
            verifying_contract: acct("intents.near"),
            deadline_ns,
            nonce: versioned_nonce(salt, deadline_ns, random),
            sell_token: acct(sell.0),
            sell_amount: sell.1,
            buy_token: acct(buy.0),
            buy_amount: buy.1,
        },
    }
}

const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

fn canonical_cases() -> Vec<(&'static str, &'static str, Case)> {
    vec![
        (
            "mandate_sells_usdc",
            "mandate",
            case(
                "mandate.near",
                1_793_735_388_000_000_000,
                [0x0a, 0x1b, 0x2c, 0x3d],
                [0x11; 15],
                (USDC, 25_000_000),
                ("wrap.near", 6_550_000_000_000_000_000_000_000),
            ),
        ),
        (
            "filler_counter_side",
            "filler",
            case(
                "filler.near",
                1_793_735_388_123_456_789,
                [0x0a, 0x1b, 0x2c, 0x3d],
                [0x22; 15],
                ("wrap.near", 6_550_006_550_006_550_007_000_000),
                (USDC, 24_999_975),
            ),
        ),
        (
            "extreme_amounts",
            "mandate",
            case(
                "mandate.near",
                i64::MAX.unsigned_abs(),
                [0xff; 4],
                [0x00; 15],
                ("wrap.near", i128::MAX.unsigned_abs()),
                (USDC, 1),
            ),
        ),
    ]
}

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vectors/nep413.json")
}

#[test]
fn canonical_vectors_match_verifier_and_fixture() {
    let mut keys = serde_json::Map::new();
    let mut vectors = Vec::new();
    for (name, signer, c) in canonical_cases() {
        let key = test_key(signer);
        keys.insert(
            signer.into(),
            json!({
                "seed_derivation": format!("sha256(\"bounded-mandate/test-key/{signer}\")"),
                "seed_hex": hex::encode(key.to_bytes()),
                "public_key": near_pk(&key),
            }),
        );
        let mut v = cross_check(&c, &key);
        v["name"] = name.into();
        v["signer_key"] = signer.into();
        vectors.push(v);
    }
    let generated = json!({
        "description": "NEP-413 token_diff vectors from bounded_mandate::protocol::nep413, each cross-checked against defuse-core/defuse-nep413 at near/intents@16d04f6ec4401263f8914638710260da50bb46b0. Keys are TEST ONLY.",
        "nep413_tag": nep461_tag(),
        "test_keys": keys,
        "vectors": vectors,
    });
    let path = vectors_path();
    if std::env::var_os("UPDATE_VECTORS").is_some() {
        let mut text = serde_json::to_string_pretty(&generated).unwrap();
        text.push('\n');
        std::fs::write(&path, text).unwrap();
    }
    let recorded: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(recorded, generated, "fixtures/vectors/nep413.json is stale");

    // The recorded signatures verify independently of our encoder.
    for v in recorded["vectors"].as_array().unwrap() {
        let key = test_key(v["signer_key"].as_str().unwrap()).verifying_key();
        let hash: [u8; 32] = hex::decode(v["prehash_hex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let sig: [u8; 64] = hex::decode(v["signature_hex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert!(
            key.verify(&hash, &ed25519_dalek::Signature::from_bytes(&sig))
                .is_ok()
        );
        let preimage = hex::decode(v["nep413_borsh_hex"].as_str().unwrap()).unwrap();
        assert_eq!(<[u8; 32]>::from(Sha256::digest(preimage)), hash);
    }
}

#[test]
fn randomized_orders_match_verifier() {
    let mut rng = ChaCha8Rng::seed_from_u64(0x4e_5034_3133);
    let tokens = [USDC, "wrap.near", "a.near", "z-token.tkn.near"];
    let signers = [
        "mandate.near",
        "mm",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ];
    let key = test_key("random");
    for i in 0..300 {
        let sell = tokens[rng.random_range(0..tokens.len())];
        let buy = loop {
            let t = tokens[rng.random_range(0..tokens.len())];
            if t != sell {
                break t;
            }
        };
        let amount = |rng: &mut ChaCha8Rng| match rng.random_range(0..4) {
            0 => 1,
            1 => i128::MAX.unsigned_abs(),
            2 => rng.random_range(1..=1_000_000_000u128),
            _ => rng.random_range(1..=i128::MAX.unsigned_abs()),
        };
        let deadline_ns = match i % 4 {
            0 => rng.random_range(0..=i64::MAX.unsigned_abs()),
            1 => rng
                .random_range(1_700_000_000u64..2_000_000_000)
                .checked_mul(1_000_000_000)
                .unwrap(),
            _ => rng.random_range(1_700_000_000_000_000_000u64..2_000_000_000_000_000_000),
        };
        let c = case(
            signers[rng.random_range(0..signers.len())],
            deadline_ns,
            rng.random(),
            rng.random(),
            (sell, amount(&mut rng)),
            (buy, amount(&mut rng)),
        );
        cross_check(&c, &key);
    }
}

/// Mainnet view responses recorded in `fixtures/vectors/oracle.json` validate under the demo
/// policy at their recording time.
#[test]
fn recorded_oracle_responses_validate() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/vectors/oracle.json");
    let doc: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let responses = doc["responses"].as_array().unwrap();
    assert_eq!(responses.len(), 2);
    for r in responses {
        let asset = AssetConfig {
            token: acct(r["token"].as_str().unwrap()),
            decimals: u8::try_from(r["decimals"].as_u64().unwrap()).unwrap(),
            price_id: r["price_id"].as_str().unwrap().into(),
        };
        let result = serde_json::to_vec(&r["result"]).unwrap();
        let now = r["queried_at_unix"].as_u64().unwrap();
        let obs = oracle::validate(&result, &asset, now, 60, 50).unwrap();
        assert_eq!(obs.price_id, asset.price_id);
        assert_eq!(obs.expo, -8);
        assert_eq!(
            oracle::validate(&result, &asset, now, 0, 50),
            Err(oracle::PriceError::Stale)
        );
    }
}

#[test]
fn payload_type_roundtrips_through_contract_json() {
    let (_, _, c) = canonical_cases().remove(0);
    let p = payload(&c.order).unwrap();
    let back: Nep413Payload = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
    assert_eq!(back, p);
}
