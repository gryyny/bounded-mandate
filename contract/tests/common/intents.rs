//! Independent derivation of the verifier's wire formats (near/intents v0.4.5), used by the test
//! filler and by the verifier world model. Deliberately not shared with the contract's encoder.

use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use near_sdk::base64::Engine;
use near_sdk::base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// NEP-461 off-chain prefix tag for NEP-413: 2^31 + 413.
pub const NEP413_TAG: u32 = 2_147_484_061;
pub const VERSIONED_MAGIC: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];
/// Verifier fee unit: 1 pip = 1e-6.
pub const PIPS_MAX: u128 = 1_000_000;

#[derive(BorshSerialize, Clone, Debug)]
pub struct Nep413Payload {
    pub message: String,
    pub nonce: [u8; 32],
    pub recipient: String,
    pub callback_url: Option<String>,
}

pub fn nep413_prehash(p: &Nep413Payload) -> [u8; 32] {
    let bytes = borsh::to_vec(&(NEP413_TAG, p)).expect("borsh");
    Sha256::digest(bytes).into()
}

/// VersionedNonce::V1: magic || enum tag 0 || salt || deadline (i64 ns, LE) || 15 random bytes.
pub fn versioned_nonce(salt: [u8; 4], deadline_ns: i64, random: [u8; 15]) -> [u8; 32] {
    let mut n = [0u8; 32];
    n[..4].copy_from_slice(&VERSIONED_MAGIC);
    n[4] = 0;
    n[5..9].copy_from_slice(&salt);
    n[9..17].copy_from_slice(&deadline_ns.to_le_bytes());
    n[17..].copy_from_slice(&random);
    n
}

/// Parsed versioned nonce: (salt, deadline_ns). None for legacy (unversioned) nonces.
pub fn parse_versioned_nonce(n: &[u8; 32]) -> Option<([u8; 4], i64)> {
    if n[..4] != VERSIONED_MAGIC || n[4] != 0 {
        return None;
    }
    let salt: [u8; 4] = n[5..9].try_into().ok()?;
    let deadline = i64::from_le_bytes(n[9..17].try_into().ok()?);
    Some((salt, deadline))
}

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Vec<u8> {
    B64.decode(s).expect("base64")
}

pub fn ed25519_str(bytes: &[u8]) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(bytes).into_string())
}

pub fn parse_ed25519_str(s: &str) -> Vec<u8> {
    let data = s.strip_prefix("ed25519:").expect("ed25519: prefix");
    near_sdk::bs58::decode(data).into_vec().expect("base58")
}

/// RFC 3339 UTC with nanoseconds, the verifier's `Timestamp` JSON format.
pub fn rfc3339(ns: u64) -> String {
    let secs = ns / 1_000_000_000;
    let nanos = ns % 1_000_000_000;
    let days = i64::try_from(secs / 86_400).expect("days");
    let sod = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{nanos:09}Z",
        sod / 3_600,
        (sod % 3_600) / 60,
        sod % 60
    )
}

/// Inverse of [`rfc3339`] for the subset the verifier and contract emit (UTC `Z`, optional fraction).
pub fn parse_rfc3339(s: &str) -> u64 {
    let s = s.strip_suffix('Z').expect("UTC timestamp");
    let (date, time) = s.split_once('T').expect("T");
    let mut dp = date.split('-').map(|x| x.parse::<i64>().expect("date"));
    let (y, m, d) = (dp.next().unwrap(), dp.next().unwrap(), dp.next().unwrap());
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut tp = hms.split(':').map(|x| x.parse::<i64>().expect("time"));
    let (hh, mm, ss) = (tp.next().unwrap(), tp.next().unwrap(), tp.next().unwrap());
    let nanos: i64 = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<9}")[..9].parse().expect("fraction")
    };
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 86_400 + hh * 3_600 + mm * 60 + ss) * 1_000_000_000) + nanos)
        .expect("positive time")
}

pub fn fee_ceil(amount: u128, fee_pips: u128) -> u128 {
    (amount * fee_pips).div_ceil(PIPS_MAX)
}

/// The counterparty's closure for a mandate token_diff of `-sell` / `+buy` under the verifier's
/// fee rule (fee charged on every negative delta, credited to the collector):
/// returns (filler receives of sold token, filler pays of bought token).
pub fn filler_closure(sell: u128, buy: u128, fee_pips: u128) -> (u128, u128) {
    let receive = sell - fee_ceil(sell, fee_pips);
    // Smallest pay with pay - fee_ceil(pay) == buy.
    let mut pay = (buy * PIPS_MAX).div_ceil(PIPS_MAX - fee_pips);
    while pay - fee_ceil(pay, fee_pips) > buy {
        pay -= 1;
    }
    while pay - fee_ceil(pay, fee_pips) < buy {
        pay += 1;
    }
    assert_eq!(
        pay - fee_ceil(pay, fee_pips),
        buy,
        "no exact closure for {buy}"
    );
    (receive, pay)
}

pub fn token_id(token: &str) -> String {
    format!("nep141:{token}")
}

/// A token_diff DefusePayload message, NEP-413 arm (verifying contract and nonce live in the
/// NEP-413 envelope).
pub fn token_diff_message(signer: &str, deadline_ns: u64, diff: &[(String, i128)]) -> String {
    let diff: serde_json::Map<String, Value> = diff
        .iter()
        .map(|(t, d)| (t.clone(), Value::String(d.to_string())))
        .collect();
    json!({
        "signer_id": signer,
        "deadline": rfc3339(deadline_ns),
        "intents": [{"intent": "token_diff", "diff": diff}],
    })
    .to_string()
}

pub fn multipayload(p: &Nep413Payload, public_key: &[u8; 32], signature: &[u8; 64]) -> Value {
    let mut payload = json!({
        "message": p.message,
        "nonce": b64(&p.nonce),
        "recipient": p.recipient,
    });
    if let Some(cb) = &p.callback_url {
        payload["callback_url"] = json!(cb);
    }
    json!({
        "standard": "nep413",
        "payload": payload,
        "public_key": ed25519_str(public_key),
        "signature": ed25519_str(signature),
    })
}

/// Decoded view of a NEP-413 MultiPayload, independently parsed from JSON.
#[derive(Clone, Debug)]
pub struct DecodedOrder {
    pub payload: Nep413Payload,
    pub public_key: [u8; 32],
    pub signature: [u8; 64],
    pub signer_id: String,
    pub deadline_ns: u64,
    pub diff: Vec<(String, i128)>,
    pub nonce_salt: Option<[u8; 4]>,
    pub nonce_deadline_ns: Option<i64>,
}

impl DecodedOrder {
    pub fn from_multipayload(v: &Value) -> Self {
        assert_eq!(v["standard"], "nep413", "standard: {v}");
        let p = &v["payload"];
        let nonce: [u8; 32] = unb64(p["nonce"].as_str().expect("nonce"))
            .try_into()
            .expect("32-byte nonce");
        let payload = Nep413Payload {
            message: p["message"].as_str().expect("message").to_owned(),
            nonce,
            recipient: p["recipient"].as_str().expect("recipient").to_owned(),
            callback_url: p["callback_url"].as_str().map(str::to_owned),
        };
        let msg: Value = serde_json::from_str(&payload.message).expect("message json");
        let intents = msg["intents"].as_array().expect("intents");
        let mut diff = Vec::new();
        for i in intents {
            assert_eq!(
                i["intent"], "token_diff",
                "only token_diff intents expected: {i}"
            );
            for (k, d) in i["diff"].as_object().expect("diff") {
                diff.push((
                    k.clone(),
                    d.as_str().expect("string delta").parse().expect("i128"),
                ));
            }
        }
        let parsed = parse_versioned_nonce(&nonce);
        Self {
            public_key: parse_ed25519_str(v["public_key"].as_str().expect("pk"))
                .try_into()
                .expect("pk len"),
            signature: parse_ed25519_str(v["signature"].as_str().expect("sig"))
                .try_into()
                .expect("sig len"),
            signer_id: msg["signer_id"].as_str().expect("signer_id").to_owned(),
            deadline_ns: parse_rfc3339(msg["deadline"].as_str().expect("deadline")),
            diff,
            nonce_salt: parsed.map(|p| p.0),
            nonce_deadline_ns: parsed.map(|p| p.1),
            payload,
        }
    }

    pub fn signature_valid(&self) -> bool {
        let Ok(vk) = VerifyingKey::from_bytes(&self.public_key) else {
            return false;
        };
        let sig = ed25519_dalek::Signature::from_bytes(&self.signature);
        vk.verify(&nep413_prehash(&self.payload), &sig).is_ok()
    }

    pub fn delta(&self, token: &str) -> i128 {
        self.diff
            .iter()
            .find(|(t, _)| t == token)
            .map_or(0, |(_, d)| *d)
    }
}

/// Our separately keyed filler.
pub struct FillerKey {
    pub sk: SigningKey,
}

impl FillerKey {
    pub fn from_seed(seed: u8) -> Self {
        let mut s = [0u8; 32];
        s[0] = seed;
        s[31] = 0xf1;
        Self {
            sk: SigningKey::from_bytes(&s),
        }
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.sk.verifying_key().to_bytes()
    }

    pub fn public_key_str(&self) -> String {
        ed25519_str(&self.public_key())
    }

    pub fn sign_diff(
        &self,
        signer: &str,
        verifier: &str,
        deadline_ns: u64,
        nonce: [u8; 32],
        diff: &[(String, i128)],
    ) -> Value {
        let payload = Nep413Payload {
            message: token_diff_message(signer, deadline_ns, diff),
            nonce,
            recipient: verifier.to_owned(),
            callback_url: None,
        };
        let sig = self.sk.sign(&nep413_prehash(&payload)).to_bytes();
        multipayload(&payload, &self.public_key(), &sig)
    }

    /// The counter-intent closing `order` (mandate sells `-a` of X, buys `+b` of Y) with the
    /// verifier fee on the filler's side.
    pub fn counter_for(
        &self,
        filler_id: &str,
        verifier: &str,
        order: &DecodedOrder,
        fee_pips: u128,
        nonce: [u8; 32],
    ) -> Value {
        let (sold, sell) = order
            .diff
            .iter()
            .find(|(_, d)| *d < 0)
            .cloned()
            .expect("negative leg");
        let (bought, buy) = order
            .diff
            .iter()
            .find(|(_, d)| *d > 0)
            .cloned()
            .expect("positive leg");
        let (receive, pay) = filler_closure(sell.unsigned_abs(), buy.unsigned_abs(), fee_pips);
        // The verifier rejects zero deltas; when the fee consumes the whole sold amount the
        // filler simply omits that token (supply still closes through the fee collector).
        let diff: Vec<(String, i128)> = [
            (sold, i128::try_from(receive).expect("i128")),
            (bought, -i128::try_from(pay).expect("i128")),
        ]
        .into_iter()
        .filter(|(_, d)| *d != 0)
        .collect();
        self.sign_diff(filler_id, verifier, order.deadline_ns, nonce, &diff)
    }
}
