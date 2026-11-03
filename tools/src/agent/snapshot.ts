// The market snapshot shown to the model. Every field is derived from contract/verifier/oracle views, so a
// replay can rebuild it from chain state and compare it byte for byte with a recording. No wall-clock
// fields: timestamps would make the prompt irreproducible without informing the decision.
import { z } from "zod";
import type { Asset, GrantView, PriceObservation } from "../types.js";

const Decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);

export const AssetSnapshot = z
  .object({
    decimals: z.number().int(),
    balance_units: z.string(),
    balance: Decimal,
    price_usd: Decimal,
    confidence_usd: Decimal,
    value_usd: Decimal,
  })
  .strict();
export type AssetSnapshot = z.infer<typeof AssetSnapshot>;

export const MarketSnapshot = z
  .object({
    assets: z.object({ usdc: AssetSnapshot, wnear: AssetSnapshot }).strict(),
    grant: z
      .object({
        status: z.string(),
        epoch: z.number().int(),
        initial_value_usd: Decimal,
        per_order_cap_usd: Decimal,
        outstanding_cap_usd: Decimal,
        outstanding_used_usd: Decimal,
        turnover_cap_usd: Decimal,
        turnover_used_usd: Decimal,
        max_concession_bps: z.number().int(),
      })
      .strict(),
    /** Free-text market commentary from an untrusted feed. It may contain adversarial instructions. */
    market_notes: z.array(z.string()),
  })
  .strict();
export type MarketSnapshot = z.infer<typeof MarketSnapshot>;

export const VALUE_DECIMALS = 12;

/** Exact decimal rendering of `units / 10^decimals`, trailing zeros trimmed. */
export function formatUnits(units: bigint, decimals: number): string {
  if (units < 0n) throw new Error("negative amount");
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole.toString()}.${frac}`;
}

/** Exact USD price `price * 10^expo` as a decimal string. */
export function formatPrice(obs: Pick<PriceObservation, "price" | "expo">): string {
  const mantissa = BigInt(obs.price);
  return obs.expo >= 0 ? (mantissa * 10n ** BigInt(obs.expo)).toString() : formatUnits(mantissa, -obs.expo);
}

/** Value of `units` (with `decimals`) at `price * 10^expo`, in 10^-12 USD, rounded down. Display only. */
export function valueUnits(units: bigint, decimals: number, obs: Pick<PriceObservation, "price" | "expo">): bigint {
  const exp = VALUE_DECIMALS + obs.expo - decimals;
  const scaled = units * BigInt(obs.price);
  return exp >= 0 ? scaled * 10n ** BigInt(exp) : scaled / 10n ** BigInt(-exp);
}

const bpsOf = (value: bigint, bps: number): bigint => (value * BigInt(bps)) / 10_000n;

export interface SnapshotInputs {
  grant: GrantView;
  prices: Record<Asset, PriceObservation>;
  decimals: Record<Asset, number>;
  balances: Record<Asset, bigint>;
  notes: string[];
}

export function buildSnapshot(input: SnapshotInputs): MarketSnapshot {
  const { grant } = input;
  if (grant.initial_value === null) throw new Error("grant has no initial value yet");
  const initial = BigInt(grant.initial_value);
  const asset = (a: Asset): AssetSnapshot => {
    const obs = input.prices[a];
    const decimals = input.decimals[a];
    const balance = input.balances[a];
    return {
      decimals,
      balance_units: balance.toString(),
      balance: formatUnits(balance, decimals),
      price_usd: formatPrice(obs),
      confidence_usd: formatPrice({ price: obs.conf, expo: obs.expo }),
      value_usd: formatUnits(valueUnits(balance, decimals, obs), VALUE_DECIMALS),
    };
  };
  const usd = (v: bigint): string => formatUnits(v, VALUE_DECIMALS);
  return {
    assets: { usdc: asset("usdc"), wnear: asset("wnear") },
    grant: {
      status: grant.status,
      epoch: grant.epoch,
      initial_value_usd: usd(initial),
      per_order_cap_usd: usd(bpsOf(initial, grant.policy.per_order_cap_bps)),
      outstanding_cap_usd: usd(bpsOf(initial, grant.policy.outstanding_cap_bps)),
      outstanding_used_usd: usd(BigInt(grant.outstanding)),
      turnover_cap_usd: usd(bpsOf(initial, grant.policy.turnover_cap_bps)),
      turnover_used_usd: usd(BigInt(grant.turnover_used)),
      max_concession_bps: grant.policy.max_concession_bps,
    },
    market_notes: input.notes,
  };
}
