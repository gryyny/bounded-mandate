// `MANDATE_LIVE=1 make live`: executes an approved manifest against a configured RPC.
// - Preflight binds network, code, config, keys and balances to the manifest; any mismatch refuses (exit 2).
// - Every transaction is written to a hash-chained ledger before it is sent; budget is derived from it.
// - Each step ends with an operation-specific terminal check over chain state and the whole receipt tree.
// - An ambiguous outcome stops the run (exit 1). Nothing is ever resubmitted or substituted; a resume
//   (MANDATE_LIVE_RESUME=1) first reconciles the ledger with chain state.
// - A model-sourced propose step is a recorded agent decision (decision-request before the model call, decision
//   after it). A recorded decision is never re-asked; a request without a result stops unless
//   MANDATE_LIVE_ALLOW_NEW_DECISION=1. A no-action sends nothing, and fill/settle/withhold of that step are skipped.
// The flag is not spending approval; mainnet additionally needs MANDATE_LIVE_CONFIRM=<manifest sha256>.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { actions, type Account, type Action } from "near-api-js";
import { z } from "zod";
import { toRecording, writeRecording } from "../agent/live-recording.js";
import { AnthropicProvider, ClaudeCliProvider, NearAiProvider, type LiveModelProvider } from "../agent/providers.js";
import { RebalanceVerdict, allocation, assess, callModel, inputsFrom, judgeCall, objectiveProblems, readObservations, type FreshObservations } from "../agent/rebalance.js";
import { environment, sourceBinding } from "../evidence/source.js";
import { payableFor } from "../filler/arithmetic.js";
import { Filler, mandateLeg } from "../filler/filler.js";
import { NearClient, TGAS, plannedDeposit, toEvidenceReceipt, type Outcome } from "../near/client.js";
import { MandateClient, VerifierClient, tokenId } from "../near/contracts.js";
import { loadCredential, type Credential } from "../near/credentials.js";
import { REPO_ROOT } from "../near/sandbox.js";
import { Evidence, GrantView, OrderView, SignedNep413, type Asset, type Assertion, type Proposal, type Receipt } from "../types.js";
import { BudgetExceeded, checkActual, checkPlanned, sellProblem, totals, type Planned } from "./budget.js";
import { Ledger, canonical, type LedgerEntry } from "./ledger.js";
import { Refusal, loadManifest, type LiveManifest, type ModelSource, type Step } from "./manifest.js";
import { credentialProblems } from "./network.js";
import { STEP_SIGNER, preflight, worstFee, type Check } from "./preflight.js";
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
  type Balances,
  type Verification,
  type VerifyContext,
} from "./verify.js";

export { LiveManifest, Refusal, loadManifest } from "./manifest.js";

export interface LiveResult {
  /** 0 completed, 1 stopped (failed check, budget, ambiguity), 2 refused before acting. */
  exitCode: 0 | 1 | 2;
  message: string;
  evidence?: Evidence;
  preflight?: Check[];
}

export interface LiveDeps {
  client?: NearClient;
  /** Ledger root; defaults to out/live. */
  outRoot?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Replaces the manifest's model provider for every model-sourced step (tests use labelled synthetic providers). */
  modelProvider?: LiveModelProvider;
}

const BalancesJson = z.object({ usdc: z.string(), wnear: z.string() }).strict();
const toBal = (b: z.infer<typeof BalancesJson>): Balances => ({ usdc: BigInt(b.usdc), wnear: BigInt(b.wnear) });
const fromBal = (b: Balances) => ({ usdc: b.usdc.toString(), wnear: b.wnear.toString() });

const ProposalJson = z.object({ sell: z.enum(["usdc", "wnear"]), sell_amount: z.string(), max_concession_bps: z.number().int() }).strict();

/** State captured before a transaction, persisted in its intent so a resume can verify it. */
const Pre = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant"), previous_epoch: z.number().int().nullable() }).strict(),
  z.object({ kind: z.literal("propose"), proposal: ProposalJson, expect: z.enum(["signed", "rejected"]), grant: GrantView }).strict(),
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
}

class Stop extends Error {}

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
interface Probe {
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
const FAILURE_EXPECTED = new Set<string>(["refused_proposal", "relay_withheld"]);

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
  const intended = new Set(ledger.ofKind("tx-intent").filter((e) => !rejected.has(String(e.data.tx_hash))).map((e) => e.data.step));
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

async function proposePlan(rt: Runtime, expect: "signed" | "rejected", proposal: Proposal, detail: Record<string, unknown>): Promise<Plan> {
  const grant = await rt.mandate.grant();
  if (grant === null) throw new Stop("propose: no grant");
  const a = [fc("propose_order", { proposal }, rt.m.gas_tgas.propose)];
  return {
    signer: rt.accounts.agent,
    receiver: rt.mandate.id,
    method: "propose_order",
    actions: a,
    planned: { worst_fee_yocto: worstFee(rt.m, "propose", rt.gasPrice).toString(), deposit_yocto: plannedDeposit(a).toString(), sell: { asset: proposal.sell, units: proposal.sell_amount } },
    pre: { kind: "propose", proposal, expect, grant },
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
  if (rt.agent.provider !== undefined) return rt.agent.provider;
  switch (source.provider) {
    case "anthropic":
      return new AnthropicProvider(source.model);
    case "claude-cli":
      return new ClaudeCliProvider(source.model);
    case "near-ai": {
      const { model, timeout_ms, max_tokens } = source;
      if (model === undefined || timeout_ms === undefined || max_tokens === undefined) throw new Error("near-ai needs model, timeout_ms and max_tokens");
      return NearAiProvider.fromEnv(rt.agent.env, { model, timeoutMs: timeout_ms, maxTokens: max_tokens });
    }
  }
}

/**
 * A new agent decision from fresh inputs. The request is persisted before the model is called, the result
 * (exact raw output, verdicts, recording file) after it; balanced or unusable inputs never call the model.
 */
async function newDecision(rt: Runtime, i: number, source: ModelSource, supersedes: number | null): Promise<LedgerEntry> {
  const observations = await observe(rt);
  const decimals = decimalsOf(rt.m);
  const usable = inputsFrom(observations, decimals);
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
    requested_model: source.model ?? null,
    prompt_version: a.prompt.version,
    prompt_sha256: a.prompt.sha256,
    request_body: requestBody,
    observations,
    allocation: a.allocation,
  });
  const result = await callModel(provider, a.prompt);
  const judged = judgeCall(usable.inputs, a.allocation, result);
  const rec = toRecording(
    { step: i, requestSeq: request.seq, provider: provider.name, requestedModel: source.model ?? null, observations, decimals, notes: source.notes, requestBody },
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
 * decision is never re-asked: on resume its proposal is re-checked against fresh state and submitted unchanged,
 * or the step becomes a no-action. Returns null when nothing is to be sent.
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
  if (resumed) {
    const observations = await observe(rt);
    const usable = inputsFrom(observations, decimalsOf(rt.m));
    const problems = usable.ok ? objectiveProblems(usable.inputs, allocation(usable.inputs), verdict.proposal) : usable.problems;
    evidence.recheck = { observations, problems };
    if (problems.length > 0) {
      const reason = `recorded proposal not acceptable at fresh state: ${problems.join("; ")}`;
      noAction(rt, i, reason, evidence, usable.ok ? null : reason);
      return null;
    }
  }
  const overBudget = sellProblem(rt.m.budget, totals(rt.ledger), { asset: verdict.proposal.sell, units: verdict.proposal.sell_amount });
  if (overBudget !== null) {
    noAction(rt, i, "proposal exceeds the run budget", evidence, `budget: ${overBudget}`);
    return null;
  }
  return proposePlan(rt, expect, verdict.proposal, { source: "live-model", ...evidence });
}

async function plan(rt: Runtime, i: number, step: Exclude<Step, { kind: "check" | "withhold" }>): Promise<Plan> {
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

/** Records the verification of an executed step; a failed check stops the run. */
async function finishStep(rt: Runtime, step: number, kind: string, pre: Pre, outcome: Outcome): Promise<void> {
  if (!outcome.final) throw new Stop(`step ${step + 1} ${kind}: outcome of ${outcome.tx_hash ?? "?"} is not final (${outcome.final_execution_status ?? "unknown"}); rerun with MANDATE_LIVE_RESUME=1 once final`);
  const breach = checkActual(rt.m.budget, totals(rt.ledger));
  if (breach !== null) throw new Stop(`budget: ${breach}`);
  const v = await verify(rt, pre, outcome);
  const observed = kind === "relay_withheld" ? { ...v.observed, timing: deadlineTimeline(rt.ledger, []) } : v.observed;
  rt.assertions.push({ id: `step-${step + 1}-${kind}`, gate: "LIVE", description: `${kind}: terminal verification`, passed: v.passed, observed: { ...observed, problems: v.problems } });
  if (!v.passed && v.fatal !== false) throw new Stop(`step ${step + 1} ${kind}: terminal verification failed: ${v.problems.join("; ")}`);
  rt.ledger.append("step-done", { step, kind, verification: observed, ...v.data, ...(v.passed ? {} : { finding: `step ${step + 1} ${kind}: ${v.problems.join("; ")}` }) });
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
    problem = simulationProblem(await rt.verifier.simulate(prepared.bundle));
    withheld = { ...base, bundle: prepared.bundle, bundle_sha256: sha256Of(prepared.bundle), filler_nonce: prepared.own.payload.nonce, counter: prepared.counter, executable: problem === null };
  }
  const timing = await probe(rt, "withheld bundle prepared and simulated", BigInt(order.deadline_ns), true);
  const observed = { order_id: orderId, deadline_ns: order.deadline_ns, bundle_sha256: withheld.bundle_sha256, executable: withheld.executable, timing, ...(problem === null ? {} : { problem }) };
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
function deadlineTimeline(ledger: Ledger, extra: Probe[]): Record<string, unknown> {
  const w = latestWithheld(ledger);
  if (w === null) return { deadline_ns: null, phases: extra };
  const deadlineMs = Number(BigInt(w.deadline_ns) / 1_000_000n);
  const withholdDone = ledger.ofKind("step-done").filter((e) => e.data.kind === "withhold").at(-1);
  const intents = ledger.ofKind("tx-intent");
  const doneOf = (intent: LedgerEntry | undefined): LedgerEntry | undefined =>
    intent === undefined ? undefined : ledger.ofKind("step-done").find((e) => e.data.step === intent.data.step && e.data.kind === intent.data.kind);
  const propose = intents.filter((e) => e.data.kind === "propose" && e.seq < (withholdDone?.seq ?? Number.POSITIVE_INFINITY)).at(-1);
  const revoke = intents.filter((e) => e.data.kind === "revoke").at(-1);
  const relay = intents.filter((e) => e.data.kind === "relay_withheld").at(-1);
  const wall = (phase: string, e: LedgerEntry | undefined): Probe[] => (e === undefined ? [] : [{ phase, at: e.at, chain_ns: null, remaining_ms: null }]);
  const recorded = (v: unknown): Probe[] => z.array(z.object({ phase: z.string(), at: z.string(), chain_ns: z.string().nullable(), remaining_ms: z.number().nullable() })).catch([]).parse(Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const withholdTiming = (withholdDone?.data.verification as { timing?: unknown } | undefined)?.timing;
  const phases = [
    ...wall("withheld order proposed (sent)", propose),
    ...wall("withheld order signed (propose confirmed by runner)", doneOf(propose)),
    ...(withholdTiming === undefined ? wall("withheld bundle prepared and simulated", withholdDone) : recorded(withholdTiming)),
    ...wall("revoke sent", revoke),
    ...wall("revoke confirmed by runner", doneOf(revoke)),
    ...recorded(relay?.data.timing),
    ...extra,
  ].map((ph) => ({ ...ph, wall_remaining_ms: deadlineMs - Date.parse(ph.at) }));
  return {
    deadline_ns: w.deadline_ns,
    note: "at and wall_remaining_ms use the runner's clock; chain_ns and remaining_ms use the final block's timestamp, which the verifier's deadline check follows. A phase confirmed by runner is the time its step's terminal verification was recorded (after a reconciling resume, if the response was lost), not the block time of finality",
    phases,
  };
}

/** Records a relay that was not broadcast as inconclusive. */
function skipRelay(rt: Runtime, i: number, skipped: RelaySkipped, probes: Probe[]): void {
  const verification = { ...skipped.observed, timing: deadlineTimeline(rt.ledger, probes) };
  rt.assertions.push({ id: `step-${i + 1}-relay_withheld`, gate: "LIVE", description: "relay_withheld: not sent", passed: false, observed: { ...verification, problems: [skipped.message] } });
  rt.ledger.append("step-done", { step: i, kind: "relay_withheld", verification, classification: "inconclusive", sent: false, finding: `step ${i + 1} relay_withheld: inconclusive, not sent: ${skipped.message}` });
}

/** Unresolved intents and executed-but-unverified steps are reconciled from chain before anything new. */
async function reconcile(rt: Runtime, startNonces: Record<"owner" | "agent" | "filler", string>): Promise<void> {
  const { ledger, client } = rt;
  const results = new Map<string, LedgerEntry>();
  for (const e of ledger.entries) if ((e.kind === "tx-result" || e.kind === "reconciled") && typeof e.data.tx_hash === "string") results.set(e.data.tx_hash, e);
  const doneSteps = new Set(ledger.ofKind("step-done").map((e) => e.data.step));
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
    if (!doneSteps.has(step)) {
      if (!found.submitted || (!found.success && !FAILURE_EXPECTED.has(kind))) throw new Stop(`step ${step + 1} ${kind}: reconciled transaction ${hash} did not succeed: ${found.error ?? ""}`);
      await finishStep(rt, step, kind, Pre.parse(intent.data.pre), found);
      doneSteps.add(step);
    }
  }
  // Every executed transaction of ours must be in the ledger: compare access-key nonces.
  const expected: Record<"owner" | "agent" | "filler", bigint> = { owner: BigInt(startNonces.owner), agent: BigInt(startNonces.agent), filler: BigInt(startNonces.filler) };
  for (const intent of ledger.ofKind("tx-intent")) {
    const role = z.enum(["owner", "agent", "filler"]).parse(intent.data.role);
    const hash = z.string().parse(intent.data.tx_hash);
    const res = [...ledger.entries].reverse().find((e) => (e.kind === "tx-result" || e.kind === "reconciled") && e.data.tx_hash === hash);
    if (res?.data.status === "executed") expected[role] = BigInt(z.string().parse(intent.data.nonce));
  }
  for (const role of ["owner", "agent", "filler"] as const) {
    const key = role === "owner" ? rt.m.keys.owner.public_key : role === "agent" ? rt.m.keys.agent.public_key : rt.m.keys.filler.public_key;
    const chain = await client.accessKeyNonce(rt.m.accounts[role], key);
    if (chain !== expected[role]) {
      throw new Refusal(`cannot resume: ${role} key nonce on chain is ${String(chain)}, ledger expects ${expected[role]}; transactions exist that the ledger does not record`);
    }
  }
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
  const outcome = await rt.client.submit(`step ${i + 1} ${step.kind}`, p.signer, p.receiver, p.actions, p.method, async (info) => {
    const extra = gate === undefined ? {} : await gate();
    rt.ledger.append("tx-intent", { step: i, kind: step.kind, role, method: p.method, ...info, planned: p.planned, pre: p.pre, detail: p.detail, ...extra });
  });
  rt.ledger.append("tx-result", { step: i, ...outcomeData(outcome) });
  rt.receipts.push(toEvidenceReceipt(outcome, { step: i + 1, ...p.detail }));
  if (outcome.ambiguous) {
    throw new Stop(`step ${i + 1} ${step.kind}: ambiguous outcome for ${outcome.tx_hash ?? "?"} (${outcome.error ?? ""}). Not resubmitted; rerun with MANDATE_LIVE_RESUME=1 to reconcile from chain state.`);
  }
  if (!outcome.submitted) throw new Stop(`step ${i + 1} ${step.kind}: transaction refused by the network: ${outcome.error ?? ""}`);
  await finishStep(rt, i, step.kind, p.pre, outcome);
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
  try {
    const pre = await relayGate(rt, step, "relay pre-check");
    probes.push(pre.probe);
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
      return { timing: probes };
    });
  } catch (error) {
    if (!(error instanceof RelaySkipped)) throw error;
    skipRelay(rt, i, error, probes);
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
  try {
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
    });
    // A resume first proves it is on the ledger's chain, then reconciles (reads only, nothing is sent),
    // so that preflight sees the orders and fees the interrupted run actually produced.
    let rt: Runtime | null = null;
    if (ledger !== null) {
      const status = await client.nodeStatus();
      const start = ledger.entries[0];
      if (start === undefined || start.data.genesis_hash !== status.genesis_hash) throw new Refusal("cannot resume: ledger was written against another chain");
      const startNonces = z.object({ owner: z.string(), agent: z.string(), filler: z.string() }).parse(start.data.nonces);
      rt = runtime(ledger, await client.gasPrice());
      await reconcile(rt, startNonces);
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
      pending: ledger === null ? m.steps : pendingSteps(ledger, m),
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
    const findings = ledger.ofKind("step-done").flatMap((e) => (typeof e.data.finding === "string" ? [e.data.finding] : []));
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
    if (ledger !== null && exitCode === 1) ledger.append("stopped", { reason: text });
  }
  if (exitCode !== 0 && ledger === null) return { exitCode, message, ...(checks === undefined ? {} : { preflight: checks }) };
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
  return { exitCode, message, evidence, ...(checks === undefined ? {} : { preflight: checks }) };
}

/** Steps completed by an earlier session of this ledger, so a resumed run's evidence covers the whole run. */
function earlierSteps(ledger: Ledger | null, current: Assertion[]): Assertion[] {
  if (ledger === null) return [];
  const seen = new Set(current.map((a) => a.id));
  return ledger.ofKind("step-done").flatMap((e) => {
    const step = z.number().int().parse(e.data.step);
    const kind = z.string().parse(e.data.kind);
    const id = `step-${step + 1}-${kind}`;
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
