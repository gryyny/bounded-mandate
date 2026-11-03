//! Independent valuation arithmetic for gate assertions: arbitrary-precision non-negative integers
//! and spec-derived checks. Intentionally does not reuse the contract's `math` module.

use std::cmp::Ordering;

/// Little-endian base-2^32 natural number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Big(Vec<u32>);

impl Big {
    pub fn from_u128(mut v: u128) -> Self {
        let mut limbs = Vec::new();
        while v > 0 {
            limbs.push((v & 0xffff_ffff) as u32);
            v >>= 32;
        }
        Self(limbs)
    }

    fn trim(mut self) -> Self {
        while self.0.last() == Some(&0) {
            self.0.pop();
        }
        self
    }

    pub fn mul_u32(&self, m: u32) -> Self {
        let mut out = Vec::with_capacity(self.0.len() + 1);
        let mut carry = 0u64;
        for &l in &self.0 {
            let p = u64::from(l) * u64::from(m) + carry;
            out.push((p & 0xffff_ffff) as u32);
            carry = p >> 32;
        }
        if carry > 0 {
            out.push(carry as u32);
        }
        Self(out).trim()
    }

    pub fn mul_u128(&self, m: u128) -> Self {
        let mut acc = Self(Vec::new());
        let mut shift = 0usize;
        let mut m = m;
        while m > 0 {
            let part = self.mul_u32((m & 0xffff_ffff) as u32);
            let mut shifted = vec![0u32; shift];
            shifted.extend(part.0);
            acc = acc.add(&Self(shifted));
            m >>= 32;
            shift += 1;
        }
        acc.trim()
    }

    pub fn add(&self, o: &Self) -> Self {
        let n = self.0.len().max(o.0.len());
        let mut out = Vec::with_capacity(n + 1);
        let mut carry = 0u64;
        for i in 0..n {
            let s = u64::from(*self.0.get(i).unwrap_or(&0))
                + u64::from(*o.0.get(i).unwrap_or(&0))
                + carry;
            out.push((s & 0xffff_ffff) as u32);
            carry = s >> 32;
        }
        if carry > 0 {
            out.push(carry as u32);
        }
        Self(out).trim()
    }

    pub fn pow10(&self, e: u32) -> Self {
        (0..e).fold(self.clone(), |a, _| a.mul_u32(10))
    }

    pub fn div_u32(&self, d: u32) -> (Self, u32) {
        let mut out = vec![0u32; self.0.len()];
        let mut rem = 0u64;
        for i in (0..self.0.len()).rev() {
            let cur = (rem << 32) | u64::from(self.0[i]);
            out[i] = (cur / u64::from(d)) as u32;
            rem = cur % u64::from(d);
        }
        (Self(out).trim(), rem as u32)
    }

    pub fn to_u128(&self) -> u128 {
        let t = self.clone().trim();
        assert!(t.0.len() <= 4, "value exceeds u128");
        t.0.iter()
            .rev()
            .fold(0u128, |a, &l| (a << 32) | u128::from(l))
    }

    pub fn to_f64(&self) -> f64 {
        self.0
            .iter()
            .rev()
            .fold(0.0, |a, &l| a * 4_294_967_296.0 + f64::from(l))
    }
}

impl PartialOrd for Big {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

impl Ord for Big {
    fn cmp(&self, o: &Self) -> Ordering {
        let (a, b) = (self.clone().trim(), o.clone().trim());
        a.0.len()
            .cmp(&b.0.len())
            .then_with(|| a.0.iter().rev().cmp(b.0.iter().rev()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Px {
    pub mantissa: u64,
    pub expo: i32,
}

/// USD value of `amount` units with `decimals`, scaled by 10^shift_extra, as an exact rational
/// num / 10^den_exp.
fn usd_rational(amount: u128, decimals: u8, p: Px) -> (Big, i64) {
    // amount * m * 10^expo / 10^decimals
    let num = Big::from_u128(amount).mul_u128(u128::from(p.mantissa));
    (num, i64::from(decimals) - i64::from(p.expo))
}

/// Compares a*X vs b*Y where X = num_x / 10^ex.
fn cmp_scaled(x: (Big, i64), kx: u128, y: (Big, i64), ky: u128) -> Ordering {
    let e = x.1.max(y.1);
    let lx = x.0.mul_u128(kx).pow10(u32::try_from(e - x.1).expect("exp"));
    let ly = y.0.mul_u128(ky).pow10(u32::try_from(e - y.1).expect("exp"));
    lx.cmp(&ly)
}

/// Value in 10^-12 USD, rounded down or up. Panics if it does not fit in u128.
pub fn value_units(amount: u128, decimals: u8, p: Px, up: bool) -> u128 {
    let (num, den_exp) = usd_rational(amount, decimals, p);
    // units = num * 10^12 / 10^den_exp
    let shift = 12 - den_exp;
    if shift >= 0 {
        return num.pow10(u32::try_from(shift).expect("shift")).to_u128();
    }
    let mut q = num;
    let mut inexact = false;
    for _ in 0..(-shift) {
        let (nq, r) = q.div_u32(10);
        inexact |= r != 0;
        q = nq;
    }
    let v = q.to_u128();
    if up && inexact { v + 1 } else { v }
}

/// True iff receiving `buy` of the bought asset for `sell` of the sold asset concedes at most
/// `max_bps` against the reference prices: value(buy) * 10000 >= value(sell) * (10000 - max_bps).
pub fn concession_within(
    sell: u128,
    sell_dec: u8,
    sell_px: Px,
    buy: u128,
    buy_dec: u8,
    buy_px: Px,
    max_bps: u128,
) -> bool {
    cmp_scaled(
        usd_rational(buy, buy_dec, buy_px),
        10_000,
        usd_rational(sell, sell_dec, sell_px),
        10_000 - max_bps,
    ) != Ordering::Less
}

/// Realised concession in basis points (reporting only; the assertion uses [`concession_within`]).
pub fn concession_bps(
    sell: u128,
    sell_dec: u8,
    sell_px: Px,
    buy: u128,
    buy_dec: u8,
    buy_px: Px,
) -> f64 {
    let (s, se) = usd_rational(sell, sell_dec, sell_px);
    let (b, be) = usd_rational(buy, buy_dec, buy_px);
    let vs = s.to_f64() / 10f64.powi(i32::try_from(se).expect("exp"));
    let vb = b.to_f64() / 10f64.powi(i32::try_from(be).expect("exp"));
    (1.0 - vb / vs) * 10_000.0
}

pub fn bps_floor(v: u128, bps: u128) -> u128 {
    // v * bps / 10000 without overflow for v < 2^114.
    v / 10_000 * bps + (v % 10_000) * bps / 10_000
}
