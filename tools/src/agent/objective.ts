// The live agent's objective: keep about 50% USDC / 50% wNEAR by USD value at fresh oracle prices, within the
// runner's remaining sale budgets. This is the agent's own decision rule, applied before anything is sent; it is
// not contract policy and verifies nothing. The mandate re-checks every limit itself. This module reads no chain
// state and has no chain client: inputs are given (rebalance.ts reads them; rehearsal.ts takes them from a file).
import { z } from "zod";
import { GrantView, Policy, Proposal, type Asset, type PriceObservation } from "../types.js";
import { judge, type AdapterVerdict } from "./decision.js";
import { buildPrompt, type BuiltPrompt } from "./prompt.js";
import type { LiveModelCall, LiveModelProvider } from "./providers.js";
import { VALUE_DECIMALS, buildSnapshot, formatUnits, valueUnits, type MarketSnapshot, type SaleBudget } from "./snapshot.js";

/** Act only when the USDC share of value is more than 2 percentage points from 50%. */
export const BAND_BPS = 200n;
/** A proposal may sell up to 1% more than the amount needed to reach 50/50 (plus one unit), for rounding. */
export const NEEDED_TOLERANCE_BPS = 100n;
/**
 * Immediately before signing, each price must have at least the grant's min_remaining_sec plus this margin left
 * of its oracle_max_age_sec: the order's deadline is at most the oldest publish time plus that age, and the
 * mandate refuses an order with less than min_remaining_sec left after pricing.
 */
export const PRICE_MARGIN_EXTRA_SEC = 15;

const Units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const ASSETS = ["usdc", "wnear"] as const;

/** One oracle reading as returned by get_price_no_older_than, with its age at the read block. */
export const PriceReading = z
  .object({
    price_id: z.string(),
    max_age_sec: z.number().int(),
    price: z.string(),
    conf: z.string(),
    expo: z.number().int(),
    publish_time: z.number().int(),
    age_sec: z.number().int(),
  })
  .strict();
export type PriceReading = z.infer<typeof PriceReading>;

/** Every input of one decision, read at a single final block. */
export const FreshObservations = z
  .object({
    block: z.object({ height: z.number().int(), hash: z.string(), timestamp_ns: Units }).strict(),
    grant: GrantView.nullable(),
    balances: z.object({ usdc: Units, wnear: Units }).strict(),
    prices: z.object({ usdc: PriceReading.nullable(), wnear: PriceReading.nullable() }).strict(),
    read_errors: z.array(z.string()),
  })
  .strict();
export type FreshObservations = z.infer<typeof FreshObservations>;

/**
 * A grant the owner plans to make (the approved manifest's grant step), for a rehearsal before any grant exists.
 * It is an approval input, never a chain reading.
 */
export const PlannedGrant = z.object({ source: z.string().min(1), epoch: z.number().int().min(1), policy: Policy.strict() }).strict();
export type PlannedGrant = z.infer<typeof PlannedGrant>;

/**
 * The decision inputs as they would be if `planned` were granted at `obs` with `units` deposited: the planned
 * policy, the observed prices as the initial reference, and `units` valued at those prices rounded down, as the
 * contract's holdings_value rounds. A rehearsal estimate only; nothing here exists on chain, and the contract
 * computes the real reference and value when the grant is made. Without two integer prices there is no reference
 * and inputsFrom refuses.
 */
export function plannedObservations(obs: FreshObservations, planned: PlannedGrant, decimals: Record<Asset, number>, units: Record<Asset, string>): FreshObservations {
  const integer = (p: PriceReading | null): p is PriceReading => p !== null && /^[1-9][0-9]*$/.test(p.price) && /^(0|[1-9][0-9]*)$/.test(p.conf);
  const { usdc, wnear } = obs.prices;
  const observation = (p: PriceReading): PriceObservation => ({ price_id: p.price_id, price: p.price, conf: p.conf, expo: p.expo, publish_time_sec: p.publish_time.toString() });
  const reference = integer(usdc) && integer(wnear) ? { usdc: observation(usdc), wnear: observation(wnear), observed_at_ns: obs.block.timestamp_ns } : null;
  const value = reference === null ? null : ASSETS.reduce((sum, a) => sum + valueUnits(BigInt(units[a]), decimals[a], reference[a]), 0n);
  const grant: GrantView = {
    epoch: planned.epoch,
    path: `mandate/v1/${String(planned.epoch)}`,
    public_key: null,
    status: "active",
    policy: planned.policy,
    initial_reference: reference,
    initial_value: value === null ? null : value.toString(),
    turnover_used: "0",
    outstanding: "0",
    breaker: null,
    key_op_in_flight: false,
  };
  return { ...obs, grant, balances: { usdc: units.usdc, wnear: units.wnear } };
}

export interface RebalanceInputs {
  grant: GrantView;
  /** Current oracle prices, never the grant's initial reference. */
  prices: Record<Asset, PriceObservation>;
  decimals: Record<Asset, number>;
  balances: Record<Asset, bigint>;
  /** The runner's remaining sale budgets, shown to the model and enforced on its proposal; null outside a runner. */
  sale_budget: SaleBudget | null;
}

/**
 * Inputs usable for a decision, or why not: no active grant, missing, invalid, unconfident or stale prices.
 * `saleBudget` is the runner's remaining sale budget at this moment (see snapshot.remainingSaleBudget).
 */
export function inputsFrom(
  obs: FreshObservations,
  decimals: Record<Asset, number>,
  saleBudget: SaleBudget | null = null,
): { ok: true; inputs: RebalanceInputs } | { ok: false; problems: string[] } {
  const problems = [...obs.read_errors];
  const g = obs.grant;
  if (g === null) return { ok: false, problems: [...problems, "no grant"] };
  if (g.status !== "active") problems.push(`grant status ${g.status}, not active`);
  if (g.breaker !== null) problems.push("loss breaker tripped");
  if (g.initial_value === null || g.initial_reference === null) problems.push("grant has no initial reference");
  const prices: Partial<Record<Asset, PriceObservation>> = {};
  for (const a of ASSETS) {
    const p = obs.prices[a];
    if (p === null) {
      problems.push(`${a}: no oracle price within ${g.policy.oracle_max_age_sec} s`);
      continue;
    }
    if (!/^[1-9][0-9]*$/.test(p.price) || !/^(0|[1-9][0-9]*)$/.test(p.conf)) {
      problems.push(`${a}: invalid price ${p.price} +- ${p.conf}`);
      continue;
    }
    if (BigInt(p.conf) * 10_000n > BigInt(p.price) * BigInt(g.policy.max_confidence_bps)) problems.push(`${a}: confidence ${p.conf} above ${g.policy.max_confidence_bps} bps of ${p.price}`);
    if (p.age_sec > p.max_age_sec) problems.push(`${a}: price is ${p.age_sec} s old, above ${p.max_age_sec} s`);
    prices[a] = { price_id: p.price_id, price: p.price, conf: p.conf, expo: p.expo, publish_time_sec: p.publish_time.toString() };
  }
  const { usdc, wnear } = prices;
  if (problems.length > 0 || usdc === undefined || wnear === undefined) return { ok: false, problems };
  return { ok: true, inputs: { grant: g, prices: { usdc, wnear }, decimals, balances: { usdc: BigInt(obs.balances.usdc), wnear: BigInt(obs.balances.wnear) }, sale_budget: saleBudget } };
}

/** Prices too close to their maximum age to survive submission and the mandate's own read. */
export function priceMarginProblems(obs: FreshObservations, policy: Policy): string[] {
  const need = policy.min_remaining_sec + PRICE_MARGIN_EXTRA_SEC;
  return ASSETS.flatMap((a) => {
    const p = obs.prices[a];
    if (p === null) return [];
    const left = p.max_age_sec - p.age_sec;
    return left < need ? [`${a}: price has ${left} s of its ${p.max_age_sec} s maximum age left, below the ${need} s margin (min_remaining_sec + ${PRICE_MARGIN_EXTRA_SEC})`] : [];
  });
}

export const Allocation = z
  .object({
    value_usd: z.object({ usdc: z.string(), wnear: z.string() }).strict(),
    usdc_share_bps: z.string(),
    band_bps: z.string(),
    balanced: z.boolean(),
    overweight: z.enum(ASSETS).nullable(),
    /** Units of the overweight asset whose sale at the current price reaches 50/50 (rounded down). */
    needed_units: z.string(),
    /** Largest sale the objective accepts: needed plus NEEDED_TOLERANCE_BPS, plus one unit. */
    max_units: z.string(),
  })
  .strict();
export type Allocation = z.infer<typeof Allocation>;

/** 10^-12 USD value of `units` at `obs`, rounded up. */
function valueUp(units: bigint, decimals: number, obs: Pick<PriceObservation, "price" | "expo">): bigint {
  const exp = VALUE_DECIMALS + obs.expo - decimals;
  const scaled = units * BigInt(obs.price);
  if (exp >= 0) return scaled * 10n ** BigInt(exp);
  const div = 10n ** BigInt(-exp);
  return (scaled + div - 1n) / div;
}

export function allocation(inputs: RebalanceInputs): Allocation {
  const v = { usdc: valueUnits(inputs.balances.usdc, inputs.decimals.usdc, inputs.prices.usdc), wnear: valueUnits(inputs.balances.wnear, inputs.decimals.wnear, inputs.prices.wnear) };
  const total = v.usdc + v.wnear;
  const diff = v.usdc > v.wnear ? v.usdc - v.wnear : v.wnear - v.usdc;
  // |usdc/total - 1/2| <= band  <=>  |usdc - wnear| <= 2 * band * total
  const balanced = total === 0n || diff * 10_000n <= 2n * BAND_BPS * total;
  const overweight: Asset | null = balanced ? null : v.usdc > v.wnear ? "usdc" : "wnear";
  let needed = 0n;
  if (overweight !== null) {
    // Selling x units moves value(x) from one side to the other: value(x) = diff / 2.
    const obs = inputs.prices[overweight];
    const exp = VALUE_DECIMALS + obs.expo - inputs.decimals[overweight];
    const price = BigInt(obs.price);
    needed = exp >= 0 ? diff / (2n * price * 10n ** BigInt(exp)) : (diff * 10n ** BigInt(-exp)) / (2n * price);
  }
  return {
    value_usd: { usdc: formatUnits(v.usdc, VALUE_DECIMALS), wnear: formatUnits(v.wnear, VALUE_DECIMALS) },
    usdc_share_bps: total === 0n ? "0" : ((v.usdc * 10_000n) / total).toString(),
    band_bps: BAND_BPS.toString(),
    balanced,
    overweight,
    needed_units: needed.toString(),
    max_units: overweight === null ? "0" : (needed + (needed * NEEDED_TOLERANCE_BPS) / 10_000n + 1n).toString(),
  };
}

/**
 * Why a proposal does not serve the objective: wrong direction, more than needed to reach 50/50, more than the
 * mandate holds, more than the runner's remaining per-order or cumulative sale budget (rejected, never clipped), a concession above the grant's, a value above the per-order cap, the remaining outstanding
 * capacity or the remaining turnover (charged at least the proposal charge), or holdings at or below the loss
 * breaker's threshold. Values use the larger of the grant's reference and the current price, rounded up. These are
 * the agent's estimates; the mandate decides.
 */
export function objectiveProblems(inputs: RebalanceInputs, alloc: Allocation, proposal: Proposal): string[] {
  const p: string[] = [];
  const { grant } = inputs;
  const amount = BigInt(proposal.sell_amount);
  if (alloc.overweight === null) p.push("allocation is within the band; no order is needed");
  else if (proposal.sell !== alloc.overweight) p.push(`sells ${proposal.sell}, but ${alloc.overweight} is overweight`);
  if (amount === 0n) p.push("sell_amount is zero");
  if (alloc.overweight === proposal.sell && amount > BigInt(alloc.max_units)) {
    p.push(`sells ${amount} units, more than the ${alloc.needed_units} needed to reach 50/50 (+${NEEDED_TOLERANCE_BPS} bps tolerance: ${alloc.max_units})`);
  }
  if (amount > inputs.balances[proposal.sell]) p.push(`sells ${amount} units, the mandate holds ${inputs.balances[proposal.sell]}`);
  if (inputs.sale_budget !== null) {
    const b = inputs.sale_budget[proposal.sell];
    if (amount > BigInt(b.per_order_units)) p.push(`sells ${amount} units of ${proposal.sell}, above the runner's per-order sale budget ${b.per_order_units}`);
    if (amount > BigInt(b.cumulative_remaining_units)) p.push(`sells ${amount} units of ${proposal.sell}, above the runner's remaining cumulative sale budget ${b.cumulative_remaining_units}`);
  }
  if (proposal.max_concession_bps > grant.policy.max_concession_bps) p.push(`concession ${proposal.max_concession_bps} bps above the grant's ${grant.policy.max_concession_bps}`);
  if (grant.initial_value === null || grant.initial_reference === null) return [...p, "grant has no initial reference"];
  const initial = BigInt(grant.initial_value);
  const decimals = inputs.decimals[proposal.sell];
  const value = [valueUp(amount, decimals, grant.initial_reference[proposal.sell]), valueUp(amount, decimals, inputs.prices[proposal.sell])].reduce((a, b) => (a > b ? a : b));
  const perOrder = (initial * BigInt(grant.policy.per_order_cap_bps)) / 10_000n;
  const outstandingCap = (initial * BigInt(grant.policy.outstanding_cap_bps)) / 10_000n;
  const used = BigInt(grant.outstanding);
  const remaining = outstandingCap > used ? outstandingCap - used : 0n;
  if (value > perOrder) p.push(`order value ${formatUnits(value, VALUE_DECIMALS)} USD above the per-order cap ${formatUnits(perOrder, VALUE_DECIMALS)} USD`);
  if (value > remaining) p.push(`order value ${formatUnits(value, VALUE_DECIMALS)} USD above the remaining outstanding capacity ${formatUnits(remaining, VALUE_DECIMALS)} USD`);
  const ceilBps = (bps: number) => (initial * BigInt(bps) + 9_999n) / 10_000n;
  const charged = [value, ceilBps(grant.policy.proposal_charge_bps)].reduce((a, b) => (a > b ? a : b));
  const turnoverCap = (initial * BigInt(grant.policy.turnover_cap_bps)) / 10_000n;
  const turnover = BigInt(grant.turnover_used) + charged;
  if (turnover > turnoverCap) p.push(`turnover would reach ${formatUnits(turnover, VALUE_DECIMALS)} USD, above the cap ${formatUnits(turnoverCap, VALUE_DECIMALS)} USD`);
  const holdings = ASSETS.reduce((sum, a) => sum + valueUnits(inputs.balances[a], inputs.decimals[a], inputs.prices[a]), 0n);
  const threshold = ceilBps(10_000 - grant.policy.breaker_drawdown_bps);
  if (holdings <= threshold) p.push(`holdings ${formatUnits(holdings, VALUE_DECIMALS)} USD at or below the loss-breaker threshold ${formatUnits(threshold, VALUE_DECIMALS)} USD`);
  return p;
}

export const RebalanceVerdict = z.discriminatedUnion("kind", [
  /** A legitimate decision to send nothing. */
  z.object({ kind: z.literal("no-action"), reason: z.enum(["balanced", "model-declined"]), detail: z.string() }).strict(),
  z.object({ kind: z.literal("proposal"), proposal: Proposal, reason: z.string() }).strict(),
  /** Nothing is sent and the run records a finding. */
  z.object({ kind: z.literal("rejected"), boundary: z.enum(["inputs", "provider", "adapter-schema", "objective"]), problems: z.array(z.string()) }).strict(),
]);
export type RebalanceVerdict = z.infer<typeof RebalanceVerdict>;

export type Assessment =
  | { kind: "balanced"; allocation: Allocation; verdict: RebalanceVerdict }
  | { kind: "ask"; allocation: Allocation; snapshot: MarketSnapshot; prompt: BuiltPrompt };

/** Balanced portfolios are decided without a model call; otherwise the snapshot uses the current prices. */
export function assess(inputs: RebalanceInputs, notes: string[]): Assessment {
  const alloc = allocation(inputs);
  if (alloc.balanced) {
    const detail = `USDC share ${alloc.usdc_share_bps} bps is within ${BAND_BPS} bps of 5000; no model call`;
    return { kind: "balanced", allocation: alloc, verdict: { kind: "no-action", reason: "balanced", detail } };
  }
  const snapshot = buildSnapshot({ grant: inputs.grant, prices: inputs.prices, decimals: inputs.decimals, balances: inputs.balances, notes, sale_budget: inputs.sale_budget });
  return { kind: "ask", allocation: alloc, snapshot, prompt: buildPrompt(snapshot) };
}

export interface CallResult {
  call: LiveModelCall | null;
  /** Provider failure: thrown error, HTTP status, truncation; null when the provider answered. */
  error: string | null;
  started_at: string;
  finished_at: string;
}

/** Exactly one provider call; failures are returned for recording, never retried. */
export async function callModel(provider: LiveModelProvider, prompt: BuiltPrompt): Promise<CallResult> {
  const started = new Date().toISOString();
  try {
    const call = await provider.decide(prompt);
    return { call, error: call.error ?? null, started_at: call.started_at, finished_at: call.finished_at };
  } catch (error) {
    return { call: null, error: error instanceof Error ? error.message : String(error), started_at: started, finished_at: new Date().toISOString() };
  }
}

export function judgeCall(inputs: RebalanceInputs, alloc: Allocation, result: CallResult): { adapter: AdapterVerdict | null; verdict: RebalanceVerdict } {
  if (result.error !== null || result.call === null) return { adapter: null, verdict: { kind: "rejected", boundary: "provider", problems: [result.error ?? "no provider result"] } };
  const adapter = judge(result.call.decision_text);
  if (adapter.kind === "rejected") return { adapter, verdict: { kind: "rejected", boundary: "adapter-schema", problems: adapter.errors } };
  if (adapter.kind === "decline") return { adapter, verdict: { kind: "no-action", reason: "model-declined", detail: adapter.reason } };
  const problems = objectiveProblems(inputs, alloc, adapter.proposal);
  if (problems.length > 0) return { adapter, verdict: { kind: "rejected", boundary: "objective", problems } };
  return { adapter, verdict: { kind: "proposal", proposal: adapter.proposal, reason: adapter.reason } };
}

export interface RebalanceDecision {
  assessment: Assessment;
  result: CallResult | null;
  adapter: AdapterVerdict | null;
  verdict: RebalanceVerdict;
}

/** The whole decision for given inputs; `onRequest` runs before the model is called (to persist the request). */
export async function decideRebalance(
  provider: LiveModelProvider,
  inputs: RebalanceInputs,
  notes: string[],
  onRequest?: (prompt: BuiltPrompt, requestBody: string | null) => void,
): Promise<RebalanceDecision> {
  const assessment = assess(inputs, notes);
  if (assessment.kind === "balanced") return { assessment, result: null, adapter: null, verdict: assessment.verdict };
  onRequest?.(assessment.prompt, provider.requestBody?.(assessment.prompt) ?? null);
  const result = await callModel(provider, assessment.prompt);
  const judged = judgeCall(inputs, assessment.allocation, result);
  return { assessment, result, ...judged };
}
