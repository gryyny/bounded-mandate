// Building blocks of the sandbox story shared by `make demo` and the sandbox tests.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, type MarketSnapshot } from "../agent/snapshot.js";
import { loadRecording, type LoadedRecording, type PromptVariant } from "../agent/recording.js";
import { toEvidenceReceipt, type Outcome } from "../near/client.js";
import { REPO_ROOT, requireSuccess } from "../near/sandbox.js";
import type { Assertion, Receipt } from "../types.js";
import { DECIMALS, DEMO_POLICY } from "./market.js";
import { balances, postPrices, type World } from "./world.js";

export async function grantDemo(world: World): Promise<Outcome> {
  await postPrices(world);
  const outcome = requireSuccess(await world.mandate.grantPolicy(world.owner.account, DEMO_POLICY));
  const grant = await world.mandate.grant();
  if (grant?.status !== "active") throw new Error(`grant did not activate: ${JSON.stringify(grant)}`);
  return outcome;
}

/** The model's view, rebuilt from contract and verifier views only. */
export async function chainSnapshot(world: World, notes: string[]): Promise<MarketSnapshot> {
  const grant = await world.mandate.grant();
  if (grant?.initial_reference == null) throw new Error("no active grant with a reference");
  return buildSnapshot({
    grant,
    prices: { usdc: grant.initial_reference.usdc, wnear: grant.initial_reference.wnear },
    decimals: DECIMALS,
    balances: await balances(world, world.mandate.id),
    notes,
  });
}

export const recordingFile = (variant: PromptVariant): string => join(REPO_ROOT, "fixtures/model", `${variant}.json`);

/** Loads a recording with all hash checks, or explains why it is unavailable. */
export function tryLoadRecording(variant: PromptVariant): { ok: true; recording: LoadedRecording } | { ok: false; reason: string } {
  const path = recordingFile(variant);
  if (!existsSync(path)) return { ok: false, reason: `fixtures/model/${variant}.json does not exist (no genuine model interaction recorded)` };
  try {
    return { ok: true, recording: loadRecording(REPO_ROOT, path) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Collects receipts, assertions and step timings for an evidence record. */
export class Recorder {
  readonly receipts: Receipt[] = [];
  readonly assertions: Assertion[] = [];
  /** Step start offsets from the recorder's creation. */
  readonly steps: { step: string; started_ms: number; first_receipt: number; first_assertion: number }[] = [];
  private readonly start = Date.now();

  receipt(outcome: Outcome, detail: Record<string, unknown> = {}): Outcome {
    this.receipts.push(toEvidenceReceipt(outcome, detail));
    return outcome;
  }

  check(id: string, gate: string, description: string, passed: boolean, observed: unknown): boolean {
    this.assertions.push({ id, gate, description, passed, observed });
    console.log(`  ${passed ? "ok  " : "FAIL"} [${gate}] ${description}`);
    return passed;
  }

  step(name: string): void {
    this.steps.push({ step: name, started_ms: Date.now() - this.start, first_receipt: this.receipts.length, first_assertion: this.assertions.length });
    console.log(`\n== ${name}`);
  }
}
