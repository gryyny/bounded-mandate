//! TEST DOUBLE of the NEAR MPC signer `v1.signer`. Signs with deterministic Ed25519 TEST keys
//! derived from public inputs: anyone can recompute every secret key. Never deploy to a public
//! network; never present its signatures as MPC output.
//!
//! # Pinned real interface
//!
//! Mainnet `v1.signer` reports `version` "3.17.0" and `contract_source_metadata` link
//! `https://github.com/near/mpc/tree/d0fc87b19e2643299e7becdd7d9611afcd5d5a78`
//! (commit "chore: v3.17.0 (#4742)", contract_path `crates/contract`). Paths below are in that tree.
//!
//! - `sign({"request": {"path": String, "payload_v2": {"Eddsa": "<hex>"}, "domain_id": 1}})`
//!   (`crates/contract/src/api/sign.rs`, args type `SignRequestArgs` in
//!   `crates/near-mpc-crypto-types/src/sign.rs`). `domain_id` is a JSON number (`DomainId(u64)`);
//!   mainnet domain 1 is Ed25519 (`derived_public_key` with `domain_id: 1` returns `ed25519:...`).
//!   The `Eddsa` payload is hex of 0..=1232 raw message bytes (`EDDSA_PAYLOAD_SIZE_UPPER_BOUND_BYTES`,
//!   `crates/near-mpc-crypto-types/src/primitives.rs`); the nodes sign those bytes as-is.
//!   Legacy `payload`/`key_version` fields are also accepted by the real contract (not modelled).
//! - Preconditions (`check_request_preconditions`, `crates/contract/src/api/common.rs`):
//!   prepaid gas >= `sign_call_gas_attachment_requirement_tera_gas` = 15 TGas (mainnet `config`
//!   view), panic "Provided gas is lower than required. Provided: {p}, required: {r}"; attached
//!   deposit >= `SIGN_DEPOSIT_YOCTONEAR` = 1 yocto, panic "Attached deposit is lower than required.
//!   Attached: {a}, required: {r}", excess refunded to the predecessor by a detached transfer.
//!   Payload of the wrong kind panics "Payload is not EdDSA".
//! - `sign` creates a yield (`env::promise_yield_create`) whose callback
//!   `return_signature_and_clean_state_on_success` has 7 TGas static gas and weight 0. On resume it
//!   returns the `SignatureResponse`; on yield timeout (protocol `yield_timeout_length_in_blocks`,
//!   200 on mainnet) it removes the pending request and returns a promise to `fail_on_timeout`,
//!   which panics "Request has timed out." The caller's promise result is then a failure.
//! - Ed25519 return value (`SignatureResponse`, `#[serde(tag = "scheme")]`, `Ed25519Signature`
//!   serialized as `[u8; 64]`): `{"scheme": "Ed25519", "signature": [<64 numbers 0..=255>]}`.
//! - Nodes publish the signature in a `respond(request, response)` transaction before the yield
//!   callback runs, so a signature can be public even when the requester's callback never sees it.
//! - `derived_public_key({"path": String, "predecessor": Option<AccountId>, "domain_id":
//!   Option<u64>})` (view, `crates/contract/src/api/keys.rs`) returns a string `"ed25519:<base58>"`
//!   for an Ed25519 domain. `domain_id` defaults to 0 (secp256k1), so callers must pass 1.
//!
//! # Mock semantics
//!
//! Only domain 1 is modelled. The test secret key is
//! `sha256("bounded-mandate mock-mpc TEST KEY, NOT MPC, v1:" || domain_id (decimal) || ":" ||
//! predecessor || "," || path)` used as the Ed25519 seed. `set_mode` chooses what happens after
//! `sign`; `respond` (owner only) resolves held requests. Immediate modes resolve in a detached
//! self-call that receives the gas left after `sign` (weight 1); attach enough for one Ed25519
//! signature in wasm (measured in sandbox: ~5.7 TGas for a 32-byte payload; a 1232-byte payload
//! succeeds with 100 TGas attached to `sign`).

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, CryptoHash, Gas, GasWeight, NearToken, PanicOnDefault, Promise, env, near, require,
};

pub const ED25519_DOMAIN_ID: u64 = 1;
pub const MAX_EDDSA_PAYLOAD_BYTES: usize = 1232;
pub const SIGN_MIN_GAS: Gas = Gas::from_tgas(15);
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
const CALLBACK_GAS: Gas = Gas::from_tgas(7);
const FAIL_ON_TIMEOUT_GAS: Gas = Gas::from_tgas(2);
const DATA_ID_REGISTER: u64 = 0;
const TEST_KEY_LABEL: &str = "bounded-mandate mock-mpc TEST KEY, NOT MPC, v1:";
const TAG_OK: u8 = b'O';
const TAG_ERR: u8 = b'E';
pub const INJECTED_ERROR: &str = "mock-mpc: injected error";
pub const MALFORMED_RESPONSE: &str = r#"{"scheme":"Ed25519","signature":"not-a-signature"}"#;

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequestArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    Ed25519 { signature: Vec<u8> },
}

/// What happens right after `sign` records a request.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Wait for an explicit `respond`.
    Hold,
    /// Resume with a valid signature in the next receipt.
    Immediate,
    ImmediateInvalidSignature,
    ImmediateMalformed,
    ImmediateError,
    /// Publish a valid signature at once but never resume; the yield times out.
    DiscloseOnly,
}

/// How `respond` resolves a pending request.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseKind {
    /// Resume with a valid signature over the exact payload bytes.
    Valid,
    /// Resume with a well-formed Ed25519 response whose signature does not verify.
    InvalidSignature,
    /// Resume with `MALFORMED_RESPONSE` bytes as the callback's return value.
    Malformed,
    /// Resume such that the callback fails with `INJECTED_ERROR`.
    Error,
    /// Publish a valid signature (log + `get_disclosed_signature`) without resuming.
    DiscloseOnly,
}

#[near(serializers = [borsh])]
pub struct PendingRequest {
    data_id: CryptoHash,
    predecessor: AccountId,
    path: String,
    domain_id: u64,
    payload: Vec<u8>,
    created_at_block: u64,
}

#[near(serializers = [json])]
pub struct PendingView {
    pub request_id: u64,
    pub predecessor: AccountId,
    pub path: String,
    pub domain_id: u64,
    pub payload_hex: String,
    pub created_at_block: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    owner_id: AccountId,
    mode: Mode,
    next_request_id: u64,
    pending: IterableMap<u64, PendingRequest>,
    disclosed: LookupMap<u64, Vec<u8>>,
}

#[near]
impl MockMpc {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            mode: Mode::Immediate,
            next_request_id: 0,
            pending: IterableMap::new(b"p"),
            disclosed: LookupMap::new(b"d"),
        }
    }

    #[payable]
    pub fn sign(&mut self, request: SignRequestArgs) {
        let predecessor = env::predecessor_account_id();
        require_domain(request.domain_id);
        let prepaid = env::prepaid_gas();
        if prepaid < SIGN_MIN_GAS {
            env::panic_str(&format!(
                "Provided gas is lower than required. Provided: {}, required: {}",
                prepaid.as_gas(),
                SIGN_MIN_GAS.as_gas()
            ));
        }
        let deposit = env::attached_deposit();
        let Some(excess) = deposit.checked_sub(SIGN_DEPOSIT) else {
            env::panic_str(&format!(
                "Attached deposit is lower than required. Attached: {}, required: {}",
                deposit.as_yoctonear(),
                SIGN_DEPOSIT.as_yoctonear()
            ));
        };
        if !excess.is_zero() {
            Promise::new(predecessor.clone()).transfer(excess).detach();
        }
        let Payload::Eddsa(payload_hex) = &request.payload_v2 else {
            env::panic_str("Payload is not EdDSA");
        };
        let payload = hex::decode(payload_hex).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        require!(
            payload.len() <= MAX_EDDSA_PAYLOAD_BYTES,
            "mock-mpc: EdDSA payload longer than 1232 bytes"
        );

        let request_id = self.next_request_id;
        self.next_request_id = request_id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("request id overflow"));
        env::log_str(&format!(
            "mock-mpc sign: request_id={request_id} predecessor={predecessor} path={} domain_id={}",
            request.path, request.domain_id
        ));

        let args = serde_json::to_vec(&serde_json::json!({ "request_id": request_id }))
            .unwrap_or_else(|_| env::panic_str("serialize"));
        let yield_index = env::promise_yield_create(
            "return_signature_and_clean_state_on_success",
            args,
            CALLBACK_GAS,
            GasWeight(0),
            DATA_ID_REGISTER,
        );
        let data_id: CryptoHash = env::read_register(DATA_ID_REGISTER)
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or_else(|| env::panic_str("read data id"));
        self.pending.insert(
            request_id,
            PendingRequest {
                data_id,
                predecessor,
                path: request.path,
                domain_id: request.domain_id,
                payload,
                created_at_block: env::block_height(),
            },
        );

        let auto = match self.mode {
            Mode::Hold => None,
            Mode::Immediate => Some(ResponseKind::Valid),
            Mode::ImmediateInvalidSignature => Some(ResponseKind::InvalidSignature),
            Mode::ImmediateMalformed => Some(ResponseKind::Malformed),
            Mode::ImmediateError => Some(ResponseKind::Error),
            Mode::DiscloseOnly => {
                self.resolve(request_id, ResponseKind::DiscloseOnly);
                None
            }
        };
        if let Some(response) = auto {
            Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_gas(0))
                .with_unused_gas_weight(1)
                .auto_respond(request_id, response)
                .detach();
        }
        env::promise_return(yield_index);
    }

    /// Yield callback. Not part of the caller-facing interface.
    #[private]
    pub fn return_signature_and_clean_state_on_success(&mut self, request_id: u64) {
        match env::promise_result_checked(0, 16 * 1024) {
            Ok(data) => match data.split_first() {
                Some((&TAG_OK, raw)) => env::value_return(raw),
                Some((&TAG_ERR, msg)) => env::panic_str(&String::from_utf8_lossy(msg)),
                _ => env::panic_str("mock-mpc: unknown resume data"),
            },
            Err(_) => {
                self.pending.remove(&request_id);
                let fail = env::promise_create(
                    env::current_account_id(),
                    "fail_on_timeout",
                    b"{}",
                    NearToken::from_yoctonear(0),
                    FAIL_ON_TIMEOUT_GAS,
                );
                env::promise_return(fail);
            }
        }
    }

    #[private]
    pub fn fail_on_timeout(&self) {
        env::panic_str("Request has timed out.");
    }

    #[private]
    pub fn auto_respond(&mut self, request_id: u64, response: ResponseKind) {
        self.resolve(request_id, response);
    }

    // Test controls (owner only).

    pub fn set_mode(&mut self, mode: Mode) {
        self.assert_owner();
        self.mode = mode;
    }

    /// Resolves a pending request. Returns the signature when one was produced.
    pub fn respond(
        &mut self,
        request_id: u64,
        response: ResponseKind,
    ) -> Option<SignatureResponse> {
        self.assert_owner();
        self.resolve(request_id, response)
    }

    // Views.

    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String {
        let predecessor = predecessor.unwrap_or_else(env::predecessor_account_id);
        let domain_id = domain_id.unwrap_or(0);
        require_domain(domain_id);
        let key = test_signing_key(domain_id, &predecessor, &path);
        format!(
            "ed25519:{}",
            near_sdk::bs58::encode(key.verifying_key().as_bytes()).into_string()
        )
    }

    pub fn get_mode(&self) -> Mode {
        self.mode
    }

    pub fn list_pending(&self) -> Vec<PendingView> {
        self.pending
            .iter()
            .map(|(id, p)| PendingView {
                request_id: *id,
                predecessor: p.predecessor.clone(),
                path: p.path.clone(),
                domain_id: p.domain_id,
                payload_hex: hex::encode(&p.payload),
                created_at_block: p.created_at_block,
            })
            .collect()
    }

    /// The valid signature made public for `request_id` (by `valid` or `disclose_only`), if any.
    pub fn get_disclosed_signature(&self, request_id: u64) -> Option<SignatureResponse> {
        self.disclosed
            .get(&request_id)
            .map(|signature| SignatureResponse::Ed25519 {
                signature: signature.clone(),
            })
    }

    pub fn is_mock(&self) -> bool {
        true
    }
}

impl MockMpc {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "mock-mpc: owner only"
        );
    }

    fn resolve(&mut self, request_id: u64, response: ResponseKind) -> Option<SignatureResponse> {
        let request = self.pending.get(&request_id).unwrap_or_else(|| {
            env::panic_str("This sign request has timed out, was completed, or never existed.")
        });
        let data_id = request.data_id;
        let key = test_signing_key(request.domain_id, &request.predecessor, &request.path);
        let payload = request.payload.clone();
        let valid = || key.sign(&payload).to_bytes().to_vec();

        let (resume, signature) = match response {
            ResponseKind::Valid | ResponseKind::DiscloseOnly => {
                let signature = valid();
                self.disclosed.insert(request_id, signature.clone());
                let signature = SignatureResponse::Ed25519 { signature };
                env::log_str(&format!(
                    "mock-mpc signature disclosed: request_id={request_id} response={}",
                    serde_json::to_string(&signature).unwrap_or_default()
                ));
                let resume = (response == ResponseKind::Valid)
                    .then(|| tagged(TAG_OK, &serde_json::to_vec(&signature).unwrap_or_default()));
                (resume, Some(signature))
            }
            ResponseKind::InvalidSignature => {
                let mut wrong = payload.clone();
                wrong.push(0);
                let response = SignatureResponse::Ed25519 {
                    signature: key.sign(&wrong).to_bytes().to_vec(),
                };
                let data = tagged(TAG_OK, &serde_json::to_vec(&response).unwrap_or_default());
                (Some(data), Some(response))
            }
            ResponseKind::Malformed => (Some(tagged(TAG_OK, MALFORMED_RESPONSE.as_bytes())), None),
            ResponseKind::Error => (Some(tagged(TAG_ERR, INJECTED_ERROR.as_bytes())), None),
        };

        if let Some(data) = resume {
            self.pending.remove(&request_id);
            require!(
                env::promise_yield_resume(&data_id, data),
                "mock-mpc: yield is no longer resumable"
            );
        }
        signature
    }
}

fn tagged(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut data = Vec::with_capacity(body.len().saturating_add(1));
    data.push(tag);
    data.extend_from_slice(body);
    data
}

fn require_domain(domain_id: u64) {
    if domain_id != ED25519_DOMAIN_ID {
        env::panic_str(&format!(
            "mock-mpc: only domain {ED25519_DOMAIN_ID} (Ed25519) is modelled, got {domain_id}"
        ));
    }
}

/// The mock's TEST secret key for `(domain_id, predecessor, path)`. Public by construction.
pub fn test_signing_key(domain_id: u64, predecessor: &AccountId, path: &str) -> SigningKey {
    let input = format!("{TEST_KEY_LABEL}{domain_id}:{predecessor},{path}");
    SigningKey::from_bytes(&env::sha256_array(input.as_bytes()))
}
