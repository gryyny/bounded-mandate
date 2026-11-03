//! Grant policy bounds and derived value caps.

use crate::math::{BPS_DENOMINATOR, Round, bps_of};
use crate::types::Policy;

/// Upper bounds that keep an owner typo from creating effectively unbounded authority.
pub const MAX_TURNOVER_CAP_BPS: u32 = 1_000_000;
pub const MAX_ORACLE_AGE_SEC: u32 = 3_600;
pub const MAX_ORDER_TTL_SEC: u32 = 3_600;
pub const MAX_PRICING_DELAY_SEC: u32 = 600;

const BPS: u16 = 10_000;

pub fn validate(p: &Policy) -> Result<(), &'static str> {
    let in_bps = |v: u16| (1..=BPS).contains(&v);
    if !in_bps(p.per_order_cap_bps) {
        return Err("per_order_cap_bps must be in 1..=10000");
    }
    if !in_bps(p.outstanding_cap_bps) {
        return Err("outstanding_cap_bps must be in 1..=10000");
    }
    if p.per_order_cap_bps > p.outstanding_cap_bps {
        return Err("per_order_cap_bps must not exceed outstanding_cap_bps");
    }
    if p.max_concession_bps >= BPS {
        return Err("max_concession_bps must be below 10000");
    }
    if !(1..=MAX_ORACLE_AGE_SEC).contains(&p.oracle_max_age_sec) {
        return Err("oracle_max_age_sec must be in 1..=3600");
    }
    if p.max_confidence_bps > BPS {
        return Err("max_confidence_bps must be at most 10000");
    }
    if !in_bps(p.breaker_drawdown_bps) {
        return Err("breaker_drawdown_bps must be in 1..=10000");
    }
    if !(1..=MAX_TURNOVER_CAP_BPS).contains(&p.turnover_cap_bps) {
        return Err("turnover_cap_bps must be in 1..=1000000");
    }
    if !(1..=MAX_ORDER_TTL_SEC).contains(&p.order_ttl_sec) {
        return Err("order_ttl_sec must be in 1..=3600");
    }
    if p.min_remaining_sec >= p.order_ttl_sec || p.min_remaining_sec >= p.oracle_max_age_sec {
        return Err("min_remaining_sec must be below order_ttl_sec and oracle_max_age_sec");
    }
    if !(1..=MAX_PRICING_DELAY_SEC).contains(&p.max_pricing_delay_sec) {
        return Err("max_pricing_delay_sec must be in 1..=600");
    }
    Ok(())
}

/// Value caps derived from the initial reference value. Caps round down; the breaker threshold
/// rounds up so it trips no later than the exact drawdown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub per_order: u128,
    pub outstanding: u128,
    pub turnover: u128,
    pub breaker_threshold: u128,
}

impl Caps {
    pub fn new(p: &Policy, initial_value: u128) -> Option<Self> {
        let keep = BPS_DENOMINATOR.checked_sub(u128::from(p.breaker_drawdown_bps))?;
        Some(Self {
            per_order: bps_of(initial_value, p.per_order_cap_bps.into(), Round::Down)?,
            outstanding: bps_of(initial_value, p.outstanding_cap_bps.into(), Round::Down)?,
            turnover: bps_of(initial_value, p.turnover_cap_bps.into(), Round::Down)?,
            breaker_threshold: bps_of(initial_value, keep, Round::Up)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_policy_is_valid() {
        assert_eq!(validate(&Policy::DEMO), Ok(()));
    }

    #[test]
    fn rejects_unbounded_or_inconsistent_policies() {
        let cases: [fn(&mut Policy); 13] = [
            |p| p.per_order_cap_bps = 0,
            |p| p.outstanding_cap_bps = 10_001,
            |p| p.per_order_cap_bps = p.outstanding_cap_bps.saturating_add(1),
            |p| p.max_concession_bps = 10_000,
            |p| p.oracle_max_age_sec = 0,
            |p| p.max_confidence_bps = 10_001,
            |p| p.breaker_drawdown_bps = 0,
            |p| p.turnover_cap_bps = 0,
            |p| p.turnover_cap_bps = MAX_TURNOVER_CAP_BPS.saturating_add(1),
            |p| p.min_remaining_sec = p.order_ttl_sec,
            |p| p.order_ttl_sec = 0,
            |p| p.max_pricing_delay_sec = 0,
            |p| p.min_remaining_sec = p.oracle_max_age_sec,
        ];
        for (i, mutate) in cases.iter().enumerate() {
            let mut p = Policy::DEMO;
            mutate(&mut p);
            assert!(validate(&p).is_err(), "case {i} accepted");
        }
    }

    #[test]
    fn caps_round_conservatively() {
        // 1_000_001 * 2000 / 10000 = 200_000.2 -> 200_000; threshold 1_000_001 * 9800 / 10000 = 980_000.98 -> 980_001.
        let caps = Caps::new(&Policy::DEMO, 1_000_001).unwrap();
        assert_eq!(caps.per_order, 200_000);
        assert_eq!(caps.outstanding, 200_000);
        assert_eq!(caps.turnover, 1_000_001);
        assert_eq!(caps.breaker_threshold, 980_001);
    }
}
