use near_workspaces::types::NearToken;
use serde_json::{Value, json};

const WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/near/mock_oracle/mock_oracle.wasm"
);
const NEAR_ID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";

#[tokio::test]
async fn mock_oracle_mirrors_age_semantics_and_controls() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let oracle = worker.dev_deploy(&std::fs::read(WASM)?).await?;
    let owner = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;
    oracle
        .call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;

    let now_s = worker.view_block().await?.timestamp() / 1_000_000_000;
    let publish_time = i64::try_from(now_s)? - 5;
    owner
        .call(oracle.id(), "set_price")
        .args_json(json!({
            "price_id": NEAR_ID, "price": "381468942", "conf": "516058", "expo": -8,
            "publish_time": publish_time
        }))
        .transact()
        .await?
        .into_result()?;

    let refused = stranger
        .call(oracle.id(), "set_price")
        .args_json(json!({
            "price_id": NEAR_ID, "price": "1", "conf": "0", "expo": -8, "publish_time": publish_time
        }))
        .deposit(NearToken::from_yoctonear(0))
        .transact()
        .await?;
    assert!(refused.is_failure());

    // Pin one block so block time is fixed across the boundary queries.
    let block = worker.view_block().await?;
    let height = block.height();
    let block_s = i64::try_from(block.timestamp() / 1_000_000_000)?;
    let age = u64::try_from(block_s - publish_time)?;
    let at = |id: &str, age: u64| {
        oracle
            .view("get_price_no_older_than")
            .args_json(json!({ "price_id": id, "age": age }))
            .block_height(height)
    };

    let fresh: Value = at(NEAR_ID, age).await?.json()?;
    assert_eq!(
        fresh,
        json!({"price": "381468942", "conf": "516058", "expo": -8, "publish_time": publish_time})
    );
    let stale: Value = at(NEAR_ID, age - 1).await?.json()?;
    assert_eq!(stale, Value::Null);
    let prefixed: Value = at(&format!("0x{}", NEAR_ID.to_uppercase()), age)
        .await?
        .json()?;
    assert_eq!(prefixed, fresh);
    let unknown: Value = at(&"00".repeat(32), 3600).await?.json()?;
    assert_eq!(unknown, Value::Null);

    let listed: Value = oracle
        .view("list_prices_no_older_than")
        .args_json(json!({ "price_ids": [NEAR_ID, "00"], "age": age }))
        .block_height(height)
        .await?
        .json()?;
    assert_eq!(listed, json!({ NEAR_ID: fresh, "00": null }));

    owner
        .call(oracle.id(), "set_unavailable")
        .args_json(json!({ "price_id": NEAR_ID }))
        .transact()
        .await?
        .into_result()?;
    let gone: Value = oracle
        .view("get_price_no_older_than")
        .args_json(json!({ "price_id": NEAR_ID, "age": u64::MAX }))
        .await?
        .json()?;
    assert_eq!(gone, Value::Null);

    owner
        .call(oracle.id(), "set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let failed = oracle
        .view("get_price_no_older_than")
        .args_json(json!({ "price_id": NEAR_ID, "age": 60 }))
        .await;
    assert!(format!("{:?}", failed.err()).contains("mock-oracle: fail mode"));
    Ok(())
}
