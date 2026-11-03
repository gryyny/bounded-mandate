// Our own separately keyed filler. It counter-signs the exact closing token_diff for a signed mandate
// order and submits both payloads with permissionless execute_intents.
// Restart safety: every order is recorded in a state file before submission; a recorded order is never
// submitted again. An ambiguous submission is investigated (is_nonce_used) and reported, never replaced.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { actions, type Account, type KeyPair } from "near-api-js";
import { z } from "zod";
import { MAX_GAS, type NearClient, type Outcome } from "../near/client.js";
import { tokenId, type MandateClient, type VerifierClient } from "../near/contracts.js";
import { SignedNep413, type OrderView } from "../types.js";
import { counterDiff, imbalance, type MandateLeg } from "./arithmetic.js";
import { signNep413, tokenDiffMessage, versionedNonce } from "./nep413.js";

const FillState = z.enum(["submitting", "filled", "failed", "ambiguous", "skipped"]);
const FillRecord = z
  .object({
    order_id: z.string(),
    state: FillState,
    updated_at: z.string(),
    mandate_nonce: z.string().optional(),
    filler_nonce: z.string().optional(),
    tx_hash: z.string().optional(),
    detail: z.string().optional(),
    counter_diff: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type FillRecord = z.infer<typeof FillRecord>;
const StateFile = z.object({ version: z.literal(1), mandate: z.string(), orders: z.record(z.string(), FillRecord) }).strict();
type StateFile = z.infer<typeof StateFile>;

const MandateMessage = z
  .object({
    signer_id: z.string(),
    deadline: z.string(),
    intents: z.array(z.object({ intent: z.literal("token_diff"), diff: z.record(z.string(), z.string().regex(/^-?[0-9]+$/)) }).loose()).length(1),
  })
  .loose();

/** Extracts and checks the mandate's two-token diff from its signed payload. */
export function mandateLeg(signed: SignedNep413, mandateId: string, verifierId: string, allowedTokens: string[]): MandateLeg {
  if (signed.payload.recipient !== verifierId) throw new Error(`payload recipient ${signed.payload.recipient} is not the verifier`);
  const message = MandateMessage.parse(JSON.parse(signed.payload.message));
  if (message.signer_id !== mandateId) throw new Error(`payload signer ${message.signer_id} is not the mandate`);
  const intent = message.intents[0];
  if (intent === undefined) throw new Error("no intent");
  const entries = Object.entries(intent.diff).map(([token, delta]) => [token, BigInt(delta)] as const);
  if (entries.length !== 2) throw new Error("mandate diff must have exactly two tokens");
  const sell = entries.find(([, d]) => d < 0n);
  const buy = entries.find(([, d]) => d > 0n);
  if (sell === undefined || buy === undefined) throw new Error("mandate diff must have one negative and one positive delta");
  for (const [token] of entries) if (!allowedTokens.includes(token)) throw new Error(`unexpected token ${token}`);
  return { sellToken: sell[0], sellAmount: -sell[1], buyToken: buy[0], buyAmount: buy[1] };
}

export interface FillerOptions {
  client: NearClient;
  mandate: MandateClient;
  verifier: VerifierClient;
  account: Account;
  key: KeyPair;
  statePath: string;
  /** Lifetime of the filler's own payload. */
  ttlSec?: bigint;
}

export interface FillResult {
  record: FillRecord;
  outcome?: Outcome;
  bundle?: SignedNep413[];
}

export class Filler {
  private state: StateFile;

  constructor(private readonly o: FillerOptions) {
    this.state = existsSync(o.statePath)
      ? StateFile.parse(JSON.parse(readFileSync(o.statePath, "utf8")))
      : { version: 1, mandate: o.mandate.id, orders: {} };
    if (this.state.mandate !== o.mandate.id) throw new Error(`filler state ${o.statePath} belongs to ${this.state.mandate}`);
  }

  records(): FillRecord[] {
    return Object.values(this.state.orders);
  }

  private save(record: FillRecord): FillRecord {
    this.state = { ...this.state, orders: { ...this.state.orders, [record.order_id]: record } };
    mkdirSync(dirname(this.o.statePath), { recursive: true });
    const tmp = `${this.o.statePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.o.statePath);
    return record;
  }

  private record(orderId: string, state: FillRecord["state"], extra: Partial<FillRecord> = {}): FillRecord {
    const prev = this.state.orders[orderId];
    return this.save({ ...prev, ...extra, order_id: orderId, state, updated_at: new Date().toISOString() });
  }

  /** Builds the signed mandate payload from the order view and the grant key of the same epoch. */
  async signedOrder(order: OrderView): Promise<SignedNep413> {
    if (order.payload === null || order.signature === null) throw new Error(`order ${order.id} has no recorded signature`);
    const grant = await this.o.mandate.grant();
    if (grant?.epoch !== order.epoch || grant.public_key === null) {
      throw new Error(`order ${order.id}: grant key for epoch ${order.epoch} unavailable from views; use the order_signed event`);
    }
    return SignedNep413.parse({ standard: "nep413", payload: order.payload, public_key: grant.public_key, signature: order.signature });
  }

  /**
   * Builds and signs the closing counter-payload for a signed mandate order without submitting anything.
   * Used by `fill` and by independent relayers that want a complete bundle.
   */
  async prepare(
    signed: SignedNep413,
  ): Promise<{ bundle: SignedNep413[]; own: SignedNep413; counter: Record<string, string> } | { shortfall: string }> {
    const config = await this.o.mandate.config();
    const tokens = [tokenId(config.usdc.token), tokenId(config.wnear.token)];
    const leg = mandateLeg(signed, this.o.mandate.id, this.o.verifier.id, tokens);
    const pips = await this.o.verifier.feePips();
    const diff = counterDiff(leg, pips);
    const mandateDiff = { [leg.sellToken]: -leg.sellAmount, [leg.buyToken]: leg.buyAmount };
    const residual = Object.entries(imbalance([mandateDiff, diff], pips)).filter(([, v]) => v !== 0n);
    if (residual.length > 0) throw new Error(`counter diff does not close: ${JSON.stringify(residual.map(([t, v]) => [t, v.toString()]))}`);
    for (const [token, delta] of Object.entries(diff)) {
      if (delta >= 0n) continue;
      const have = await this.o.verifier.balance(this.o.account.accountId, token.replace(/^nep141:/, ""));
      if (have < -delta) return { shortfall: `insufficient ${token}: have ${have}, need ${-delta}` };
    }
    const nowNs = await this.o.client.blockTimestampNs();
    const deadlineNs = nowNs + (this.o.ttlSec ?? 120n) * 1_000_000_000n;
    const salt = await this.o.verifier.currentSalt();
    const own = signNep413(this.o.key, {
      message: tokenDiffMessage(this.o.account.accountId, deadlineNs, diff),
      nonce: versionedNonce(salt, deadlineNs, randomBytes(15)),
      recipient: this.o.verifier.id,
    });
    const counter = Object.fromEntries(Object.entries(diff).map(([t, v]) => [t, v.toString()]));
    return { bundle: [signed, own], own, counter };
  }

  /** Fills one order at most once across restarts. Pass the event payload when the view lacks it. */
  async fill(orderId: string, fromEvent?: SignedNep413): Promise<FillResult> {
    const existing = this.state.orders[orderId];
    if (existing !== undefined) {
      if (existing.state === "submitting") return { record: await this.investigate(existing, "restart found an unfinished submission") };
      return { record: existing };
    }
    const order = await this.o.mandate.order(orderId);
    if (order === null) throw new Error(`order ${orderId} not found`);
    const signed = fromEvent ?? (await this.signedOrder(order));
    if (await this.o.verifier.isNonceUsed(this.o.mandate.id, signed.payload.nonce)) {
      return { record: this.record(orderId, "skipped", { mandate_nonce: signed.payload.nonce, detail: "mandate nonce already used" }) };
    }
    const prepared = await this.prepare(signed);
    if ("shortfall" in prepared) return { record: this.record(orderId, "skipped", { detail: prepared.shortfall }) };
    const { bundle, own, counter } = prepared;
    // Write-ahead: once this record exists the order is never submitted again by this filler.
    this.record(orderId, "submitting", { mandate_nonce: signed.payload.nonce, filler_nonce: own.payload.nonce, counter_diff: counter });
    const sent = await this.o.client.sendOnce(
      `filler execute_intents order ${orderId}`,
      this.o.account,
      this.o.verifier.id,
      [actions.functionCall("execute_intents", { signed: bundle }, MAX_GAS, 0n)],
      "execute_intents",
    );
    if ("ambiguous" in sent) {
      const rec = this.record(orderId, "submitting", { tx_hash: sent.tx_hash, detail: sent.error });
      return { record: await this.investigate(rec, `ambiguous submission: ${sent.error}`), bundle };
    }
    const { outcome } = sent;
    const ok = outcome.submitted && outcome.success && !outcome.any_receipt_failed;
    const record = this.record(orderId, ok ? "filled" : "failed", {
      ...(outcome.tx_hash === undefined ? {} : { tx_hash: outcome.tx_hash }),
      ...(ok ? {} : { detail: outcome.error ?? "receipt failure" }),
    });
    return { record, outcome, bundle };
  }

  /** Checks chain state for an unresolved submission and reports it. Never builds a replacement order. */
  private async investigate(rec: FillRecord, why: string): Promise<FillRecord> {
    const mandateUsed = rec.mandate_nonce === undefined ? null : await this.o.verifier.isNonceUsed(this.o.mandate.id, rec.mandate_nonce);
    const fillerUsed =
      rec.filler_nonce === undefined ? null : await this.o.verifier.isNonceUsed(this.o.account.accountId, rec.filler_nonce);
    const detail = `${why}; mandate nonce used: ${String(mandateUsed)}, filler nonce used: ${String(fillerUsed)}; no replacement order constructed`;
    return this.record(rec.order_id, mandateUsed === true && fillerUsed === true ? "filled" : "ambiguous", { detail });
  }
}
