// Records one genuine model interaction for the fixed demo market. Spends a real model call: requires
// --call-model. Usage: tsx src/agent/record.ts --variant normal|injection --call-model
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DECIMALS, DEMO_POLICY, DEPOSITS, notesFor, observation } from "../demo/market.js";
import { REPO_ROOT } from "../near/sandbox.js";
import type { GrantView } from "../types.js";
import { judge } from "./adapter.js";
import { buildPrompt } from "./prompt.js";
import { ClaudeCliProvider, parseCliOutput } from "./providers.js";
import { PromptVariant, toInteraction } from "./recording.js";
import { VALUE_DECIMALS, buildSnapshot, valueUnits, type MarketSnapshot } from "./snapshot.js";

/** The snapshot the demo's first proposal sees: fresh grant, nothing reserved or traded yet. */
export function demoSnapshot(variant: PromptVariant): MarketSnapshot {
  const reference = { usdc: observation("usdc", 0n), wnear: observation("wnear", 0n), observed_at_ns: "0" };
  const initial =
    valueUnits(DEPOSITS.usdc, DECIMALS.usdc, reference.usdc) + valueUnits(DEPOSITS.wnear, DECIMALS.wnear, reference.wnear);
  const grant: GrantView = {
    epoch: 1,
    path: "mandate/v1/1",
    public_key: null,
    status: "active",
    policy: DEMO_POLICY,
    initial_reference: reference,
    initial_value: initial.toString(),
    turnover_used: "0",
    outstanding: "0",
    breaker: null,
    key_op_in_flight: false,
  };
  return buildSnapshot({
    grant,
    prices: { usdc: reference.usdc, wnear: reference.wnear },
    decimals: DECIMALS,
    balances: DEPOSITS,
    notes: notesFor(variant),
  });
}

export const recordingPath = (variant: PromptVariant): string => join(REPO_ROOT, "fixtures/model", `${variant}.json`);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { variant: { type: "string" }, "call-model": { type: "boolean" } } });
  const variant = PromptVariant.parse(values.variant);
  if (values["call-model"] !== true) throw new Error("refusing to spend a model call without --call-model");
  const snapshot = demoSnapshot(variant);
  const prompt = buildPrompt(snapshot);
  const call = await new ClaudeCliProvider().decide(prompt);
  const attempts = join(REPO_ROOT, "out/model-attempts");
  mkdirSync(attempts, { recursive: true });
  writeFileSync(join(attempts, `${variant}-${Date.now()}.stdout.json`), call.raw_output);
  const cli = parseCliOutput(call.raw_output);
  if (cli.error !== undefined || call.decision_text === null) {
    throw new Error(`model call produced no decision (${cli.error ?? "empty"}); no recording written`);
  }
  const interaction = toInteraction(variant, snapshot, prompt, call);
  const path = recordingPath(variant);
  writeFileSync(path, `${JSON.stringify(interaction, null, 2)}\n`);
  console.log(JSON.stringify({ path, model: call.model, prompt_sha256: prompt.sha256, verdict: judge(call.decision_text), value_decimals: VALUE_DECIMALS }, null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
