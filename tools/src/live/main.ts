// `MANDATE_LIVE=1 make live`: executes an approved manifest against a configured RPC.
// - Preflight binds network, code, config, keys and balances to the manifest; any mismatch refuses (exit 2).
// - Every transaction is written to a hash-chained ledger before it is sent; budget is derived from it.
// - Each step ends with an operation-specific terminal check over chain state and the whole receipt tree.
// - An ambiguous outcome stops the run (exit 1). Nothing is ever resubmitted or substituted; a resume
//   (MANDATE_LIVE_RESUME=1) first reconciles the ledger with chain state.
// - A model-sourced propose step is a recorded agent decision (decision-request before the model call, decision
//   after it). A recorded decision is never re-asked; a request without a result stops unless
//   MANDATE_LIVE_ALLOW_NEW_DECISION=1. Inputs are re-read and re-checked immediately before signing. A no-action
//   sends nothing; the mandate refusing a model proposal is a finding, not a stop. Either way the step makes no
//   order, and fill/settle/withhold of that step are skipped.
// - An external owner step (revoke_external, recover_external, withdraw_external) persists an intent (external.ts)
//   before the owner signs it outside the runner, then imports the signed transaction by hash: chain, signer, approved
//   key, receiver, every action and argument, bounds, the key's nonce, the final receipt tree and the step's end state.
//   Unrelated, altered or duplicate handoffs are refused and recorded as refused; nothing is ever submitted for the
//   owner. A handoff comes from LiveDeps.handoff, MANDATE_LIVE_HANDOFF=<file> or <ledger>/external/<stem>.handoff.json.
// - A transaction the ledger does not record stops the run, never absorbed: before every runner-signed transaction and
//   every import the signing key's chain nonce must equal the ledger's expectation (the transaction's must be the next),
//   and the owner account's complete access-key list must still match the start snapshot (manifest
//   expected_owner_keys, else preflight): no key added or removed, no key the ledger does not track used. Resumes check
//   the same. A refused handoff whose transaction is found on chain records its fee, charged once if the owner paid.
// - Owner withdrawals (withdraw, withdraw_external) run after recovery, outside recovery claims; a refunded or failed
//   attempt leaves the Intents balance intact and is retried on resume, the other asset is neither blocked nor repeated.
// The flag is not spending approval; mainnet additionally needs MANDATE_LIVE_CONFIRM=<manifest sha256>.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { actions, type Account, type Action } from "near-api-js";
import { z } from "zod";
import { toRecording, writeRecording } from "../agent/live-recording.js";
import { NearAiProvider, type LiveModelProvider } from "../agent/providers.js";
import {
  PRICE_MARGIN_EXTRA_SEC,
  RebalanceVerdict,
  allocation,
  assess,
  callModel,
  inputsFrom,
  judgeCall,
  objectiveProblems,
  priceMarginProblems,
  readObservations,
  type FreshObservations,
} from "../agent/rebalance.js";
import { environment, sourceBinding } from "../evidence/source.js";
import { payableFor } from "../filler/arithmetic.js";
import { Filler, mandateLeg } from "../filler/filler.js";
import { remainingSaleBudget } from "../agent/snapshot.js";
import { NearClient, TGAS, plannedDeposit, toEvidenceReceipt, type Outcome } from "../near/client.js";
import { MandateClient, VerifierClient, tokenId } from "../near/contracts.js";
import { loadCredential, type Credential } from "../near/credentials.js";
import { REPO_ROOT } from "../near/sandbox.js";
import { Evidence, GrantView, OrderView, SignedNep413, type Asset, type Assertion, type Proposal, type Receipt } from "../types.js";
import { BudgetExceeded, checkActual, checkPlanned, sellProblem, totals, type Planned } from "./budget.js";
import { EXTERNAL_HANDOFF_SCHEMA, EXTERNAL_INTENT_SCHEMA, ExternalHandoff, ExternalIntent, intentSha256, intentStem, transactionProblems, type ExternalKind } from "./external.js";
import { Ledger, canonical, type LedgerEntry } from "./ledger.js";
import { OwnerKey, Refusal, externalOwnerKey, loadManifest, type LiveManifest, type ModelSource, type Step } from "./manifest.js";
import { credentialProblems } from "./network.js";
import { STEP_SIGNER, ownerKeyChanges, ownerKeySnapshot, preflight, stepGasTgas, worstFee, type Check } from "./preflight.js";
import {
  balancesOf,
  classifyRelay,
  verifyFill,
  verifyGrant,
  verifyPropose,
  verifyReconcile,
  verifyRecover,
  verifyRefusedProposal,
  verifyRevoke,
  verifySettle,
  simulationProblem,
  tokenOf,
  verifyStorage,
  verifyWithdraw,
  type Balances,
  type Verification,
  type VerifyContext,
} from "./verify.js";

export { LiveManifest, Refusal, loadManifest } from "./manifest.js";

/** An external owner action the run is waiting for: load `intent_path` in the console, sign, hand back the hash. */
export interface Awaiting {
  step: number;
  kind: ExternalKind;
  attempt: number;
  intent_sha256: string;
  intent_path: string;
  /** Where the runner looks for the handoff record on resume. */
  handoff_path: string;
}

export interface LiveResult {
  /** 0 completed, 1 stopped (failed check, budget, ambiguity, awaiting an owner signature), 2 refused before acting. */
  exitCode: 0 | 1 | 2;
  message: string;
  evidence?: Evidence;
  preflight?: Check[];
  awaiting?: Awaiting;
}

export interface LiveDeps {
  client?: NearClient;
  /** Ledger root; defaults to out/live. */
  outRoot?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Replaces the manifest's model provider for every model-sourced step (tests use labelled synthetic providers). */
  modelProvider?: LiveModelProvider;
  /**
   * Supplies the handoff of an external owner action once its intent is persisted (in-process console or signing
   * adapter); null leaves the run awaiting. The handoff is verified like any other.
   */
  handoff?: (intent: ExternalIntent, files: { intent: string; handoff: string }) => Promise<ExternalHandoff | null>;
  /** How long to poll for the handoff file before stopping as awaiting (default MANDATE_LIVE_HANDOFF_WAIT_SEC or 0). */
  handoffWaitMs?: number;
}

const BalancesJson = z.object({ usdc: z.string(), wnear: z.string() }).strict();
const toBal = (b: z.infer<typeof BalancesJson>): Balances => ({ usdc: BigInt(b.usdc), wnear: BigInt(b.wnear) });
const fromBal = (b: Balances) => ({ usdc: b.usdc.toString(), wnear: b.wnear.toString() });

const ProposalJson = z.object({ sell: z.enum(["usdc", "wnear"]), sell_amount: z.string(), max_concession_bps: z.number().int() }).strict();

/** State captured before a transaction, persisted in its intent so a resume can verify it. */
const Pre = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant"), previous_epoch: z.number().int().nullable() }).strict(),
  z
    .object({
      kind: z.literal("propose"),
      proposal: ProposalJson,
      expect: z.enum(["signed", "rejected"]),
      grant: GrantView,
      /** Present for a live agent proposal: the mandate refusing it is a finding, not a stop. */
      source: z.literal("model").optional(),
      orders_before: z.number().int().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("refused_proposal"), proposal: ProposalJson, error: z.string(), grant: GrantView, orders_before: z.number().int() }).strict(),
  z
    .object({
      kind: z.literal("relay_withheld"),
      order_id: z.string(),
      signing_key: z.string(),
      deadline_ns: z.string(),
      mandate_nonce: z.string(),
      filler_nonce: z.string(),
      bundle_sha256: z.string(),
      mandate_before: BalancesJson,
      filler_before: BalancesJson,
    })
    .strict(),
  z
    .object({
      kind: z.literal("fill"),
      order: OrderView,
      mandate_before: BalancesJson,
      filler_before: BalancesJson,
      filler_delta: BalancesJson,
      mandate_nonce: z.string(),
      filler_nonce: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("settle"), order_id: z.string() }).strict(),
  z.object({ kind: z.literal("revoke"), grant: GrantView }).strict(),
  z.object({ kind: z.literal("reconcile_registration") }).strict(),
  z.object({ kind: z.literal("recover"), asset: z.enum(["usdc", "wnear"]), mandate_before: BalancesJson, owner_before: BalancesJson }).strict(),
  z.object({ kind: z.literal("register_storage"), asset: z.enum(["usdc", "wnear"]), token: z.string(), deposit: z.string() }).strict(),
  z.object({ kind: z.literal("withdraw"), asset: z.enum(["usdc", "wnear"]), amount: z.string(), intents_before: BalancesJson, token_before: z.string() }).strict(),
]);
type Pre = z.infer<typeof Pre>;

/** A withheld order as recorded by the `withhold` step: the exact bundle the relay will submit. */
const Withheld = z
  .object({
    order_id: z.string(),
    /** Key that signed the order (the grant key of its epoch). */
    signing_key: z.string(),
    deadline_ns: z.string(),
    mandate_nonce: z.string(),
    /** null when no bundle could be prepared (recorded as a finding). */
    bundle: z.array(SignedNep413).nullable(),
    bundle_sha256: z.string().nullable(),
    filler_nonce: z.string().nullable(),
    counter: z.record(z.string(), z.string()).nullable(),
    /** simulate_intents accepted the exact bundle before revocation. */
    executable: z.boolean(),
  })
  .strict();
type Withheld = z.infer<typeof Withheld>;

interface Plan {
  signer: Account;
  receiver: string;
  method: string;
  actions: Action[];
  planned: Planned;
  pre: Pre;
  detail: Record<string, unknown>;
  /** Attempt of a retried step (withdrawal, storage registration); absent means 1. */
  attempt?: number;
}

interface Runtime {
  m: LiveManifest;
  client: NearClient;
  mandate: MandateClient;
  verifier: VerifierClient;
  ledger: Ledger;
  ctx: VerifyContext;
  accounts: Record<"owner" | "agent" | "filler", Account>;
  filler: Filler;
  gasPrice: bigint;
  receipts: Receipt[];
  assertions: Assertion[];
  agent: { provider: LiveModelProvider | undefined; allowNewDecision: boolean; env: NodeJS.ProcessEnv };
  external: {
    supply: LiveDeps["handoff"];
    waitMs: number;
    /** Handoffs from MANDATE_LIVE_HANDOFF, keyed by intent sha256, consumed once. */
    supplied: Map<string, ExternalHandoff>;
  };
}

class Stop extends Error {}

/** Stops the run until the owner has signed the persisted intent outside the runner. */
class AwaitingSignature extends Stop {
  constructor(readonly info: Awaiting) {
    super(
      `step ${info.step} ${info.kind}: awaiting the owner's signature of intent ${info.intent_sha256} (${info.intent_path}). Sign it outside the runner, write the handoff to ${info.handoff_path} (or set MANDATE_LIVE_HANDOFF), then rerun with MANDATE_LIVE_RESUME=1.`,
    );
  }
}

/** A relay the runner decided not to broadcast: recorded as inconclusive, and the run continues to recovery. */
class RelaySkipped extends Error {
  constructor(
    message: string,
    readonly observed: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** One timing sample of a deadline-sensitive phase. chain_ns is the final block's timestamp; null when not read. */
export interface Probe {
  phase: string;
  at: string;
  chain_ns: string | null;
  remaining_ms: number | null;
}

async function probe(rt: Runtime, phase: string, deadlineNs: bigint, chain: boolean): Promise<Probe> {
  const at = new Date().toISOString();
  if (!chain) return { phase, at, chain_ns: null, remaining_ms: null };
  const now = await rt.client.blockTimestampNs();
  return { phase, at, chain_ns: now.toString(), remaining_ms: Number((deadlineNs - now) / 1_000_000n) };
}

/** Steps whose transaction is expected to fail; a failed final outcome is verified, not a stop. */
const FAILURE_EXPECTED = new Set<string>(["refused_proposal", "relay_withheld", "withdraw"]);

/** The latest `withhold` record of this run; null if there is none or it was skipped (never an earlier one). */
function latestWithheld(ledger: Ledger): Withheld | null {
  const done = ledger.ofKind("step-done").filter((e) => e.data.kind === "withhold");
  const last = done.at(-1);
  return last === undefined || last.data.skipped === true ? null : Withheld.parse(last.data.withheld);
}

const sha256Of = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

/** Orders created by this run (from propose step-done entries), in order. */
const createdOrders = (ledger: Ledger): string[] =>
  ledger.ofKind("step-done").flatMap((e) => (typeof e.data.order_id === "string" ? [e.data.order_id] : []));

/**
 * Steps that will still send a new transaction: not done, and without an intent that may have executed.
 * An intended step already holds its fee reservation (or actual fee) in the ledger: counting it again
 * would reserve twice.
 */
function pendingSteps(ledger: Ledger, m: LiveManifest): Step[] {
  const from = nextStepIndex(ledger);
  const rejected = new Set<string>();
  for (const e of ledger.entries) if ((e.kind === "tx-result" || e.kind === "reconciled") && e.data.status === "rejected" && typeof e.data.tx_hash === "string") rejected.add(e.data.tx_hash);
  const intended = new Set([...ledger.ofKind("tx-intent").filter((e) => !rejected.has(String(e.data.tx_hash))), ...ledger.ofKind("external-intent")].map((e) => e.data.step));
  return m.steps.filter((_s, i) => i >= from && !intended.has(i));
}

const nextStepIndex = (ledger: Ledger): number => {
  const done = ledger.ofKind("step-done").map((e) => z.number().int().parse(e.data.step));
  return done.length === 0 ? 0 : Math.max(...done) + 1;
};

/**
 * The order a fill/settle/withhold step acts on: its explicit order_id, else the order of the most recent propose
 * step before it, else (no propose step before it) the latest order this run created. `skipped` when that propose
 * step made no order: the step must not act on an earlier one.
 */
function targetOrder(rt: Runtime, i: number, explicit: string | undefined): { order_id: string } | { skipped: string } | null {
  if (explicit !== undefined) return { order_id: explicit };
  const j = rt.m.steps.slice(0, i).map((x) => x.kind).lastIndexOf("propose");
  if (j === -1) {
    const last = createdOrders(rt.ledger).at(-1);
    return last === undefined ? null : { order_id: last };
  }
  const done = rt.ledger.ofKind("step-done").filter((e) => e.data.step === j).at(-1);
  if (done === undefined) return null;
  if (typeof done.data.order_id === "string") return { order_id: done.data.order_id };
  return { skipped: `step ${j + 1} propose made no order (${typeof done.data.reason === "string" ? done.data.reason : "no order id"})` };
}

function orderOf(rt: Runtime, i: number, kind: string, explicit: string | undefined): string {
  const t = targetOrder(rt, i, explicit);
  if (t === null) throw new Stop(`${kind}: no order id`);
  if ("skipped" in t) throw new Stop(`${kind}: ${t.skipped}`);
  return t.order_id;
}

/** Records a step that did not run because its target propose step made no order. Nothing is sent. */
function skipStep(rt: Runtime, i: number, kind: string, reason: string): void {
  const verification = { skipped: true, reason };
  rt.assertions.push({ id: `step-${i + 1}-${kind}`, gate: "LIVE", description: `${kind}: skipped, nothing sent (${reason})`, passed: true, observed: verification });
  rt.ledger.append("step-done", { step: i, kind, skipped: true, reason, verification });
}

function orderAllowed(rt: Runtime, orderId: string): void {
  if (!createdOrders(rt.ledger).includes(orderId) && !rt.m.fillable_preexisting_orders.includes(orderId)) {
    throw new Stop(`order ${orderId} was not created by this run and is not listed in fillable_preexisting_orders; refused`);
  }
}

const fc = (method: string, args: Record<string, unknown>, tgas: number): Action => actions.functionCall(method, args, BigInt(tgas) * TGAS, 0n);

async function proposePlan(rt: Runtime, expect: "signed" | "rejected", proposal: Proposal, detail: Record<string, unknown>, model = false): Promise<Plan> {
  const grant = await rt.mandate.grant();
  if (grant === null) throw new Stop("propose: no grant");
  const fromModel = model ? { source: "model" as const, orders_before: (await rt.mandate.allOrders()).length } : {};
  const a = [fc("propose_order", { proposal }, rt.m.gas_tgas.propose)];
  return {
    signer: rt.accounts.agent,
    receiver: rt.mandate.id,
    method: "propose_order",
    actions: a,
    planned: { worst_fee_yocto: worstFee(rt.m, "propose", rt.gasPrice).toString(), deposit_yocto: plannedDeposit(a).toString(), sell: { asset: proposal.sell, units: proposal.sell_amount } },
    pre: { kind: "propose", proposal, expect, grant, ...fromModel },
    detail,
  };
}

const decimalsOf = (m: LiveManifest) => ({ usdc: m.mandate_config.usdc.decimals, wnear: m.mandate_config.wnear.decimals });

function observe(rt: Runtime): Promise<FreshObservations> {
  const c = rt.m.mandate_config;
  return readObservations(rt.client, {
    mandate: rt.mandate.id,
    verifier: rt.verifier.id,
    oracle: rt.m.accounts.oracle,
    tokens: { usdc: c.usdc.token, wnear: c.wnear.token },
    priceIds: { usdc: c.usdc.price_id, wnear: c.wnear.price_id },
  });
}

function providerFor(rt: Runtime, source: ModelSource): LiveModelProvider {
  return rt.agent.provider ?? NearAiProvider.fromEnv(rt.agent.env, { model: source.model, timeoutMs: source.timeout_ms, maxTokens: source.max_tokens });
}

/**
 * A new agent decision from fresh inputs. The request is persisted before the model is called, the result
 * (exact raw output, verdicts, recording file) after it; balanced or unusable inputs never call the model.
 */
async function newDecision(rt: Runtime, i: number, source: ModelSource, supersedes: number | null): Promise<LedgerEntry> {
  const observations = await observe(rt);
  const decimals = decimalsOf(rt.m);
  const usable = inputsFrom(observations, decimals, remainingSaleBudget(rt.m.budget, totals(rt.ledger).sold));
  const record = (data: Record<string, unknown>) => rt.ledger.append("decision", { step: i, ...data, observations });
  if (!usable.ok) return record({ model_called: false, verdict: { kind: "rejected", boundary: "inputs", problems: usable.problems } });
  const a = assess(usable.inputs, source.notes);
  if (a.kind === "balanced") return record({ model_called: false, verdict: a.verdict, allocation: a.allocation });
  let provider: LiveModelProvider;
  try {
    provider = providerFor(rt, source);
  } catch (error) {
    return record({ model_called: false, verdict: { kind: "rejected", boundary: "provider", problems: [error instanceof Error ? error.message : String(error)] }, allocation: a.allocation });
  }
  const requestBody = provider.requestBody?.(a.prompt) ?? null;
  const request = rt.ledger.append("decision-request", {
    step: i,
    supersedes,
    provider: provider.name,
    requested_model: source.model,
    prompt_version: a.prompt.version,
    prompt_sha256: a.prompt.sha256,
    request_body: requestBody,
    observations,
    allocation: a.allocation,
  });
  const result = await callModel(provider, a.prompt);
  const judged = judgeCall(usable.inputs, a.allocation, result);
  const rec = toRecording(
    { step: i, requestSeq: request.seq, provider: provider.name, requestedModel: source.model, observations, decimals, notes: source.notes, requestBody },
    { assessment: a, result, ...judged },
  );
  const recording = writeRecording(rt.ledger.dir, rec);
  return record({
    request_seq: request.seq,
    model_called: true,
    provider: rec.provider,
    requested_model: rec.requested_model,
    model: rec.model,
    prompt_version: a.prompt.version,
    prompt_sha256: a.prompt.sha256,
    started_at: rec.started_at,
    finished_at: rec.finished_at,
    duration_ms: rec.duration_ms,
    raw_output: rec.raw_output,
    decision_text: rec.decision_text,
    provider_error: rec.provider_error,
    adapter_verdict: judged.adapter,
    verdict: judged.verdict,
    recording,
    allocation: a.allocation,
  });
}

/** Records a model-sourced propose step that sends nothing. A finding marks a decision that failed, not a decline. */
function noAction(rt: Runtime, i: number, reason: string, evidence: Record<string, unknown>, finding: string | null): void {
  const verification = { no_action: true, reason, ...evidence };
  rt.assertions.push({
    id: `step-${i + 1}-propose`,
    gate: "LIVE",
    description: finding === null ? `propose: agent no-action, nothing sent (${reason})` : "propose: agent decision not accepted, nothing sent",
    passed: finding === null,
    observed: verification,
  });
  rt.ledger.append("step-done", { step: i, kind: "propose", no_action: true, reason, verification, ...(finding === null ? {} : { finding: `step ${i + 1} propose: ${finding}` }) });
}

/**
 * Plans a model-sourced proposal from this step's recorded decision, making one only if none exists. A recorded
 * decision is never re-asked. Immediately before signing, inputs are read again: the proposal is submitted
 * unchanged only if it still passes the objective guard and every price keeps its age margin; otherwise the step
 * is a no-action finding. Returns null when nothing is to be sent.
 */
async function modelPlan(rt: Runtime, i: number, expect: "signed" | "rejected", source: ModelSource): Promise<Plan | null> {
  const ofStep = (kind: "decision" | "decision-request") => rt.ledger.ofKind(kind).filter((e) => e.data.step === i);
  const recorded = ofStep("decision").at(-1);
  const request = ofStep("decision-request").at(-1);
  const resumed = recorded !== undefined && (request === undefined || recorded.seq > request.seq);
  let entry: LedgerEntry;
  if (resumed) entry = recorded;
  else if (request !== undefined && !rt.agent.allowNewDecision) {
    throw new Stop(
      `step ${i + 1} propose: the model request in ledger entry ${request.seq} has no recorded result; the model may have answered, so it is not asked again. Set MANDATE_LIVE_ALLOW_NEW_DECISION=1 to make a new, recorded decision.`,
    );
  } else entry = await newDecision(rt, i, source, request?.seq ?? null);
  const verdict = RebalanceVerdict.parse(entry.data.verdict);
  const evidence: Record<string, unknown> = {
    decision_seq: entry.seq,
    model_called: entry.data.model_called === true,
    verdict,
    observations: entry.data.observations,
    allocation: entry.data.allocation ?? null,
    ...(resumed ? { resumed_from_ledger: true } : {}),
  };
  if (verdict.kind === "no-action") {
    noAction(rt, i, `${verdict.reason}: ${verdict.detail}`, evidence, null);
    return null;
  }
  if (verdict.kind === "rejected") {
    noAction(rt, i, `rejected at ${verdict.boundary}`, evidence, `agent decision rejected at ${verdict.boundary}: ${verdict.problems.join("; ")}`);
    return null;
  }
  const observations = await observe(rt);
  const usable = inputsFrom(observations, decimalsOf(rt.m), remainingSaleBudget(rt.m.budget, totals(rt.ledger).sold));
  const problems = usable.ok ? [...priceMarginProblems(observations, usable.inputs.grant.policy), ...objectiveProblems(usable.inputs, allocation(usable.inputs), verdict.proposal)] : usable.problems;
  evidence.recheck = { observations, problems, price_margin_extra_sec: PRICE_MARGIN_EXTRA_SEC };
  if (problems.length > 0) {
    const reason = `recorded proposal not acceptable immediately before signing: ${problems.join("; ")}`;
    noAction(rt, i, "pre-signing check failed", evidence, reason);
    return null;
  }
  const overBudget = sellProblem(rt.m.budget, totals(rt.ledger), { asset: verdict.proposal.sell, units: verdict.proposal.sell_amount });
  if (overBudget !== null) {
    noAction(rt, i, "proposal exceeds the run budget", evidence, `budget: ${overBudget}`);
    return null;
  }
  return proposePlan(rt, expect, verdict.proposal, { source: "live-model", ...evidence }, true);
}

type PlannedStep = Exclude<Step, { kind: "check" | "withhold" | "register_storage" | "withdraw" | ExternalKind }>;

async function plan(rt: Runtime, i: number, step: PlannedStep): Promise<Plan> {
  const { m, mandate } = rt;
  const g = m.gas_tgas;
  const base = (kind: Step["kind"], txActions: Action[]): Planned => ({
    worst_fee_yocto: worstFee(m, kind, rt.gasPrice).toString(),
    deposit_yocto: plannedDeposit(txActions).toString(),
  });
  switch (step.kind) {
    case "grant": {
      const a = [fc("grant", { policy: step.policy }, g.grant)];
      const prev = await mandate.grant();
      return { signer: rt.accounts.owner, receiver: mandate.id, method: "grant", actions: a, planned: base("grant", a), pre: { kind: "grant", previous_epoch: prev?.epoch ?? null }, detail: {} };
    }
    case "propose":
      if (step.source.from !== "manifest") throw new Stop("propose: a model-sourced proposal is planned from its recorded decision");
      return proposePlan(rt, step.expect, step.source.proposal, { source: "manifest" });
    case "refused_proposal": {
      const grant = await mandate.grant();
      if (grant === null) throw new Stop("refused_proposal: no grant");
      const a = [fc("propose_order", { proposal: step.proposal }, g.propose)];
      return {
        signer: rt.accounts.agent,
        receiver: mandate.id,
        method: "propose_order",
        actions: a,
        // Counted as if it could sell: a refusal is expected, never assumed.
        planned: { ...base("refused_proposal", a), sell: { asset: step.proposal.sell, units: step.proposal.sell_amount } },
        pre: { kind: "refused_proposal", proposal: step.proposal, error: step.error, grant, orders_before: (await mandate.allOrders()).length },
        detail: { source: "manifest", expected_error: step.error },
      };
    }
    case "relay_withheld": {
      const w = latestWithheld(rt.ledger);
      if (w?.bundle == null || w.filler_nonce === null || w.counter === null || w.bundle_sha256 === null) throw new Stop("relay_withheld: no withheld bundle");
      if (sha256Of(w.bundle) !== w.bundle_sha256) throw new Stop("relay_withheld: stored bundle does not match its recorded sha256");
      const tokens = { usdc: tokenId(m.mandate_config.usdc.token), wnear: tokenId(m.mandate_config.wnear.token) };
      const paid = Object.entries(w.counter).find(([, v]) => BigInt(v) < 0n);
      if (paid === undefined) throw new Stop("relay_withheld: withheld counter diff pays nothing");
      const payAsset: Asset = paid[0] === tokens.usdc ? "usdc" : "wnear";
      const a = [fc("execute_intents", { signed: w.bundle }, g.fill)];
      return {
        signer: rt.accounts.filler,
        receiver: rt.verifier.id,
        method: "execute_intents",
        actions: a,
        // Counted as if it could execute: a rejection is expected, never assumed.
        planned: { ...base("relay_withheld", a), filler_pay: { asset: payAsset, units: (-BigInt(paid[1])).toString() } },
        pre: {
          kind: "relay_withheld",
          order_id: w.order_id,
          signing_key: w.signing_key,
          deadline_ns: w.deadline_ns,
          mandate_nonce: w.mandate_nonce,
          filler_nonce: w.filler_nonce,
          bundle_sha256: w.bundle_sha256,
          mandate_before: fromBal(await balancesOf(rt.ctx, mandate.id)),
          filler_before: fromBal(await balancesOf(rt.ctx, m.accounts.filler)),
        },
        detail: { order_id: w.order_id, bundle_sha256: w.bundle_sha256, withheld_relay: true },
      };
    }
    case "fill": {
      const orderId = orderOf(rt, i, "fill", step.order_id);
      orderAllowed(rt, orderId);
      const order = await mandate.order(orderId);
      if (order?.state.state !== "signed") throw new Stop(`fill: order ${orderId} is not signed (${JSON.stringify(order?.state)})`);
      const signed = await rt.filler.signedOrder(order);
      const tokens = [tokenId(m.mandate_config.usdc.token), tokenId(m.mandate_config.wnear.token)];
      const leg = mandateLeg(signed, mandate.id, rt.verifier.id, tokens);
      const assetOf = (token: string): Asset => (token === tokens[0] ? "usdc" : "wnear");
      const prepared = await rt.filler.prepare(signed);
      if ("shortfall" in prepared) throw new Stop(`fill: ${prepared.shortfall}`);
      const delta: Balances = { usdc: 0n, wnear: 0n };
      for (const [token, v] of Object.entries(prepared.counter)) delta[assetOf(token)] += BigInt(v);
      const payAsset = assetOf(leg.buyToken);
      const pay = payableFor(leg.buyAmount, await rt.verifier.feePips());
      if (-delta[payAsset] !== pay) throw new Stop("fill: counter diff disagrees with the fee closure");
      const preexisting = !createdOrders(rt.ledger).includes(orderId);
      const a = [fc("execute_intents", { signed: prepared.bundle }, g.fill)];
      return {
        signer: rt.accounts.filler,
        receiver: rt.verifier.id,
        method: "execute_intents",
        actions: a,
        planned: {
          ...base("fill", a),
          filler_pay: { asset: payAsset, units: pay.toString() },
          // A pre-existing order's sale was never counted at propose time: count it now.
          ...(preexisting ? { sell: { asset: order.sell, units: order.sell_amount } } : {}),
        },
        pre: {
          kind: "fill",
          order,
          mandate_before: fromBal(await balancesOf(rt.ctx, mandate.id)),
          filler_before: fromBal(await balancesOf(rt.ctx, m.accounts.filler)),
          filler_delta: fromBal(delta),
          mandate_nonce: signed.payload.nonce,
          filler_nonce: prepared.own.payload.nonce,
        },
        detail: { order_id: orderId, preexisting, counter_diff: prepared.counter },
      };
    }
    case "settle": {
      const orderId = orderOf(rt, i, "settle", step.order_id);
      orderAllowed(rt, orderId);
      const a = [fc("settle_order", { order_id: orderId }, g.settle)];
      return { signer: rt.accounts.owner, receiver: mandate.id, method: "settle_order", actions: a, planned: base("settle", a), pre: { kind: "settle", order_id: orderId }, detail: { order_id: orderId } };
    }
    case "revoke": {
      const grant = await mandate.grant();
      if (grant === null) throw new Stop("revoke: no grant");
      const a = [fc("revoke", {}, g.revoke)];
      return { signer: rt.accounts.owner, receiver: mandate.id, method: "revoke", actions: a, planned: base("revoke", a), pre: { kind: "revoke", grant }, detail: {} };
    }
    case "reconcile_registration": {
      const a = [fc("reconcile_registration", {}, g.reconcile_registration)];
      return { signer: rt.accounts.owner, receiver: mandate.id, method: "reconcile_registration", actions: a, planned: base("reconcile_registration", a), pre: { kind: "reconcile_registration" }, detail: {} };
    }
    case "recover": {
      const a = [fc("recover", { asset: step.asset }, g.recover)];
      return {
        signer: rt.accounts.owner,
        receiver: mandate.id,
        method: "recover",
        actions: a,
        planned: base("recover", a),
        pre: { kind: "recover", asset: step.asset, mandate_before: fromBal(await balancesOf(rt.ctx, mandate.id)), owner_before: fromBal(await balancesOf(rt.ctx, m.accounts.owner)) },
        detail: { asset: step.asset },
      };
    }
  }
}

/**
 * A model proposal the mandate itself refused: propose_order panicked on the mandate (the only failed receipt) with
 * nothing changed, or the order was rejected while pricing and holds no reservation. Null for anything else (a
 * pending or signed order, other failures), which stays fatal. The refused order is never a fill target.
 */
async function modelRefusal(rt: Runtime, outcome: Outcome, pre: Extract<Pre, { kind: "propose" }>): Promise<{ refusal: string; error?: string; rejected_order_id?: string } | null> {
  if (!outcome.final || outcome.receipts.some((r) => r.unknown)) return null;
  const failed = outcome.receipts.filter((r) => r.error !== undefined);
  const own = failed.filter((r) => r.executor_id === rt.mandate.id);
  const grant = await rt.mandate.grant();
  if (grant === null || grant.epoch !== pre.grant.epoch || grant.outstanding !== pre.grant.outstanding) return null;
  if (!outcome.success) {
    const orders = (await rt.mandate.allOrders()).length;
    if (own.length !== 1 || failed.length !== 1 || orders !== pre.orders_before || grant.turnover_used !== pre.grant.turnover_used) return null;
    return { refusal: "propose_order panicked on the mandate; nothing changed", error: (own[0]?.error ?? "").slice(0, 300) };
  }
  if (own.length > 0) return null;
  const id = typeof outcome.return_value === "string" || typeof outcome.return_value === "number" ? String(outcome.return_value) : null;
  const order = id === null ? null : await rt.mandate.order(id);
  if (id === null || order?.state.state !== "rejected" || order.epoch !== pre.grant.epoch) return null;
  return { refusal: `order ${id} rejected while pricing (${order.state.reason}); no reservation remains`, rejected_order_id: id };
}

/** `fatal: false` records a failed check as a finding and continues, so revocation and recovery still run. */
async function verify(rt: Runtime, pre: Pre, outcome: Outcome): Promise<Verification & { data: Record<string, unknown>; fatal?: false }> {
  const { ctx } = rt;
  switch (pre.kind) {
    case "refused_proposal":
      // A finding, not a stop: if the contract misbehaves, revocation and recovery must still run.
      return { ...(await verifyRefusedProposal(ctx, outcome, pre.error, pre.grant, pre.orders_before)), data: {}, fatal: false };
    case "relay_withheld": {
      const v = await classifyRelay(ctx, outcome, {
        orderId: pre.order_id,
        revokedKey: pre.signing_key,
        deadlineNs: BigInt(pre.deadline_ns),
        mandateNonce: pre.mandate_nonce,
        fillerAccount: rt.m.accounts.filler,
        fillerNonce: pre.filler_nonce,
        mandateBefore: toBal(pre.mandate_before),
        fillerBefore: toBal(pre.filler_before),
        blockTimeNs: (hash) => rt.client.blockTimestampAt(hash).catch(() => null),
      });
      return { ...v, data: { classification: v.classification }, fatal: false };
    }
    case "grant":
      return { ...(await verifyGrant(ctx, outcome, pre.previous_epoch)), data: {} };
    case "propose": {
      const v = await verifyPropose(ctx, outcome, pre.expect, pre.proposal, pre.grant);
      if (!v.passed && pre.source === "model" && pre.expect === "signed") {
        const refused = await modelRefusal(rt, outcome, pre);
        if (refused !== null) {
          return { passed: false, problems: [`the mandate refused the agent's proposal: ${refused.refusal}`, ...v.problems], observed: { ...v.observed, ...refused }, data: { refused: true, reason: `the mandate refused the proposal: ${refused.refusal}` }, fatal: false };
        }
      }
      return { ...v, data: v.orderId === null ? {} : { order_id: v.orderId } };
    }
    case "fill":
      return {
        ...(await verifyFill(ctx, outcome, {
          order: pre.order,
          mandateBefore: toBal(pre.mandate_before),
          fillerBefore: toBal(pre.filler_before),
          fillerDelta: toBal(pre.filler_delta),
          fillerAccount: rt.m.accounts.filler,
          mandateNonce: pre.mandate_nonce,
          fillerNonce: pre.filler_nonce,
        })),
        data: {},
      };
    case "settle":
      return { ...(await verifySettle(ctx, outcome, pre.order_id)), data: {} };
    case "revoke":
      return { ...(await verifyRevoke(ctx, outcome, pre.grant)), data: {} };
    case "reconcile_registration":
      return { ...(await verifyReconcile(ctx, outcome)), data: {} };
    case "recover":
      return { ...(await verifyRecover(ctx, outcome, pre.asset, rt.m.accounts.owner, toBal(pre.mandate_before), toBal(pre.owner_before))), data: {} };
    case "register_storage":
      return { ...(await verifyStorage(ctx, outcome, pre.asset, rt.m.accounts.owner)), data: { asset: pre.asset } };
    case "withdraw": {
      const v = await verifyWithdraw(ctx, outcome, { asset: pre.asset, owner: rt.m.accounts.owner, amount: BigInt(pre.amount), intentsBefore: toBal(pre.intents_before), tokenBefore: BigInt(pre.token_before) });
      const data = { asset: pre.asset, withdrawn: v.withdrawn.toString(), classification: v.classification };
      if (v.classification === "refunded" || v.classification === "failed") return { ...v, data: { ...data, retryable: true }, fatal: false };
      return { ...v, data };
    }
  }
}

const outcomeData = (o: Outcome): Record<string, unknown> => ({
  tx_hash: o.tx_hash ?? null,
  status: o.ambiguous ? "ambiguous" : o.submitted ? "executed" : "rejected",
  success: o.success,
  any_receipt_failed: o.any_receipt_failed,
  fee_yocto: o.fee_yocto,
  deposit_yocto: o.deposit_yocto,
  block_height: o.block_height ?? null,
  error: o.error ?? null,
});

/** Evidence id of a step's verification; a retried step's later attempts are listed separately. */
const assertionId = (step: number, kind: string, attempt: unknown): string => `step-${step + 1}-${kind}${typeof attempt === "number" && attempt > 1 ? `-attempt-${attempt}` : ""}`;

/** Records the verification of an executed step; a failed check stops the run. `extra` is kept in its step-done. */
async function finishStep(rt: Runtime, step: number, kind: string, pre: Pre, outcome: Outcome, extra: Record<string, unknown> = {}): Promise<void> {
  if (!outcome.final) throw new Stop(`step ${step + 1} ${kind}: outcome of ${outcome.tx_hash ?? "?"} is not final (${outcome.final_execution_status ?? "unknown"}); rerun with MANDATE_LIVE_RESUME=1 once final`);
  const breach = checkActual(rt.m.budget, totals(rt.ledger));
  if (breach !== null) throw new Stop(`budget: ${breach}`);
  const v = await verify(rt, pre, outcome);
  const observed = kind === "relay_withheld" ? { ...v.observed, timing: deadlineTimeline(rt.ledger, []) } : v.observed;
  const label = extra.imported === true ? `${kind}: imported owner transaction, terminal verification` : `${kind}: terminal verification`;
  rt.assertions.push({ id: assertionId(step, kind, extra.attempt), gate: "LIVE", description: label, passed: v.passed, observed: { ...observed, problems: v.problems } });
  if (!v.passed && v.fatal !== false) throw new Stop(`step ${step + 1} ${kind}: terminal verification failed: ${v.problems.join("; ")}`);
  rt.ledger.append("step-done", { step, kind, tx_hash: outcome.tx_hash ?? null, ...extra, verification: observed, ...v.data, ...(v.passed ? {} : { finding: `step ${step + 1} ${kind}: ${v.problems.join("; ")}` }) });
}

/** Prepares and simulates the withheld bundle; never sends it. Failures are findings, not stops. */
async function withhold(rt: Runtime, i: number, step: Extract<Step, { kind: "withhold" }>): Promise<void> {
  const target = targetOrder(rt, i, step.order_id);
  if (target !== null && "skipped" in target) {
    skipStep(rt, i, "withhold", target.skipped);
    return;
  }
  const orderId = target?.order_id;
  if (orderId === undefined || !createdOrders(rt.ledger).includes(orderId)) throw new Stop(`withhold: order ${orderId ?? "?"} was not created by this run`);
  const order = await rt.mandate.order(orderId);
  const grant = await rt.mandate.grant();
  if (order?.state.state !== "signed" || order.deadline_ns === null || order.payload === null || grant?.public_key == null || grant.epoch !== order.epoch) {
    throw new Stop(`withhold: order ${orderId} is not a signed order of the current grant (${JSON.stringify(order?.state)})`);
  }
  const base = { order_id: orderId, signing_key: grant.public_key, deadline_ns: order.deadline_ns, mandate_nonce: order.payload.nonce };
  const signed = await rt.filler.signedOrder(order);
  const prepared = await rt.filler.prepare(signed);
  let withheld: Withheld;
  let problem: string | null;
  if ("shortfall" in prepared) {
    withheld = { ...base, bundle: null, bundle_sha256: null, filler_nonce: null, counter: null, executable: false };
    problem = `filler cannot cover the withheld order: ${prepared.shortfall}`;
  } else {
    problem = simulationProblem(await rt.verifier.simulate(prepared.bundle), prepared.bundle);
    withheld = { ...base, bundle: prepared.bundle, bundle_sha256: sha256Of(prepared.bundle), filler_nonce: prepared.own.payload.nonce, counter: prepared.counter, executable: problem === null };
  }
  const timing = await probe(rt, "withheld bundle prepared and simulated", BigInt(order.deadline_ns), true);
  const observed = {
    order_id: orderId,
    deadline_ns: order.deadline_ns,
    sign_requested_at_ns: order.sign_requested_at_ns,
    signed_at_ns: order.signed_at_ns,
    bundle_sha256: withheld.bundle_sha256,
    executable: withheld.executable,
    timing,
    ...(problem === null ? {} : { problem }),
  };
  rt.assertions.push({ id: `step-${i + 1}-withhold`, gate: "LIVE", description: "withhold: the exact bundle is executable before revocation (simulate_intents)", passed: problem === null, observed });
  rt.ledger.append("step-done", { step: i, kind: "withhold", verification: observed, withheld, ...(problem === null ? {} : { finding: `step ${i + 1} withhold: ${problem}` }) });
}

/**
 * Gate of the relay, run before preparation and again immediately before broadcast. Throws unless revocation
 * is confirmed (status revoked, no key operation in flight, signing key absent): a withheld order is never sent
 * while its key may be registered. Returns a skip reason when the relay cannot test revocation: the bundle was
 * not executable, or the order's remaining lifetime by the final block's time is below min_remaining_sec.
 */
async function relayGate(rt: Runtime, step: Extract<Step, { kind: "relay_withheld" }>, phase: string): Promise<{ probe: Probe; skip: string | null; observed: Record<string, unknown> }> {
  const w = latestWithheld(rt.ledger);
  if (w === null) throw new Stop("relay_withheld: no withhold step recorded");
  const grant = await rt.mandate.grant();
  const keyPresent = await rt.verifier.hasPublicKey(rt.mandate.id, w.signing_key);
  if (grant?.status !== "revoked" || grant.key_op_in_flight || keyPresent) {
    throw new Stop(
      `relay_withheld: revocation not confirmed at ${phase} (status ${String(grant?.status)}, key operation in flight ${String(grant?.key_op_in_flight)}, key registered ${String(keyPresent)}); the withheld order is not sent`,
    );
  }
  // Read last, so the lifetime is measured as close to the broadcast as possible.
  const p = await probe(rt, phase, BigInt(w.deadline_ns), true);
  const observed = { order_id: w.order_id, deadline_ns: w.deadline_ns, now_ns: p.chain_ns, executable_before_revocation: w.executable, classification: "inconclusive" };
  if (!w.executable || w.bundle === null) return { probe: p, skip: "the withheld bundle was not executable before revocation", observed };
  const remaining = BigInt(w.deadline_ns) - BigInt(p.chain_ns ?? "0");
  if (remaining < BigInt(step.min_remaining_sec) * 1_000_000_000n) {
    return { probe: p, skip: `order deadline too close or passed at ${phase} (${remaining} ns left by the final block's time, need ${step.min_remaining_sec} s)`, observed };
  }
  return { probe: p, skip: null, observed };
}

/**
 * Times of the deadline-sensitive phases of the withheld order, from the ledger: runner wall clock for every
 * phase, and the final block's time where it was read. Instrumentation only; it decides nothing. Completion of
 * propose and revoke is the runner's verified step-done, not a transaction response: a lost response is first
 * recorded as ambiguous and confirmed only by a later reconciliation.
 */
function deadlineTimeline(ledger: Ledger, extra: Probe[], window: Record<string, unknown> | null = null): Record<string, unknown> {
  const w = latestWithheld(ledger);
  if (w === null) return { deadline_ns: null, phases: extra, revocation_window: window };
  const deadlineMs = Number(BigInt(w.deadline_ns) / 1_000_000n);
  const withholdDone = ledger.ofKind("step-done").filter((e) => e.data.kind === "withhold").at(-1);
  const intents = ledger.ofKind("tx-intent");
  const doneOf = (intent: LedgerEntry | undefined): LedgerEntry | undefined =>
    intent === undefined ? undefined : ledger.ofKind("step-done").find((e) => e.data.step === intent.data.step && e.data.kind === intent.data.kind);
  const propose = intents.filter((e) => e.data.kind === "propose" && e.seq < (withholdDone?.seq ?? Number.POSITIVE_INFINITY)).at(-1);
  const runnerRevoke = intents.filter((e) => e.data.kind === "revoke").at(-1);
  // An external revocation has no send time the runner observed: its intent (written before the owner signs) stands in.
  const externalRevoke = runnerRevoke === undefined ? ledger.ofKind("external-intent").filter((e) => e.data.kind === "revoke_external").at(-1) : undefined;
  const revoke = runnerRevoke ?? externalRevoke;
  const relay = intents.filter((e) => e.data.kind === "relay_withheld").at(-1);
  const wall = (phase: string, e: LedgerEntry | undefined): Probe[] => (e === undefined ? [] : [{ phase, at: e.at, chain_ns: null, remaining_ms: null }]);
  const recorded = (v: unknown): Probe[] => z.array(z.object({ phase: z.string(), at: z.string(), chain_ns: z.string().nullable(), remaining_ms: z.number().nullable() })).catch([]).parse(Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const withholdTiming = (withholdDone?.data.verification as { timing?: unknown } | undefined)?.timing;
  const phases = [
    ...wall("withheld order proposed (sent)", propose),
    ...wall("withheld order signed (propose confirmed by runner)", doneOf(propose)),
    ...(withholdTiming === undefined ? wall("withheld bundle prepared and simulated", withholdDone) : recorded(withholdTiming)),
    ...wall(externalRevoke === undefined ? "revoke sent" : "revoke intent written (owner signs outside the runner)", revoke),
    ...wall("revoke confirmed by runner", doneOf(revoke)),
    ...recorded(relay?.data.timing),
    ...extra,
  ].map((ph) => ({ ...ph, wall_remaining_ms: deadlineMs - Date.parse(ph.at) }));
  return {
    deadline_ns: w.deadline_ns,
    revocation_window: window ?? relay?.data.revocation_window ?? null,
    note: "at and wall_remaining_ms use the runner's clock; chain_ns and remaining_ms use the final block's timestamp, which the verifier's deadline check follows. A phase confirmed by runner is the time its step's terminal verification was recorded (after a reconciling resume, if the response was lost), not the block time of finality",
    phases,
  };
}

/**
 * What revocation bought for the withheld order, by chain time. Instrumentation only: it reads only the ledger and
 * the probe already taken, so it makes no request and cannot fail the relay. The comparison point is an owner who
 * stops authorizing and waits: from the moment removal was confirmed, that owner stays exposed until the order's
 * own deadline. `confirmed` is the relay pre-check's final-block read, taken after the runner confirmed removal, so
 * removal was final no later than that and the remaining lifetime is at least the value shown (for an external
 * revocation the pre-check can come well after the owner's transaction, which loosens the bound). The order's
 * timestamps come from its view at the withhold step.
 */
export function revocationWindow(ledger: Ledger, confirmed: Probe): Record<string, unknown> | null {
  const w = latestWithheld(ledger);
  const done = ledger.ofKind("step-done").filter((e) => e.data.kind === "withhold").at(-1);
  if (w === null || confirmed.chain_ns === null) return null;
  const times = z.object({ sign_requested_at_ns: z.string().nullable(), signed_at_ns: z.string().nullable() }).catch({ sign_requested_at_ns: null, signed_at_ns: null }).parse(done?.data.verification);
  const ms = (ns: bigint): number => Number(ns / 1_000_000n);
  const deadline = BigInt(w.deadline_ns);
  const remainingNs = deadline - BigInt(confirmed.chain_ns);
  const requested = times.sign_requested_at_ns === null ? null : BigInt(times.sign_requested_at_ns);
  const signed = times.signed_at_ns === null ? null : BigInt(times.signed_at_ns);
  return {
    basis: "chain time: the order's timestamps from its view at the withhold step, and the relay pre-check's final-block read after the runner confirmed removal",
    order_id: w.order_id,
    deadline_ns: w.deadline_ns,
    sign_requested_at_ns: times.sign_requested_at_ns,
    signed_at_ns: times.signed_at_ns,
    read_after_confirmed_removal_ns: confirmed.chain_ns,
    sign_request_to_signed_ms: requested === null || signed === null ? null : ms(signed - requested),
    signed_to_deadline_ms: signed === null ? null : ms(deadline - signed),
    remaining_after_confirmed_removal_ns: remainingNs.toString(),
    remaining_after_confirmed_removal_ms: ms(remainingNs),
    // The verifier rejects only once the deadline is strictly before the block time (engine/mod.rs L66 at 16d04f6).
    expired_when_read: remainingNs < 0n,
    note: "remaining_after_confirmed_removal is how long the withheld order would still have been executable for an owner who stopped authorizing and waited, from the same moment; a lower bound, since removal was final before the read. sign_request_to_signed_ms runs from the block of the MPC sign request to the block of the contract's signature callback (MPC signing plus the yield/resume round trip).",
  };
}

/** Records a relay that was not broadcast as inconclusive. */
function skipRelay(rt: Runtime, i: number, skipped: RelaySkipped, probes: Probe[], window: Record<string, unknown> | null = null): void {
  const verification = { ...skipped.observed, timing: deadlineTimeline(rt.ledger, probes, window) };
  rt.assertions.push({ id: `step-${i + 1}-relay_withheld`, gate: "LIVE", description: "relay_withheld: not sent", passed: false, observed: { ...verification, problems: [skipped.message] } });
  rt.ledger.append("step-done", { step: i, kind: "relay_withheld", verification, classification: "inconclusive", sent: false, finding: `step ${i + 1} relay_withheld: inconclusive, not sent: ${skipped.message}` });
}

// ---------------------------------------------------------------- owner withdrawal and storage registration

type WithdrawStep = Extract<Step, { kind: "withdraw" | "withdraw_external" }>;

const doneOfStep = (ledger: Ledger, step: number): LedgerEntry[] => ledger.ofKind("step-done").filter((e) => e.data.step === step);
/** 1 + the verified attempts of this step: the attempt a new transaction or intent for it belongs to. */
const nextAttempt = (ledger: Ledger, step: number): number => doneOfStep(ledger, step).length + 1;

/** Units of `asset` this run's recovery steps moved to the owner's Intents account (from their verification). */
function recoveredBy(ledger: Ledger, asset: Asset): bigint {
  let sum = 0n;
  for (const e of ledger.ofKind("step-done")) {
    if (e.data.kind !== "recover" && e.data.kind !== "recover_external") continue;
    const v = z.object({ asset: z.string(), gained: z.string() }).loose().safeParse(e.data.verification);
    if (v.success && v.data.asset === asset) sum += BigInt(v.data.gained);
  }
  return sum;
}

/** Units of `asset` withdrawn by verified withdrawal attempts; `only` restricts to one step, `except` excludes one. */
function withdrawnBy(ledger: Ledger, asset: Asset, filter: { only?: number; except?: number } = {}): bigint {
  let sum = 0n;
  for (const e of ledger.ofKind("step-done")) {
    if ((e.data.kind !== "withdraw" && e.data.kind !== "withdraw_external") || e.data.asset !== asset || typeof e.data.withdrawn !== "string") continue;
    if (filter.only !== undefined && e.data.step !== filter.only) continue;
    if (filter.except !== undefined && e.data.step === filter.except) continue;
    sum += BigInt(e.data.withdrawn);
  }
  return sum;
}

/**
 * What a withdrawal step should withdraw now: its explicit amount, or what this run recovered of the asset less what
 * other steps withdrew; minus what earlier attempts of this step withdrew. A refunded attempt withdrew nothing, so a
 * retry never counts a unit twice. An unregistered owner is not sent anything (the transfer would be refunded).
 */
async function withdrawSpec(rt: Runtime, i: number, step: WithdrawStep): Promise<{ skip: string; retryable: boolean } | { pre: Extract<Pre, { kind: "withdraw" }> }> {
  const { asset } = step;
  const owner = rt.m.accounts.owner;
  const target = step.amount !== undefined ? BigInt(step.amount) : recoveredBy(rt.ledger, asset) - withdrawnBy(rt.ledger, asset, { except: i });
  const left = target - withdrawnBy(rt.ledger, asset, { only: i });
  if (left <= 0n) return { skip: `nothing left to withdraw (${asset}: target ${target}, already withdrawn by this step ${target - left})`, retryable: false };
  const token = tokenOf(rt.ctx, asset);
  if (!(await token.isRegistered(owner))) return { skip: `${owner} is not registered on ${token.id}; the transfer would be refunded, nothing sent`, retryable: true };
  const intentsBefore = await balancesOf(rt.ctx, owner);
  if (intentsBefore[asset] < left) throw new Stop(`step ${i + 1} ${step.kind}: the owner's Intents ${asset} balance ${intentsBefore[asset]} is below the ${left} to withdraw`);
  return { pre: { kind: "withdraw", asset, amount: left.toString(), intents_before: fromBal(intentsBefore), token_before: (await token.balance(owner)).toString() } };
}

/** Records a withdrawal that sent nothing; `retryable` marks one a resume tries again. */
function skipWithdraw(rt: Runtime, i: number, kind: string, attempt: number, asset: Asset, reason: string, retryable: boolean): void {
  const verification = { skipped: true, reason, asset };
  rt.assertions.push({ id: assertionId(i, kind, attempt), gate: "LIVE", description: `${kind}: nothing sent (${reason})`, passed: !retryable, observed: verification });
  rt.ledger.append("step-done", { step: i, kind, attempt, skipped: true, reason, asset, withdrawn: "0", verification, ...(retryable ? { retryable: true, finding: `step ${i + 1} ${kind}: ${reason}` } : {}) });
}

const withdrawAction = (rt: Runtime, pre: Extract<Pre, { kind: "withdraw" }>): { method: string; args: Record<string, unknown>; deposit: bigint } => ({
  method: "ft_withdraw",
  args: { token: rt.m.mandate_config[pre.asset].token, receiver_id: rt.m.accounts.owner, amount: pre.amount },
  deposit: 1n,
});

/** The owner's runner-signed withdrawal of one asset from its Intents account to its NEAR account. */
async function runnerWithdraw(rt: Runtime, i: number, step: Extract<Step, { kind: "withdraw" }>): Promise<void> {
  const attempt = nextAttempt(rt.ledger, i);
  const spec = await withdrawSpec(rt, i, step);
  if ("skip" in spec) {
    skipWithdraw(rt, i, step.kind, attempt, step.asset, spec.skip, spec.retryable);
    return;
  }
  const w = withdrawAction(rt, spec.pre);
  const a = [actions.functionCall(w.method, w.args, BigInt(rt.m.gas_tgas.withdraw) * TGAS, w.deposit)];
  const p: Plan = {
    signer: rt.accounts.owner,
    receiver: rt.verifier.id,
    method: w.method,
    actions: a,
    planned: { worst_fee_yocto: worstFee(rt.m, "withdraw", rt.gasPrice).toString(), deposit_yocto: plannedDeposit(a).toString() },
    pre: spec.pre,
    detail: { asset: step.asset, amount: spec.pre.amount, outside_recovery: true, attempt },
    attempt,
  };
  checkPlanned(rt.m.budget, totals(rt.ledger), p.planned);
  await send(rt, i, step, p);
}

/** Registers the owner on the asset's token contract with the minimum storage deposit, only if it is not registered. */
async function registerStorage(rt: Runtime, i: number, step: Extract<Step, { kind: "register_storage" }>): Promise<void> {
  const attempt = nextAttempt(rt.ledger, i);
  const owner = rt.m.accounts.owner;
  const token = tokenOf(rt.ctx, step.asset);
  if (await token.isRegistered(owner)) {
    const verification = { skipped: true, reason: `${owner} is already registered on ${token.id}`, asset: step.asset, registered: true };
    rt.assertions.push({ id: assertionId(i, step.kind, attempt), gate: "LIVE", description: `${step.kind}: already registered, nothing sent`, passed: true, observed: verification });
    rt.ledger.append("step-done", { step: i, kind: step.kind, attempt, skipped: true, reason: verification.reason, asset: step.asset, verification });
    return;
  }
  const deposit = await token.storageMin();
  const a = [actions.functionCall("storage_deposit", { account_id: owner, registration_only: true }, BigInt(rt.m.gas_tgas.storage_deposit) * TGAS, deposit)];
  const p: Plan = {
    signer: rt.accounts.owner,
    receiver: token.id,
    method: "storage_deposit",
    actions: a,
    planned: { worst_fee_yocto: worstFee(rt.m, "register_storage", rt.gasPrice).toString(), deposit_yocto: plannedDeposit(a).toString() },
    pre: { kind: "register_storage", asset: step.asset, token: token.id, deposit: deposit.toString() },
    detail: { asset: step.asset, token: token.id, deposit_yocto: deposit.toString(), outside_recovery: true, attempt },
    attempt,
  };
  checkPlanned(rt.m.budget, totals(rt.ledger), p.planned);
  await send(rt, i, step, p);
}

// ---------------------------------------------------------------- external owner actions

type ExternalStep = Extract<Step, { kind: ExternalKind }>;

interface ExternalSpec {
  method: string;
  args: Record<string, unknown>;
  deposit: bigint;
  pre: Pre;
  expected: ExternalIntent["expected"];
}

/** The exact action of an external step and the state it must produce, from current chain state. */
async function externalSpec(rt: Runtime, i: number, step: ExternalStep): Promise<ExternalSpec | { skip: string; retryable: boolean }> {
  switch (step.kind) {
    case "revoke_external": {
      const grant = await rt.mandate.grant();
      if (grant === null) throw new Stop("revoke_external: no grant");
      return {
        method: "revoke",
        args: {},
        deposit: 0n,
        pre: { kind: "revoke", grant },
        expected: {
          summary: `grant epoch ${grant.epoch} revoked: its key removed from ${rt.verifier.id}, no open order of the epoch, nothing outstanding`,
          state: { epoch: String(grant.epoch), status: "revoked", removed_key: grant.public_key ?? "none", outstanding: "0" },
        },
      };
    }
    case "recover_external": {
      const mandateBefore = await balancesOf(rt.ctx, rt.mandate.id);
      const ownerBefore = await balancesOf(rt.ctx, rt.m.accounts.owner);
      return {
        method: "recover",
        args: { asset: step.asset },
        deposit: 0n,
        pre: { kind: "recover", asset: step.asset, mandate_before: fromBal(mandateBefore), owner_before: fromBal(ownerBefore) },
        expected: {
          summary: `the mandate's whole Intents ${step.asset} balance moves to the owner's Intents account; nothing else moves`,
          state: { asset: step.asset, mandate_before: mandateBefore[step.asset].toString(), mandate_after: "0", owner_intents_before: ownerBefore[step.asset].toString() },
        },
      };
    }
    case "withdraw_external": {
      const spec = await withdrawSpec(rt, i, step);
      if ("skip" in spec) return spec;
      const w = withdrawAction(rt, spec.pre);
      return {
        ...w,
        pre: spec.pre,
        expected: {
          summary: `${spec.pre.amount} ${step.asset} leaves the owner's Intents account for its NEAR account on ${rt.m.mandate_config[step.asset].token}; a refund leaves both unchanged`,
          state: {
            asset: step.asset,
            amount: spec.pre.amount,
            owner_intents_before: spec.pre.intents_before[step.asset],
            owner_intents_after: (BigInt(spec.pre.intents_before[step.asset]) - BigInt(spec.pre.amount)).toString(),
            owner_token_before: spec.pre.token_before,
            owner_token_after: (BigInt(spec.pre.token_before) + BigInt(spec.pre.amount)).toString(),
          },
        },
      };
    }
  }
}

const IntentRecord = z
  .object({ step: z.number().int(), kind: z.string(), attempt: z.number().int(), intent: ExternalIntent, intent_sha256: z.string(), intent_file: z.string(), handoff_file: z.string(), pre: z.unknown() })
  .loose();
type IntentRecord = z.infer<typeof IntentRecord>;

const intentOf = (e: LedgerEntry): IntentRecord => IntentRecord.parse(e.data);
const filesOf = (rt: Runtime, rec: IntentRecord) => ({ intent: join(rt.ledger.dir, rec.intent_file), handoff: join(rt.ledger.dir, rec.handoff_file) });

/** Every transaction hash the ledger knows: sent, handed off or refused. */
function knownHashes(ledger: Ledger): Set<string> {
  const out = new Set<string>();
  for (const e of ledger.entries) if (["tx-intent", "tx-result", "reconciled", "external-handoff", "external-refused"].includes(e.kind) && typeof e.data.tx_hash === "string") out.add(e.data.tx_hash);
  return out;
}

const handoffOfIntent = (ledger: Ledger, sha: string): LedgerEntry | undefined => ledger.ofKind("external-handoff").find((e) => e.data.intent_sha256 === sha);

/** What a refused handoff's transaction cost, as recorded with the refusal; budget.ts charges `charged` fees once. */
interface RefusalFee {
  fee_yocto: string | null;
  payer: string | null;
  charged: boolean;
  fee_note: string;
}

/**
 * The fee of a refused handoff's transaction: charged when it is found final on this chain, the owner paid it and
 * the ledger does not already hold it. Looked up unless `found` is given; a hash the ledger knows is not looked up.
 */
async function refusalFee(rt: Runtime, h: ExternalHandoff, found?: Outcome): Promise<RefusalFee> {
  if (found === undefined && knownHashes(rt.ledger).has(h.tx_hash)) {
    return { fee_yocto: null, payer: null, charged: false, fee_note: "already in the ledger: counted where it was first recorded, never again" };
  }
  let o = found ?? null;
  if (o === null && (await rt.client.txKnown(h.tx_hash, h.signer_id)) === "known") o = await rt.client.resolve(`refused handoff ${h.tx_hash}`, h.signer_id, h.tx_hash);
  if (o === null || o.ambiguous || !o.final || o.transaction === undefined) {
    return { fee_yocto: null, payer: null, charged: false, fee_note: "not found final on this chain at refusal: its fee, if any, is unknown and not counted" };
  }
  const payer = o.transaction.signer_id;
  const charged = payer === rt.m.accounts.owner;
  return { fee_yocto: o.fee_yocto, payer, charged, fee_note: charged ? "paid by the owner: charged once against max_fee_yocto" : `paid by ${payer}, not the owner: recorded, not charged` };
}

/** Records a refused handoff (never a success) with its fee and stops the run. */
function refuseHandoff(rt: Runtime, step: number | null, h: ExternalHandoff, problems: string[], fee: RefusalFee): never {
  rt.ledger.append("external-refused", { step, intent_sha256: h.intent_sha256, tx_hash: h.tx_hash, signer_id: h.signer_id, problems, ...fee });
  const where = step === null ? "" : `step ${step + 1}: `;
  throw new Stop(`${where}handoff ${h.tx_hash} refused: ${problems.join("; ")}. Nothing was imported; nothing is resubmitted.`);
}

const StartNonces = z.object({ owner: z.string(), agent: z.string(), filler: z.string(), owner_external: z.string().optional() }).strict();

/**
 * Nonce each key must have on chain if every transaction of it is in the ledger: the start nonce plus one per executed
 * runner transaction and per imported owner transaction. Refused or unrelated transactions advance nothing. Each
 * recorded transaction was checked to be exactly the next nonce before it was sent or imported, so a gap is never
 * absorbed.
 */
function expectedNonces(rt: Runtime): { account: string; key: string; nonce: bigint }[] {
  const start = StartNonces.parse(rt.ledger.entries[0]?.data.nonces);
  const { m } = rt;
  const keys = new Map<string, { account: string; nonce: bigint }>([
    [m.keys.owner.public_key, { account: m.accounts.owner, nonce: BigInt(start.owner) }],
    [m.keys.agent.public_key, { account: m.accounts.agent, nonce: BigInt(start.agent) }],
    [m.keys.filler.public_key, { account: m.accounts.filler, nonce: BigInt(start.filler) }],
  ]);
  const ext = externalOwnerKey(m);
  if (!keys.has(ext) && start.owner_external !== undefined) keys.set(ext, { account: m.accounts.owner, nonce: BigInt(start.owner_external) });
  const bump = (key: unknown): void => {
    const k = typeof key === "string" ? keys.get(key) : undefined;
    if (k !== undefined) k.nonce += 1n;
  };
  for (const intent of rt.ledger.ofKind("tx-intent")) {
    const res = [...rt.ledger.entries].reverse().find((e) => (e.kind === "tx-result" || e.kind === "reconciled") && e.data.tx_hash === intent.data.tx_hash);
    if (res?.data.status === "executed") bump(intent.data.public_key);
  }
  for (const h of rt.ledger.ofKind("external-handoff")) bump(h.data.public_key);
  return [...keys].map(([key, v]) => ({ key, ...v }));
}

const roleOfKey = (rt: Runtime, k: { account: string; key: string }): string =>
  k.account === rt.m.accounts.owner ? (k.key === rt.m.keys.owner.public_key ? "owner" : "owner external") : k.account === rt.m.accounts.agent ? "agent" : "filler";

/**
 * Changes of the owner account's access keys against the snapshot taken at the run's start: an added or removed key, a
 * changed permission, or a nonce change of a key whose nonce the ledger does not track.
 */
async function ownerKeyProblems(rt: Runtime): Promise<string[]> {
  const snapshot = z.array(OwnerKey).safeParse(rt.ledger.entries[0]?.data.owner_keys);
  if (!snapshot.success) return ["the ledger's start entry holds no snapshot of the owner account's access keys"];
  const owner = rt.m.accounts.owner;
  const tracked = new Set(expectedNonces(rt).filter((k) => k.account === owner).map((k) => k.key));
  return ownerKeyChanges(snapshot.data, ownerKeySnapshot(await rt.client.accessKeys(owner)), tracked);
}

/**
 * Why the chain shows a transaction of `account` the ledger does not record, or []: a tracked key whose nonce is not the
 * ledger's expectation (`importing` names the key of a transaction being imported and the nonce it must now have), and
 * for the owner account any change of its key list against the start snapshot.
 */
async function unrecordedProblems(rt: Runtime, account: string, importing?: { key: string; nonce: bigint }): Promise<string[]> {
  const p: string[] = [];
  for (const k of expectedNonces(rt).filter((x) => x.account === account)) {
    const want = importing?.key === k.key ? importing.nonce : k.nonce;
    const chain = await rt.client.accessKeyNonce(k.account, k.key);
    if (chain !== want) p.push(`${roleOfKey(rt, k)} key nonce on chain is ${String(chain)}, ledger expects ${want}`);
  }
  if (account === rt.m.accounts.owner) p.push(...(await ownerKeyProblems(rt)));
  return p;
}

/**
 * Imports a handed-off owner transaction for a persisted intent. Refuses (records, never as success, and stops) a
 * duplicate hash, a second hash for a handed-off intent, an unrelated intent, the wrong chain, signer, key, receiver,
 * method, arguments, action list or bounds, and a nonce showing an owner transaction the ledger does not record. A
 * transaction not found final on this chain records nothing. Only then is it recorded and its end state verified.
 */
async function importHandoff(rt: Runtime, rec: IntentRecord, h: ExternalHandoff): Promise<void> {
  const { step: i, intent } = rec;
  if (knownHashes(rt.ledger).has(h.tx_hash)) refuseHandoff(rt, i, h, [`duplicate: transaction ${h.tx_hash} is already in the ledger`], await refusalFee(rt, h));
  if (h.intent_sha256 !== rec.intent_sha256) {
    const other = rt.ledger.ofKind("external-intent").find((e) => e.data.intent_sha256 === h.intent_sha256);
    const problem = other === undefined ? `unrelated: no intent ${h.intent_sha256} in this ledger` : `unrelated: the handoff names intent ${h.intent_sha256} (step ${String(other.data.step)}), the pending intent is ${rec.intent_sha256}`;
    refuseHandoff(rt, i, h, [problem], await refusalFee(rt, h));
  }
  const prior = handoffOfIntent(rt.ledger, rec.intent_sha256);
  if (prior !== undefined) refuseHandoff(rt, i, h, [`duplicate: intent ${rec.intent_sha256} was already handed off as ${String(prior.data.tx_hash)}`], await refusalFee(rt, h));
  if (h.signer_id !== intent.signer_id) refuseHandoff(rt, i, h, [`wrong signer: the handoff names ${h.signer_id}, the intent requires ${intent.signer_id}`], await refusalFee(rt, h));
  const status = await rt.client.nodeStatus();
  if (status.chain_id !== intent.network.chain_id || status.genesis_hash !== intent.network.genesis_hash) {
    // The RPC, not necessarily the handoff, is wrong: nothing is looked up or recorded, so the hash can still be
    // imported once the runner reads the intent's chain.
    throw new Stop(
      `step ${i + 1} ${rec.kind}: wrong chain: the RPC serves ${status.chain_id}/${status.genesis_hash}, the intent is for ${intent.network.chain_id}/${intent.network.genesis_hash}; handoff ${h.tx_hash} not looked up, nothing recorded.`,
    );
  }
  const known = await rt.client.txKnown(h.tx_hash, h.signer_id);
  const found = known === "unknown" ? null : await rt.client.resolve(`import step ${i + 1} ${rec.kind}`, h.signer_id, h.tx_hash, intent.actions[0]?.method ?? "-");
  if (found === null) throw new Stop(`step ${i + 1} ${rec.kind}: transaction ${h.tx_hash} is not found final on ${status.chain_id} (unrelated, from another chain, or not final yet); nothing recorded. Resume once it is final.`);
  if (found.ambiguous || !found.final || found.transaction === undefined) throw new Stop(`step ${i + 1} ${rec.kind}: transaction ${h.tx_hash} is not final yet; nothing recorded. Resume to import it.`);
  const tx = found.transaction;
  const problems = transactionProblems(intent, tx);
  if (problems.length > 0) refuseHandoff(rt, i, h, problems, await refusalFee(rt, h, found));
  const expected = expectedNonces(rt).find((k) => k.key === intent.public_key);
  const chainNonce = await rt.client.accessKeyNonce(intent.signer_id, intent.public_key);
  const txNonce = tx.nonce === null ? null : BigInt(tx.nonce);
  if (expected === undefined || txNonce === null || txNonce !== expected.nonce + 1n || chainNonce !== txNonce) {
    refuseHandoff(
      rt,
      i,
      h,
      [
        `unrecorded owner transaction: the imported transaction has nonce ${String(txNonce)} and the key's nonce on chain is ${String(chainNonce)}, the ledger expects ${String(expected === undefined ? null : expected.nonce + 1n)} for both; transactions exist that the ledger does not record`,
      ],
      await refusalFee(rt, h, found),
    );
  }
  // The owner's other tracked key and its whole key list, with this transaction counted.
  const other = await unrecordedProblems(rt, intent.signer_id, { key: intent.public_key, nonce: txNonce });
  if (other.length > 0) refuseHandoff(rt, i, h, [`unrecorded owner transaction: ${other.join("; ")}; transactions exist that the ledger does not record`], await refusalFee(rt, h, found));
  rt.ledger.append("external-handoff", { step: i, kind: rec.kind, attempt: rec.attempt, intent_sha256: rec.intent_sha256, tx_hash: h.tx_hash, signer_id: h.signer_id, public_key: tx.public_key, nonce: tx.nonce });
  await finishImport(rt, rec, found, "tx-result");
}

/** Records an accepted import's outcome (fee included, once) and verifies the step's end state. */
async function finishImport(rt: Runtime, rec: IntentRecord, found: Outcome, kind: "tx-result" | "reconciled"): Promise<void> {
  const known = rt.ledger.entries.some((e) => (e.kind === "tx-result" || e.kind === "reconciled") && e.data.tx_hash === found.tx_hash);
  if (!known) rt.ledger.append(kind, { step: rec.step, imported: true, intent_sha256: rec.intent_sha256, ...outcomeData(found) });
  rt.receipts.push(toEvidenceReceipt(found, { step: rec.step + 1, imported: true, signed_outside_runner: true, intent_sha256: rec.intent_sha256, ...(kind === "reconciled" ? { reconciled: true } : {}) }));
  await finishStep(rt, rec.step, rec.kind, Pre.parse(rec.pre), found, { imported: true, intent_sha256: rec.intent_sha256, attempt: rec.attempt });
}

async function readHandoffFile(path: string): Promise<ExternalHandoff[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Stop(`handoff file ${path} is not JSON; nothing imported`);
  }
  const parsed = z.union([ExternalHandoff, z.array(ExternalHandoff)]).safeParse(raw);
  if (!parsed.success) throw new Stop(`handoff file ${path} is not a ${EXTERNAL_HANDOFF_SCHEMA} record: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
  return Promise.resolve(Array.isArray(parsed.data) ? parsed.data : [parsed.data]);
}

/** A handoff already available for a pending intent: from MANDATE_LIVE_HANDOFF or the file next to the intent. */
async function availableHandoff(rt: Runtime, rec: IntentRecord): Promise<ExternalHandoff | null> {
  const supplied = rt.external.supplied.get(rec.intent_sha256);
  if (supplied !== undefined) {
    rt.external.supplied.delete(rec.intent_sha256);
    return supplied;
  }
  const file = filesOf(rt, rec).handoff;
  if (!existsSync(file)) return null;
  const [first, ...rest] = await readHandoffFile(file);
  if (first === undefined || rest.length > 0) throw new Stop(`handoff file ${file} must hold exactly one record`);
  return first;
}

/** The handoff for a pending intent: an available one, the in-process supplier, or the file once it appears. */
async function obtainHandoff(rt: Runtime, rec: IntentRecord): Promise<ExternalHandoff | null> {
  const ready = await availableHandoff(rt, rec);
  if (ready !== null) return ready;
  const fromDeps = await rt.external.supply?.(rec.intent, filesOf(rt, rec));
  if (fromDeps != null) return ExternalHandoff.parse(fromDeps);
  const deadline = Date.now() + rt.external.waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, rt.ctx.pollMs ?? 1_000));
    const later = await availableHandoff(rt, rec);
    if (later !== null) return later;
  }
  return null;
}

/**
 * On resume, before the nonce check: a pending intent whose handoff is available is imported first. Its owner
 * transaction is on chain but not yet in the ledger (for example after a lost lookup), and the import's own nonce
 * check is the same guarantee: an owner transaction the ledger does not record still stops the run.
 */
async function importAvailable(rt: Runtime): Promise<void> {
  for (const e of rt.ledger.ofKind("external-intent")) {
    const rec = intentOf(e);
    if (doneAfter(rt.ledger, rec.step, e.seq) || handoffOfIntent(rt.ledger, rec.intent_sha256) !== undefined) continue;
    const h = await availableHandoff(rt, rec);
    // A handoff already refused stays refused; the nonce check then reports the unrecorded transaction.
    if (h !== null && !knownHashes(rt.ledger).has(h.tx_hash)) await importHandoff(rt, rec, h);
  }
}

/**
 * An external owner step: persist the intent (once per attempt) before the owner signs, then import its handoff.
 * Without a handoff the run stops as awaiting; a resume continues from the same intent.
 */
async function externalStep(rt: Runtime, i: number, step: ExternalStep): Promise<void> {
  const attempt = nextAttempt(rt.ledger, i);
  const existing = rt.ledger.ofKind("external-intent").filter((e) => e.data.step === i && e.data.attempt === attempt).at(-1);
  let rec: IntentRecord;
  if (existing !== undefined) rec = intentOf(existing);
  else {
    const spec = await externalSpec(rt, i, step);
    if ("skip" in spec) {
      skipWithdraw(rt, i, step.kind, attempt, step.kind === "withdraw_external" ? step.asset : "usdc", spec.skip, spec.retryable);
      return;
    }
    const gas = stepGasTgas(rt.m, step.kind);
    if (gas === null) throw new Stop(`${step.kind}: no gas allocation`);
    const planned: Planned = { worst_fee_yocto: worstFee(rt.m, step.kind, rt.gasPrice).toString(), deposit_yocto: spec.deposit.toString() };
    checkPlanned(rt.m.budget, totals(rt.ledger), planned);
    const intent = ExternalIntent.parse({
      schema: EXTERNAL_INTENT_SCHEMA,
      manifest_sha256: rt.ledger.manifestSha256,
      step: i + 1,
      kind: step.kind,
      attempt,
      network: rt.m.network,
      signer_id: rt.m.accounts.owner,
      public_key: externalOwnerKey(rt.m),
      receiver_id: step.kind === "withdraw_external" ? rt.verifier.id : rt.mandate.id,
      actions: [
        {
          method: spec.method,
          args: spec.args,
          gas: (BigInt(gas.proposed) * TGAS).toString(),
          deposit: spec.deposit.toString(),
          gas_min: (BigInt(gas.proposed) * TGAS).toString(),
          gas_max: (BigInt(gas.max) * TGAS).toString(),
          deposit_min: spec.deposit.toString(),
          deposit_max: spec.deposit.toString(),
        },
      ],
      expected: spec.expected,
      created_at: new Date().toISOString(),
    });
    const sha = await intentSha256(intent);
    const stem = intentStem(intent);
    mkdirSync(join(rt.ledger.dir, "external"), { recursive: true });
    const intentFile = join("external", `${stem}.intent.json`);
    // Persisted in the hash-chained ledger first; the file is a copy for the console.
    const entry = rt.ledger.append("external-intent", { step: i, kind: step.kind, attempt, role: "owner", intent, intent_sha256: sha, intent_file: intentFile, handoff_file: join("external", `${stem}.handoff.json`), planned, pre: spec.pre });
    writeFileSync(join(rt.ledger.dir, intentFile), `${JSON.stringify(intent, null, 2)}\n`);
    rec = intentOf(entry);
  }
  if (handoffOfIntent(rt.ledger, rec.intent_sha256) !== undefined) throw new Stop(`step ${i + 1} ${step.kind}: intent ${rec.intent_sha256} has a recorded handoff that is not verified; rerun with MANDATE_LIVE_RESUME=1 to reconcile it`);
  const h = await obtainHandoff(rt, rec);
  const files = filesOf(rt, rec);
  if (h === null) throw new AwaitingSignature({ step: i + 1, kind: step.kind, attempt: rec.attempt, intent_sha256: rec.intent_sha256, intent_path: files.intent, handoff_path: files.handoff });
  await importHandoff(rt, rec, h);
}

/**
 * Handoffs given in MANDATE_LIVE_HANDOFF are screened before anything runs: a hash the ledger knows, a second hash for
 * a handed-off intent, or an intent this ledger does not have is refused. The rest wait for their pending intent.
 */
async function screenSupplied(rt: Runtime, list: ExternalHandoff[]): Promise<void> {
  const known = knownHashes(rt.ledger);
  for (const h of list) {
    const intent = rt.ledger.ofKind("external-intent").find((e) => e.data.intent_sha256 === h.intent_sha256);
    const step = intent === undefined ? null : z.number().int().parse(intent.data.step);
    if (known.has(h.tx_hash)) refuseHandoff(rt, step, h, [`duplicate: transaction ${h.tx_hash} is already in the ledger`], await refusalFee(rt, h));
    if (intent === undefined) refuseHandoff(rt, null, h, [`unrelated: no intent ${h.intent_sha256} in this ledger`], await refusalFee(rt, h));
    const prior = handoffOfIntent(rt.ledger, h.intent_sha256);
    if (prior !== undefined) refuseHandoff(rt, step, h, [`duplicate: intent ${h.intent_sha256} was already handed off as ${String(prior.data.tx_hash)}`], await refusalFee(rt, h));
    if (rt.external.supplied.has(h.intent_sha256)) refuseHandoff(rt, step, h, [`duplicate: a second handoff for intent ${h.intent_sha256}`], await refusalFee(rt, h));
    rt.external.supplied.set(h.intent_sha256, h);
  }
}

/** Withdrawal steps whose latest attempt was refunded, failed or not sent for a missing registration. */
function retryableWithdrawals(ledger: Ledger, m: LiveManifest): number[] {
  return m.steps.flatMap((s, i) => ((s.kind === "withdraw" || s.kind === "withdraw_external") && doneOfStep(ledger, i).at(-1)?.data.retryable === true ? [i] : []));
}

/** Steps a resume's withdrawal retries may send: each retryable withdrawal and its asset's registration step. */
function retrySteps(ledger: Ledger, m: LiveManifest): Step[] {
  return retryableWithdrawals(ledger, m).flatMap((i) => {
    const s = m.steps[i];
    if (s === undefined || (s.kind !== "withdraw" && s.kind !== "withdraw_external")) return [];
    const reg = m.steps.slice(0, i).findLast((x) => x.kind === "register_storage" && x.asset === s.asset);
    return reg === undefined ? [s] : [reg, s];
  });
}

/** On resume: retries each retryable withdrawal once, re-running the asset's storage registration step first. */
async function retryWithdrawals(rt: Runtime): Promise<void> {
  for (const i of retryableWithdrawals(rt.ledger, rt.m)) {
    const step = rt.m.steps[i];
    if (step === undefined || (step.kind !== "withdraw" && step.kind !== "withdraw_external")) continue;
    console.log(`== retry step ${i + 1} ${step.kind} ${step.asset}`);
    const j = rt.m.steps.slice(0, i).findLastIndex((x) => x.kind === "register_storage" && x.asset === step.asset);
    const reg = rt.m.steps[j];
    // An external retry already waiting for its signature keeps its intent; registration ran before it was written.
    const pendingIntent = step.kind === "withdraw_external" && rt.ledger.ofKind("external-intent").some((e) => e.data.step === i && e.data.attempt === nextAttempt(rt.ledger, i));
    if (reg?.kind === "register_storage" && !pendingIntent) await registerStorage(rt, j, reg);
    if (step.kind === "withdraw") await runnerWithdraw(rt, i, step);
    else await externalStep(rt, i, step);
  }
}

/** A step-done for `step` recorded after ledger entry `seq` (a retried step has one per attempt). */
const doneAfter = (ledger: Ledger, step: number, seq: number): boolean => ledger.ofKind("step-done").some((e) => e.data.step === step && e.seq > seq);

/**
 * Unresolved intents, executed-but-unverified steps and accepted-but-unverified imports are reconciled from chain
 * before anything new. checkNonces then requires every key's nonce to match the ledger.
 */
async function reconcile(rt: Runtime): Promise<void> {
  const { ledger, client } = rt;
  const results = new Map<string, LedgerEntry>();
  for (const e of ledger.entries) if ((e.kind === "tx-result" || e.kind === "reconciled") && typeof e.data.tx_hash === "string") results.set(e.data.tx_hash, e);
  for (const intent of ledger.ofKind("tx-intent")) {
    const hash = z.string().parse(intent.data.tx_hash);
    const step = z.number().int().parse(intent.data.step);
    const signer = z.string().parse(intent.data.signer_id);
    const kind = z.string().parse(intent.data.kind);
    const prior = results.get(hash);
    if (prior !== undefined && prior.data.status === "rejected") continue;
    const found = await client.resolve(`reconcile ${kind}`, signer, hash, z.string().parse(intent.data.method));
    if (found === null || found.ambiguous) {
      throw new Refusal(`cannot resume: transaction ${hash} (step ${step + 1} ${kind}) is not resolvable on chain; it may still be included until it expires. Nothing is resubmitted.`);
    }
    if (prior === undefined || prior.data.status === "ambiguous") ledger.append("reconciled", { step, ...outcomeData(found) });
    else if (prior.data.success !== found.success) throw new Refusal(`cannot resume: ledger says ${hash} success=${String(prior.data.success)}, chain says ${String(found.success)}`);
    rt.receipts.push(toEvidenceReceipt(found, { reconciled: true }));
    if (!doneAfter(ledger, step, intent.seq)) {
      const pre = Pre.parse(intent.data.pre);
      // A failed model proposal goes through its non-fatal verification (a mandate refusal is a finding).
      const failureExpected = FAILURE_EXPECTED.has(kind) || (pre.kind === "propose" && pre.source === "model");
      if (!found.submitted || (!found.success && !failureExpected)) throw new Stop(`step ${step + 1} ${kind}: reconciled transaction ${hash} did not succeed: ${found.error ?? ""}`);
      await finishStep(rt, step, kind, pre, found, typeof intent.data.attempt === "number" ? { attempt: intent.data.attempt } : {});
    }
  }
  // Imports accepted (handoff recorded) whose verification did not complete: verify them from chain, once.
  for (const h of ledger.ofKind("external-handoff")) {
    const step = z.number().int().parse(h.data.step);
    if (doneAfter(ledger, step, h.seq)) continue;
    const recEntry = ledger.ofKind("external-intent").find((e) => e.data.intent_sha256 === h.data.intent_sha256);
    if (recEntry === undefined) throw new Refusal(`cannot resume: handoff ${String(h.data.tx_hash)} names no intent of this ledger`);
    const rec = intentOf(recEntry);
    const hash = z.string().parse(h.data.tx_hash);
    const found = await client.resolve(`reconcile import ${rec.kind}`, rec.intent.signer_id, hash, rec.intent.actions[0]?.method ?? "-");
    if (found === null || found.ambiguous || !found.final) throw new Refusal(`cannot resume: imported transaction ${hash} (step ${step + 1} ${rec.kind}) is not resolvable as final on chain. Nothing is resubmitted.`);
    const prior = results.get(hash);
    if (prior !== undefined && prior.data.success !== found.success) throw new Refusal(`cannot resume: ledger says ${hash} success=${String(prior.data.success)}, chain says ${String(found.success)}`);
    await finishImport(rt, rec, found, "reconciled");
  }
}

/** Every executed transaction of the run's keys must be in the ledger: compare access-key nonces. */
async function checkNonces(rt: Runtime): Promise<void> {
  const { client } = rt;
  for (const k of expectedNonces(rt)) {
    const chain = await client.accessKeyNonce(k.account, k.key);
    if (chain !== k.nonce) {
      throw new Refusal(`cannot resume: ${roleOfKey(rt, k)} key nonce on chain is ${String(chain)}, ledger expects ${k.nonce}; transactions exist that the ledger does not record`);
    }
  }
  const changes = await ownerKeyProblems(rt);
  if (changes.length > 0) throw new Refusal(`cannot resume: the owner account's access keys differ from the run's start snapshot (${changes.join("; ")}); transactions exist that the ledger does not record`);
}

async function execute(rt: Runtime, from: number): Promise<void> {
  for (let i = from; i < rt.m.steps.length; i++) {
    const step = rt.m.steps[i];
    if (step === undefined) break;
    console.log(`== step ${i + 1} ${step.kind}`);
    if (step.kind === "check") {
      const grant = await rt.mandate.grant();
      const observed = { grant, mandate: fromBal(await balancesOf(rt.ctx, rt.mandate.id)), filler: fromBal(await balancesOf(rt.ctx, rt.m.accounts.filler)) };
      rt.assertions.push({ id: `step-${i + 1}-check`, gate: "LIVE", description: "read-only state check", passed: true, observed });
      rt.ledger.append("step-done", { step: i, kind: "check", verification: observed });
      continue;
    }
    if (step.kind === "withhold") {
      await withhold(rt, i, step);
      continue;
    }
    if (step.kind === "relay_withheld") {
      await relayWithheld(rt, i, step);
      continue;
    }
    if (step.kind === "revoke_external" || step.kind === "recover_external" || step.kind === "withdraw_external") {
      await externalStep(rt, i, step);
      continue;
    }
    if (step.kind === "register_storage") {
      await registerStorage(rt, i, step);
      continue;
    }
    if (step.kind === "withdraw") {
      await runnerWithdraw(rt, i, step);
      continue;
    }
    if (step.kind === "fill" || step.kind === "settle") {
      const target = targetOrder(rt, i, step.order_id);
      if (target !== null && "skipped" in target) {
        skipStep(rt, i, step.kind, target.skipped);
        continue;
      }
    }
    if (step.kind === "propose" && step.source.from === "model") {
      const decided = await modelPlan(rt, i, step.expect, step.source);
      if (decided === null) continue;
      checkPlanned(rt.m.budget, totals(rt.ledger), decided.planned);
      await send(rt, i, step, decided);
      continue;
    }
    const p = await plan(rt, i, step);
    checkPlanned(rt.m.budget, totals(rt.ledger), p.planned);
    await send(rt, i, step, p);
  }
}

/** Signs, records the intent and broadcasts once; `gate` runs after signing, immediately before the broadcast. */
async function send(rt: Runtime, i: number, step: Step, p: Plan, gate?: () => Promise<Record<string, unknown>>): Promise<void> {
  const role = STEP_SIGNER[step.kind];
  if (role === undefined) throw new Stop(`step ${i + 1} ${step.kind}: no signer role`);
  // Every transaction of the signer's account must be in the ledger before another is signed: a stray one is never
  // absorbed by taking the chain's next nonce.
  const unrecorded = await unrecordedProblems(rt, rt.m.accounts[role]);
  if (unrecorded.length > 0) throw new Stop(`step ${i + 1} ${step.kind}: unrecorded ${role} transaction: ${unrecorded.join("; ")}; nothing was sent`);
  const key = rt.m.keys[role].public_key;
  const expected = expectedNonces(rt).find((k) => k.key === key)?.nonce;
  const outcome = await rt.client.submit(`step ${i + 1} ${step.kind}`, p.signer, p.receiver, p.actions, p.method, async (info) => {
    if (expected === undefined || info.public_key !== key || BigInt(info.nonce) !== expected + 1n) {
      throw new Stop(`step ${i + 1} ${step.kind}: unrecorded ${role} transaction: signed with ${info.public_key} at nonce ${info.nonce}, the ledger expects ${key} at ${String(expected === undefined ? null : expected + 1n)}; nothing was sent`);
    }
    const extra = gate === undefined ? {} : await gate();
    rt.ledger.append("tx-intent", { step: i, kind: step.kind, role, method: p.method, ...info, planned: p.planned, pre: p.pre, detail: p.detail, ...(p.attempt === undefined ? {} : { attempt: p.attempt }), ...extra });
  });
  rt.ledger.append("tx-result", { step: i, ...outcomeData(outcome) });
  rt.receipts.push(toEvidenceReceipt(outcome, { step: i + 1, ...p.detail }));
  if (outcome.ambiguous) {
    throw new Stop(`step ${i + 1} ${step.kind}: ambiguous outcome for ${outcome.tx_hash ?? "?"} (${outcome.error ?? ""}). Not resubmitted; rerun with MANDATE_LIVE_RESUME=1 to reconcile from chain state.`);
  }
  if (!outcome.submitted) throw new Stop(`step ${i + 1} ${step.kind}: transaction refused by the network: ${outcome.error ?? ""}`);
  await finishStep(rt, i, step.kind, p.pre, outcome, p.attempt === undefined ? {} : { attempt: p.attempt });
}

/**
 * The relay of the withheld bundle. Revocation and the remaining lifetime are checked before preparation and
 * again after signing, immediately before the broadcast: preparation and RPC delays can consume the margin.
 * A skipped relay is inconclusive and the run continues to recovery; unconfirmed revocation stops the run.
 */
async function relayWithheld(rt: Runtime, i: number, step: Extract<Step, { kind: "relay_withheld" }>): Promise<void> {
  const probes: Probe[] = [];
  const lastWithhold = rt.ledger.ofKind("step-done").filter((e) => e.data.kind === "withhold").at(-1);
  if (lastWithhold?.data.skipped === true) {
    skipRelay(rt, i, new RelaySkipped(`no withheld order: step ${z.number().int().parse(lastWithhold.data.step) + 1} withhold was skipped`, { classification: "inconclusive" }), probes);
    return;
  }
  let window: Record<string, unknown> | null = null;
  try {
    const pre = await relayGate(rt, step, "relay pre-check");
    probes.push(pre.probe);
    window = revocationWindow(rt.ledger, pre.probe);
    if (pre.skip !== null) throw new RelaySkipped(pre.skip, pre.observed);
    const p = await plan(rt, i, step);
    const w = latestWithheld(rt.ledger);
    probes.push(await probe(rt, "relay prepared", BigInt(w?.deadline_ns ?? "0"), false));
    try {
      checkPlanned(rt.m.budget, totals(rt.ledger), p.planned);
    } catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      throw new RelaySkipped(error.message, { order_id: (p.pre as { order_id?: string }).order_id ?? null, classification: "inconclusive" });
    }
    await send(rt, i, step, p, async () => {
      const last = await relayGate(rt, step, "relay broadcast");
      probes.push(last.probe);
      if (last.skip !== null) throw new RelaySkipped(last.skip, last.observed);
      return { timing: probes, revocation_window: window };
    });
  } catch (error) {
    if (!(error instanceof RelaySkipped)) throw error;
    skipRelay(rt, i, error, probes, window);
  }
}

export async function runLive(env: NodeJS.ProcessEnv = process.env, deps: LiveDeps = {}): Promise<LiveResult> {
  let loaded: ReturnType<typeof loadManifest>;
  let creds: Record<"owner" | "agent" | "filler" | "filler_intents", Credential>;
  try {
    loaded = loadManifest(env);
    const c = loaded.manifest.credentials;
    const a = loaded.manifest.accounts;
    creds = {
      owner: loadCredential(c.owner, a.owner),
      agent: loadCredential(c.agent, a.agent),
      filler: loadCredential(c.filler, a.filler),
      filler_intents: loadCredential(c.filler_intents, a.filler),
    };
    const keyProblems = credentialProblems(loaded.manifest, {
      ...Object.fromEntries(Object.entries(creds).map(([role, cred]) => [`credential.${role}`, cred.key.getPublicKey().toString()])),
      "manifest.owner": loaded.manifest.keys.owner.public_key,
      "manifest.agent": loaded.manifest.keys.agent.public_key,
      "manifest.filler": loaded.manifest.keys.filler.public_key,
      "manifest.filler_intents": loaded.manifest.keys.filler.intents_public_key,
    });
    if (keyProblems.length > 0) throw new Refusal(`live: ${keyProblems.join("; ")}`);
  } catch (error) {
    return { exitCode: 2, message: error instanceof Error ? error.message : String(error) };
  }
  const m = loaded.manifest;
  // Finalized reads everywhere and transactions awaited to FINAL.
  const client = (deps.client ?? new NearClient(m.network.rpc_url)).final();
  const mandate = new MandateClient(client, m.accounts.mandate);
  const verifier = new VerifierClient(client, m.accounts.verifier);
  const dir = Ledger.dirFor(deps.outRoot ?? join(REPO_ROOT, "out/live"), loaded.sha256);
  const resume = env.MANDATE_LIVE_RESUME === "1";
  const receipts: Receipt[] = [];
  const assertions: Assertion[] = [];
  let checks: Check[] | undefined;
  let exitCode: 0 | 1 | 2 = 0;
  let message = "completed";
  let ledger: Ledger | null = null;
  let awaiting: Awaiting | undefined;
  let supplied: ExternalHandoff[] = [];
  try {
    const handoffPath = env.MANDATE_LIVE_HANDOFF;
    if (handoffPath !== undefined && handoffPath !== "") {
      if (!resume) throw new Refusal("live: MANDATE_LIVE_HANDOFF imports into an existing ledger; set MANDATE_LIVE_RESUME=1");
      try {
        supplied = await readHandoffFile(handoffPath);
      } catch (error) {
        throw new Refusal(`live: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (resume) ledger = Ledger.load(dir, loaded.sha256);
    else if (Ledger.exists(dir)) throw new Refusal(`ledger already exists at ${dir}; set MANDATE_LIVE_RESUME=1 to resume it`);
    const ctx: VerifyContext = { mandate, verifier, tokens: { usdc: m.mandate_config.usdc.token, wnear: m.mandate_config.wnear.token }, timeoutMs: deps.timeoutMs ?? 180_000, pollMs: deps.pollMs ?? 1_000 };
    const runtime = (l: Ledger, gasPrice: bigint): Runtime => ({
      m,
      client,
      mandate,
      verifier,
      ledger: l,
      ctx,
      accounts: {
        owner: client.account(creds.owner.accountId, creds.owner.key),
        agent: client.account(creds.agent.accountId, creds.agent.key),
        filler: client.account(creds.filler.accountId, creds.filler.key),
      },
      filler: new Filler({ client, mandate, verifier, account: client.account(creds.filler.accountId, creds.filler.key), key: creds.filler_intents.key, statePath: join(dir, "filler-unused.json") }),
      gasPrice,
      receipts,
      assertions,
      agent: { provider: deps.modelProvider, allowNewDecision: env.MANDATE_LIVE_ALLOW_NEW_DECISION === "1", env },
      external: { supply: deps.handoff, waitMs: deps.handoffWaitMs ?? Number(env.MANDATE_LIVE_HANDOFF_WAIT_SEC ?? "0") * 1_000, supplied: new Map() },
    });
    // A resume first proves it is on the ledger's chain, then reconciles (reads only, nothing is sent),
    // so that preflight sees the orders and fees the interrupted run actually produced.
    let rt: Runtime | null = null;
    if (ledger !== null) {
      const status = await client.nodeStatus();
      const start = ledger.entries[0];
      if (start === undefined || start.data.genesis_hash !== status.genesis_hash) throw new Refusal("cannot resume: ledger was written against another chain");
      rt = runtime(ledger, await client.gasPrice());
      await reconcile(rt);
      // Handed-off hashes are screened before the nonce check, so a duplicate is refused for what it is.
      await screenSupplied(rt, supplied);
      await importAvailable(rt);
      await checkNonces(rt);
    }
    const pf = await preflight({
      client,
      manifest: m,
      mandate,
      verifier,
      credentialKeys: {
        owner: creds.owner.key.getPublicKey().toString(),
        agent: creds.agent.key.getPublicKey().toString(),
        filler: creds.filler.key.getPublicKey().toString(),
        filler_intents: creds.filler_intents.key.getPublicKey().toString(),
      },
      fresh: ledger === null,
      spentFeeYocto: ledger === null ? 0n : totals(ledger).fee_yocto,
      pending: ledger === null ? m.steps : [...pendingSteps(ledger, m), ...retrySteps(ledger, m)],
      createdOrders: ledger === null ? [] : createdOrders(ledger),
      fillerPaid: ledger === null ? { usdc: 0n, wnear: 0n } : totals(ledger).filler_paid,
    });
    checks = pf.checks;
    if (!pf.passed) throw new Refusal(`preflight refused: ${pf.checks.filter((c) => !c.passed).map((c) => c.id).join(", ")}`);
    if (ledger === null) {
      ledger = Ledger.create(dir, loaded.sha256);
      ledger.append("start", { manifest_sha256: loaded.sha256, ...pf.facts, preflight: pf.checks });
    }
    rt = { ...(rt ?? runtime(ledger, 0n)), gasPrice: BigInt(pf.facts.gas_price) };
    await execute(rt, nextStepIndex(ledger));
    if (resume) await retryWithdrawals(rt);
    for (const h of rt.external.supplied.values()) refuseHandoff(rt, null, h, [`unrelated: intent ${h.intent_sha256} is not pending in this run`], await refusalFee(rt, h));
    // The checks before each send never see a transaction made after the last one; without this it surfaces only on resume.
    const unrecorded: string[] = [];
    for (const role of ["owner", "agent", "filler"] as const) {
      const problems = await unrecordedProblems(rt, m.accounts[role]);
      if (problems.length > 0) unrecorded.push(`unrecorded ${role} transaction after the last step: ${problems.join("; ")}`);
    }
    if (unrecorded.length > 0) throw new Stop(`${unrecorded.join(" | ")}; transactions exist that the ledger does not record`);
    const findings = currentFindings(ledger);
    if (findings.length > 0) {
      exitCode = 1;
      message = `completed with findings: ${findings.join(" | ")}`;
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (error instanceof BudgetExceeded || error instanceof Stop) exitCode = 1;
    else if (error instanceof Refusal) exitCode = 2;
    else exitCode = 1;
    message = text;
    if (error instanceof AwaitingSignature) awaiting = error.info;
    if (ledger !== null && exitCode === 1) ledger.append("stopped", { reason: text });
  }
  if (exitCode !== 0 && ledger === null) return { exitCode, message, ...(checks === undefined ? {} : { preflight: checks }) };
  const extra = { ...(checks === undefined ? {} : { preflight: checks }), ...(awaiting === undefined ? {} : { awaiting }) };
  const binding = sourceBinding(REPO_ROOT, m.code_hashes.mandate);
  const evidence = Evidence.parse({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: m.network.name === "mainnet" ? "mainnet" : "sandbox",
    source: binding.source,
    environment: environment(REPO_ROOT, { rpc_url: m.network.rpc_url, chain_id: m.network.chain_id, manifest_sha256: loaded.sha256, ledger: dir }),
    command: resume ? "MANDATE_LIVE=1 MANDATE_LIVE_RESUME=1 make live" : "MANDATE_LIVE=1 make live",
    identifiers: { ...m.accounts, mandate_code_hash: m.code_hashes.mandate, approval: `${m.approval.approved_by}: ${m.approval.reference}` },
    receipts,
    assertions: [...(checks ?? []).map((c) => ({ id: `preflight-${c.id}`, gate: "LIVE", description: `preflight ${c.id}`, passed: c.passed, observed: c.observed })), ...earlierSteps(ledger, assertions), ...assertions],
    unknowns: exitCode === 0 ? [] : [message.startsWith("completed with findings") ? message : `run stopped: ${message}`],
  });
  const outDir = join(deps.outRoot ?? join(REPO_ROOT, "out/live"), "..", "evidence");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `live-${m.network.name}.json`), `${JSON.stringify(evidence, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  return { exitCode, message, evidence, ...extra };
}

/** Findings of each step's latest verification: a refunded withdrawal retried successfully is no longer one. */
function currentFindings(ledger: Ledger): string[] {
  const latest = new Map<unknown, LedgerEntry>();
  for (const e of ledger.ofKind("step-done")) latest.set(e.data.step, e);
  return [...latest.values()].sort((a, b) => a.seq - b.seq).flatMap((e) => (typeof e.data.finding === "string" ? [e.data.finding] : []));
}

/** Steps completed by an earlier session of this ledger, so a resumed run's evidence covers the whole run. */
function earlierSteps(ledger: Ledger | null, current: Assertion[]): Assertion[] {
  if (ledger === null) return [];
  const seen = new Set(current.map((a) => a.id));
  return ledger.ofKind("step-done").flatMap((e) => {
    const step = z.number().int().parse(e.data.step);
    const kind = z.string().parse(e.data.kind);
    const id = assertionId(step, kind, e.data.attempt);
    if (seen.has(id)) return [];
    const observed = { ...(typeof e.data.verification === "object" && e.data.verification !== null ? e.data.verification : {}), recorded_at: e.at, from_ledger: true };
    return [{ id, gate: "LIVE", description: `${kind}: verified in an earlier session (ledger entry ${e.seq})`, passed: typeof e.data.finding !== "string", observed }];
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runLive();
  for (const c of result.preflight ?? []) console.log(`preflight ${c.passed ? "PASS" : "FAIL"} ${c.id}${c.passed ? "" : `: ${JSON.stringify(c.observed)}`}`);
  console.log(result.message);
  process.exitCode = result.exitCode;
}
