//! Harness self-test: proves the sandbox world, the independent NEP-413/token_diff encoding and
//! the fee-closure arithmetic against the pinned verifier WASM, without the mandate contract.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::intents::{self, FillerKey, fee_ceil, filler_closure, parse_rfc3339, rfc3339};
use common::sandbox::{Base, FEE_PIPS, fill, register_filler_key, subaccount};

#[test]
fn rfc3339_roundtrip() {
    for ns in [
        0u64,
        1_700_000_000_123_456_789,
        1_762_195_200_000_000_000,
        951_782_400_000_000_001,
    ] {
        assert_eq!(parse_rfc3339(&rfc3339(ns)), ns);
    }
    assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000000000Z");
    assert_eq!(
        rfc3339(951_782_400_000_000_000),
        "2000-02-29T00:00:00.000000000Z"
    );
}

#[test]
fn closure_balances_supply() {
    for (s, b) in [
        (1u128, 1u128),
        (999_999, 5),
        (1_000_000, 1_000_000),
        (123_456_789_012, 7),
    ] {
        let (r, p) = filler_closure(s, b, 1);
        assert_eq!(s, r + fee_ceil(s, 1));
        assert_eq!(p, b + fee_ceil(p, 1));
    }
}

/// Filler-vs-filler trade on the real verifier, relayed by an unrelated account; then replay and
/// post-removal relays fail.
#[tokio::test]
async fn filler_vs_filler_trade_on_pinned_verifier() -> anyhow::Result<()> {
    let usdc_unit = 10u128.pow(6);
    let near_unit = 10u128.pow(24);
    let b = Base::new(1_000 * usdc_unit, 0).await?;
    let maker = subaccount(&b.root, "maker", 20).await?;
    let maker_key = FillerKey::from_seed(9);
    register_filler_key(&maker, b.verifier.id(), &maker_key).await?;
    b.fund_intents(&maker, 0, 100 * near_unit).await?;
    let (usdc_t, wnear_t) = b.token_ids();

    // Maker sells 10 wNEAR for 31 USDC, exact; the filler closes with fees on its side.
    let (sell, buy) = (10 * near_unit, 31 * usdc_unit);
    let now = b.now_ns().await?;
    let deadline = now + 120_000_000_000;
    let salt = b.verifier.current_salt().await?;
    let maker_nonce = intents::versioned_nonce(salt, deadline as i64, [1; 15]);
    let order = maker_key.sign_diff(
        maker.id().as_str(),
        b.verifier.id().as_str(),
        deadline,
        maker_nonce,
        &[
            (wnear_t.clone(), -(sell as i128)),
            (usdc_t.clone(), buy as i128),
        ],
    );
    let decoded = intents::DecodedOrder::from_multipayload(&order);
    assert!(decoded.signature_valid());

    let before_m = b.balances(maker.id()).await?;
    let before_f = b.balances(b.filler.id()).await?;
    let (out, _) = fill(
        &b.verifier,
        &b.relayer,
        &b.filler,
        &b.filler_key,
        &order,
        [2; 15],
    )
    .await?;
    assert!(out.is_success(), "fill failed: {}", out.failure_text());
    let after_m = b.balances(maker.id()).await?;
    let after_f = b.balances(b.filler.id()).await?;
    let fees = b.balances(b.fee_collector.id()).await?;
    let (receive, pay) = filler_closure(sell, buy, FEE_PIPS);
    assert_eq!(
        after_m.0 - before_m.0,
        buy,
        "maker receives exactly the signed amount"
    );
    assert_eq!(
        before_m.1 - after_m.1,
        sell,
        "maker pays exactly the signed amount"
    );
    assert_eq!(before_f.0 - after_f.0, pay);
    assert_eq!(after_f.1 - before_f.1, receive);
    assert_eq!(fees, (fee_ceil(pay, FEE_PIPS), fee_ceil(sell, FEE_PIPS)));
    assert!(b.verifier.is_nonce_used(maker.id(), &maker_nonce).await?);

    // Replay fails (nonce used).
    let (replay, _) = fill(
        &b.verifier,
        &b.relayer,
        &b.filler,
        &b.filler_key,
        &order,
        [3; 15],
    )
    .await?;
    assert!(!replay.is_success());

    // A fresh maker order fails after the maker removes its key.
    let n2 = intents::versioned_nonce(salt, deadline as i64, [4; 15]);
    let order2 = maker_key.sign_diff(
        maker.id().as_str(),
        b.verifier.id().as_str(),
        deadline,
        n2,
        &[(wnear_t, -(sell as i128)), (usdc_t, buy as i128)],
    );
    maker
        .call(b.verifier.id(), "remove_public_key")
        .args_json(serde_json::json!({"public_key": maker_key.public_key_str()}))
        .deposit(common::sandbox::ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    let (after_removal, _) = fill(
        &b.verifier,
        &b.relayer,
        &b.filler,
        &b.filler_key,
        &order2,
        [5; 15],
    )
    .await?;
    assert!(!after_removal.is_success());
    assert!(
        after_removal.failure_text().contains("public key"),
        "unexpected failure: {}",
        after_removal.failure_text()
    );
    assert_eq!(b.balances(maker.id()).await?, after_m);

    // Clock control: fast-forward moves block time.
    let t0 = b.now_ns().await?;
    let t1 = common::sandbox::advance_past(&b.worker, t0 + 30_000_000_000).await?;
    assert!(t1 > t0 + 30_000_000_000);
    Ok(())
}
