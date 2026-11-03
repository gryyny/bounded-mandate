use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use std::task::Poll;

const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/near/mock_mpc/mock_mpc.wasm"
);
const PATH: &str = "mandate/v1/1";

struct Env {
    worker: Worker<Sandbox>,
    mpc: Contract,
    owner: Account,
    caller: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let mpc = worker.dev_deploy(&std::fs::read(WASM)?).await?;
    let owner = worker.dev_create_account().await?;
    let caller = worker.dev_create_account().await?;
    mpc.call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    Ok(Env {
        worker,
        mpc,
        owner,
        caller,
    })
}

/// Independent re-derivation of the documented mock test key.
fn expected_key(predecessor: &AccountId, path: &str) -> VerifyingKey {
    let input = format!("bounded-mandate mock-mpc TEST KEY, NOT MPC, v1:1:{predecessor},{path}");
    let seed: [u8; 32] = Sha256::digest(input.as_bytes()).into();
    SigningKey::from_bytes(&seed).verifying_key()
}

fn parse_near_key(key: &str) -> anyhow::Result<VerifyingKey> {
    let bytes = near_workspaces::types::PublicKey::from_str(key)?;
    let raw: [u8; 32] = bytes.key_data().try_into()?;
    Ok(VerifyingKey::from_bytes(&raw)?)
}

fn signature_of(value: &Value) -> anyhow::Result<Signature> {
    assert_eq!(value["scheme"], "Ed25519");
    let bytes: Vec<u8> = serde_json::from_value(value["signature"].clone())?;
    let raw: [u8; 64] = bytes.as_slice().try_into()?;
    Ok(Signature::from_bytes(&raw))
}

fn sign_args(payload: &[u8]) -> Value {
    json!({ "request": { "path": PATH, "payload_v2": { "Eddsa": hex::encode(payload) }, "domain_id": 1 } })
}

async fn sign(env: &Env, payload: &[u8]) -> anyhow::Result<ExecutionFinalResult> {
    Ok(env
        .caller
        .call(env.mpc.id(), "sign")
        .args_json(sign_args(payload))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

async fn set_mode(env: &Env, mode: &str) -> anyhow::Result<()> {
    env.owner
        .call(env.mpc.id(), "set_mode")
        .args_json(json!({ "mode": mode }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn wait_pending(env: &Env, count: usize) -> anyhow::Result<Vec<Value>> {
    for _ in 0..100 {
        let pending: Vec<Value> = env.mpc.view("list_pending").await?.json()?;
        if pending.len() == count {
            return Ok(pending);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    anyhow::bail!("pending request count never reached {count}")
}

fn failure_text(result: ExecutionFinalResult) -> String {
    format!("{:?}", result.into_result().err())
}

#[tokio::test]
async fn immediate_modes_and_preconditions() -> anyhow::Result<()> {
    let env = setup().await?;
    let expected = expected_key(env.caller.id(), PATH);

    let derived: String = env
        .mpc
        .view("derived_public_key")
        .args_json(json!({ "path": PATH, "predecessor": env.caller.id(), "domain_id": 1 }))
        .await?
        .json()?;
    assert_eq!(parse_near_key(&derived)?, expected);

    // Default mode is immediate: the caller's result is the signature response.
    let payload = Sha256::digest(b"nep413 prehash stand-in").to_vec();
    let result = sign(&env, &payload).await?;
    let gas: Vec<(String, u64)> = result
        .receipt_outcomes()
        .iter()
        .map(|o| (o.executor_id.to_string(), o.gas_burnt.as_gas()))
        .collect();
    println!("immediate sign receipts gas: {gas:?}");
    let response: Value = result.into_result()?.json()?;
    expected.verify(&payload, &signature_of(&response)?)?;
    let disclosed: Value = env
        .mpc
        .view("get_disclosed_signature")
        .args_json(json!({ "request_id": 0 }))
        .await?
        .json()?;
    assert_eq!(disclosed, response);
    assert!(wait_pending(&env, 0).await?.is_empty());

    // Maximum payload size, with the gas the mandate would plausibly attach.
    let long = vec![7u8; 1232];
    let result = env
        .caller
        .call(env.mpc.id(), "sign")
        .args_json(sign_args(&long))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let response: Value = result.into_result()?.json()?;
    expected.verify(&long, &signature_of(&response)?)?;
    let too_long = sign(&env, &[0u8; 1233]).await?;
    assert!(failure_text(too_long).contains("longer than 1232"));

    set_mode(&env, "immediate_invalid_signature").await?;
    let response: Value = sign(&env, &payload).await?.into_result()?.json()?;
    assert!(
        expected
            .verify(&payload, &signature_of(&response)?)
            .is_err()
    );

    set_mode(&env, "immediate_malformed").await?;
    let raw = sign(&env, &payload).await?.into_result()?.raw_bytes()?;
    assert_eq!(
        raw,
        br#"{"scheme":"Ed25519","signature":"not-a-signature"}"#
    );

    set_mode(&env, "immediate_error").await?;
    assert!(failure_text(sign(&env, &payload).await?).contains("mock-mpc: injected error"));

    // Preconditions mirror v1.signer.
    let no_deposit = env
        .caller
        .call(env.mpc.id(), "sign")
        .args_json(sign_args(&payload))
        .max_gas()
        .transact()
        .await?;
    assert!(failure_text(no_deposit).contains("Attached deposit is lower than required"));
    let low_gas = env
        .caller
        .call(env.mpc.id(), "sign")
        .args_json(sign_args(&payload))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(14))
        .transact()
        .await?;
    assert!(failure_text(low_gas).contains("Provided gas is lower than required"));
    let ecdsa = env
        .caller
        .call(env.mpc.id(), "sign")
        .args_json(json!({ "request": { "path": PATH, "payload_v2": { "Ecdsa": hex::encode(&payload) }, "domain_id": 1 } }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(failure_text(ecdsa).contains("Payload is not EdDSA"));
    let wrong_domain = env
        .caller
        .call(env.mpc.id(), "sign")
        .args_json(
            json!({ "request": { "path": PATH, "payload_v2": { "Eddsa": "00" }, "domain_id": 0 } }),
        )
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(failure_text(wrong_domain).contains("only domain 1"));

    let stranger = env
        .caller
        .call(env.mpc.id(), "set_mode")
        .args_json(json!({ "mode": "hold" }))
        .transact()
        .await?;
    assert!(failure_text(stranger).contains("owner only"));
    Ok(())
}

#[tokio::test]
async fn hold_then_respond_valid() -> anyhow::Result<()> {
    let env = setup().await?;
    set_mode(&env, "hold").await?;
    let payload = b"held payload".to_vec();
    let status = env
        .caller
        .call(env.mpc.id(), "sign")
        .args_json(sign_args(&payload))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact_async()
        .await?;
    let pending = wait_pending(&env, 1).await?;
    assert_eq!(pending[0]["predecessor"], env.caller.id().to_string());
    assert_eq!(pending[0]["payload_hex"], hex::encode(&payload));
    assert!(matches!(status.status().await?, Poll::Pending));

    let request_id = pending[0]["request_id"].as_u64().unwrap_or(u64::MAX);
    let responded: Value = env
        .owner
        .call(env.mpc.id(), "respond")
        .args_json(json!({ "request_id": request_id, "response": "valid" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let response: Value = status.await?.into_result()?.json()?;
    assert_eq!(responded, response);
    expected_key(env.caller.id(), PATH).verify(&payload, &signature_of(&response)?)?;
    assert!(wait_pending(&env, 0).await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn disclosed_signature_without_resume_times_out() -> anyhow::Result<()> {
    let env = setup().await?;
    set_mode(&env, "hold").await?;
    let payload = b"disclosed payload".to_vec();
    let status = env
        .caller
        .call(env.mpc.id(), "sign")
        .args_json(sign_args(&payload))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact_async()
        .await?;
    let pending = wait_pending(&env, 1).await?;
    let request_id = pending[0]["request_id"].as_u64().unwrap_or(u64::MAX);
    let created = pending[0]["created_at_block"].as_u64().unwrap_or(u64::MAX);

    let disclosed: Value = env
        .owner
        .call(env.mpc.id(), "respond")
        .args_json(json!({ "request_id": request_id, "response": "disclose_only" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    expected_key(env.caller.id(), PATH).verify(&payload, &signature_of(&disclosed)?)?;
    let view: Value = env
        .mpc
        .view("get_disclosed_signature")
        .args_json(json!({ "request_id": request_id }))
        .await?
        .json()?;
    assert_eq!(view, disclosed);
    assert!(matches!(status.status().await?, Poll::Pending));

    env.worker.fast_forward(250).await?;
    let outcome = status.await?;
    assert!(failure_text(outcome).contains("Request has timed out."));
    assert!(wait_pending(&env, 0).await?.is_empty());
    let now = env.worker.view_block().await?.height();
    println!("yield timed out between blocks {created} and {now}");

    // The signature stays public after the timeout.
    let view: Value = env
        .mpc
        .view("get_disclosed_signature")
        .args_json(json!({ "request_id": request_id }))
        .await?
        .json()?;
    assert_eq!(view, disclosed);
    let late = env
        .owner
        .call(env.mpc.id(), "respond")
        .args_json(json!({ "request_id": request_id, "response": "valid" }))
        .max_gas()
        .transact()
        .await?;
    assert!(failure_text(late).contains("timed out, was completed, or never existed"));
    Ok(())
}
