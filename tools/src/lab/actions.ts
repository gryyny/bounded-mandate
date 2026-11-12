// The lab's listed actions. Each one signs and sends ordinary transactions on the session's own sandbox world, as the
// role that would send them (owner, agent, filler, relayer, or the lab as keeper of its test doubles), and reports the
// receipts. Inputs are checked for shape and type range only: whether a limit is acceptable, a trade is allowed or an
// order can still execute is decided by the contracts, and the answer is whatever their receipts say.
import { z } from "zod";
import { PRICES, PRICE_IDS } from "../demo/market.js";
import type { World } from "../demo/world.js";
import { relayRejectionProblems, removedKeyError } from "../evidence/journey.js";
import { simulationProblem } from "../live/verify.js";
import type { Outcome } from "../near/client.js";
import { findSignedPayload } from "../near/contracts.js";
import { Asset, type SignedNep413 } from "../types.js";
import { ALTERNATIVES, runAlternative, type AlternativeResult } from "./alternatives.js";
import { ALTERNATIVE_NEAR, MAX_ALTERNATIVE_RUNS, labState, type LabState, type LabWorld } from "./world.js";

const U16 = z.number().int().min(0).max(65_535);
const U32 = z.number().int().min(0).max(4_294_967_295);
const OrderId = z.string().regex(/^(0|[1-9][0-9]{0,18})$/, "order id: decimal integer");
const OrderInput = z.object({ order_id: OrderId }).strict();
const None = z.object({}).strict();

/** The contract's Policy fields at their integer widths; the contract validates the values. */
export const LabPolicy = z
  .object({
    per_order_cap_bps: U16,
    outstanding_cap_bps: U16,
    max_concession_bps: U16,
    oracle_max_age_sec: U32,
    max_confidence_bps: U16,
    breaker_drawdown_bps: U16,
    turnover_cap_bps: U32,
    order_ttl_sec: U32,
    min_remaining_sec: U32,
    max_pricing_delay_sec: U32,
    proposal_charge_bps: U16,
  })
  .strict();

const GrantInput = z.object({ policy: LabPolicy }).strict();
const ProposeInput = z
  .object({
    sell: Asset,
    sell_amount: z.string().regex(/^(0|[1-9][0-9]{0,38})$/, "sell_amount: decimal integer of token units"),
    max_concession_bps: U16,
    /** Whether the lab, as keeper of the oracle double, posts fresh prices first. Default true. */
    refresh_prices: z.boolean().optional(),
  })
  .strict();
const OracleInput = z
  .object({
    available: z.boolean(),
    /** wNEAR price in USD at exponent -8 (300000000 = 3.00). */
    wnear_price: z
      .string()
      .regex(/^[1-9][0-9]{0,11}$/, "wnear_price: positive integer mantissa at exponent -8")
      .optional(),
  })
  .strict();
const SignerInput = z.object({ available: z.boolean() }).strict();
const AlternativeInput = z.object({ id: z.enum(ALTERNATIVES) }).strict();

export interface ReceiptView {
  receipt_id: string;
  executor_id: string;
  success: boolean;
  error: string | null;
  logs: string[];
}

export interface TxView {
  label: string;
  tx_hash: string | null;
  signer_id: string;
  receiver_id: string;
  method: string;
  /** Included in a block and executed; false when the node refused it before inclusion. */
  included: boolean;
  /** The transaction's final status. A detached receipt can still have failed: see `any_receipt_failed`. */
  success: boolean;
  any_receipt_failed: boolean;
  ambiguous: boolean;
  error: string | null;
  block_height: number | null;
  receipts: ReceiptView[];
  events: { emitter: string; event: string }[];
}

export function txView(o: Outcome): TxView {
  return {
    label: o.label,
    tx_hash: o.tx_hash ?? null,
    signer_id: o.signer_id,
    receiver_id: o.receiver_id,
    method: o.method,
    included: o.submitted,
    success: o.submitted && o.success,
    any_receipt_failed: o.any_receipt_failed,
    ambiguous: o.ambiguous,
    error: o.error ?? o.receipts.find((r) => r.error !== undefined)?.error ?? null,
    block_height: o.block_height ?? null,
    receipts: o.receipts.map((r) => ({ receipt_id: r.id, executor_id: r.executor_id, success: r.success, error: r.error ?? null, logs: r.logs })),
    events: o.events.map((e) => ({ emitter: e.emitter, event: e.event })),
  };
}

export interface ActionRecord {
  seq: number;
  action: ActionName;
  input: unknown;
  /** Milliseconds from the world's creation to the start of the action. */
  at_ms: number;
  duration_ms: number;
  transactions: TxView[];
  /** What the action observed, read from receipts and views. `not_sent` explains an action that sent nothing. */
  result: Record<string, unknown>;
  state: LabState;
}

interface Done {
  outcomes: Outcome[];
  /** Transactions another module ran, read back by hash. */
  external?: TxView[];
  result: Record<string, unknown>;
}

const allOk = (o: Outcome): boolean => o.submitted && o.success && !o.any_receipt_failed;
const pairOf = (b: Record<Asset, bigint>): Record<Asset, string> => ({ usdc: b.usdc.toString(), wnear: b.wnear.toString() });

async function mandateBalances(world: World): Promise<Record<Asset, bigint>> {
  const [usdc, wnear] = await Promise.all([world.verifier.balance(world.mandate.id, world.tokens.usdc), world.verifier.balance(world.mandate.id, world.tokens.wnear)]);
  return { usdc, wnear };
}

/** The lab as keeper of the session's oracle double: both prices, published at the current block time. */
async function postPrices(lw: LabWorld): Promise<Outcome[]> {
  const { world } = lw;
  const nowSec = (await world.client.blockTimestampNs()) / 1_000_000_000n;
  const out: Outcome[] = [];
  for (const asset of ["usdc", "wnear"] as const) {
    const p = PRICES[asset];
    out.push(
      await world.client.call(`oracle TEST DOUBLE set_price ${asset} (lab as keeper)`, world.operator.account, world.oracleId, "set_price", {
        price_id: PRICE_IDS[asset],
        price: (asset === "wnear" ? lw.wnearPrice : p.price).toString(),
        conf: p.conf.toString(),
        expo: p.expo,
        publish_time: Number(nowSec),
      }),
    );
  }
  return out;
}

async function signedOf(lw: LabWorld, orderId: string): Promise<SignedNep413 | string> {
  const known = lw.signed.get(orderId);
  if (known !== undefined) return known;
  const order = await lw.world.mandate.order(orderId);
  if (order === null) return `the mandate has no order ${orderId}`;
  try {
    return await lw.filler.signedOrder(order);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A request whose input has the wrong shape or type range; nothing was sent. */
export class InputError extends Error {}

interface Listed {
  help: string;
  run(lw: LabWorld, raw: unknown): Promise<Done>;
}

const listed = <S extends z.ZodType>(help: string, input: S, handler: (lw: LabWorld, input: z.infer<S>) => Promise<Done>): Listed => ({
  help,
  run: async (lw, raw) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) throw new InputError(z.prettifyError(parsed.error));
    return handler(lw, parsed.data);
  },
});

/** Every action a visitor can reach. Anything else is refused before it touches a world. */
const LISTED = {
  grant: listed("Owner: post fresh prices to the oracle double, then grant the agent a mandate with these limits.", GrantInput, async (lw, { policy }) => {
    const outcomes = lw.oracleAvailable ? await postPrices(lw) : [];
    outcomes.push(await lw.world.mandate.grantPolicy(lw.world.owner.account, policy));
    return { outcomes, result: {} };
  }),

  propose: listed("Agent: propose one trade with its restricted key. The contract decides, prices and signs it, or refuses.", ProposeInput, async (lw, input) => {
    const { world } = lw;
    const outcomes = input.refresh_prices !== false && lw.oracleAvailable ? await postPrices(lw) : [];
    const proposal = { sell: input.sell, sell_amount: input.sell_amount, max_concession_bps: input.max_concession_bps };
    const outcome = await world.mandate.propose(world.agent.account, proposal);
    outcomes.push(outcome);
    if (!outcome.submitted || !outcome.success) return { outcomes, result: { order_id: null, order: null } };
    const orderId = z.union([z.string(), z.number()]).transform(String).parse(outcome.return_value);
    const event = outcome.events.find((e) => e.event === "order_signed");
    const signed = event === undefined ? null : findSignedPayload(event.data);
    if (signed !== null) lw.signed.set(orderId, signed);
    return { outcomes, result: { order_id: orderId, order: await world.mandate.order(orderId) } };
  }),

  fill: listed("Filler: counter-sign a signed order and execute both sides on the verifier, then record the settlement.", OrderInput, async (lw, { order_id }) => {
    const { world } = lw;
    const signed = await signedOf(lw, order_id);
    if (typeof signed === "string") return { outcomes: [], result: { not_sent: signed } };
    const before = await mandateBalances(world);
    const fill = await lw.filler.fill(order_id, signed);
    const outcomes = fill.outcome === undefined ? [] : [fill.outcome];
    // The reservation is released on the verifier's own nonce evidence, by anyone: here the relayer.
    if (fill.outcome !== undefined && fill.record.state === "filled") outcomes.push(await world.mandate.settle(world.relayer.account, order_id));
    return {
      outcomes,
      result: {
        order_id,
        filler_record: { state: fill.record.state, detail: fill.record.detail ?? null, counter_diff: fill.record.counter_diff ?? null },
        ...(fill.outcome === undefined ? { not_sent: `the filler already handled order ${order_id}: ${fill.record.state}` } : {}),
        mandate_before: pairOf(before),
        mandate_after: pairOf(await mandateBalances(world)),
        order: await world.mandate.order(order_id),
      },
    };
  }),

  withhold: listed("Counterparty: counter-sign a signed order and keep the complete bundle instead of sending it.", OrderInput, async (lw, { order_id }) => {
    const { world } = lw;
    const signed = await signedOf(lw, order_id);
    if (typeof signed === "string") return { outcomes: [], result: { not_sent: signed } };
    const prepared = await lw.filler.prepare(signed);
    if ("shortfall" in prepared) return { outcomes: [], result: { not_sent: prepared.shortfall } };
    const order = await world.mandate.order(order_id);
    // A dry run by the verifier itself (simulate_intents view) of the exact bundle that is being held back.
    const problem = simulationProblem(await world.verifier.simulate(prepared.bundle), prepared.bundle);
    lw.withheld.set(order_id, { bundle: prepared.bundle, signed, deadline_ns: order?.deadline_ns ?? null, relayed: false });
    return {
      outcomes: [],
      result: {
        order_id,
        withheld: true,
        executable_now: problem === null,
        simulation: problem ?? "simulate_intents accepted the bundle: both intents executed, no invariant violation",
        signing_public_key: signed.public_key,
        deadline_ns: order?.deadline_ns ?? null,
      },
    };
  }),

  relay: listed("Another account: send a withheld bundle to the verifier.", OrderInput, async (lw, { order_id }) => {
    const { world } = lw;
    const held = lw.withheld.get(order_id);
    if (held === undefined) return { outcomes: [], result: { not_sent: `order ${order_id} is not withheld in this session` } };
    const before = await mandateBalances(world);
    const outcome = await world.verifier.execute(world.relayer.account, held.bundle, `relayer execute_intents (withheld order ${order_id})`);
    held.relayed = true;
    const outcomes = [outcome];
    const executed = allOk(outcome);
    if (executed) outcomes.push(await world.mandate.settle(world.relayer.account, order_id));
    const after = await mandateBalances(world);
    const failure = outcome.receipts.find((r) => r.executor_id === world.verifier.id && r.error !== undefined);
    const rejectedAtNs = failure === undefined ? null : await world.client.blockTimestampAt(failure.block_hash);
    const deadlineNs = held.deadline_ns === null ? null : BigInt(held.deadline_ns);
    const unchanged = before.usdc === after.usdc && before.wnear === after.wnear;
    // Only the verifier's own error naming the removed key, before the deadline, counts as rejection by revocation.
    const problems = relayRejectionProblems({
      relaySucceeded: outcome.success,
      verifierError: failure?.error ?? null,
      revokedKey: held.signed.public_key,
      mandate: world.mandate.id,
      deadlineNs,
      rejectedAtNs,
      nonceUsed: await world.verifier.isNonceUsed(world.mandate.id, held.signed.payload.nonce),
      balancesUnchanged: unchanged,
    });
    return {
      outcomes,
      result: {
        order_id,
        executed,
        verifier_error: failure?.error ?? null,
        rejected_for_removed_key: problems.length === 0,
        expected_removed_key_error: removedKeyError(held.signed.public_key, world.mandate.id),
        not_a_revocation_rejection_because: problems,
        deadline_ns: held.deadline_ns,
        rejected_at_ns: rejectedAtNs === null ? null : rejectedAtNs.toString(),
        before_deadline: deadlineNs === null || rejectedAtNs === null ? null : rejectedAtNs < deadlineNs,
        mandate_before: pairOf(before),
        mandate_after: pairOf(after),
      },
    };
  }),

  expire: listed("Anyone: ask the contract to release an order whose deadline has passed.", OrderInput, async (lw, { order_id }) => {
    return { outcomes: [await lw.world.mandate.expire(lw.world.relayer.account, order_id)], result: { order_id, order: await lw.world.mandate.order(order_id) } };
  }),

  revoke: listed("Owner: revoke the grant; the contract removes its key from the verifier.", None, async (lw) => {
    return { outcomes: [await lw.world.mandate.revoke(lw.world.owner.account)], result: {} };
  }),

  recover: listed("Owner: move both assets from the mandate to the owner's Intents account.", None, async (lw) => {
    const { world } = lw;
    const owner = async (): Promise<Record<Asset, bigint>> => ({
      usdc: await world.verifier.balance(world.owner.id, world.tokens.usdc),
      wnear: await world.verifier.balance(world.owner.id, world.tokens.wnear),
    });
    const [mandateBefore, ownerBefore] = [await mandateBalances(world), await owner()];
    const outcomes: Outcome[] = [];
    for (const asset of ["usdc", "wnear"] as const) outcomes.push(await world.mandate.recover(world.owner.account, asset));
    const ownerAfter = await owner();
    return {
      outcomes,
      result: {
        destination: `${world.owner.id} (the owner's Intents account, not an external wallet)`,
        mandate_before: pairOf(mandateBefore),
        mandate_after: pairOf(await mandateBalances(world)),
        owner_received: pairOf({ usdc: ownerAfter.usdc - ownerBefore.usdc, wnear: ownerAfter.wnear - ownerBefore.wnear }),
      },
    };
  }),

  set_oracle: listed("Lab (test double): make this session's price oracle fail or answer, and set its wNEAR price.", OracleInput, async (lw, input) => {
    const { world } = lw;
    if (input.wnear_price !== undefined) lw.wnearPrice = BigInt(input.wnear_price);
    const outcomes = [await world.client.call(`oracle TEST DOUBLE set_fail(${String(!input.available)})`, world.operator.account, world.oracleId, "set_fail", { fail: !input.available })];
    lw.oracleAvailable = input.available;
    if (input.available) outcomes.push(...(await postPrices(lw)));
    return { outcomes, result: {} };
  }),

  set_signer: listed("Lab (test double): make this session's MPC signer answer every request with an error, or sign again.", SignerInput, async (lw, { available }) => {
    // An erroring signer, not a silent one: a request the double never answers stays pending for 200 blocks, and the
    // proposal's transaction with it.
    const mode = available ? "immediate" : "immediate_error";
    return { outcomes: [await lw.world.client.call(`MPC TEST DOUBLE set_mode(${mode})`, lw.world.operator.account, lw.world.mpcId, "set_mode", { mode })], result: {} };
  }),

  alternative: listed("Run one of the owner's alternatives on its own fresh accounts in this session's sandbox.", AlternativeInput, async (lw, { id }) => {
    if (lw.alternativeRuns >= MAX_ALTERNATIVE_RUNS) return { outcomes: [], result: { not_sent: `this session has run ${MAX_ALTERNATIVE_RUNS} comparisons; reset it to run more` } };
    lw.alternativeRuns += 1;
    await lw.lease.topUp(lw.world.net.root.id, ALTERNATIVE_NEAR);
    const { verifier, ft } = lw.world.wasm;
    // Its accounts live under this session's parent account, apart from the session's treasury and from other sessions.
    const ran: AlternativeResult = await runAlternative(lw.world.net, { verifier, ft }, `alt${lw.alternativeRuns}`, id);
    // A run sets its accounts up concurrently, so those transactions complete in no fixed order: list them by label.
    const setup = ran.transactions.filter((t) => t.step === "setup").sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const comparison: AlternativeResult = { ...ran, transactions: [...setup, ...ran.transactions.filter((t) => t.step !== "setup")] };
    // The run reports its transactions by hash; their receipts are read back from the chain.
    const external = await Promise.all(
      comparison.transactions.map(async (t): Promise<TxView> => {
        const outcome = await lw.world.client.resolve(`${t.step}: ${t.label}`, t.signer_id, t.tx_hash, t.method);
        if (outcome !== null) return txView(outcome);
        return { label: `${t.step}: ${t.label}`, tx_hash: t.tx_hash, signer_id: t.signer_id, receiver_id: t.receiver_id, method: t.method, included: true, success: t.success, any_receipt_failed: !t.success, ambiguous: false, error: t.error, block_height: null, receipts: [], events: [] };
      }),
    );
    return { outcomes: [], external, result: { comparison } };
  }),
} satisfies Record<string, Listed>;

export type ActionName = keyof typeof LISTED;
export const ACTIONS = Object.keys(LISTED) as ActionName[];
export const isAction = (name: string): name is ActionName => Object.hasOwn(LISTED, name);
export const ACTION_HELP: Record<ActionName, string> = Object.fromEntries(ACTIONS.map((a) => [a, LISTED[a].help])) as Record<ActionName, string>;

/** Runs one listed action on a world and reads the state after it. Throws InputError, before sending anything, on a malformed input. */
export async function runAction(lw: LabWorld, seq: number, action: ActionName, input: unknown): Promise<ActionRecord> {
  const started = Date.now();
  const done = await LISTED[action].run(lw, input);
  return {
    seq,
    action,
    input,
    at_ms: started - lw.createdAt,
    duration_ms: Date.now() - started,
    transactions: [...done.outcomes.map(txView), ...(done.external ?? [])],
    result: done.result,
    state: await labState(lw),
  };
}
