//! gate: BOUNDARY
//!
//! Forbidden asset, recipient/raw payload/path/key fields, transfer/withdrawal/key-mutation
//! attempts by the agent, over-cap requests and direct callback invocation each fail, and the test
//! asserts WHICH boundary stopped them: protocol access-key permission, JSON input schema,
//! contract role check, contract policy check, #[private] callback guard, or verifier
//! authorization.
#![allow(clippy::arithmetic_side_effects, clippy::as_conversions)]

mod common;

use common::evidence;
use common::sandbox::{MAX_GAS, ONE_YOCTO, TxOutcome, call, subaccount};
use common::world::{NEAR, Side, USDC, World, WorldOpts, demo_policy};
use near_workspaces::Account;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{Value, json};

struct Case {
    name: String,
    boundary: &'static str,
    ok: bool,
    detail: String,
}

fn expect(
    cases: &mut Vec<Case>,
    name: &str,
    boundary: &'static str,
    out: &TxOutcome,
    needle: &[&str],
) {
    let text = out.failure_text();
    let stopped = !out.is_success();
    let matched = needle.iter().any(|n| text.contains(n));
    cases.push(Case {
        name: name.to_owned(),
        boundary,
        ok: stopped && matched,
        detail: if stopped {
            text.chars().take(400).collect()
        } else {
            "SUCCEEDED".into()
        },
    });
}

async fn raw(
    from: &Account,
    to: &near_workspaces::AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> TxOutcome {
    call(from, to, method, args, deposit, Gas::from_tgas(150)).await
}

/// gate: BOUNDARY
#[tokio::test]
async fn boundary_rejections_at_the_right_layer() -> anyhow::Result<()> {
    let w = World::new(WorldOpts::default()).await?;
    w.grant_ok(demo_policy()).await?;
    let m = w.mandate.id().clone();
    let v = w.b.verifier.id().clone();
    let zero = NearToken::from_yoctonear(0);
    let mut cases = Vec::new();
    let keys_before = w.b.verifier.public_keys_of(&m).await?;
    let bal_before = w.balances().await?;

    // --- JSON schema: the proposal names no recipient, payload, path, key or token id.
    for (name, extra) in [
        ("recipient field", json!({"recipient": w.agent.id()})),
        ("receiver_id field", json!({"receiver_id": w.agent.id()})),
        ("raw payload field", json!({"payload": "deadbeef"})),
        ("derivation path field", json!({"path": "mandate/v1/1"})),
        (
            "public key field",
            json!({"public_key": "ed25519:11111111111111111111111111111111"}),
        ),
        ("token id field", json!({"token_id": "nep141:evil.near"})),
        (
            "intent field",
            json!({"intents": [{"intent": "ft_withdraw"}]}),
        ),
    ] {
        let mut p = json!({"sell": "usdc", "sell_amount": "1000000", "max_concession_bps": 0});
        for (k, val) in extra.as_object().unwrap() {
            p[k] = val.clone();
        }
        let out = raw(&w.agent, &m, "propose_order", json!({"proposal": p}), zero).await;
        expect(&mut cases, name, "json-schema", &out, &["unknown field"]);
    }
    for (name, sell) in [
        ("forbidden asset usdt", "usdt"),
        ("forbidden asset native near", "near"),
        ("token account as asset", "wrap.near"),
    ] {
        let out = raw(
            &w.agent,
            &m,
            "propose_order",
            json!({"proposal": {"sell": sell, "sell_amount": "1", "max_concession_bps": 0}}),
            zero,
        )
        .await;
        expect(&mut cases, name, "json-schema", &out, &["unknown variant"]);
    }
    let out = raw(
        &w.agent,
        &m,
        "propose_order",
        json!({"proposal": {"sell": "usdc", "sell_amount": -5, "max_concession_bps": 0}}),
        zero,
    )
    .await;
    expect(
        &mut cases,
        "negative amount",
        "json-schema",
        &out,
        &["invalid", "expected"],
    );

    // --- Contract policy checks.
    let out = w.propose(Side::Usdc, 5_000 * USDC, 0).await;
    expect(
        &mut cases,
        "over per-order cap",
        "contract-policy",
        &out,
        &["per-order cap"],
    );
    let out = w.propose(Side::Usdc, USDC, 51).await;
    expect(
        &mut cases,
        "concession above policy",
        "contract-policy",
        &out,
        &["concession"],
    );
    let out = w.propose(Side::Usdc, 0, 0).await;
    expect(
        &mut cases,
        "zero amount",
        "contract-policy",
        &out,
        &["positive"],
    );
    let out = w.propose(Side::Wnear, u128::MAX / 2, 0).await;
    expect(
        &mut cases,
        "absurd amount",
        "contract-policy",
        &out,
        &["overflow", "too large", "cap"],
    );
    // Outstanding cap: fill up with withheld orders, then one more.
    let mut held = 0;
    let mut last = None;
    for _ in 0..8 {
        let o = w.propose(Side::Usdc, 1_800 * USDC, 50).await;
        if o.is_success() {
            held += 1;
        } else {
            last = Some(o);
            break;
        }
    }
    match last {
        Some(o) => expect(
            &mut cases,
            "over outstanding cap",
            "contract-policy",
            &o,
            &["outstanding cap", "turnover cap"],
        ),
        None => cases.push(Case {
            name: "over outstanding cap".into(),
            boundary: "contract-policy",
            ok: false,
            detail: format!("{held} withheld orders accepted"),
        }),
    }

    // --- Protocol access-key permission: the agent's only key allows propose_order on the mandate.
    for (name, method, args, dep) in [
        (
            "agent grant",
            "grant",
            json!({"policy": demo_policy()}),
            zero,
        ),
        ("agent revoke", "revoke", json!({}), zero),
        ("agent recover", "recover", json!({"asset": "usdc"}), zero),
        (
            "agent settle",
            "settle_order",
            json!({"order_id": "0"}),
            zero,
        ),
        (
            "agent callback",
            "on_signed",
            json!({"order_id": "0", "epoch": 1}),
            zero,
        ),
    ] {
        let out = raw(&w.agent, &m, method, args, dep).await;
        expect(
            &mut cases,
            name,
            "protocol-access-key",
            &out,
            &["MethodNameMismatch", "method name", "does not match"],
        );
    }
    for (name, method, args) in [
        (
            "agent mt_transfer on verifier",
            "mt_transfer",
            json!({"receiver_id": w.agent.id(), "token_id": "nep141:x", "amount": "1"}),
        ),
        (
            "agent ft_withdraw on verifier",
            "ft_withdraw",
            json!({"token": w.b.usdc.id(), "receiver_id": w.agent.id(), "amount": "1"}),
        ),
        (
            "agent add_public_key on verifier",
            "add_public_key",
            json!({"public_key": "ed25519:11111111111111111111111111111111"}),
        ),
        (
            "agent disable predecessor auth",
            "disable_auth_by_predecessor_id",
            json!({}),
        ),
        (
            "agent execute_intents",
            "execute_intents",
            json!({"signed": []}),
        ),
    ] {
        // With the verifier's required 1 yocto the key rejects the deposit; without it the key
        // rejects the receiver. Both are protocol-level rejections before any contract runs.
        let out = raw(&w.agent, &v, method, args.clone(), ONE_YOCTO).await;
        expect(
            &mut cases,
            &format!("{name} (1 yocto)"),
            "protocol-access-key",
            &out,
            &["DepositWithFunctionCall"],
        );
        let out = raw(&w.agent, &v, method, args, zero).await;
        expect(
            &mut cases,
            &format!("{name} (no deposit)"),
            "protocol-access-key",
            &out,
            &["ReceiverMismatch"],
        );
    }
    let out = match w
        .agent
        .transfer_near(w.owner.id(), NearToken::from_millinear(1))
        .await
    {
        Ok(r) => TxOutcome::Executed(Box::new(r)),
        Err(e) => TxOutcome::Rejected(format!("{e:?}")),
    };
    expect(
        &mut cases,
        "agent NEAR transfer",
        "protocol-access-key",
        &out,
        &["RequiresFullAccess", "full access", "FullAccess"],
    );
    let out = match w
        .agent
        .batch(w.agent.id())
        .add_key(
            w.owner.secret_key().public_key(),
            near_workspaces::types::AccessKey::full_access(),
        )
        .transact()
        .await
    {
        Ok(r) => TxOutcome::Executed(Box::new(r)),
        Err(e) => TxOutcome::Rejected(format!("{e:?}")),
    };
    expect(
        &mut cases,
        "agent adds itself a full key",
        "protocol-access-key",
        &out,
        &["RequiresFullAccess", "full access", "FullAccess"],
    );
    let out = raw(
        &w.agent,
        &m,
        "propose_order",
        json!({"proposal": {"sell": "usdc", "sell_amount": "1000000", "max_concession_bps": 0}}),
        ONE_YOCTO,
    )
    .await;
    expect(
        &mut cases,
        "agent attaches deposit",
        "protocol-access-key",
        &out,
        &["DepositWithFunctionCall", "deposit"],
    );

    // --- #[private] callbacks invoked directly by other accounts.
    for (method, args) in [
        ("on_grant_prepared", json!({"epoch": 1})),
        ("on_key_added", json!({"epoch": 1})),
        ("on_key_removed", json!({"epoch": 1, "attempt": 1})),
        ("on_key_presence", json!({"epoch": 1, "attempt": 1})),
        ("on_order_priced", json!({"order_id": "0", "epoch": 1})),
        ("on_signed", json!({"order_id": "0", "epoch": 1})),
        ("on_settle_checked", json!({"order_id": "0", "epoch": 1})),
        (
            "on_recovery_balance",
            json!({"asset": "usdc", "attempt": 1, "gas_tgas": 15}),
        ),
        (
            "on_recovery_transferred",
            json!({"asset": "usdc", "attempt": 1, "amount": "1"}),
        ),
    ] {
        for who in [&w.owner, &w.b.relayer] {
            let out = raw(who, &m, method, args.clone(), zero).await;
            expect(
                &mut cases,
                &format!("{method} by {}", who.id()),
                "private-callback",
                &out,
                &["is private"],
            );
        }
    }

    // --- Permissionless calls cannot release without trusted evidence.
    let orders = w.orders().await?;
    let signed = orders
        .iter()
        .find(|o| o["state"]["state"] == "signed")
        .cloned();
    if let Some(o) = signed {
        let id: u64 = o["id"].as_str().unwrap().parse()?;
        let s = w.settle(&w.b.relayer, id).await;
        let still = w.order(id).await?["state"]["state"] == "signed";
        cases.push(Case {
            name: "settle unfilled order".into(),
            boundary: "verifier-evidence",
            ok: s.is_success() && still,
            detail: format!("state still signed: {still}"),
        });
        let e = w.expire(&w.b.relayer, id).await;
        expect(
            &mut cases,
            "expire before deadline",
            "contract-policy",
            &e,
            &["deadline not passed"],
        );
    }

    // --- Verifier authorization: a forged mandate intent signed by an agent-controlled key.
    let forged_key = common::intents::FillerKey::from_seed(99);
    let salt = w.b.verifier.current_salt().await?;
    let now = w.b.now_ns().await?;
    let nonce = common::intents::versioned_nonce(salt, (now + 30_000_000_000) as i64, [9; 15]);
    let (usdc_t, wnear_t) = w.b.token_ids();
    let forged = forged_key.sign_diff(
        m.as_str(),
        v.as_str(),
        now + 30_000_000_000,
        nonce,
        &[(usdc_t, -1_000_000_000), (wnear_t, 1)],
    );
    let out =
        w.b.verifier
            .execute_intents(&w.b.relayer, vec![forged])
            .await;
    expect(
        &mut cases,
        "forged mandate intent with foreign key",
        "verifier-authorization",
        &out,
        &["public key", "PublicKeyNotExist", "doesn't exist"],
    );

    // --- Negative control: the configured agent account WITH a full-access key. The contract's
    // own role checks must still stop non-proposal methods.
    let agent_full = subaccount(&w.b.root, "agentfull", 10).await?;
    let m2c = subaccount(&w.b.root, "mandate2", 30)
        .await?
        .deploy(&common::sandbox::built_wasm("bounded_mandate")?)
        .await?
        .into_result()?;
    let m2 = m2c.id().clone();
    let cfg: Value = w.mandate.view("get_config").await?.json()?;
    let mut cfg2 = cfg.clone();
    cfg2["agent_id"] = json!(agent_full.id());
    m2c.call("new")
        .args_json(json!({"config": cfg2}))
        .transact()
        .await?
        .into_result()?;
    w.b.fund_intents_for(&w.owner, &m2, 1_000 * USDC, 300 * NEAR)
        .await?;
    w.set_prices_now(100_000_000, 300_000_000).await?;
    let g2 = call(
        &w.owner,
        &m2,
        "grant",
        json!({"policy": demo_policy()}),
        zero,
        MAX_GAS,
    )
    .await;
    let g2v: Value = m2c.view("get_grant").await?.json()?;
    cases.push(Case {
        name: "negative-control mandate active".into(),
        boundary: "setup",
        ok: g2.is_success() && g2v["status"] == "active",
        detail: g2v.to_string(),
    });
    for (name, method, args) in [
        (
            "full-key agent grant",
            "grant",
            json!({"policy": demo_policy()}),
        ),
        ("full-key agent revoke", "revoke", json!({})),
        (
            "full-key agent recover",
            "recover",
            json!({"asset": "usdc"}),
        ),
    ] {
        let out = call(&agent_full, &m2, method, args, zero, MAX_GAS).await;
        expect(&mut cases, name, "contract-role", &out, &["only the owner"]);
    }
    let out = call(
        &agent_full,
        &m2,
        "on_signed",
        json!({"order_id": "0", "epoch": 1}),
        zero,
        MAX_GAS,
    )
    .await;
    expect(
        &mut cases,
        "full-key agent callback",
        "private-callback",
        &out,
        &["is private"],
    );
    // The agent can add keys only to its OWN Intents account; the mandate's keys are unchanged.
    let k2 = w.b.verifier.public_keys_of(&m2).await?;
    let out = call(
        &agent_full,
        &v,
        "add_public_key",
        json!({"public_key": common::intents::FillerKey::from_seed(98).public_key_str()}),
        ONE_YOCTO,
        MAX_GAS,
    )
    .await;
    let k2b = w.b.verifier.public_keys_of(&m2).await?;
    cases.push(Case {
        name: "full-key agent add_public_key affects only itself".into(),
        boundary: "verifier-authorization",
        ok: k2 == k2b && !k2.is_empty(),
        detail: format!("tx_ok={} mandate keys {k2b:?}", out.is_success()),
    });
    let b2 = w.b.balances(&m2).await?;
    let out = call(&agent_full, &v, "mt_transfer", json!({"receiver_id": agent_full.id(), "token_id": format!("nep141:{}", w.b.usdc.id()), "amount": "1"}), ONE_YOCTO, MAX_GAS).await;
    cases.push(Case {
        name: "full-key agent mt_transfer cannot move mandate funds".into(),
        boundary: "verifier-authorization",
        ok: w.b.balances(&m2).await? == b2,
        detail: format!("tx_ok={}", out.is_success()),
    });
    let p = w.propose_as(&agent_full, Side::Wnear, NEAR, 0).await;
    let p2 = call(&agent_full, &m2, "propose_order", json!({"proposal": {"sell": "wnear", "sell_amount": NEAR.to_string(), "max_concession_bps": 0}}), zero, Gas::from_tgas(150)).await;
    cases.push(Case {
        name: "full-key agent of mandate2 cannot propose on mandate1".into(),
        boundary: "contract-role",
        ok: !p.is_success(),
        detail: p.failure_text().chars().take(200).collect(),
    });
    cases.push(Case {
        name: "full-key agent can propose on its own mandate".into(),
        boundary: "contract-role",
        ok: p2.is_success(),
        detail: p2.failure_text().chars().take(200).collect(),
    });

    // Nothing above changed the mandate's keys or moved its funds except the agent's own
    // (permitted) unfilled orders.
    let keys_after = w.b.verifier.public_keys_of(&m).await?;
    let bal_after = w.balances().await?;
    cases.push(Case {
        name: "mandate keys unchanged".into(),
        boundary: "summary",
        ok: keys_before == keys_after,
        detail: format!("{keys_after:?}"),
    });
    cases.push(Case {
        name: "mandate funds unchanged".into(),
        boundary: "summary",
        ok: bal_before == bal_after,
        detail: format!("{bal_after:?}"),
    });
    cases.push(Case {
        name: "predecessor auth enabled".into(),
        boundary: "summary",
        ok: w.b.verifier.auth_by_predecessor_enabled(&m).await?,
        detail: String::new(),
    });

    let failed: Vec<&Case> = cases.iter().filter(|c| !c.ok).collect();
    evidence::write(
        "BOUNDARY",
        None,
        failed.is_empty(),
        "sandbox",
        json!({"cases": cases.iter().map(|c| json!({"case": c.name, "boundary": c.boundary, "rejected_at_boundary": c.ok, "detail": c.detail})).collect::<Vec<_>>()}),
    );
    assert!(
        failed.is_empty(),
        "boundary cases not stopped where expected:\n{}",
        failed
            .iter()
            .map(|c| format!("- {} [{}]: {}", c.name, c.boundary, c.detail))
            .collect::<Vec<_>>()
            .join("\n")
    );
    Ok(())
}
