// Building blocks of the sandbox story shared by `make demo` and the sandbox tests.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSnapshot, type MarketSnapshot } from "../agent/snapshot.js";
import { loadRecording, type LoadedRecording, type PromptVariant } from "../agent/recording.js";
import type { DemoStep, StepState } from "../evidence/journey.js";
import { toEvidenceReceipt, type Outcome } from "../near/client.js";
import { OPEN_ORDER_STATES } from "../near/contracts.js";
import { REPO_ROOT, requireSuccess } from "../near/sandbox.js";
import type { Assertion, Receipt } from "../types.js";
import { DECIMALS, DEMO_POLICY } from "./market.js";
import { balances, postPrices, type World } from "./world.js";
import { ftBalance } from "./withdraw.js";

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

/** Chain state through views only: grant status, key registration, open orders and both sides' balances. */
export async function journeyState(world: World): Promise<StepState> {
  const grant = await world.mandate.grant();
  const orders = await world.mandate.allOrders();
  const pair = (b: Record<"usdc" | "wnear", bigint>) => ({ usdc: b.usdc.toString(), wnear: b.wnear.toString() });
  return {
    grant_status: grant?.status ?? "none",
    grant_epoch: grant?.epoch ?? null,
    key_present: grant?.public_key == null ? null : await world.verifier.hasPublicKey(world.mandate.id, grant.public_key),
    open_orders: orders.filter((o) => OPEN_ORDER_STATES.includes(o.state.state)).length,
    mandate: pair(await balances(world, world.mandate.id)),
    owner_intents: pair(await balances(world, world.owner.id)),
    owner_near: { usdc: (await ftBalance(world, "usdc", world.owner.id)).toString(), wnear: (await ftBalance(world, "wnear", world.owner.id)).toString() },
    block_time_ns: (await world.client.blockTimestampNs()).toString(),
  };
}

/** Collects receipts, assertions, step timings and, when given a probe, the chain state at the end of each step. */
export class Recorder {
  readonly receipts: Receipt[] = [];
  readonly assertions: Assertion[] = [];
  /** Step start offsets from the recorder's creation, and the state after the step. */
  readonly steps: DemoStep[] = [];
  private readonly start = Date.now();

  constructor(private readonly probe?: () => Promise<StepState>) {}

  receipt(outcome: Outcome, detail: Record<string, unknown> = {}): Outcome {
    this.receipts.push(toEvidenceReceipt(outcome, detail));
    return outcome;
  }

  check(id: string, gate: string, description: string, passed: boolean, observed: unknown): boolean {
    this.assertions.push({ id, gate, description, passed, observed });
    console.log(`  ${passed ? "ok  " : "FAIL"} [${gate}] ${description}`);
    return passed;
  }

  /** Closes the previous step (recording its end state) and opens the next. */
  async step(name: string): Promise<void> {
    await this.close();
    this.steps.push({ step: name, started_ms: Date.now() - this.start, first_receipt: this.receipts.length, first_assertion: this.assertions.length });
    console.log(`\n== ${name}`);
  }

  /** Records the end state of the open step, once. */
  async close(): Promise<void> {
    const open = this.steps.at(-1);
    if (open !== undefined && open.state === undefined && this.probe !== undefined) open.state = await this.probe();
  }
}
