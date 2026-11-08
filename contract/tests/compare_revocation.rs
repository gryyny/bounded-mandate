//! gate: COMPARE
//!
//! Matched comparison of the owner's alternatives when it withdraws trust from an Intents account
//! that has signed orders outstanding, on the pinned verifier WASM (near/intents 0.4.5). Each
//! strategy gets its own account with the same deposits, the same three withheld orders (all
//! unexpired; two recorded in the owner's ledger, one not, as a disclosed signature would be) and
//! the same relays by an unrelated account:
//!
//! - wait: stop issuing and let the orders expire;
//! - cancel recorded nonces: the account key signs an empty intent per recorded nonce;
//! - cancel every nonce: the same action with the complete list available;
//! - remove the key, then resume with a fresh key (the mandate's revoke and regrant);
//! - remove the key, then re-add the same key (a fixed-path regrant).
//!
//! The account key is a labelled TEST key standing in for the account's signer (the MPC-derived
//! key in the mandate). What is measured: which withheld orders still execute after the owner's
//! action, how many signatures by the account key the action needs, whether an order the owner did
//! not record is covered, and what resuming requires. Expectations follow the verifier's checks
//! (deadline, then key, then nonce: engine/mod.rs L65-L77 at 16d04f6; an empty intent commits its
//! nonce: intents/mod.rs L30-L37). Sandbox block times are not mainnet latency; the time between
//! confirmed removal and an order's own deadline is measured in the mainnet run. The mandate's
//! policy, accounting and recovery are covered by T1-T4, not here.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use anyhow::{Context, Result, bail, ensure};
use common::evidence;
use common::intents::{self, FillerKey};
use common::sandbox::{
    Base, ONE_YOCTO, advance_past, block_time_ns, fill, register_filler_key, subaccount,
};
use near_workspaces::Account;
use serde_json::{Value, json};

const SELL_USDC: u128 = 1_000_000; // 1 USDC per withheld order
const BUY_WNEAR: u128 = 300_000_000_000_000_000_000_000; // 0.3 wNEAR
const TTL_NS: u64 = 120_000_000_000;

struct Treasury {
    account: Account,
    key: FillerKey,
}

struct Order {
    label: &'static str,
    recorded: bool,
    payload: Value,
    nonce: [u8; 32],
    deadline_ns: u64,
}

#[derive(Clone)]
struct Relay {
    label: String,
    executed: bool,
    error: String,
    filler_nonce_used: bool,
}

impl Relay {
    fn json(&self) -> Value {
        json!({"order": self.label, "executed": self.executed, "verifier_error": self.error, "filler_nonce_used": self.filler_nonce_used})
    }
}

async fn treasury(base: &Base, name: &str, seed: u8) -> Result<Treasury> {
    let account = subaccount(&base.root, name, 10).await?;
    let key = FillerKey::from_seed(seed);
    register_filler_key(&account, base.verifier.id(), &key).await?;
    base.fund_intents(&account, 10 * SELL_USDC, 0).await?;
    Ok(Treasury { account, key })
}

async fn sign_order(
    base: &Base,
    t: &Treasury,
    key: &FillerKey,
    label: &'static str,
    recorded: bool,
    random: u8,
) -> Result<Order> {
    let (usdc, wnear) = base.token_ids();
    let deadline_ns = block_time_ns(&base.worker).await? + TTL_NS;
    let nonce = intents::versioned_nonce(
        base.verifier.current_salt().await?,
        i64::try_from(deadline_ns).context("deadline")?,
        [random; 15],
    );
    let diff = [
        (usdc, -i128::try_from(SELL_USDC)?),
        (wnear, i128::try_from(BUY_WNEAR)?),
    ];
    let payload = key.sign_diff(
        t.account.id().as_str(),
        base.verifier.id().as_str(),
        deadline_ns,
        nonce,
        &diff,
    );
    Ok(Order {
        label,
        recorded,
        payload,
        nonce,
        deadline_ns,
    })
}

/// Relays the order with the filler's counter-intent from an unrelated account. "Executed" is the
/// treasury's USDC balance moving by exactly the order's amount, and must agree with the outcome.
/// The filler's counter-intent nonce must be committed exactly when the bundle executed: a rejected
/// bundle, including one rejected for an already used order nonce, commits neither nonce.
async fn relay(base: &Base, t: &Treasury, o: &Order, random: u8) -> Result<Relay> {
    let before = base.balances(t.account.id()).await?.0;
    // The same derivation `fill` uses for the counter-intent; an executed relay confirms it.
    let filler_nonce = intents::versioned_nonce(
        base.verifier.current_salt().await?,
        i64::try_from(o.deadline_ns).context("deadline")?,
        [random; 15],
    );
    let (out, _) = fill(
        &base.verifier,
        &base.relayer,
        &base.filler,
        &base.filler_key,
        &o.payload,
        [random; 15],
    )
    .await?;
    let after = base.balances(t.account.id()).await?.0;
    let executed = before - after == SELL_USDC;
    ensure!(
        executed == out.is_success() && (executed || after == before),
        "{}: outcome {} disagrees with the balance change {before} -> {after}",
        o.label,
        out.is_success()
    );
    let filler_nonce_used = base
        .verifier
        .is_nonce_used(base.filler.id(), &filler_nonce)
        .await?;
    ensure!(
        filler_nonce_used == executed,
        "{}: filler nonce used={filler_nonce_used} but executed={executed}",
        o.label
    );
    Ok(Relay {
        label: o.label.to_owned(),
        executed,
        filler_nonce_used,
        error: if executed {
            String::new()
        } else {
            out.failure_text()
        },
    })
}

fn expect_error(r: &Relay, needle: &str) -> Result<()> {
    ensure!(
        !r.executed && r.error.contains(needle),
        "{}: expected a verifier rejection containing {needle:?}, got executed={} error={}",
        r.label,
        r.executed,
        r.error
    );
    Ok(())
}

async fn withheld(base: &Base, t: &Treasury, salt: u8) -> Result<Vec<Order>> {
    Ok(vec![
        sign_order(base, t, &t.key, "O1 (recorded)", true, salt).await?,
        sign_order(base, t, &t.key, "O2 (recorded)", true, salt + 1).await?,
        sign_order(base, t, &t.key, "O3 (not recorded)", false, salt + 2).await?,
    ])
}

async fn relay_all(base: &Base, t: &Treasury, orders: &[Order], salt: u8) -> Result<Vec<Relay>> {
    let mut out = Vec::new();
    for (i, o) in orders.iter().enumerate() {
        out.push(relay(base, t, o, salt + u8::try_from(i)?).await?);
    }
    Ok(out)
}

async fn remove_key(base: &Base, t: &Treasury, key: &FillerKey) -> Result<()> {
    t.account
        .call(base.verifier.id(), "remove_public_key")
        .args_json(json!({"public_key": key.public_key_str()}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    ensure!(
        !base
            .verifier
            .has_public_key(t.account.id(), &key.public_key_str())
            .await?,
        "the key is still registered after its removal"
    );
    Ok(())
}

/// The verifier's missing-key error for this treasury's account, not any account's.
fn pk_err(t: &Treasury) -> String {
    format!("doesn't exist for account '{}'", t.account.id())
}

/// Whether the order the owner did not record was stopped before its deadline, from its own relay.
fn unrecorded_stopped(relays: &[Relay]) -> Result<bool> {
    let r = relays
        .iter()
        .find(|r| r.label.contains("not recorded"))
        .context("no relay of the unrecorded order")?;
    Ok(!r.executed)
}

fn executed_value(relays: &[Relay]) -> u128 {
    relays.iter().filter(|r| r.executed).count() as u128 * SELL_USDC
}

async fn cancel_nonces(base: &Base, t: &Treasury, orders: &[&Order]) -> Result<usize> {
    let cancellations = orders
        .iter()
        .map(|o| {
            t.key.sign_message(
                base.verifier.id().as_str(),
                o.nonce,
                intents::empty_intents_message(t.account.id().as_str(), o.deadline_ns),
            )
        })
        .collect();
    let out = base
        .verifier
        .execute_intents(&base.relayer, cancellations)
        .await;
    ensure!(
        out.is_success(),
        "cancellation intents failed: {}",
        out.failure_text()
    );
    for o in orders {
        ensure!(
            base.verifier
                .is_nonce_used(t.account.id(), &o.nonce)
                .await?,
            "{}: nonce not committed by the cancellation",
            o.label
        );
    }
    Ok(orders.len())
}

async fn run() -> Result<Value> {
    let base = Base::new(0, 10 * BUY_WNEAR * 2).await?;
    let nonce_err = "nonce was already used";

    // 1. Wait for expiry: nothing to sign, nothing covered until each deadline.
    let wait = treasury(&base, "t-wait", 41).await?;
    let wait_orders = withheld(&base, &wait, 10).await?;
    let wait_relays = relay_all(&base, &wait, &wait_orders, 110).await?;
    ensure!(
        wait_relays.iter().all(|r| r.executed),
        "wait: every unexpired withheld order executes"
    );

    // 2. Cancel recorded nonces: one signature by the account key per recorded order.
    let cancel = treasury(&base, "t-cancel", 42).await?;
    let cancel_orders = withheld(&base, &cancel, 20).await?;
    let recorded: Vec<_> = cancel_orders.iter().filter(|o| o.recorded).collect();
    let cancel_signatures = cancel_nonces(&base, &cancel, &recorded).await?;
    let cancel_relays = relay_all(&base, &cancel, &cancel_orders, 120).await?;
    expect_error(&cancel_relays[0], nonce_err)?;
    expect_error(&cancel_relays[1], nonce_err)?;
    ensure!(
        !cancel_relays[0].filler_nonce_used && !cancel_relays[1].filler_nonce_used,
        "cancel: a bundle rejected for a used order nonce committed the filler's nonce"
    );
    ensure!(
        cancel_relays[2].executed,
        "cancel: the order the owner did not record still executes"
    );
    let cancel_resume =
        sign_order(&base, &cancel, &cancel.key, "O4 (after resume)", true, 25).await?;
    let cancel_resume_relay = relay(&base, &cancel, &cancel_resume, 125).await?;
    ensure!(
        cancel_resume_relay.executed,
        "cancel: trading resumes with the same key"
    );

    // Complete-list control: the fixture also supplies the owner with O3's nonce.
    let complete = treasury(&base, "t-cancel-complete", 45).await?;
    let complete_orders = withheld(&base, &complete, 50).await?;
    let known: Vec<_> = complete_orders.iter().collect();
    let complete_signatures = cancel_nonces(&base, &complete, &known).await?;
    let complete_relays = relay_all(&base, &complete, &complete_orders, 160).await?;
    for r in &complete_relays {
        expect_error(r, nonce_err)?;
    }
    let complete_resume = sign_order(
        &base,
        &complete,
        &complete.key,
        "O4 (after resume)",
        true,
        55,
    )
    .await?;
    let complete_resume_relay = relay(&base, &complete, &complete_resume, 165).await?;
    ensure!(
        complete_resume_relay.executed,
        "complete cancellation: trading resumes with the same key"
    );

    // 3. Remove the key, resume with a fresh key (the mandate's revoke and regrant).
    let fresh = treasury(&base, "t-remove-fresh", 43).await?;
    let fresh_orders = withheld(&base, &fresh, 30).await?;
    remove_key(&base, &fresh, &fresh.key).await?;
    let fresh_relays = relay_all(&base, &fresh, &fresh_orders, 130).await?;
    for r in &fresh_relays {
        expect_error(r, &pk_err(&fresh))?;
    }
    let new_key = FillerKey::from_seed(53);
    register_filler_key(&fresh.account, base.verifier.id(), &new_key).await?;
    let fresh_resume = sign_order(&base, &fresh, &new_key, "O4 (fresh key)", true, 35).await?;
    let fresh_resume_relay = relay(&base, &fresh, &fresh_resume, 135).await?;
    ensure!(
        fresh_resume_relay.executed,
        "remove + fresh key: trading resumes"
    );
    let fresh_old_again = relay(&base, &fresh, &fresh_orders[0], 136).await?;
    expect_error(&fresh_old_again, &pk_err(&fresh))?;

    // 4. Remove the key, then re-add the same key: unexpired old orders execute again.
    let same = treasury(&base, "t-remove-same", 44).await?;
    let same_orders = withheld(&base, &same, 40).await?;
    remove_key(&base, &same, &same.key).await?;
    let same_removed = relay_all(&base, &same, &same_orders, 140).await?;
    for r in &same_removed {
        expect_error(r, &pk_err(&same))?;
    }
    register_filler_key(&same.account, base.verifier.id(), &same.key).await?;
    let same_relays = relay_all(&base, &same, &same_orders, 150).await?;
    ensure!(
        same_relays.iter().all(|r| r.executed),
        "re-adding the same key revives every unexpired withheld order"
    );

    // Expiry: the wait strategy's protection arrives at the order's own deadline.
    let late = sign_order(
        &base,
        &wait,
        &wait.key,
        "O5 (not recorded, relayed after its deadline)",
        false,
        15,
    )
    .await?;
    let now = advance_past(&base.worker, late.deadline_ns).await?;
    let late_relay = relay(&base, &wait, &late, 115).await?;
    expect_error(&late_relay, "deadline has expired")?;
    if now <= late.deadline_ns {
        bail!("the clock did not pass the deadline");
    }

    let scenario = |name: &str,
                    action: &str,
                    signatures: usize,
                    relays: &[Relay],
                    resume: Value|
     -> Result<Value> {
        Ok(json!({
            "strategy": name,
            "owner_action": action,
            "account_key_signatures_for_the_action": signatures,
            "withheld_relays_after_action": relays.iter().map(Relay::json).collect::<Vec<_>>(),
            "executed_after_action": relays.iter().filter(|r| r.executed).count(),
            "executed_value_usdc_units": executed_value(relays).to_string(),
            "unrecorded_order_stopped_before_its_deadline": unrecorded_stopped(relays)?,
            "resume": resume,
        }))
    };
    Ok(json!({
        "verifier": "pinned near/intents 0.4.5 WASM (fixtures/verifier/defuse-0.4.5.wasm)",
        "account_key": "TEST key standing in for the account's signer (MPC-derived in the mandate)",
        "withheld_orders": "three per strategy, each selling 1 USDC for 0.3 wNEAR, TTL 120 s, all relayed unexpired by an unrelated account; O1 and O2 are recorded in the owner's ledger, O3 is not",
        "strategies": [
            scenario("wait for expiry", "stop issuing new orders", 0, &wait_relays,
                json!({"requires": "nothing", "protection_starts": "at each order's own deadline, recorded or not", "unrecorded_order_after_its_deadline": late_relay.json()}))?,
            scenario("cancel recorded nonces", "sign and submit one empty intent per recorded nonce", cancel_signatures, &cancel_relays,
                json!({"requires": "the account's signer available for every cancellation; complete coverage requires a full list of outstanding nonces", "same_key_new_order": cancel_resume_relay.json()}))?,
            scenario("cancel complete nonce list", "sign and submit one empty intent per nonce, including O3 (supplied separately from the ledger)", complete_signatures, &complete_relays,
                json!({"requires": "the account's signer available for every cancellation; the full list of outstanding nonces", "same_key_new_order": complete_resume_relay.json()}))?,
            scenario("remove key, fresh key", "remove_public_key on the verifier, a direct call by the account: no signature by the account key (in the mandate the owner signs revoke and the contract makes this call; covered by T1, not here)", 0, &fresh_relays,
                json!({"requires": "a new key (the mandate derives one on path mandate/v1/<epoch>)", "fresh_key_new_order": fresh_resume_relay.json(), "old_order_after_fresh_key": fresh_old_again.json()}))?,
            scenario("remove key, same key re-added", "remove_public_key, then add_public_key with the same key", 0, &same_relays,
                json!({"while_removed": same_removed.iter().map(Relay::json).collect::<Vec<_>>(), "unrecorded_order_stopped_while_removed": unrecorded_stopped(&same_removed)?, "after_re_add": "every unexpired withheld order executes again"}))?,
        ],
        "not_measured_here": [
            "time between confirmed removal and an order's deadline (only the mainnet run gives a meaningful value)",
            "the mandate's own removal path: the owner's revoke, the contract's call to the verifier and its callback (T1)",
            "the mandate's caps, reservations and recovery (T1-T4)",
            "a race in which a relay lands before the owner's action is final",
        ],
    }))
}

/// gate: COMPARE — wait, cancel known nonces, remove the key (fresh or same key afterwards).
#[tokio::test]
async fn compare_revocation_alternatives() -> Result<()> {
    match run().await {
        Ok(data) => {
            evidence::write("COMPARE", "revocation-alternatives", true, "sandbox", data);
            Ok(())
        }
        Err(e) => {
            evidence::write(
                "COMPARE",
                "revocation-alternatives",
                false,
                "sandbox",
                json!({"error": format!("{e:#}")}),
            );
            Err(e)
        }
    }
}
