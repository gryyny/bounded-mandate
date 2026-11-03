//! Checked integer valuation and pricing. Every function returns `None` instead of overflowing.

use crate::types::VALUE_DECIMALS;

pub const BPS_DENOMINATOR: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Round {
    Down,
    Up,
}

/// A validated price: USD price of one whole unit is `mantissa * 10^expo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    pub mantissa: u64,
    pub expo: i32,
}

/// `a * b / d` rounded as requested, with a 256-bit intermediate product.
pub fn mul_div(a: u128, b: u128, d: u128, round: Round) -> Option<u128> {
    if d == 0 {
        return None;
    }
    let (hi, lo) = full_mul(a, b)?;
    if hi >= d {
        return None;
    }
    let (mut q, mut rem) = (0u128, hi);
    for bit in (0..128u32).rev() {
        let carry = rem.checked_shr(127)? == 1;
        rem = rem.checked_shl(1)? | (lo.checked_shr(bit)? & 1);
        q = q.checked_shl(1)?;
        // With the carry the true remainder is rem + 2^128 > d; wrapping subtraction yields it exactly.
        if carry || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1;
        }
    }
    match round {
        Round::Up if rem != 0 => q.checked_add(1),
        _ => Some(q),
    }
}

fn full_mul(a: u128, b: u128) -> Option<(u128, u128)> {
    const MASK: u128 = 0xFFFF_FFFF_FFFF_FFFF;
    let (a1, a0) = (a.checked_shr(64)?, a & MASK);
    let (b1, b0) = (b.checked_shr(64)?, b & MASK);
    let p00 = a0.checked_mul(b0)?;
    let p01 = a0.checked_mul(b1)?;
    let p10 = a1.checked_mul(b0)?;
    let p11 = a1.checked_mul(b1)?;
    let mid = p00
        .checked_shr(64)?
        .checked_add(p01 & MASK)?
        .checked_add(p10 & MASK)?;
    let lo = (p00 & MASK) | (mid & MASK).checked_shl(64)?;
    let hi = p11
        .checked_add(p01.checked_shr(64)?)?
        .checked_add(p10.checked_shr(64)?)?
        .checked_add(mid.checked_shr(64)?)?;
    Some((hi, lo))
}

pub fn pow10(exp: u32) -> Option<u128> {
    10u128.checked_pow(exp)
}

/// Splits `10^shift` into a (multiplier, divisor) pair.
fn scale(shift: i64) -> Option<(u128, u128)> {
    let magnitude = u32::try_from(shift.unsigned_abs()).ok()?;
    let factor = pow10(magnitude)?;
    Some(if shift >= 0 { (factor, 1) } else { (1, factor) })
}

/// Value in units of 10^-12 USD of `amount` integer token units with `decimals`.
pub fn value_of(amount: u128, decimals: u8, price: Price, round: Round) -> Option<u128> {
    let shift = i64::from(price.expo)
        .checked_add(i64::from(VALUE_DECIMALS))?
        .checked_sub(i64::from(decimals))?;
    let (mul, div) = scale(shift)?;
    mul_div(
        amount,
        u128::from(price.mantissa).checked_mul(mul)?,
        div,
        round,
    )
}

/// Buy amount for selling `sell_amount` at the two reference prices less `concession_bps`, rounded
/// up as one exact rational so the realised concession never exceeds `concession_bps`.
pub fn buy_amount(
    sell_amount: u128,
    sell_decimals: u8,
    sell_price: Price,
    buy_decimals: u8,
    buy_price: Price,
    concession_bps: u16,
    round: Round,
) -> Option<u128> {
    let keep = BPS_DENOMINATOR.checked_sub(u128::from(concession_bps))?;
    let shift = i64::from(sell_price.expo)
        .checked_sub(i64::from(buy_price.expo))?
        .checked_add(i64::from(buy_decimals))?
        .checked_sub(i64::from(sell_decimals))?;
    let (mul, div) = scale(shift)?;
    let num = u128::from(sell_price.mantissa)
        .checked_mul(keep)?
        .checked_mul(mul)?;
    let den = u128::from(buy_price.mantissa)
        .checked_mul(BPS_DENOMINATOR)?
        .checked_mul(div)?;
    mul_div(sell_amount, num, den, round)
}

/// `value * bps / 10000`.
pub fn bps_of(value: u128, bps: u128, round: Round) -> Option<u128> {
    mul_div(value, bps, BPS_DENOMINATOR, round)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    fn naive(a: u128, b: u128, d: u128, round: Round) -> u128 {
        let p = a * b;
        match round {
            Round::Down => p / d,
            Round::Up => p.div_ceil(d),
        }
    }

    #[test]
    fn mul_div_matches_native_when_product_fits() {
        let cases = [
            (0u128, 5u128, 3u128),
            (1, 1, 1),
            (7, 3, 2),
            (u64::MAX.into(), u64::MAX.into(), 7),
            (123_456_789, 987_654_321, 1_000_003),
            (u128::from(u64::MAX) << 10, 1 << 50, 3),
        ];
        for (a, b, d) in cases {
            for round in [Round::Down, Round::Up] {
                assert_eq!(
                    mul_div(a, b, d, round),
                    Some(naive(a, b, d, round)),
                    "{a} {b} {d}"
                );
            }
        }
    }

    #[test]
    fn mul_div_uses_wide_intermediate() {
        // (2^127 * 6) / 4 = 3 * 2^126 does not fit the product in u128 but the quotient fits.
        assert_eq!(mul_div(1 << 127, 6, 4, Round::Down), Some(3 << 126));
        assert_eq!(
            mul_div(u128::MAX, u128::MAX, u128::MAX, Round::Up),
            Some(u128::MAX)
        );
        // u128::MAX * 3 / 2 overflows the result.
        assert_eq!(mul_div(u128::MAX, 3, 2, Round::Down), None);
        assert_eq!(mul_div(1, 1, 0, Round::Down), None);
        // ceil((2^128 - 1) * (2^128 - 1) / (2^128 - 2)) = 2^128 does not fit.
        assert_eq!(
            mul_div(u128::MAX, u128::MAX, u128::MAX - 1, Round::Up),
            None
        );
        assert_eq!(
            mul_div(u128::MAX, u128::MAX - 1, u128::MAX, Round::Up),
            Some(u128::MAX - 1)
        );
    }

    #[test]
    fn value_of_scales_decimals_and_exponent() {
        // 2.5 wNEAR at $3.12345678 (expo -8): 7.80864195 USD = 7_808_641_950_000 units.
        let near = Price {
            mantissa: 312_345_678,
            expo: -8,
        };
        let amount = 25 * 10u128.pow(23);
        assert_eq!(
            value_of(amount, 24, near, Round::Down),
            Some(7_808_641_950_000)
        );
        // 1 yocto rounds down to zero and up to one unit.
        assert_eq!(value_of(1, 24, near, Round::Down), Some(0));
        assert_eq!(value_of(1, 24, near, Round::Up), Some(1));
        // 10 USDC at $0.9999 (expo -4): 9.999 USD.
        let usdc = Price {
            mantissa: 9_999,
            expo: -4,
        };
        assert_eq!(
            value_of(10_000_000, 6, usdc, Round::Down),
            Some(9_999_000_000_000)
        );
        // Positive shifts multiply.
        let big = Price {
            mantissa: 2,
            expo: 3,
        };
        assert_eq!(
            value_of(5, 0, big, Round::Down),
            Some(10_000 * 10u128.pow(12))
        );
    }

    #[test]
    fn buy_amount_is_exact_rational_ceiling() {
        let usdc = Price {
            mantissa: 100_000_000,
            expo: -8,
        };
        let near = Price {
            mantissa: 300_000_000,
            expo: -8,
        };
        // 30 USDC buys 10 wNEAR at fair price; 50 bps concession: 9.95 wNEAR.
        let fair = buy_amount(30_000_000, 6, usdc, 24, near, 0, Round::Down);
        assert_eq!(fair, Some(10 * 10u128.pow(24)));
        let signed = buy_amount(30_000_000, 6, usdc, 24, near, 50, Round::Up);
        assert_eq!(signed, Some(995 * 10u128.pow(22)));
        // 1 wNEAR yocto sells for 3e-18 USDC units: ceil yields 1 unit with 0 concession.
        assert_eq!(buy_amount(1, 24, near, 6, usdc, 0, Round::Up), Some(1));
        assert_eq!(buy_amount(1, 24, near, 6, usdc, 0, Round::Down), Some(0));
        // Concession of 10000 bps or more is invalid.
        assert_eq!(buy_amount(1, 6, usdc, 24, near, 10_001, Round::Up), None);
    }

    #[test]
    fn buy_amount_handles_mixed_exponents() {
        // Same USD prices expressed with different exponents give the same answer.
        let usdc = Price {
            mantissa: 1,
            expo: 0,
        };
        let near = Price {
            mantissa: 3_000_000,
            expo: -6,
        };
        let a = buy_amount(30_000_000, 6, usdc, 24, near, 37, Round::Up);
        let usdc8 = Price {
            mantissa: 100_000_000,
            expo: -8,
        };
        let near8 = Price {
            mantissa: 300_000_000,
            expo: -8,
        };
        let b = buy_amount(30_000_000, 6, usdc8, 24, near8, 37, Round::Up);
        assert_eq!(a, b);
        // Independent derivation: 10 NEAR * (10000 - 37) / 10000 = 9.963 NEAR.
        assert_eq!(a, Some(9_963 * 10u128.pow(21)));
    }
}
