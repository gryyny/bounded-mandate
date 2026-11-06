// The market snapshot shown to the model. Every field is derived from contract/verifier/oracle views, so a
// replay can rebuild it from chain state and compare it byte for byte with a recording. No wall-clock
// fields: timestamps would make the prompt irreproducible without informing the decision.
import { z } from "zod";
import type { Asset, GrantView, PriceObservation } from "../types.js";

const Decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
const Units = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** The runner's remaining sale budget for one asset, in integer base units of that asset. */
export const AssetSaleBudget = z
  .object({
    /** Largest single sale the runner allows (its max_order_sell). */
    per_order_units: Units,
    /** Units the runner may still sell in this run (max_total_sell minus what the ledger already charged). */
    cumulative_remaining_units: Units,
  })
  .strict();
export type AssetSaleBudget = z.infer<typeof AssetSaleBudget>;

/** Input from the runner: its remaining per-order and cumulative sale budgets for both assets. */
export const SaleBudget = z.object({ usdc: AssetSaleBudget, wnear: AssetSaleBudget }).strict();
export type SaleBudget = z.infer<typeof SaleBudget>;

/** The model-visible form: both budgets and the tighter of the two, which bounds any sale of the asset. */
export const AssetSaleBudgetSnapshot = AssetSaleBudget.extend({ max_sale_units: Units }).strict();

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
    /**
     * The runner's remaining sale budgets. Absent only in snapshots built without a runner (the recorded demo
     * fixtures), whose prompt version stays v1; present, it selects the budgeted prompt.
     */
    runner_sale_budget: z.object({ usdc: AssetSaleBudgetSnapshot, wnear: AssetSaleBudgetSnapshot }).strict().optional(),
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
  /** The runner's remaining sale budgets; null only outside the live runner (demo fixtures). */
  sale_budget?: SaleBudget | null;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Largest sale of `asset` both budgets allow. */
export const maxSaleUnits = (budget: SaleBudget, asset: Asset): bigint =>
  min(BigInt(budget[asset].per_order_units), BigInt(budget[asset].cumulative_remaining_units));

/**
 * The runner's remaining sale budget from its caps and the units it has already charged, per asset. Exceeded
 * caps leave zero, never a negative budget.
 */
export function remainingSaleBudget(
  caps: { max_order_sell: Record<Asset, string>; max_total_sell: Record<Asset, string> },
  sold: Record<Asset, bigint>,
): SaleBudget {
  const of = (a: Asset): AssetSaleBudget => {
    const left = BigInt(caps.max_total_sell[a]) - sold[a];
    return { per_order_units: BigInt(caps.max_order_sell[a]).toString(), cumulative_remaining_units: (left > 0n ? left : 0n).toString() };
  };
  return SaleBudget.parse({ usdc: of("usdc"), wnear: of("wnear") });
}

/** The budget a snapshot showed the model, as runner input again (replay). */
export function saleBudgetOf(snapshot: MarketSnapshot): SaleBudget | null {
  const b = snapshot.runner_sale_budget;
  if (b === undefined) return null;
  const of = (a: Asset): AssetSaleBudget => ({ per_order_units: b[a].per_order_units, cumulative_remaining_units: b[a].cumulative_remaining_units });
  return { usdc: of("usdc"), wnear: of("wnear") };
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
  const budget = input.sale_budget === undefined || input.sale_budget === null ? null : SaleBudget.parse(input.sale_budget);
  const budgetOf = (b: SaleBudget, a: Asset) => ({ ...b[a], max_sale_units: maxSaleUnits(b, a).toString() });
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
    ...(budget === null ? {} : { runner_sale_budget: { usdc: budgetOf(budget, "usdc"), wnear: budgetOf(budget, "wnear") } }),
    market_notes: input.notes,
  };
}
