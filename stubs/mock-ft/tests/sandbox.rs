use near_workspaces::types::{Gas, NearToken};
use serde_json::{Value, json};

const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/near/mock_ft/mock_ft.wasm"
);
const VERIFIER_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/verifier/defuse-0.4.5.wasm"
);

#[tokio::test]
async fn mint_and_deposit_into_real_verifier() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let mandate = worker.dev_create_account().await?;

    let ft = worker.dev_deploy(&std::fs::read(WASM)?).await?;
    ft.call("new")
        .args_json(json!({ "owner_id": owner.id(), "name": "Mock USDC (TEST)", "symbol": "USDC", "decimals": 6 }))
        .transact()
        .await?
        .into_result()?;
    let metadata: Value = ft.view("ft_metadata").await?.json()?;
    assert_eq!(metadata["decimals"], 6);
    assert_eq!(metadata["symbol"], "USDC");

    let verifier = worker.dev_deploy(&std::fs::read(VERIFIER_WASM)?).await?;
    verifier
        .call("new")
        .args_json(json!({ "config": {
            "wnear_id": ft.id(),
            "fees": { "fee": 1, "fee_collector": owner.id() },
            "roles": { "super_admins": [owner.id()], "admins": {}, "grantees": {} }
        }}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let refused = alice
        .call(ft.id(), "mint")
        .args_json(json!({ "account_id": alice.id(), "amount": "1" }))
        .transact()
        .await?;
    assert!(format!("{:?}", refused.into_result().err()).contains("mock-ft: owner only"));

    owner
        .call(ft.id(), "mint")
        .args_json(json!({ "account_id": alice.id(), "amount": "1000000" }))
        .transact()
        .await?
        .into_result()?;
    let bounds: Value = ft.view("storage_balance_bounds").await?.json()?;
    let min: u128 = bounds["min"].as_str().unwrap_or("x").parse()?;
    owner
        .call(ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": verifier.id(), "registration_only": true }))
        .deposit(NearToken::from_yoctonear(min))
        .transact()
        .await?
        .into_result()?;

    // Deposit format: msg is the receiving Intents account id as a plain string.
    let used: String = alice
        .call(ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": verifier.id(), "amount": "250000", "msg": mandate.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(used, "250000");

    // Empty msg credits the sender.
    alice
        .call(ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": verifier.id(), "amount": "1000", "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    let token_id = format!("nep141:{}", ft.id());
    let mt = |account: &near_workspaces::AccountId| {
        verifier
            .view("mt_balance_of")
            .args_json(json!({ "account_id": account, "token_id": token_id }))
    };
    let mandate_balance: String = mt(mandate.id()).await?.json()?;
    assert_eq!(mandate_balance, "250000");
    let alice_intents: String = mt(alice.id()).await?.json()?;
    assert_eq!(alice_intents, "1000");

    let ft_balance = |account: &near_workspaces::AccountId| {
        ft.view("ft_balance_of")
            .args_json(json!({ "account_id": account }))
    };
    let alice_ft: String = ft_balance(alice.id()).await?.json()?;
    assert_eq!(alice_ft, (1_000_000u128 - 250_000 - 1_000).to_string());
    let verifier_ft: String = ft_balance(verifier.id()).await?.json()?;
    assert_eq!(verifier_ft, (250_000u128 + 1_000).to_string());
    Ok(())
}
