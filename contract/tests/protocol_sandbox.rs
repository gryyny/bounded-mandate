//! Exact-encoding proof against the pinned verifier WASM (`fixtures/verifier/defuse-0.4.5.wasm`,
//! mainnet `intents.near` code) in a local near-workspaces sandbox. Both sides of a token_diff
//! trade are built only with `bounded_mandate::protocol`, signed with TEST keys and relayed by an
//! unrelated account. Token accounts are plain accounts: the verifier credits NEP-141 deposits to
//! whichever account calls `ft_on_transfer`, which is all this encoding proof needs.

use anyhow::{Result, ensure};
use bounded_mandate::protocol::nep413::{
    TokenDiffOrder, multi_payload_json, payload, prehash, token_id, versioned_nonce,
};
use bounded_mandate::protocol::{gas, verifier};
use defuse_core::fees::Pips;
use defuse_core::intents::token_diff::TokenDiff;
use defuse_core::token_id::TokenId;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const FEE_PIPS: u32 = 1;
const PIPS_MAX: u128 = 1_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const MAX_GAS: Gas = Gas::from_tgas(300);
const SECOND_NS: u64 = 1_000_000_000;
const TTL_NS: u64 = 120_000_000_000;

/// TEST ONLY: public deterministic keys, never funded.
fn test_key(label: &str) -> SigningKey {
    SigningKey::from_bytes(&Sha256::digest(format!("bounded-mandate/test-key/{label}")).into())
}

fn near_pk(key: &SigningKey) -> near_sdk::PublicKey {
    format!(
        "ed25519:{}",
        near_sdk::bs58::encode(key.verifying_key().as_bytes()).into_string()
    )
    .parse()
    .unwrap()
}

fn sdk_id(id: &AccountId) -> near_sdk::AccountId {
    id.as_str().parse().unwrap()
}

struct World {
    worker: Worker<Sandbox>,
    verifier: Contract,
    usdc: Account,
    wnear: Account,
    mandate: Account,
    filler: Account,
    relayer: Account,
    fee_collector: Account,
}

async fn sub(root: &Account, name: &str) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?)
}

/// Gas burnt by the receipt the verifier executed.
fn verifier_gas(r: &ExecutionFinalResult, verifier: &AccountId) -> u64 {
    r.receipt_outcomes()
        .iter()
        .filter(|o| &o.executor_id == verifier)
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .unwrap_or_default()
}

fn failure_text(r: &ExecutionFinalResult) -> String {
    r.receipt_failures()
        .iter()
        .map(|f| format!("{:?}", (*f).clone().into_result().err()))
        .collect::<Vec<_>>()
        .join("; ")
}

async fn setup() -> Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let fee_collector = sub(&root, "fees").await?;
    let usdc = sub(&root, "usdc").await?;
    let wnear = sub(&root, "wnear").await?;
    let wasm = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/verifier/defuse-0.4.5.wasm"),
    )?;
    let verifier = sub(&root, "intents")
        .await?
        .deploy(&wasm)
        .await?
        .into_result()?;
    verifier
        .call("new")
        .args_json(json!({"config": {
            "wnear_id": wnear.id(),
            "fees": {"fee": FEE_PIPS, "fee_collector": fee_collector.id()},
            "roles": {"super_admins": [root.id()], "admins": {}, "grantees": {}},
        }}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(World {
        mandate: sub(&root, "mandate").await?,
        filler: sub(&root, "filler").await?,
        relayer: sub(&root, "relayer").await?,
        worker,
        verifier,
        usdc,
        wnear,
        fee_collector,
    })
}

impl World {
    async fn deposit(&self, token: &Account, to: &Account, amount: u128) -> Result<()> {
        token
            .call(self.verifier.id(), "ft_on_transfer")
            .args_json(json!({"sender_id": to.id(), "amount": amount.to_string(), "msg": to.id()}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn key_op(&self, who: &Account, method: &str, key: &SigningKey) -> Result<u64> {
        let r = who
            .call(self.verifier.id(), method)
            .args_json(json!({"public_key": near_pk(key)}))
            .deposit(ONE_YOCTO)
            .max_gas()
            .transact()
            .await?;
        ensure!(r.is_success(), "{method}: {}", failure_text(&r));
        Ok(verifier_gas(&r, self.verifier.id()))
    }

    /// Calls a verifier view as a transaction to measure its gas; returns (raw JSON, gas).
    async fn measured_view(&self, method: &str, args: Value) -> Result<(Vec<u8>, u64)> {
        let r = self
            .relayer
            .call(self.verifier.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?;
        ensure!(r.is_success(), "{method}: {}", failure_text(&r));
        let gas = verifier_gas(&r, self.verifier.id());
        Ok((r.raw_bytes()?, gas))
    }

    async fn balances(&self, who: &Account) -> Result<(u128, u128)> {
        let raw = self
            .verifier
            .view("mt_batch_balance_of")
            .args_json(json!({
                "account_id": who.id(),
                "token_ids": [token_id(&sdk_id(self.usdc.id())), token_id(&sdk_id(self.wnear.id()))],
            }))
            .await?
            .result;
        let v = verifier::parse_u128_list(&raw)?;
        Ok((v[0], v[1]))
    }

    async fn salt(&self) -> Result<[u8; 4]> {
        let raw = self.verifier.view("current_salt").await?.result;
        Ok(verifier::parse_salt(&raw)?)
    }

    async fn now_ns(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    async fn nonce_used(&self, who: &Account, nonce: &[u8; 32]) -> Result<bool> {
        let raw = self
            .verifier
            .view("is_nonce_used")
            .args_json(json!({
                "account_id": who.id(),
                "nonce": near_sdk::base64::Engine::encode(
                    &near_sdk::base64::engine::general_purpose::STANDARD,
                    nonce
                ),
            }))
            .await?
            .result;
        Ok(verifier::parse_bool(&raw)?)
    }

    /// Builds and signs one side with our encoder; returns the MultiPayload JSON value.
    #[allow(clippy::too_many_arguments)]
    fn signed(
        &self,
        signer: &Account,
        key: &SigningKey,
        deadline_ns: u64,
        salt: [u8; 4],
        random: u8,
        sell: (&Account, u128),
        buy: (&Account, u128),
    ) -> Result<(Value, [u8; 32])> {
        let order = TokenDiffOrder {
            signer_id: sdk_id(signer.id()),
            verifying_contract: sdk_id(self.verifier.id()),
            deadline_ns,
            nonce: versioned_nonce(salt, deadline_ns, [random; 15]),
            sell_token: sdk_id(sell.0.id()),
            sell_amount: sell.1,
            buy_token: sdk_id(buy.0.id()),
            buy_amount: buy.1,
        };
        let p = payload(&order)?;
        let sig = key.sign(&prehash(&p)?).to_bytes();
        let json = multi_payload_json(&p, &near_pk(key), &sig)?;
        Ok((serde_json::from_str(&json)?, order.nonce))
    }

    async fn execute(&self, signed: &[Value]) -> Result<ExecutionFinalResult> {
        Ok(self
            .relayer
            .call(self.verifier.id(), "execute_intents")
            .args_json(json!({ "signed": signed }))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }
}

fn fee_ceil(amount: u128) -> u128 {
    amount
        .checked_mul(u128::from(FEE_PIPS))
        .and_then(|x| x.checked_add(PIPS_MAX.checked_sub(1)?))
        .and_then(|x| x.checked_div(PIPS_MAX))
        .unwrap()
}

/// The filler's deltas that close the mandate's exact deltas under the verifier fee, from the
/// verifier's own `TokenDiff::closure_delta`.
fn filler_closure(token: &AccountId, mandate_delta: i128) -> i128 {
    let id: TokenId = token_id(&sdk_id(token)).parse().unwrap();
    TokenDiff::closure_delta(&id, mandate_delta, Pips::from_pips(FEE_PIPS).unwrap()).unwrap()
}

#[tokio::test]
async fn token_diff_pair_executes_exactly_and_authority_ends() -> Result<()> {
    let w = setup().await?;
    let (mandate_key, filler_key) = (test_key("mandate"), test_key("filler"));
    let usdc_in: u128 = 100_000_000; // 100 USDC
    let wnear_in: u128 = 50_000_000_000_000_000_000_000_000; // 50 wNEAR
    w.deposit(&w.usdc, &w.mandate, usdc_in).await?;
    w.deposit(&w.wnear, &w.filler, wnear_in).await?;

    let mut gas_seen = vec![
        (
            "add_public_key",
            w.key_op(&w.mandate, "add_public_key", &mandate_key).await?,
        ),
        (
            "add_public_key",
            w.key_op(&w.filler, "add_public_key", &filler_key).await?,
        ),
    ];
    let has = |acct: &Account, key: &SigningKey| json!({"account_id": acct.id(), "public_key": near_pk(key)});
    let (raw, g) = w
        .measured_view("has_public_key", has(&w.mandate, &mandate_key))
        .await?;
    ensure!(verifier::parse_bool(&raw)?);
    gas_seen.push(("has_public_key", g));
    let (raw, g) = w.measured_view("current_salt", json!({})).await?;
    let salt = verifier::parse_salt(&raw)?;
    ensure!(salt == w.salt().await?);
    gas_seen.push(("current_salt", g));

    // Mandate sells exactly 25 USDC for exactly 6.55 wNEAR.
    let sell_usdc: u128 = 25_000_000;
    let buy_wnear: u128 = 6_550_000_000_000_000_000_000_000;
    let filler_usdc = filler_closure(
        w.usdc.id(),
        i128::try_from(sell_usdc)?.checked_neg().unwrap(),
    );
    let filler_wnear = filler_closure(w.wnear.id(), i128::try_from(buy_wnear)?);
    ensure!(filler_usdc > 0 && filler_wnear < 0);
    let filler_gets = filler_usdc.unsigned_abs();
    let filler_pays = filler_wnear.unsigned_abs();

    let deadline = w.now_ns().await?.checked_add(TTL_NS).unwrap();
    let (m, m_nonce) = w.signed(
        &w.mandate,
        &mandate_key,
        deadline,
        salt,
        1,
        (&w.usdc, sell_usdc),
        (&w.wnear, buy_wnear),
    )?;
    let (f, f_nonce) = w.signed(
        &w.filler,
        &filler_key,
        deadline,
        salt,
        2,
        (&w.wnear, filler_pays),
        (&w.usdc, filler_gets),
    )?;
    ensure!(!w.nonce_used(&w.mandate, &m_nonce).await?);

    let r = w.execute(&[m.clone(), f.clone()]).await?;
    ensure!(r.is_success(), "execute_intents: {}", failure_text(&r));

    // Mandate amounts are exact; fees accrue on each negative delta and the filler bears both.
    let fee_usdc = fee_ceil(sell_usdc);
    let fee_wnear = fee_ceil(filler_pays);
    ensure!(fee_usdc == 25 && fee_wnear > 0);
    let mandate_after = w.balances(&w.mandate).await?;
    let filler_after = w.balances(&w.filler).await?;
    let fees_after = w.balances(&w.fee_collector).await?;
    assert_eq!(
        mandate_after,
        (usdc_in.checked_sub(sell_usdc).unwrap(), buy_wnear)
    );
    assert_eq!(
        filler_after,
        (filler_gets, wnear_in.checked_sub(filler_pays).unwrap())
    );
    assert_eq!(fees_after, (fee_usdc, fee_wnear));
    assert_eq!(filler_gets.checked_add(fee_usdc), Some(sell_usdc));
    assert_eq!(buy_wnear.checked_add(fee_wnear), Some(filler_pays));

    let (raw, g) = w
        .measured_view(
            "is_nonce_used",
            json!({"account_id": w.mandate.id(), "nonce": m["payload"]["nonce"]}),
        )
        .await?;
    ensure!(verifier::parse_bool(&raw)?, "mandate nonce is used");
    gas_seen.push(("is_nonce_used", g));
    ensure!(w.nonce_used(&w.filler, &f_nonce).await?);

    // Replay of the same signed pair fails and moves nothing.
    let r = w.execute(&[m, f]).await?;
    ensure!(r.is_failure());
    assert!(
        failure_text(&r).contains("nonce was already used"),
        "{}",
        failure_text(&r)
    );
    assert_eq!(w.balances(&w.mandate).await?, mandate_after);

    // A pair past its deadline fails.
    let past = w.now_ns().await?.checked_sub(SECOND_NS).unwrap();
    let (m, _) = w.signed(
        &w.mandate,
        &mandate_key,
        past,
        salt,
        3,
        (&w.usdc, 1_000_000),
        (&w.wnear, 1),
    )?;
    let (f, _) = w.signed(
        &w.filler,
        &filler_key,
        past,
        salt,
        4,
        (&w.wnear, 2),
        (&w.usdc, 999_999),
    )?;
    let r = w.execute(&[m, f]).await?;
    ensure!(r.is_failure());
    assert!(
        failure_text(&r).contains("deadline has expired"),
        "{}",
        failure_text(&r)
    );

    // A fresh, otherwise valid pair executes while the key is registered ...
    let deadline = w.now_ns().await?.checked_add(TTL_NS).unwrap();
    let fresh = |random: u8| {
        let (m, _) = w
            .signed(
                &w.mandate,
                &mandate_key,
                deadline,
                salt,
                random,
                (&w.usdc, 1_000_000),
                (&w.wnear, 1),
            )
            .unwrap();
        let (f, _) = w
            .signed(
                &w.filler,
                &filler_key,
                deadline,
                salt,
                random.wrapping_add(100),
                (&w.wnear, 2),
                (&w.usdc, 999_999),
            )
            .unwrap();
        [m, f]
    };
    let withheld = fresh(5);
    let probe = fresh(6);
    let r = w.execute(&probe).await?;
    ensure!(r.is_success(), "probe: {}", failure_text(&r));

    // ... and a withheld one fails after the mandate key is removed.
    gas_seen.push((
        "remove_public_key",
        w.key_op(&w.mandate, "remove_public_key", &mandate_key)
            .await?,
    ));
    let (raw, _) = w
        .measured_view("has_public_key", has(&w.mandate, &mandate_key))
        .await?;
    ensure!(!verifier::parse_bool(&raw)?);
    let before = w.balances(&w.mandate).await?;
    let r = w.execute(&withheld).await?;
    ensure!(r.is_failure());
    assert!(
        failure_text(&r).contains("doesn't exist for account"),
        "{}",
        failure_text(&r)
    );
    assert_eq!(w.balances(&w.mandate).await?, before);

    // Remaining verifier calls the contract makes, for gas measurement.
    let (raw, g) = w
        .measured_view(
            "mt_batch_balance_of",
            json!({"account_id": w.mandate.id(), "token_ids": [token_id(&sdk_id(w.usdc.id())), token_id(&sdk_id(w.wnear.id()))]}),
        )
        .await?;
    ensure!(verifier::parse_u128_list(&raw)? == vec![before.0, before.1]);
    gas_seen.push(("mt_batch_balance_of", g));
    let (raw, g) = w
        .measured_view(
            "mt_balance_of",
            json!({"account_id": w.mandate.id(), "token_id": token_id(&sdk_id(w.usdc.id()))}),
        )
        .await?;
    ensure!(verifier::parse_u128(&raw)? == before.0);
    gas_seen.push(("mt_balance_of", g));
    let r = w
        .mandate
        .call(w.verifier.id(), "mt_transfer")
        .args_json(json!({"receiver_id": w.relayer.id(), "token_id": token_id(&sdk_id(w.usdc.id())), "amount": before.0.to_string()}))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?;
    ensure!(r.is_success(), "mt_transfer: {}", failure_text(&r));
    gas_seen.push(("mt_transfer", verifier_gas(&r, w.verifier.id())));
    assert_eq!(w.balances(&w.relayer).await?.0, before.0);

    for (method, burnt) in &gas_seen {
        let budget = match *method {
            "add_public_key" | "remove_public_key" => gas::VERIFIER_KEY_OP_TGAS,
            "mt_transfer" => gas::VERIFIER_MT_TRANSFER_TGAS,
            _ => gas::VERIFIER_VIEW_TGAS,
        };
        println!("{method}: {burnt} gas burnt (budget {budget} TGas)");
        assert!(
            *burnt > 0 && *burnt <= Gas::from_tgas(budget).as_gas(),
            "{method}"
        );
    }
    Ok(())
}
