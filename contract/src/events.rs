//! NEP-297 events, standard `bounded_mandate`.

use near_sdk::env;
use near_sdk::serde_json::{Value, json};

pub const STANDARD: &str = "bounded_mandate";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let line = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}
