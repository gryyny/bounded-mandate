// Exported lab scenarios: what a session did, bound to the source revision and the exact binaries it ran, in a form
// that a fresh sandbox can repeat. Outcomes are stored normalized: values that legitimately differ between two runs
// (transaction and receipt ids, block positions, timestamps, nonces, keys and signatures, the session's account
// scope) are removed or replaced, and everything else must be equal for a replay to match.
import { z } from "zod";
import { treeState } from "../evidence/report.js";
import { LAB_LABEL, TEST_DOUBLES } from "./config.js";
import { ACTIONS, InputError, runAction, type ActionName, type ActionRecord, type TxView } from "./actions.js";
import { labState, type LabState, type LabWorld, type WorldWasm } from "./world.js";

export const SCENARIO_SCHEMA = "bounded-mandate/lab-scenario/1";
export const REPLAY_COMMAND = "cd tools && npx tsx src/lab/replay.ts <scenario.json>";

/** Keys whose values differ between two honest runs of the same scenario. */
const VOLATILE_KEY = /(^|_)(hash|ns|ms|nonce|signature|logs)$|^(receipt_id|public_key|signing_public_key|payload|publish_time|publish_time_sec|block_height)$/;
const KEY_TEXT = /ed25519:[1-9A-HJ-NP-Za-km-z]{32,}/g;

/** Removes volatile fields and rewrites the session scope and public keys inside strings and object keys. */
export function normalize(value: unknown, scope: string): unknown {
  const text = (s: string): string => s.replaceAll(scope, "<session>").replace(KEY_TEXT, "<key>");
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((v) => normalize(v, scope));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !VOLATILE_KEY.test(k))
      .map(([k, v]) => [text(k), normalize(v, scope)]),
  );
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const WasmEntry = z.object({ path: z.string(), sha256: Sha256 });

export const Scenario = z.object({
  schema: z.literal(SCENARIO_SCHEMA),
  label: z.string(),
  exported_at: z.string(),
  replay_command: z.string(),
  /** The lab's source: git revision and whether the tree had uncommitted changes. */
  source: z.object({ revision: z.string(), dirty: z.boolean() }),
  sandbox: z.object({ neard: z.string() }),
  /** Every binary the session's world deployed. */
  wasm: z.object({ mandate: WasmEntry, verifier: WasmEntry, ft: WasmEntry, oracle: WasmEntry, mpc: WasmEntry }),
  test_doubles: z.array(z.object({ role: z.string(), contract: z.string(), path: z.string(), sha256: Sha256, note: z.string() })),
  normalization: z.string(),
  starting_state: z.unknown(),
  actions: z.array(z.object({ seq: z.number().int(), at_ms: z.number().int().nonnegative(), action: z.enum(ACTIONS as [ActionName, ...ActionName[]]), input: z.unknown(), outcome: z.unknown() })),
});
export type Scenario = z.infer<typeof Scenario>;

export interface SourceRevision {
  revision: string;
  dirty: boolean;
}

/** The checkout's revision, or the revision a deployment without a checkout declares for itself. */
export function sourceRevision(root: string, declared: string | undefined): SourceRevision {
  const tree = treeState(root);
  if (tree.revision !== null) return { revision: tree.revision, dirty: tree.dirty };
  return declared === undefined || declared === "" ? { revision: "unknown", dirty: true } : { revision: `${declared} (declared by the deployment, no checkout)`, dirty: false };
}

/** A gas refund reaches the signer after the node has answered, so a response holds it only sometimes. */
const withoutRefunds = (t: TxView): TxView => ({ ...t, receipts: t.receipts.filter((r, i) => i === 0 || r.executor_id !== t.signer_id || !r.success || r.logs.length > 0) });

export const outcomeOf = (record: Pick<ActionRecord, "transactions" | "result" | "state">, scope: string): unknown =>
  normalize({ transactions: record.transactions.map(withoutRefunds), result: record.result, state: record.state }, scope);

export function exportScenario(o: { scope: string; neard: string; source: SourceRevision; wasm: WorldWasm; startingState: LabState; log: readonly ActionRecord[] }): Scenario {
  const entry = (w: { path: string; sha256: string }) => ({ path: w.path, sha256: w.sha256 });
  return {
    schema: SCENARIO_SCHEMA,
    label: LAB_LABEL,
    exported_at: new Date().toISOString(),
    replay_command: REPLAY_COMMAND,
    source: o.source,
    sandbox: { neard: o.neard },
    wasm: { mandate: entry(o.wasm.mandate), verifier: entry(o.wasm.verifier), ft: entry(o.wasm.ft), oracle: entry(o.wasm.oracle), mpc: entry(o.wasm.mpc) },
    test_doubles: TEST_DOUBLES.map((d) => ({ role: d.role, contract: d.contract, path: o.wasm[d.wasm].path, sha256: o.wasm[d.wasm].sha256, note: d.note })),
    normalization:
      "Outcomes omit transaction and receipt ids, block positions, timestamps, nonces, keys, signatures, logs and gas-refund receipts; the session's account scope reads <session> and public keys read <key>.",
    starting_state: normalize(o.startingState, o.scope),
    actions: o.log.map((r) => ({ seq: r.seq, at_ms: r.at_ms, action: r.action, input: r.input, outcome: outcomeOf(r, o.scope) })),
  };
}

/** Paths at which two normalized values differ; empty when they are equal. */
export function differences(recorded: unknown, replayed: unknown, path = "$"): string[] {
  if (Array.isArray(recorded) && Array.isArray(replayed)) {
    const out = recorded.length === replayed.length ? [] : [`${path}: ${recorded.length} items recorded, ${replayed.length} replayed`];
    return [...out, ...recorded.flatMap((v, i) => (i < replayed.length ? differences(v, replayed[i], `${path}[${i}]`) : []))];
  }
  if (typeof recorded === "object" && recorded !== null && typeof replayed === "object" && replayed !== null && !Array.isArray(recorded) && !Array.isArray(replayed)) {
    const a = recorded as Record<string, unknown>;
    const b = replayed as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => differences(a[k], b[k], `${path}.${k}`));
  }
  const show = (v: unknown): string => (v === undefined ? "absent" : JSON.stringify(v).slice(0, 200));
  return recorded === replayed ? [] : [`${path}: recorded ${show(recorded)}, replayed ${show(replayed)}`];
}

export interface ReplayResult {
  matches: boolean;
  /** Why the replay does not reproduce the scenario; empty when it does. */
  problems: string[];
  /** Differences that do not affect the comparison (another source revision). */
  notes: string[];
  actions: { seq: number; action: ActionName; matches: boolean; differences: string[] }[];
}

export interface ReplayOptions {
  /** The binaries this checkout would deploy; the scenario must name exactly these. */
  wasm: WorldWasm;
  source: SourceRevision;
  /** Builds one fresh world for the replay. */
  world: () => Promise<LabWorld>;
  /**
   * Waits between actions as the recorded session did, so outcomes that depend on a deadline having passed repeat.
   * Without it actions run back to back.
   */
  paced?: boolean;
}

/** Repeats a scenario's actions on a fresh world and compares every normalized outcome. */
export async function replayScenario(scenario: Scenario, o: ReplayOptions): Promise<ReplayResult> {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const [role, recorded] of Object.entries(scenario.wasm)) {
    const mine = o.wasm[role as keyof WorldWasm].sha256;
    if (mine !== recorded.sha256) problems.push(`wasm ${role}: the scenario ran ${recorded.sha256}, this checkout has ${mine}`);
  }
  if (scenario.source.revision !== o.source.revision || scenario.source.dirty || o.source.dirty) {
    notes.push(`source: the scenario was exported at ${scenario.source.revision}${scenario.source.dirty ? " (dirty)" : ""}, this replay runs ${o.source.revision}${o.source.dirty ? " (dirty)" : ""}`);
  }
  if (problems.length > 0) return { matches: false, problems, notes, actions: [] };

  const lw = await o.world();
  const start = differences(scenario.starting_state, normalize(await labState(lw), lw.scope), "$.starting_state");
  problems.push(...start);
  const actions: ReplayResult["actions"] = [];
  const began = Date.now();
  const first = scenario.actions[0]?.at_ms ?? 0;
  for (const step of scenario.actions) {
    if (o.paced === true) {
      const wait = step.at_ms - first - (Date.now() - began);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const record = await runAction(lw, step.seq, step.action, step.input);
      const diff = differences(step.outcome, outcomeOf(record, lw.scope));
      actions.push({ seq: step.seq, action: step.action, matches: diff.length === 0, differences: diff });
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      actions.push({ seq: step.seq, action: step.action, matches: false, differences: [`the recorded input is not a valid ${step.action} input: ${error.message}`] });
    }
  }
  for (const a of actions) problems.push(...a.differences.map((d) => `action ${a.seq} (${a.action}): ${d}`));
  return { matches: problems.length === 0, problems, notes, actions };
}
