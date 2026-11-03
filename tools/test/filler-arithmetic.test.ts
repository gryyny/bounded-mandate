import { describe, expect, it } from "vitest";
import { PIPS_MAX, counterDiff, feeCeil, imbalance, payableFor, receivableFor } from "../src/filler/arithmetic.js";

// Independent derivation: brute-force search for the smallest y with y - ceil(y*p/1e6) == b.
const bruteForcePayable = (b: bigint, p: bigint): bigint => {
  for (let y = b; ; y += 1n) if (y - (y * p + PIPS_MAX - 1n) / PIPS_MAX === b) return y;
};

// Deterministic xorshift for reproducible random cases (seed recorded here).
const SEED = 0x5eedn;
function* randoms(count: number): Generator<bigint> {
  let x = SEED;
  for (let i = 0; i < count; i++) {
    x ^= (x << 13n) & 0xffffffffffffffffn;
    x ^= x >> 7n;
    x ^= (x << 17n) & 0xffffffffffffffffn;
    yield x;
  }
}

describe("verifier fee arithmetic", () => {
  it("rounds fees up", () => {
    expect(feeCeil(0n, 1n)).toBe(0n);
    expect(feeCeil(1n, 1n)).toBe(1n);
    expect(feeCeil(1_000_000n, 1n)).toBe(1n);
    expect(feeCeil(1_000_001n, 1n)).toBe(2n);
    expect(feeCeil(49_900_000n, 1n)).toBe(50n);
    expect(feeCeil(123n, 0n)).toBe(0n);
  });

  it("matches a brute-force closure for small amounts and several fee levels", () => {
    for (const p of [0n, 1n, 100n, 10_000n, 500_000n]) {
      for (let b = 1n; b <= 300n; b += 1n) {
        expect(payableFor(b, p)).toBe(bruteForcePayable(b, p));
      }
    }
  });

  it("closes every random two-token bundle exactly (supply invariant)", () => {
    const rs = [...randoms(400)];
    for (let i = 0; i < rs.length; i += 2) {
      const sell = ((rs[i] ?? 1n) % 10n ** 30n) + 1n;
      const buy = ((rs[i + 1] ?? 1n) % 10n ** 30n) + 1n;
      for (const p of [1n, 37n, 10_000n]) {
        const leg = { sellToken: "nep141:a", sellAmount: sell, buyToken: "nep141:b", buyAmount: buy };
        const counter = counterDiff(leg, p);
        expect(counter["nep141:a"]).toBe(receivableFor(sell, p));
        const residual = imbalance([{ "nep141:a": -sell, "nep141:b": buy }, counter], p);
        expect(residual).toEqual({ "nep141:a": 0n, "nep141:b": 0n });
        // The filler bears the fees: it receives less than sold and pays more than bought.
        expect(counter["nep141:a"]).toBeLessThanOrEqual(sell);
        expect(-(counter["nep141:b"] ?? 0n)).toBeGreaterThanOrEqual(buy);
      }
    }
  });

  it("rejects degenerate inputs", () => {
    expect(() => payableFor(0n, 1n)).toThrow();
    expect(() => receivableFor(-1n, 1n)).toThrow();
    expect(() => payableFor(1n, PIPS_MAX)).toThrow();
    expect(() => counterDiff({ sellToken: "x", sellAmount: 1n, buyToken: "x", buyAmount: 1n }, 1n)).toThrow();
  });
});
