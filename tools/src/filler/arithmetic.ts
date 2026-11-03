// Counter-order arithmetic for the filler (bigint only). The verifier takes fees only from negative
// token_diff deltas: fee = ceil(|delta| * pips / 1e6), credited to the fee collector. Per token the sum of
// positive deltas plus fees must equal the sum of negative deltas.

export const PIPS_MAX = 1_000_000n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export function feeCeil(amount: bigint, pips: bigint): bigint {
  if (amount < 0n || pips < 0n || pips > PIPS_MAX) throw new Error("invalid fee input");
  return ceilDiv(amount * pips, PIPS_MAX);
}

/** What the filler receives for a token the mandate gives up (mandate delta -sold): sold - fee(sold). */
export function receivableFor(sold: bigint, pips: bigint): bigint {
  if (sold <= 0n) throw new Error("sold amount must be positive");
  return sold - feeCeil(sold, pips);
}

/**
 * The smallest amount y the filler must give up so that y - fee(y) == bought exactly
 * (y = ceil(bought * 1e6 / (1e6 - pips))).
 */
export function payableFor(bought: bigint, pips: bigint): bigint {
  if (bought <= 0n) throw new Error("bought amount must be positive");
  if (pips >= PIPS_MAX) throw new Error("fee of 100% cannot be closed");
  const y = ceilDiv(bought * PIPS_MAX, PIPS_MAX - pips);
  if (y - feeCeil(y, pips) !== bought) throw new Error("fee closure has no exact solution");
  return y;
}

export interface MandateLeg {
  /** Intents token id sold by the mandate (negative delta in its payload). */
  sellToken: string;
  sellAmount: bigint;
  /** Intents token id bought by the mandate (positive delta in its payload). */
  buyToken: string;
  buyAmount: bigint;
}

/** The filler's token_diff that exactly closes the mandate's signed diff under `pips` fees. */
export function counterDiff(leg: MandateLeg, pips: bigint): Record<string, bigint> {
  if (leg.sellToken === leg.buyToken) throw new Error("sell and buy token must differ");
  return {
    [leg.sellToken]: receivableFor(leg.sellAmount, pips),
    [leg.buyToken]: -payableFor(leg.buyAmount, pips),
  };
}

/** Sum of deposits+fees minus withdrawals per token across diffs; zero everywhere means the bundle closes. */
export function imbalance(diffs: Record<string, bigint>[], pips: bigint): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const diff of diffs) {
    for (const [token, delta] of Object.entries(diff)) {
      const fee = delta < 0n ? feeCeil(-delta, pips) : 0n;
      out[token] = (out[token] ?? 0n) + delta + fee;
    }
  }
  return out;
}
