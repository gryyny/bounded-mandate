//! Test-only fault injection, compiled only with the `fault-injection` feature. It lets the owner
//! make `on_key_added` panic for one epoch so sandbox tests can reproduce a lost registration
//! callback. The flag lives under its own storage key, so contract state layout is unchanged.

use near_sdk::{env, near, require};

use crate::{Mandate, MandateExt};

const KEY_ADDED_FAULT: &[u8] = b"fault:on_key_added";

#[near]
impl Mandate {
    /// Makes `on_key_added` panic for `epoch`; `None` clears the fault.
    pub fn fault_fail_key_added(&mut self, epoch: Option<u64>) {
        require!(
            env::predecessor_account_id() == self.get_config().owner_id,
            "only the owner"
        );
        match epoch {
            Some(e) => env::storage_write(KEY_ADDED_FAULT, &e.to_le_bytes()),
            None => env::storage_remove(KEY_ADDED_FAULT),
        };
    }
}

/// Panics (reverting the callback's state changes) when a fault is set for `epoch`.
pub fn check_key_added(epoch: u64) {
    if env::storage_read(KEY_ADDED_FAULT).as_deref() == Some(epoch.to_le_bytes().as_slice()) {
        env::panic_str("fault injection: on_key_added fails");
    }
}
