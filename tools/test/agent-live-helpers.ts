// SYNTHETIC test doubles for the live agent. Their output is written by the tests, never by a model, and is
// labelled provider "synthetic" in every ledger entry and recording.
import type { BuiltPrompt } from "../src/agent/prompt.js";
import type { LiveModelCall, LiveModelProvider } from "../src/agent/providers.js";
import { valueUnits, type SaleBudget } from "../src/agent/snapshot.js";
import { DEMO_POLICY, PRICE_IDS } from "../src/demo/market.js";
import type { Asset, GrantView, PriceObservation } from "../src/types.js";

export type SyntheticAnswer = string | Error | ((prompt: BuiltPrompt) => string | Error);

export class SyntheticProvider implements LiveModelProvider {
  readonly name = "synthetic" as const;
  calls = 0;
  prompts: BuiltPrompt[] = [];
  /** Runs after the call is counted, before the answer is returned (fault injection). */
  onDecide: (() => void | Promise<void>) | null = null;

  constructor(private readonly answer: SyntheticAnswer) {}

  async decide(prompt: BuiltPrompt): Promise<LiveModelCall> {
    this.calls += 1;
    this.prompts.push(prompt);
    await this.onDecide?.();
    const a = typeof this.answer === "function" ? this.answer(prompt) : this.answer;
    if (a instanceof Error) throw a;
    const at = new Date().toISOString();
    return {
      provider: "synthetic",
      requested_model: "synthetic",
      model: "synthetic",
      started_at: at,
      finished_at: at,
      raw_output: a,
      decision_text: a,
      harness_note: "SYNTHETIC test double; not model output",
    };
  }
}

export const proposeJson = (sell: "usdc" | "wnear", units: bigint | string, bps = 30): string =>
  JSON.stringify({ action: "propose", proposal: { sell, sell_amount: units.toString(), max_concession_bps: bps }, reason: "synthetic rebalance" });

export const DECLINE_JSON = JSON.stringify({ action: "decline", proposal: null, reason: "synthetic decline" });

/** Test arithmetic shared by the agent budget and rehearsal tests (setup values, not expectations). */
export const USDC = 10n ** 6n;
export const WNEAR = 10n ** 24n;
export const ONE_USD_PRICE = 100_000_000n;
export const DECIMALS = { usdc: 6, wnear: 24 };

export const priceObs = (asset: Asset, mantissa: bigint): PriceObservation => ({ price_id: PRICE_IDS[asset], price: mantissa.toString(), conf: "0", expo: -8, publish_time_sec: "1000" });

/** An active grant whose initial value is `balances` at `prices` (DEMO_POLICY). */
export function grantFor(balances: Record<Asset, bigint>, prices: Record<Asset, PriceObservation>, over: Partial<GrantView> = {}): GrantView {
  const initialValue = valueUnits(balances.usdc, 6, prices.usdc) + valueUnits(balances.wnear, 24, prices.wnear);
  return {
    epoch: 1,
    path: "mandate/v1/1",
    public_key: "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct",
    status: "active",
    policy: DEMO_POLICY,
    initial_reference: { ...prices, observed_at_ns: "0" },
    initial_value: initialValue.toString(),
    turnover_used: "0",
    outstanding: "0",
    breaker: null,
    key_op_in_flight: false,
    ...over,
  };
}

export const saleBudget = (usdc: [bigint, bigint], wnear: [bigint, bigint]): SaleBudget => ({
  usdc: { per_order_units: usdc[0].toString(), cumulative_remaining_units: usdc[1].toString() },
  wnear: { per_order_units: wnear[0].toString(), cumulative_remaining_units: wnear[1].toString() },
});
