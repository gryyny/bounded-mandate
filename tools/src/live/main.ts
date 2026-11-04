// `MANDATE_LIVE=1 make live`: executes an approved manifest against a configured RPC.
// - Preflight binds network, code, config, keys and balances to the manifest; any mismatch refuses (exit 2).
// - Every transaction is written to a hash-chained ledger before it is sent; budget is derived from it.
// - Each step ends with an operation-specific terminal check over chain state and the whole receipt tree.
// - An ambiguous outcome stops the run (exit 1). Nothing is ever resubmitted or substituted; a resume
//   (MANDATE_LIVE_RESUME=1) first reconciles the ledger with chain state.
// The flag is not spending approval; mainnet additionally needs MANDATE_LIVE_CONFIRM=<manifest sha256>.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { actions, type Account, type Action } from "near-api-js";
import { z } from "zod";
import { decide, decisionRecord } from "../agent/adapter.js";
import { AnthropicProvider, ClaudeCliProvider, type ModelProvider } from "../agent/providers.js";
import { buildSnapshot } from "../agent/snapshot.js";
import { environment, sourceBinding } from "../evidence/source.js";
import { payableFor } from "../filler/arithmetic.js";
import { Filler, mandateLeg } from "../filler/filler.js";
import { NearClient, TGAS, plannedDeposit, toEvidenceReceipt, type Outcome } from "../near/client.js";
import { MandateClient, VerifierClient, tokenId } from "../near/contracts.js";
import { loadCredential, type Credential } from "../near/credentials.js";
import { REPO_ROOT } from "../near/sandbox.js";
import { Evidence, GrantView, OrderView, type Asset, type Assertion, type Proposal, type Receipt } from "../types.js";
import { BudgetExceeded, checkActual, checkPlanned, totals, type Planned } from "./budget.js";
import { Ledger, type LedgerEntry } from "./ledger.js";
import { Refusal, loadManifest, type LiveManifest, type Step } from "./manifest.js";
import { STEP_SIGNER, preflight, worstFee, type Check } from "./preflight.js";
import { balancesOf, verifyFill, verifyGrant, verifyPropose, verifyReconcile, verifyRecover, verifyRevoke, verifySettle, type Balances, type Verification, type VerifyContext } from "./verify.js";

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
}

const BalancesJson = z.object({ usdc: z.string(), wnear: z.string() }).strict();
const toBal = (b: z.infer<typeof BalancesJson>): Balances => ({ usdc: BigInt(b.usdc), wnear: BigInt(b.wnear) });
const fromBal = (b: Balances) => ({ usdc: b.usdc.toString(), wnear: b.wnear.toString() });

/** State captured before a transaction, persisted in its intent so a resume can verify it. */
const Pre = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant"), previous_epoch: z.number().int().nullable() }).strict(),
  z.object({ kind: z.literal("propose"), proposal: z.object({ sell: z.enum(["usdc", "wnear"]), sell_amount: z.string(), max_concession_bps: z.number().int() }).strict(), expect: z.enum(["signed", "rejected"]), grant: GrantView }).strict(),
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
}

class Stop extends Error {}

/** Orders created by this run (from propose step-done entries), in order. */
const createdOrders = (ledger: Ledger): string[] =>
  ledger.ofKind("step-done").flatMap((e) => (typeof e.data.order_id === "string" ? [e.data.order_id] : []));

const nextStepIndex = (ledger: Ledger): number => {
  const done = ledger.ofKind("step-done").map((e) => z.number().int().parse(e.data.step));
  return done.length === 0 ? 0 : Math.max(...done) + 1;
};

function orderAllowed(rt: Runtime, orderId: string): void {
  if (!createdOrders(rt.ledger).includes(orderId) && !rt.m.fillable_preexisting_orders.includes(orderId)) {
    throw new Stop(`order ${orderId} was not created by this run and is not listed in fillable_preexisting_orders; refused`);
  }
}

const fc = (method: string, args: Record<string, unknown>, tgas: number): Action => actions.functionCall(method, args, BigInt(tgas) * TGAS, 0n);

async function plan(rt: Runtime, i: number, step: Exclude<Step, { kind: "check" }>): Promise<Plan> {
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
    case "propose": {
      const grant = await mandate.grant();
      if (grant === null) throw new Stop("propose: no grant");
      let proposal: Proposal;
      let detail: Record<string, unknown> = { source: step.source.from };
      if (step.source.from === "manifest") {
        proposal = step.source.proposal;
      } else {
        if (grant.initial_reference === null) throw new Stop("propose: grant has no reference to show the model");
        const provider: ModelProvider = step.source.provider === "anthropic" ? new AnthropicProvider() : new ClaudeCliProvider();
        const snapshot = buildSnapshot({
          grant,
          prices: { usdc: grant.initial_reference.usdc, wnear: grant.initial_reference.wnear },
          decimals: { usdc: m.mandate_config.usdc.decimals, wnear: m.mandate_config.wnear.decimals },
          balances: await balancesOf(rt.ctx, mandate.id),
          notes: step.source.notes,
        });
        const decision = await decide(provider, snapshot);
        detail = { source: "live-model", decision: decisionRecord(decision) };
        if (decision.verdict.kind !== "proposal") throw new Stop(`model did not propose (${decision.verdict.kind}); nothing submitted`);
        proposal = decision.verdict.proposal;
      }
      const a = [fc("propose_order", { proposal }, g.propose)];
      return {
        signer: rt.accounts.agent,
        receiver: mandate.id,
        method: "propose_order",
        actions: a,
        planned: { ...base("propose", a), sell: { asset: proposal.sell, units: proposal.sell_amount } },
        pre: { kind: "propose", proposal, expect: step.expect, grant },
        detail,
      };
    }
    case "fill": {
      const orderId = step.order_id ?? createdOrders(rt.ledger).at(-1);
      if (orderId === undefined) throw new Stop("fill: no order id");
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
      const orderId = step.order_id ?? createdOrders(rt.ledger).at(-1);
      if (orderId === undefined) throw new Stop("settle: no order id");
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

async function verify(rt: Runtime, pre: Pre, outcome: Outcome): Promise<Verification & { data: Record<string, unknown> }> {
  const { ctx } = rt;
  switch (pre.kind) {
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
  const breach = checkActual(rt.m.budget, totals(rt.ledger));
  if (breach !== null) throw new Stop(`budget: ${breach}`);
  const v = await verify(rt, pre, outcome);
  rt.assertions.push({ id: `step-${step + 1}-${kind}`, gate: "LIVE", description: `${kind}: terminal verification`, passed: v.passed, observed: { ...v.observed, problems: v.problems } });
  if (!v.passed) throw new Stop(`step ${step + 1} ${kind}: terminal verification failed: ${v.problems.join("; ")}`);
  rt.ledger.append("step-done", { step, kind, verification: v.observed, ...v.data });
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
      if (!found.submitted || !found.success) throw new Stop(`step ${step + 1} ${kind}: reconciled transaction ${hash} did not succeed: ${found.error ?? ""}`);
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
    const p = await plan(rt, i, step);
    checkPlanned(rt.m.budget, totals(rt.ledger), p.planned);
    const role = STEP_SIGNER[step.kind];
    const outcome = await rt.client.submit(`step ${i + 1} ${step.kind}`, p.signer, p.receiver, p.actions, p.method, (info) => {
      rt.ledger.append("tx-intent", { step: i, kind: step.kind, role, method: p.method, ...info, planned: p.planned, pre: p.pre, detail: p.detail });
    });
    rt.ledger.append("tx-result", { step: i, ...outcomeData(outcome) });
    rt.receipts.push(toEvidenceReceipt(outcome, { step: i + 1, ...p.detail }));
    if (outcome.ambiguous) {
      throw new Stop(`step ${i + 1} ${step.kind}: ambiguous outcome for ${outcome.tx_hash ?? "?"} (${outcome.error ?? ""}). Not resubmitted; rerun with MANDATE_LIVE_RESUME=1 to reconcile from chain state.`);
    }
    if (!outcome.submitted) throw new Stop(`step ${i + 1} ${step.kind}: transaction refused by the network: ${outcome.error ?? ""}`);
    await finishStep(rt, i, step.kind, p.pre, outcome);
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
  } catch (error) {
    return { exitCode: 2, message: error instanceof Error ? error.message : String(error) };
  }
  const m = loaded.manifest;
  const client = deps.client ?? new NearClient(m.network.rpc_url);
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
    const spent = ledger === null ? 0n : totals(ledger).fee_yocto;
    const from = ledger === null ? 0 : nextStepIndex(ledger);
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
      spentFeeYocto: spent,
      remaining: m.steps.slice(from),
    });
    checks = pf.checks;
    if (!pf.passed) throw new Refusal(`preflight refused: ${pf.checks.filter((c) => !c.passed).map((c) => c.id).join(", ")}`);
    if (ledger === null) {
      ledger = Ledger.create(dir, loaded.sha256);
      ledger.append("start", { manifest_sha256: loaded.sha256, ...pf.facts, preflight: pf.checks });
    } else if (ledger.entries[0]?.data.genesis_hash !== pf.facts.genesis_hash) {
      throw new Refusal("cannot resume: ledger was written against another chain");
    }
    const start = ledger.entries[0];
    const startNonces = z.object({ owner: z.string(), agent: z.string(), filler: z.string() }).parse(start?.data.nonces);
    const ctx: VerifyContext = { mandate, verifier, tokens: { usdc: m.mandate_config.usdc.token, wnear: m.mandate_config.wnear.token }, timeoutMs: deps.timeoutMs ?? 180_000, pollMs: deps.pollMs ?? 1_000 };
    const rt: Runtime = {
      m,
      client,
      mandate,
      verifier,
      ledger,
      ctx,
      accounts: {
        owner: client.account(creds.owner.accountId, creds.owner.key),
        agent: client.account(creds.agent.accountId, creds.agent.key),
        filler: client.account(creds.filler.accountId, creds.filler.key),
      },
      filler: new Filler({ client, mandate, verifier, account: client.account(creds.filler.accountId, creds.filler.key), key: creds.filler_intents.key, statePath: join(dir, "filler-unused.json") }),
      gasPrice: BigInt(pf.facts.gas_price),
      receipts,
      assertions,
    };
    if (resume) await reconcile(rt, startNonces);
    await execute(rt, nextStepIndex(ledger));
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
    assertions: [...(checks ?? []).map((c) => ({ id: `preflight-${c.id}`, gate: "LIVE", description: `preflight ${c.id}`, passed: c.passed, observed: c.observed })), ...assertions],
    unknowns: exitCode === 0 ? [] : [`run stopped: ${message}`],
  });
  const outDir = join(deps.outRoot ?? join(REPO_ROOT, "out/live"), "..", "evidence");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `live-${m.network.name}.json`), `${JSON.stringify(evidence, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  return { exitCode, message, evidence, ...(checks === undefined ? {} : { preflight: checks }) };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runLive();
  for (const c of result.preflight?.filter((x) => !x.passed) ?? []) console.error(`preflight FAILED ${c.id}: ${JSON.stringify(c.observed)}`);
  console.log(result.message);
  process.exitCode = result.exitCode;
}
