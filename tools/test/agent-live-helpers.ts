// SYNTHETIC test doubles for the live agent. Their output is written by the tests, never by a model, and is
// labelled provider "synthetic" in every ledger entry and recording.
import type { BuiltPrompt } from "../src/agent/prompt.js";
import type { LiveModelCall, LiveModelProvider } from "../src/agent/providers.js";

export type SyntheticAnswer = string | Error | ((prompt: BuiltPrompt) => string | Error);

export class SyntheticProvider implements LiveModelProvider {
  readonly name = "synthetic" as const;
  calls = 0;
  prompts: BuiltPrompt[] = [];
  /** Runs after the call is counted, before the answer is returned (fault injection). */
  onDecide: (() => void) | null = null;

  constructor(private readonly answer: SyntheticAnswer) {}

  decide(prompt: BuiltPrompt): Promise<LiveModelCall> {
    this.calls += 1;
    this.prompts.push(prompt);
    this.onDecide?.();
    const a = typeof this.answer === "function" ? this.answer(prompt) : this.answer;
    if (a instanceof Error) return Promise.reject(a);
    const at = new Date().toISOString();
    return Promise.resolve({
      provider: "synthetic",
      requested_model: "synthetic",
      model: "synthetic",
      started_at: at,
      finished_at: at,
      raw_output: a,
      decision_text: a,
      harness_note: "SYNTHETIC test double; not model output",
    });
  }
}

export const proposeJson = (sell: "usdc" | "wnear", units: bigint | string, bps = 30): string =>
  JSON.stringify({ action: "propose", proposal: { sell, sell_amount: units.toString(), max_concession_bps: bps }, reason: "synthetic rebalance" });

export const DECLINE_JSON = JSON.stringify({ action: "decline", proposal: null, reason: "synthetic decline" });
