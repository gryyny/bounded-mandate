// No-transaction provider rehearsal. From given chain observations, the runner's sale budget and the approved
// (planned) inventory, it builds the live snapshot and prompt, makes at most one provider call and validates the
// reply exactly as the live runner does, then writes an integrity-checked record. It never builds, signs or sends
// a transaction: this module and everything it imports have no chain client, signer or key (asserted by
// tools/test/agent-rehearsal.test.ts).
//
// Before the first grant exists (provider qualification precedes the run that creates it), a rehearsal decides on
// the PLANNED grant: the approved policy and inventory at the observed prices (objective.plannedObservations). The
// record labels that basis and never presents the planned grant as a chain reading.
//
// A rehearsal qualifies a live provider only when an approved real (paid) call from the requested model produced a
// final decision the live runner would act on: an accepted proposal whose pre-signing checks pass, or a decline.
// Stub rehearsals exercise the code path only.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Asset } from "../types.js";
import { AdapterVerdict, sha256Hex } from "./decision.js";
import {
  Allocation,
  FreshObservations,
  PlannedGrant,
  RebalanceVerdict,
  assess,
  callModel,
  inputsFrom,
  judgeCall,
  objectiveProblems,
  plannedObservations,
  priceMarginProblems,
  type CallResult,
  type RebalanceInputs,
} from "./objective.js";
import { buildPrompt, type BuiltPrompt } from "./prompt.js";
import type { LiveModelCall, LiveModelProvider } from "./providers.js";
import { MarketSnapshot, SaleBudget } from "./snapshot.js";

export const REHEARSAL_SCHEMA = "bounded-mandate/agent-rehearsal/1";
const ASSETS = ["usdc", "wnear"] as const;
const Units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SignedUnits = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const PerAssetUnits = z.object({ usdc: Units, wnear: Units }).strict();
const Decimals = z.object({ usdc: z.number().int(), wnear: z.number().int() }).strict();

/** Everything a rehearsal decides from. Observed state comes from the chain; planned inventory from the approval. */
export const RehearsalInput = z
  .object({
    observations: FreshObservations,
    decimals: Decimals,
    notes: z.array(z.string()),
    sale_budget: SaleBudget.nullable(),
    /** Where the sale budget came from (runner ledger, manifest caps with nothing sold, test). */
    sale_budget_source: z.string().min(1),
    /** The inventory the owner approved for the mandate (manifest/approval), not a chain reading. */
    planned_inventory: z.object({ source: z.string().min(1), units: PerAssetUnits }).strict(),
    /** The grant the owner plans to make; only when no grant exists on chain (observations.grant is null). */
    planned_grant: PlannedGrant.nullable().optional(),
    /** sha256 of the manifest the budget, planned inventory and planned grant came from (and the state was observed for). */
    manifest_sha256: Sha256.nullable().optional(),
  })
  .strict();
export type RehearsalInput = z.infer<typeof RehearsalInput>;

export type ProviderClass = "stub" | "real";

export interface RehearsalProvider {
  provider: LiveModelProvider;
  /** "real" only for a provider that sends a paid request to the actual service; anything else is "stub". */
  class: ProviderClass;
  requested_model: string;
}

export interface PaidInferenceApproval {
  approved: boolean;
  /** Who approved the paid call and where (required when approved). */
  reference: string | null;
}

export const NO_APPROVAL: PaidInferenceApproval = { approved: false, reference: null };

export class RehearsalRefusal extends Error {}

const PromptRecord = z.object({ version: z.string(), system: z.string(), user: z.string(), sha256: Sha256 }).strict();

const PLANNED_NOTE =
  "No grant exists on chain. The decision used the PLANNED grant: the approved policy and planned inventory at the observed prices (reference = those prices, initial value = planned inventory valued at them, rounded down). The contract computes the real reference and value when the grant is made.";

/** What the decision's grant and balances came from. */
const GrantBasis = z.discriminatedUnion("kind", [
  /** The grant and mandate balances in the observations (chain readings). */
  z.object({ kind: z.literal("observed") }).strict(),
  z.object({ kind: z.literal("planned"), on_chain: z.literal(false), grant: PlannedGrant, decision_balances: z.literal("planned inventory"), note: z.literal(PLANNED_NOTE) }).strict(),
]);
type GrantBasis = z.infer<typeof GrantBasis>;

const RecordBody = z
  .object({
    schema: z.literal(REHEARSAL_SCHEMA),
    kind: z.literal("agent-rehearsal"),
    /** A rehearsal never builds, signs or sends a transaction. */
    transaction: z.literal("none"),
    provider: z
      .object({
        name: z.string(),
        class: z.enum(["stub", "real"]),
        requested_model: z.string(),
        /** Model id the provider reported, or null when it produced nothing. */
        reported_model: z.string().nullable(),
        harness_note: z.string().nullable(),
      })
      .strict(),
    // Declared by the operator on the command line; the record cannot prove it. Check the reference against the approval package.
    paid_inference_approval: z.object({ approved: z.boolean(), reference: z.string().nullable(), basis: z.literal("operator-declared") }).strict(),
    qualifies_live_provider: z.boolean(),
    qualification: z.string(),
    grant_basis: GrantBasis,
    manifest_sha256: Sha256.nullable(),
    timing: z.object({ started_at: z.string(), finished_at: z.string(), duration_ms: z.number() }).strict(),
    inventory: z
      .object({
        planned: z.object({ source: z.string(), units: PerAssetUnits }).strict(),
        observed: z
          .object({ source: z.string(), block: z.object({ height: z.number().int(), hash: z.string() }).strict(), units: PerAssetUnits })
          .strict(),
        observed_minus_planned: z.object({ usdc: SignedUnits, wnear: SignedUnits }).strict(),
      })
      .strict(),
    sale_budget: SaleBudget.nullable(),
    sale_budget_source: z.string(),
    observations: FreshObservations,
    decimals: Decimals,
    notes: z.array(z.string()),
    allocation: Allocation.nullable(),
    model_called: z.boolean(),
    snapshot: MarketSnapshot.nullable(),
    prompt: PromptRecord.nullable(),
    request_body_sha256: Sha256.nullable(),
    raw_output: z.string().nullable(),
    raw_output_sha256: Sha256.nullable(),
    decision_text: z.string().nullable(),
    provider_error: z.string().nullable(),
    adapter_verdict: AdapterVerdict.nullable(),
    verdict: RebalanceVerdict,
    /**
     * The live pre-signing checks (price age margin, objective and budgets) on the same observations. Live
     * re-reads chain state immediately before signing; a rehearsal has no later reading.
     */
    pre_signing_check: z.object({ observations: z.literal("same as decision"), problems: z.array(z.string()) }).strict().nullable(),
  })
  .strict();
type RecordBody = z.infer<typeof RecordBody>;

export const RehearsalRecord = RecordBody.extend({
  /** sha256 over the canonical JSON (sorted keys, no whitespace) of every other field. */
  integrity: z.object({ algorithm: z.literal("sha256/canonical-json"), sha256: Sha256 }).strict(),
}).strict();
export type RehearsalRecord = z.infer<typeof RehearsalRecord>;

/** Canonical JSON: object keys sorted, no whitespace, `undefined` fields dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const seal = (body: RecordBody): RehearsalRecord => ({ ...body, integrity: { algorithm: "sha256/canonical-json", sha256: sha256Hex(canonicalJson(body)) } });

/** The record fields qualification depends on; the writer and the verifier both decide from these alone. */
interface QualificationFacts {
  provider: Pick<RecordBody["provider"], "class" | "requested_model" | "reported_model">;
  approval: PaidInferenceApproval;
  model_called: boolean;
  provider_error: string | null;
  adapter: AdapterVerdict | null;
  verdict: RebalanceVerdict;
  pre_signing_check: RecordBody["pre_signing_check"];
  basis: GrantBasis["kind"];
}

/**
 * Qualifies only an approved real call from the requested model whose final decision the live runner would act
 * on: an accepted proposal with every pre-signing check passing, or a decline. A schema-valid answer that the
 * objective, budget or pre-signing checks reject does not qualify.
 */
export function qualification(f: QualificationFacts): { qualifies: boolean; why: string } {
  const no = (why: string) => ({ qualifies: false, why });
  if (f.provider.class === "stub") return no("STUB provider: exercises the rehearsal path only; it is not model output and does not qualify a live provider");
  if (!f.approval.approved) return no("real provider without paid-inference approval");
  if (!f.model_called) return no("no provider call was made (inputs unusable or allocation within the band)");
  if (f.provider_error !== null || f.provider.reported_model === null) return no(`the approved real call failed: ${f.provider_error ?? "no result"}`);
  if (f.provider.reported_model !== f.provider.requested_model) return no(`the provider reported model ${f.provider.reported_model}, requested ${f.provider.requested_model}`);
  if (f.adapter === null || f.adapter.kind === "rejected") return no("the approved real call answered, but not with a schema-valid decision");
  const basis = f.basis === "planned" ? " on the planned grant (not on chain)" : "";
  const by = `approved real call (${f.approval.reference ?? ""}) from the requested model${basis}`;
  if (f.verdict.kind === "no-action" && f.verdict.reason === "model-declined") return { qualifies: true, why: `${by} declined; a decline is a legitimate final decision` };
  if (f.verdict.kind === "rejected") return no(`the approved real call answered with a schema-valid ${f.adapter.kind}, but the final decision was rejected at the ${f.verdict.boundary} boundary: ${f.verdict.problems.join("; ")}`);
  if (f.verdict.kind !== "proposal") return no(`unexpected final decision ${f.verdict.kind}`);
  const pre = f.pre_signing_check?.problems ?? ["no pre-signing check was recorded"];
  if (pre.length > 0) return no(`the approved real call's proposal was accepted, but the pre-signing checks failed: ${pre.join("; ")}`);
  return { qualifies: true, why: `${by} produced an accepted proposal whose pre-signing checks pass` };
}

const basisOf = (input: { planned_grant?: PlannedGrant | null | undefined }): GrantBasis =>
  input.planned_grant === undefined || input.planned_grant === null
    ? { kind: "observed" }
    : { kind: "planned", on_chain: false, grant: input.planned_grant, decision_balances: "planned inventory", note: PLANNED_NOTE };

/** The observations the decision uses: the chain readings, or the planned grant and inventory at those prices. */
function decisionObservations(obs: FreshObservations, basis: GrantBasis, decimals: Record<Asset, number>, planned: Record<Asset, string>): FreshObservations {
  return basis.kind === "planned" ? plannedObservations(obs, basis.grant, decimals, planned) : obs;
}

const preSigningProblems = (obs: FreshObservations, inputs: RebalanceInputs, alloc: Allocation, verdict: RebalanceVerdict): RecordBody["pre_signing_check"] =>
  verdict.kind === "proposal"
    ? { observations: "same as decision", problems: [...priceMarginProblems(obs, inputs.grant.policy), ...objectiveProblems(inputs, alloc, verdict.proposal)] }
    : null;

/**
 * One rehearsal. A real provider refuses to run without paid-inference approval, before any request. At most one
 * provider call; failures are recorded, never retried. Returns the sealed record; nothing is sent to any chain.
 */
export async function rehearse(rawInput: RehearsalInput, rp: RehearsalProvider, approval: PaidInferenceApproval = NO_APPROVAL): Promise<RehearsalRecord> {
  if (rp.class === "real" && !approval.approved) {
    throw new RehearsalRefusal("rehearsal: a real provider call is paid inference and needs explicit owner approval (--approve-paid-inference with --approval-reference); nothing was sent");
  }
  if (approval.approved && (approval.reference === null || approval.reference.trim() === "")) throw new RehearsalRefusal("rehearsal: an approval needs a reference");
  const input = RehearsalInput.parse(rawInput);
  const obs = input.observations;
  if (input.planned_grant !== undefined && input.planned_grant !== null && obs.grant !== null) {
    throw new RehearsalRefusal(`rehearsal: a grant exists on chain (epoch ${String(obs.grant.epoch)}); rehearse against it, not against a planned grant`);
  }
  const basis = basisOf(input);
  const started = new Date();
  const usable = inputsFrom(decisionObservations(obs, basis, input.decimals, input.planned_inventory.units), input.decimals, input.sale_budget);
  let allocation: Allocation | null = null;
  let snapshot: MarketSnapshot | null = null;
  let prompt: BuiltPrompt | null = null;
  let requestBody: string | null = null;
  let result: CallResult | null = null;
  let adapter: AdapterVerdict | null = null;
  let verdict: RebalanceVerdict;
  let preSigning: RecordBody["pre_signing_check"] = null;
  if (!usable.ok) verdict = { kind: "rejected", boundary: "inputs", problems: usable.problems };
  else {
    const a = assess(usable.inputs, input.notes);
    allocation = a.allocation;
    if (a.kind === "balanced") verdict = a.verdict;
    else {
      snapshot = a.snapshot;
      prompt = a.prompt;
      requestBody = rp.provider.requestBody?.(a.prompt) ?? null;
      result = await callModel(rp.provider, a.prompt);
      const judged = judgeCall(usable.inputs, a.allocation, result);
      adapter = judged.adapter;
      verdict = judged.verdict;
      preSigning = preSigningProblems(obs, usable.inputs, a.allocation, verdict);
    }
  }
  const finished = new Date();
  const startedAt = result?.started_at ?? started.toISOString();
  const finishedAt = result?.finished_at ?? finished.toISOString();
  const call = result?.call ?? null;
  const q = qualification({
    provider: { class: rp.class, requested_model: rp.requested_model, reported_model: call?.model ?? null },
    approval,
    model_called: result !== null,
    provider_error: result?.error ?? null,
    adapter,
    verdict,
    pre_signing_check: preSigning,
    basis: basis.kind,
  });
  const observed = { usdc: obs.balances.usdc, wnear: obs.balances.wnear };
  const diff = (a: Asset) => (BigInt(observed[a]) - BigInt(input.planned_inventory.units[a])).toString();
  return seal({
    schema: REHEARSAL_SCHEMA,
    kind: "agent-rehearsal",
    transaction: "none",
    provider: { name: call?.provider ?? rp.provider.name, class: rp.class, requested_model: rp.requested_model, reported_model: call?.model ?? null, harness_note: call?.harness_note ?? null },
    paid_inference_approval: { approved: approval.approved, reference: approval.reference, basis: "operator-declared" },
    qualifies_live_provider: q.qualifies,
    qualification: q.why,
    grant_basis: basis,
    manifest_sha256: input.manifest_sha256 ?? null,
    timing: { started_at: startedAt, finished_at: finishedAt, duration_ms: Date.parse(finishedAt) - Date.parse(startedAt) },
    inventory: {
      planned: input.planned_inventory,
      observed: { source: "mandate verifier balances as given in the input state file (not read from chain by the rehearsal)", block: { height: obs.block.height, hash: obs.block.hash }, units: observed },
      observed_minus_planned: { usdc: diff("usdc"), wnear: diff("wnear") },
    },
    sale_budget: input.sale_budget,
    sale_budget_source: input.sale_budget_source,
    observations: obs,
    decimals: input.decimals,
    notes: input.notes,
    allocation,
    model_called: result !== null,
    snapshot,
    prompt,
    request_body_sha256: requestBody === null ? null : sha256Hex(requestBody),
    raw_output: call?.raw_output ?? null,
    raw_output_sha256: call === null ? null : sha256Hex(call.raw_output),
    decision_text: call?.decision_text ?? null,
    provider_error: result?.error ?? null,
    adapter_verdict: adapter,
    verdict,
    pre_signing_check: preSigning,
  });
}

/**
 * Parses and verifies a rehearsal record: schema, integrity hash, raw output hash, inventory arithmetic, and that
 * the stored snapshot, prompt and verdicts are exactly what this code derives from the stored inputs and reply.
 */
export function verifyRehearsal(text: string): RehearsalRecord {
  const rec = RehearsalRecord.parse(JSON.parse(text));
  const { integrity, ...body } = rec;
  const actual = sha256Hex(canonicalJson(body));
  if (actual !== integrity.sha256) throw new Error(`rehearsal record: integrity sha256 ${actual} != recorded ${integrity.sha256}`);
  if (rec.raw_output !== null && sha256Hex(rec.raw_output) !== rec.raw_output_sha256) throw new Error("rehearsal record: raw output hash mismatch");
  for (const a of ASSETS) {
    if (rec.inventory.observed.units[a] !== rec.observations.balances[a]) throw new Error(`rehearsal record: observed ${a} inventory is not the observed balance`);
    if ((BigInt(rec.inventory.observed.units[a]) - BigInt(rec.inventory.planned.units[a])).toString() !== rec.inventory.observed_minus_planned[a]) {
      throw new Error(`rehearsal record: ${a} observed-minus-planned does not match`);
    }
  }
  if (rec.qualifies_live_provider && !(rec.provider.class === "real" && rec.paid_inference_approval.approved)) {
    throw new Error("rehearsal record: only an approved real call can qualify a live provider");
  }
  if (rec.grant_basis.kind === "planned" && rec.observations.grant !== null) throw new Error("rehearsal record: a planned grant is recorded although a grant exists on chain");
  const q = qualification({
    provider: rec.provider,
    approval: rec.paid_inference_approval,
    model_called: rec.model_called,
    provider_error: rec.provider_error,
    adapter: rec.adapter_verdict,
    verdict: rec.verdict,
    pre_signing_check: rec.pre_signing_check,
    basis: rec.grant_basis.kind,
  });
  if (q.qualifies !== rec.qualifies_live_provider || q.why !== rec.qualification) {
    throw new Error(`rehearsal record: the qualification claim does not follow from the recorded decision (${q.why})`);
  }
  const usable = inputsFrom(decisionObservations(rec.observations, rec.grant_basis, rec.decimals, rec.inventory.planned.units), rec.decimals, rec.sale_budget);
  if (!usable.ok) {
    if (rec.model_called) throw new Error("rehearsal record: model called on unusable inputs");
    return rec;
  }
  const a = assess(usable.inputs, rec.notes);
  if (canonicalJson(a.allocation) !== canonicalJson(rec.allocation)) throw new Error("rehearsal record: stored allocation differs from the one derived from its inputs");
  if (a.kind === "balanced") {
    if (rec.model_called) throw new Error("rehearsal record: model called on a balanced allocation");
    return rec;
  }
  if (rec.prompt === null || canonicalJson(a.snapshot) !== canonicalJson(rec.snapshot) || a.prompt.sha256 !== rec.prompt.sha256 || canonicalJson(buildPrompt(a.snapshot)) !== canonicalJson(rec.prompt)) {
    throw new Error("rehearsal record: stored snapshot or prompt differs from the one built from its inputs");
  }
  const call: LiveModelCall | null =
    rec.raw_output === null
      ? null
      : {
          provider: "recorded",
          requested_model: rec.provider.requested_model,
          model: rec.provider.reported_model ?? "unknown",
          started_at: rec.timing.started_at,
          finished_at: rec.timing.finished_at,
          raw_output: rec.raw_output,
          decision_text: rec.decision_text,
          harness_note: "rehearsal verification",
        };
  const judged = judgeCall(usable.inputs, a.allocation, { call, error: rec.provider_error, started_at: rec.timing.started_at, finished_at: rec.timing.finished_at });
  if (canonicalJson(judged.verdict) !== canonicalJson(rec.verdict) || canonicalJson(judged.adapter) !== canonicalJson(rec.adapter_verdict)) {
    throw new Error("rehearsal record: stored verdict differs from the verdict derived from its reply");
  }
  if (canonicalJson(preSigningProblems(rec.observations, usable.inputs, a.allocation, judged.verdict)) !== canonicalJson(rec.pre_signing_check)) {
    throw new Error("rehearsal record: stored pre-signing check differs from the one derived from its inputs");
  }
  return rec;
}

/** Writes a new record (never overwrites); the file name carries the integrity hash prefix. */
export function writeRehearsal(dir: string, rec: RehearsalRecord): { path: string; file_sha256: string } {
  const text = `${JSON.stringify(rec, null, 2)}\n`;
  const path = join(dir, `rehearsal-${rec.integrity.sha256.slice(0, 16)}.json`);
  writeFileSync(path, text, { flag: "wx" });
  return { path, file_sha256: sha256Hex(text) };
}

/** A fixed SYNTHETIC answer; never model output. Default: decline. */
export class StubProvider implements LiveModelProvider {
  readonly name = "synthetic" as const;
  calls = 0;
  constructor(
    private readonly answer: string = JSON.stringify({ action: "decline", proposal: null, reason: "STUB rehearsal provider" }),
    readonly model = "synthetic-stub",
  ) {}

  decide(): Promise<LiveModelCall> {
    this.calls += 1;
    const at = new Date().toISOString();
    return Promise.resolve({
      provider: this.name,
      requested_model: this.model,
      model: this.model,
      started_at: at,
      finished_at: at,
      raw_output: this.answer,
      decision_text: this.answer,
      harness_note: "SYNTHETIC stub provider; not model output",
    });
  }
}
