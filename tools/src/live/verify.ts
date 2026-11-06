// Operation-specific terminal verification. Each check reads chain state after the transaction and
// compares it with what that exact operation must have produced. Top-level success is never enough.
import type { Outcome } from "../near/client.js";
import { OPEN_ORDER_STATES, TokenClient, type MandateClient, type VerifierClient } from "../near/contracts.js";
import type { Asset, GrantView, OrderView } from "../types.js";

export interface Verification {
  passed: boolean;
  problems: string[];
  observed: Record<string, unknown>;
}

export interface VerifyContext {
  mandate: MandateClient;
  verifier: VerifierClient;
  tokens: Record<Asset, string>;
  /** Poll budget for asynchronous chains (MPC signing can take minutes on mainnet). */
  timeoutMs: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll<T>(ctx: VerifyContext, read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() - start > ctx.timeoutMs) return v;
    await sleep(ctx.pollMs ?? 1000);
  }
}

class Problems {
  readonly list: string[] = [];
  require(cond: boolean, msg: string): void {
    if (!cond) this.list.push(msg);
  }
}

export type Balances = Record<Asset, bigint>;

/**
 * Why a `simulate_intents` result does not show an executable bundle, or null when it does. The verifier
 * can simulate an unbalanced bundle successfully and report it in `invariant_violated`.
 */
export function simulationProblem(sim: { ok: true; value: unknown } | { ok: false; error: string }): string | null {
  if (!sim.ok) return `simulate_intents refused the bundle: ${sim.error.slice(0, 300)}`;
  if (typeof sim.value !== "object" || sim.value === null) return "simulate_intents returned no simulation output";
  const violated = (sim.value as { invariant_violated?: unknown }).invariant_violated;
  if (violated !== undefined && violated !== null) return `simulate_intents reports an invariant violation: ${JSON.stringify(violated).slice(0, 300)}`;
  return null;
}

export async function balancesOf(ctx: VerifyContext, account: string): Promise<Balances> {
  return { usdc: await ctx.verifier.balance(account, ctx.tokens.usdc), wnear: await ctx.verifier.balance(account, ctx.tokens.wnear) };
}

const str = (b: Balances) => ({ usdc: b.usdc.toString(), wnear: b.wnear.toString() });

/** Every receipt in the tree must have succeeded unless `allowFailureFrom` admits its executor. */
export function receiptTree(outcome: Outcome, allowFailureFrom: (executor: string) => boolean = () => false): string[] {
  const out: string[] = [];
  if (outcome.ambiguous) out.push(`outcome ambiguous: ${outcome.error ?? ""}`);
  if (!outcome.final) out.push(`outcome not final (${outcome.final_execution_status ?? "unknown"})`);
  if (!outcome.submitted) out.push(`not executed: ${outcome.error ?? ""}`);
  if (!outcome.success) out.push(`final status not success: ${outcome.error ?? ""}`);
  for (const r of outcome.receipts) {
    if (r.unknown) out.push(`receipt ${r.id} on ${r.executor_id} has unknown status`);
    if (r.error !== undefined && !allowFailureFrom(r.executor_id)) out.push(`receipt ${r.id} on ${r.executor_id} failed: ${r.error.slice(0, 200)}`);
  }
  return out;
}

export async function verifyGrant(ctx: VerifyContext, outcome: Outcome, previousEpoch: number | null): Promise<Verification> {
  const p = new Problems();
  for (const e of receiptTree(outcome)) p.require(false, e);
  const grant = await poll(ctx, () => ctx.mandate.grant(), (g) => g !== null && g.status !== "activating" && !g.key_op_in_flight);
  p.require(grant !== null, "no grant after grant()");
  if (grant === null) return { passed: false, problems: p.list, observed: {} };
  p.require(previousEpoch === null || grant.epoch > previousEpoch, `epoch did not advance (${grant.epoch} after ${String(previousEpoch)})`);
  p.require(grant.status === "active", `grant status ${grant.status}, expected active`);
  p.require(!grant.key_op_in_flight, "key operation still in flight");
  p.require(grant.public_key !== null, "grant has no public key");
  const keys = await ctx.verifier.publicKeysOf(ctx.mandate.id);
  p.require(grant.public_key !== null && keys.length === 1 && keys[0] === grant.public_key, `verifier keys of the mandate ${JSON.stringify(keys)} are not exactly the grant key`);
  p.require(grant.outstanding === "0" && grant.turnover_used === "0", "a fresh grant must start with no outstanding or turnover");
  return { passed: p.list.length === 0, problems: p.list, observed: { epoch: grant.epoch, path: grant.path, public_key: grant.public_key, verifier_keys: keys, initial_value: grant.initial_value } };
}

export async function verifyPropose(
  ctx: VerifyContext,
  outcome: Outcome,
  expected: "signed" | "rejected",
  proposal: { sell: Asset; sell_amount: string; max_concession_bps: number },
  before: GrantView,
): Promise<Verification & { orderId: string | null }> {
  const p = new Problems();
  // A rejection caused by a failing dependency (oracle, MPC) shows that dependency's failed receipt.
  const allow = expected === "rejected" ? (executor: string) => executor !== ctx.mandate.id : () => false;
  for (const e of receiptTree(outcome, allow)) p.require(false, e);
  const orderId = typeof outcome.return_value === "string" || typeof outcome.return_value === "number" ? String(outcome.return_value) : null;
  if (orderId === null || !/^[0-9]+$/.test(orderId)) return { passed: false, problems: [...p.list, "propose_order returned no order id"], observed: {}, orderId: null };
  const order = await poll(ctx, () => ctx.mandate.order(orderId), (o) => o !== null && !["pricing", "signing"].includes(o.state.state));
  const grant = await ctx.mandate.grant();
  p.require(order !== null, `order ${orderId} not found`);
  if (order === null || grant === null) return { passed: false, problems: p.list, observed: {}, orderId };
  p.require(order.sell === proposal.sell && order.sell_amount === proposal.sell_amount && order.concession_bps === proposal.max_concession_bps, "order does not match the proposal");
  p.require(order.epoch === before.epoch, `order epoch ${order.epoch} != grant epoch ${before.epoch}`);
  p.require(order.state.state === expected, `order state ${order.state.state}, expected ${expected}`);
  const delta = BigInt(grant.outstanding) - BigInt(before.outstanding);
  if (expected === "signed") {
    p.require(order.buy_amount !== null && order.deadline_ns !== null && order.payload !== null && order.signature !== null, "signed order lacks amount, deadline, payload or signature");
    p.require(BigInt(order.reserved_value) > 0n, "signed order has no reservation");
    p.require(delta === BigInt(order.reserved_value), `outstanding grew by ${delta}, reservation is ${order.reserved_value}`);
  } else {
    p.require(delta === 0n, `rejected order left outstanding changed by ${delta}`);
  }
  return {
    passed: p.list.length === 0,
    problems: p.list,
    observed: { order_id: orderId, state: order.state, reserved_value: order.reserved_value, outstanding_before: before.outstanding, outstanding_after: grant.outstanding, buy_amount: order.buy_amount, deadline_ns: order.deadline_ns },
    orderId,
  };
}

export interface FillExpectation {
  order: OrderView;
  mandateBefore: Balances;
  fillerBefore: Balances;
  /** Filler's signed counter diff (units per asset, negative = paid). */
  fillerDelta: Balances;
  fillerAccount: string;
  mandateNonce: string;
  fillerNonce: string;
}

export async function verifyFill(ctx: VerifyContext, outcome: Outcome, e: FillExpectation): Promise<Verification> {
  const p = new Problems();
  for (const x of receiptTree(outcome)) p.require(false, x);
  const mandateAfter = await balancesOf(ctx, ctx.mandate.id);
  const fillerAfter = await balancesOf(ctx, e.fillerAccount);
  const sold = BigInt(e.order.sell_amount);
  const bought = BigInt(e.order.buy_amount ?? "0");
  const expectedMandate = { ...e.mandateBefore, [e.order.sell]: e.mandateBefore[e.order.sell] - sold, [e.order.buy]: e.mandateBefore[e.order.buy] + bought };
  const expectedFiller = { usdc: e.fillerBefore.usdc + e.fillerDelta.usdc, wnear: e.fillerBefore.wnear + e.fillerDelta.wnear };
  p.require(mandateAfter.usdc === expectedMandate.usdc && mandateAfter.wnear === expectedMandate.wnear, "mandate balances did not move by exactly the signed amounts");
  p.require(fillerAfter.usdc === expectedFiller.usdc && fillerAfter.wnear === expectedFiller.wnear, "filler balances did not move by exactly its signed diff");
  p.require(await ctx.verifier.isNonceUsed(ctx.mandate.id, e.mandateNonce), "mandate nonce not used after fill");
  p.require(await ctx.verifier.isNonceUsed(e.fillerAccount, e.fillerNonce), "filler nonce not used after fill");
  return {
    passed: p.list.length === 0,
    problems: p.list,
    observed: { mandate_before: str(e.mandateBefore), mandate_after: str(mandateAfter), filler_before: str(e.fillerBefore), filler_after: str(fillerAfter), filler_delta: str(e.fillerDelta) },
  };
}

export async function verifySettle(ctx: VerifyContext, outcome: Outcome, orderId: string): Promise<Verification> {
  const p = new Problems();
  for (const x of receiptTree(outcome)) p.require(false, x);
  const order = await ctx.mandate.order(orderId);
  p.require(order?.state.state === "released" && order.state.reason === "settled", `order ${orderId} state ${JSON.stringify(order?.state)}, expected released:settled`);
  const nonce = order?.payload?.nonce;
  p.require(nonce !== undefined && (await ctx.verifier.isNonceUsed(ctx.mandate.id, nonce)), "verifier does not report the order nonce used");
  return { passed: p.list.length === 0, problems: p.list, observed: { order_id: orderId, state: order?.state } };
}

export async function verifyRevoke(ctx: VerifyContext, outcome: Outcome, before: GrantView): Promise<Verification> {
  const p = new Problems();
  for (const x of receiptTree(outcome)) p.require(false, x);
  const grant = await poll(ctx, () => ctx.mandate.grant(), (g) => g?.status === "revoked" && !g.key_op_in_flight);
  p.require(grant?.status === "revoked", `grant status ${String(grant?.status)}, expected revoked`);
  p.require(grant?.epoch === before.epoch, "grant epoch changed during revocation");
  const keyAbsent = before.public_key === null || !(await ctx.verifier.hasPublicKey(ctx.mandate.id, before.public_key));
  p.require(keyAbsent, "grant key still registered on the verifier");
  const keys = await ctx.verifier.publicKeysOf(ctx.mandate.id);
  p.require(keys.length === 0, `mandate still has verifier keys ${JSON.stringify(keys)}`);
  p.require(grant?.outstanding === "0", `outstanding ${String(grant?.outstanding)} after revocation`);
  const open = (await ctx.mandate.allOrders()).filter((o) => o.epoch === before.epoch && OPEN_ORDER_STATES.includes(o.state.state));
  p.require(open.length === 0, `orders of epoch ${before.epoch} still open: ${open.map((o) => o.id).join(",")}`);
  return { passed: p.list.length === 0, problems: p.list, observed: { status: grant?.status, key_absent: keyAbsent, verifier_keys: keys, outstanding: grant?.outstanding } };
}

export async function verifyReconcile(ctx: VerifyContext, outcome: Outcome): Promise<Verification> {
  const p = new Problems();
  for (const x of receiptTree(outcome)) p.require(false, x);
  const grant = await ctx.mandate.grant();
  if (grant === null) return { passed: false, problems: [...p.list, "no grant"], observed: {} };
  const registered = grant.public_key !== null && (await ctx.verifier.hasPublicKey(ctx.mandate.id, grant.public_key));
  // Presence must resolve the registration; absence must leave it pending (never presumed failed).
  if (registered) p.require(!grant.key_op_in_flight || grant.status === "revoking", "registered key but registration still unresolved");
  else p.require(grant.status === "activating" || grant.status === "revoked", `key absent but grant status ${grant.status}`);
  return { passed: p.list.length === 0, problems: p.list, observed: { status: grant.status, key_op_in_flight: grant.key_op_in_flight, registered } };
}

export async function verifyRecover(ctx: VerifyContext, outcome: Outcome, asset: Asset, owner: string, mandateBefore: Balances, ownerBefore: Balances): Promise<Verification> {
  const p = new Problems();
  for (const x of receiptTree(outcome)) p.require(false, x);
  const mandateAfter = await balancesOf(ctx, ctx.mandate.id);
  const ownerAfter = await balancesOf(ctx, owner);
  const lost = mandateBefore[asset] - mandateAfter[asset];
  const gained = ownerAfter[asset] - ownerBefore[asset];
  p.require(mandateAfter[asset] === 0n, `mandate still holds ${mandateAfter[asset]} ${asset}`);
  p.require(lost === gained, `owner gained ${gained} ${asset} but the mandate lost ${lost}`);
  const other: Asset = asset === "usdc" ? "wnear" : "usdc";
  p.require(mandateAfter[other] === mandateBefore[other] && ownerAfter[other] === ownerBefore[other], `recovering ${asset} moved ${other}`);
  const rec = (await ctx.mandate.recoveryViews()).find((r) => r.asset === asset);
  p.require(rec !== undefined && !rec.in_flight, "recovery still in flight");
  return { passed: p.list.length === 0, problems: p.list, observed: { asset, lost: lost.toString(), gained: gained.toString(), mandate_after: str(mandateAfter), owner_after: str(ownerAfter) } };
}

export async function verifyRefusedProposal(ctx: VerifyContext, outcome: Outcome, expectedError: string, before: GrantView, ordersBefore: number): Promise<Verification> {
  const p = new Problems();
  p.require(outcome.submitted && outcome.final, "refused proposal outcome is not a final executed transaction");
  p.require(!outcome.success, "forbidden proposal succeeded");
  const failed = outcome.receipts.filter((r) => r.error !== undefined);
  const own = failed.filter((r) => r.executor_id === ctx.mandate.id);
  // A contract-level refusal: the mandate's own receipt panicked with the expected policy error, and nothing
  // else failed (a gas, network or dependency failure is not a policy refusal).
  p.require(own.length === 1 && failed.length === 1, `expected exactly one failed receipt, on the mandate; got ${failed.map((r) => r.executor_id).join(",") || "none"}`);
  p.require(own[0]?.error?.includes(expectedError) === true, `mandate error does not contain "${expectedError}": ${(own[0]?.error ?? outcome.error ?? "").slice(0, 200)}`);
  p.require(outcome.receipts.every((r) => !r.unknown), "a receipt has unknown status");
  const grant = await ctx.mandate.grant();
  const orders = (await ctx.mandate.allOrders()).length;
  p.require(grant !== null && grant.status === before.status && grant.outstanding === before.outstanding && grant.turnover_used === before.turnover_used, "refused proposal changed the grant");
  p.require(orders === ordersBefore, `order count changed from ${ordersBefore} to ${orders}`);
  return {
    passed: p.list.length === 0,
    problems: p.list,
    observed: { error: (own[0]?.error ?? outcome.error ?? "").slice(0, 300), outstanding: grant?.outstanding, turnover_used: grant?.turnover_used, orders },
  };
}

/** How a relay of a withheld order after revocation ended. Only `rejected_revoked_key` passes. */
export type RelayClassification = "rejected_revoked_key" | "inconclusive" | "executed";

export interface RelayExpectation {
  orderId: string;
  /** Public key that signed the withheld order; confirmed removed before the relay. */
  revokedKey: string;
  deadlineNs: bigint;
  mandateNonce: string;
  fillerAccount: string;
  fillerNonce: string;
  mandateBefore: Balances;
  fillerBefore: Balances;
  /** Execution time of the failed verifier receipt; null when unknown. */
  blockTimeNs: (blockHash: string) => Promise<bigint | null>;
}

export async function classifyRelay(ctx: VerifyContext, outcome: Outcome, e: RelayExpectation): Promise<Verification & { classification: RelayClassification }> {
  const reasons: string[] = [];
  const mandateNonceUsed = await ctx.verifier.isNonceUsed(ctx.mandate.id, e.mandateNonce);
  const fillerNonceUsed = await ctx.verifier.isNonceUsed(e.fillerAccount, e.fillerNonce);
  const mandateAfter = await balancesOf(ctx, ctx.mandate.id);
  const fillerAfter = await balancesOf(ctx, e.fillerAccount);
  const failed = outcome.receipts.filter((r) => r.error !== undefined);
  const verifierFailure = failed.find((r) => r.executor_id === ctx.verifier.id);
  const error = verifierFailure?.error ?? outcome.error ?? "";
  const executedAt = verifierFailure === undefined ? null : await e.blockTimeNs(verifierFailure.block_hash);
  const order = await ctx.mandate.order(e.orderId);
  const observed = {
    order_id: e.orderId,
    tx_success: outcome.success,
    error: error.slice(0, 300),
    revoked_key: e.revokedKey,
    executed_at_ns: executedAt?.toString() ?? null,
    deadline_ns: e.deadlineNs.toString(),
    mandate_nonce_used: mandateNonceUsed,
    filler_nonce_used: fillerNonceUsed,
    mandate_before: str(e.mandateBefore),
    mandate_after: str(mandateAfter),
    filler_before: str(e.fillerBefore),
    filler_after: str(fillerAfter),
    order_state: order?.state ?? null,
  };
  if (outcome.success || mandateNonceUsed) {
    return { classification: "executed", passed: false, problems: ["withheld order executed after confirmed revocation"], observed: { ...observed, classification: "executed" } };
  }
  const expected = `public key '${e.revokedKey}' doesn't exist for account '${ctx.mandate.id}'`;
  if (!outcome.submitted || !outcome.final) reasons.push("outcome is not a final executed transaction");
  if (verifierFailure === undefined) reasons.push("no failed verifier receipt");
  if (!error.includes(expected)) reasons.push(`verifier error is not the removed-key rejection (${expected})`);
  if (executedAt === null || executedAt > e.deadlineNs) reasons.push(`not executed before the order deadline (executed ${executedAt?.toString() ?? "unknown"}, deadline ${e.deadlineNs})`);
  if (failed.some((r) => r.executor_id !== ctx.verifier.id)) reasons.push("a receipt outside the verifier failed");
  if (fillerNonceUsed) reasons.push("filler nonce used");
  if (mandateAfter.usdc !== e.mandateBefore.usdc || mandateAfter.wnear !== e.mandateBefore.wnear) reasons.push("mandate balances changed");
  if (fillerAfter.usdc !== e.fillerBefore.usdc || fillerAfter.wnear !== e.fillerBefore.wnear) reasons.push("filler balances changed");
  const classification: RelayClassification = reasons.length === 0 ? "rejected_revoked_key" : "inconclusive";
  return { classification, passed: reasons.length === 0, problems: reasons, observed: { ...observed, classification } };
}

export const tokenOf = (ctx: VerifyContext, asset: Asset): TokenClient => new TokenClient(ctx.mandate.client, ctx.tokens[asset]);

export async function verifyStorage(ctx: VerifyContext, outcome: Outcome, asset: Asset, owner: string): Promise<Verification> {
  const p = new Problems();
  for (const x of receiptTree(outcome)) p.require(false, x);
  const registered = await tokenOf(ctx, asset).isRegistered(owner);
  p.require(registered, `${owner} is not registered on ${ctx.tokens[asset]} after storage_deposit`);
  return { passed: p.list.length === 0, problems: p.list, observed: { asset, token: ctx.tokens[asset], registered } };
}

/**
 * How an owner withdrawal (verifier ft_withdraw to the owner's NEAR account) ended. `withdrawn`: exactly `amount` left
 * the owner's Intents balance and arrived on the token. `refunded` (the token transfer failed and the verifier
 * refunded) and `failed` (ft_withdraw itself failed): both balances unchanged, so it may be retried without double
 * counting. Anything else is inconsistent and stops the run.
 */
export type WithdrawClassification = "withdrawn" | "refunded" | "failed" | "inconsistent";

export interface WithdrawExpectation {
  asset: Asset;
  owner: string;
  amount: bigint;
  intentsBefore: Balances;
  tokenBefore: bigint;
}

export async function verifyWithdraw(ctx: VerifyContext, outcome: Outcome, e: WithdrawExpectation): Promise<Verification & { classification: WithdrawClassification; withdrawn: bigint }> {
  const token = ctx.tokens[e.asset];
  const intentsAfter = await balancesOf(ctx, e.owner);
  const tokenAfter = await tokenOf(ctx, e.asset).balance(e.owner);
  const other: Asset = e.asset === "usdc" ? "wnear" : "usdc";
  const failed = outcome.receipts.filter((r) => r.error !== undefined);
  const observed = {
    asset: e.asset,
    token,
    amount: e.amount.toString(),
    return_value: typeof outcome.return_value === "string" ? outcome.return_value : null,
    intents_before: str(e.intentsBefore),
    intents_after: str(intentsAfter),
    token_before: e.tokenBefore.toString(),
    token_after: tokenAfter.toString(),
    failed_receipts: failed.map((r) => ({ executor_id: r.executor_id, error: (r.error ?? "").slice(0, 200) })),
  };
  const result = (classification: WithdrawClassification, problems: string[], withdrawn = 0n) => ({
    classification,
    withdrawn,
    passed: classification === "withdrawn",
    problems,
    observed: { ...observed, classification },
  });
  const p = new Problems();
  p.require(intentsAfter[other] === e.intentsBefore[other], `withdrawing ${e.asset} moved the owner's ${other}`);
  const settled = outcome.submitted && outcome.final && outcome.receipts.every((r) => !r.unknown);
  if (settled && p.list.length === 0 && failed.length === 0 && outcome.success) {
    const q = new Problems();
    q.require(outcome.return_value === e.amount.toString(), `ft_withdraw returned ${JSON.stringify(outcome.return_value)}, expected "${e.amount}"`);
    q.require(e.intentsBefore[e.asset] - intentsAfter[e.asset] === e.amount, `owner's Intents ${e.asset} fell by ${e.intentsBefore[e.asset] - intentsAfter[e.asset]}, expected ${e.amount}`);
    q.require(tokenAfter - e.tokenBefore === e.amount, `owner's ${token} balance rose by ${tokenAfter - e.tokenBefore}, expected ${e.amount}`);
    return q.list.length === 0 ? result("withdrawn", [], e.amount) : result("inconsistent", q.list);
  }
  const intact = intentsAfter[e.asset] === e.intentsBefore[e.asset] && tokenAfter === e.tokenBefore;
  if (settled && p.list.length === 0 && intact && failed.length > 0) {
    const refunded = failed.every((r) => r.executor_id === token) && outcome.success && outcome.return_value === "0";
    const own = failed.every((r) => r.executor_id === ctx.verifier.id) && !outcome.success;
    if (refunded) return result("refunded", [`the token transfer failed and the verifier refunded ${e.amount} ${e.asset}; the Intents balance is intact`]);
    if (own) return result("failed", [`ft_withdraw failed on the verifier: ${(failed[0]?.error ?? "").slice(0, 200)}; the Intents balance is intact`]);
  }
  for (const x of receiptTree(outcome)) p.require(false, x);
  if (!intact) p.require(false, "balances changed without a complete withdrawal");
  return result("inconsistent", p.list.length > 0 ? p.list : ["withdrawal outcome is neither complete nor fully refunded"]);
}
