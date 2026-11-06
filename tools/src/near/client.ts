// Thin helpers over near-api-js 7: transactions with full receipt-tree capture, fees, deposits, views
// and evidence receipts. Success means the final status is SuccessValue/SuccessReceiptId; any other
// non-failure status, or a transport error after sending, is ambiguous and must be reconciled from chain.
import { createHash } from "node:crypto";
import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  type KeyPair,
  actions,
  baseEncode,
  encodeTransaction,
  type Action,
  type Provider,
} from "near-api-js";
import { z } from "zod";
import type { Receipt } from "../types.js";
import { parseEventLog, type EmittedEvent } from "./events.js";

export const TGAS = 1_000_000_000_000n;
export const MAX_GAS = 300n * TGAS;
export const ONE_YOCTO = 1n;
export const NEAR = 10n ** 24n;

const Yocto = z.union([z.string(), z.number(), z.bigint()]).transform((v) => BigInt(v));
const ExecutionOutcome = z
  .object({
    logs: z.array(z.string()),
    receipt_ids: z.array(z.string()),
    executor_id: z.string(),
    status: z.unknown(),
    gas_burnt: Yocto.optional(),
    tokens_burnt: Yocto.optional(),
  })
  .loose();
const OutcomeWithId = z.object({ id: z.string(), block_hash: z.string(), outcome: ExecutionOutcome }).loose();
const TxResponse = z
  .object({
    status: z.unknown(),
    final_execution_status: z.string().optional(),
    transaction: z
      .object({ hash: z.string(), signer_id: z.string(), receiver_id: z.string(), public_key: z.string().optional(), nonce: Yocto.optional(), actions: z.array(z.unknown()).optional() })
      .loose(),
    transaction_outcome: OutcomeWithId,
    receipts_outcome: z.array(OutcomeWithId),
  })
  .loose();
type TxResponse = z.infer<typeof TxResponse>;

export interface ReceiptOutcome {
  id: string;
  executor_id: string;
  block_hash: string;
  success: boolean;
  /** Status was neither success nor failure (e.g. Unknown): the tree is not final. */
  unknown: boolean;
  error?: string;
  logs: string[];
  tokens_burnt: string;
}

/**
 * One transaction attempt.
 * - `submitted`: known to have been included and executed (final status success or failure).
 * - `ambiguous`: it may or may not execute (transport error, unknown status, unfinished receipt tree).
 * - neither: the network refused it before inclusion; it cannot execute later.
 */
export interface Outcome {
  label: string;
  signer_id: string;
  receiver_id: string;
  method: string;
  submitted: boolean;
  ambiguous: boolean;
  /** Final status of the transaction (the returned promise chain) is a success value. */
  success: boolean;
  /** Any receipt in the tree failed, including detached ones. */
  any_receipt_failed: boolean;
  tx_hash?: string;
  block_hash?: string;
  block_height?: number;
  /** Access-key nonce used by the transaction, when known. */
  nonce?: string;
  public_key?: string;
  /** Sum of tokens_burnt over the transaction and every receipt (gas burnt x gas price), yocto. */
  fee_yocto: string;
  /** Sum of attached deposits and transfers, yocto. */
  deposit_yocto: string;
  final_execution_status?: string;
  /** The RPC reported the outcome FINAL (all receipts in final blocks). */
  final: boolean;
  return_value?: unknown;
  error?: string;
  receipts: ReceiptOutcome[];
  logs: string[];
  events: EmittedEvent[];
  /** The signed transaction as the RPC reports it (looked-up or sent transactions), for imports that check it. */
  transaction?: TransactionView;
}

/** A transaction's signed fields as reported by the RPC; `actions` are the RPC's action JSON. */
export interface TransactionView {
  hash: string;
  signer_id: string;
  public_key: string | null;
  nonce: string | null;
  receiver_id: string;
  actions: unknown[];
}

const stringify = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

const statusError = (status: unknown): string | undefined =>
  typeof status === "object" && status !== null && "Failure" in status ? stringify(status.Failure) : undefined;

const isSuccessStatus = (status: unknown): boolean =>
  typeof status === "object" && status !== null && ("SuccessValue" in status || "SuccessReceiptId" in status);

const statusValue = (status: unknown): unknown => {
  if (typeof status !== "object" || status === null || !("SuccessValue" in status)) return undefined;
  const raw = status.SuccessValue;
  if (typeof raw !== "string" || raw === "") return undefined;
  const text = Buffer.from(raw, "base64").toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/** Deposits from the RPC's action JSON ({"FunctionCall": {deposit}}, {"Transfer": {deposit}}). */
export function depositOf(txActions: unknown[]): bigint {
  let total = 0n;
  for (const a of txActions) {
    if (typeof a !== "object" || a === null) continue;
    for (const v of Object.values(a as Record<string, unknown>)) {
      const d = z.object({ deposit: Yocto }).loose().safeParse(v);
      if (d.success) total += d.data.deposit;
    }
  }
  return total;
}

/** Deposits of actions we are about to sign (near-api-js Action objects). */
export function plannedDeposit(txActions: Action[]): bigint {
  let total = 0n;
  for (const a of txActions) {
    if (a.functionCall !== undefined) total += a.functionCall.deposit;
    if (a.transfer !== undefined) total += a.transfer.deposit;
  }
  return total;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const typed = "type" in error && typeof error.type === "string" ? `${error.type}: ` : "";
    return `${typed}${error.message}`;
  }
  return stringify(error);
}

/** Errors that prove the transaction was refused before inclusion and can never execute. */
const DEFINITIVE_REJECTION =
  /InvalidTx|InvalidNonce|InvalidAccessKey|NotEnoughBalance|NotEnoughAllowance|Expired|MethodNameMismatch|ReceiverMismatch|RequiresFullAccess|DepositWithFunctionCall|Access key does not allow method|does not match transaction receiver|requires full access|Deposit is not allowed with function call|Not enough allowance for access key|Transaction nonce \d+ must be larger/i;

export const AccountInfo = z.object({ amount: z.string(), locked: z.string(), code_hash: z.string(), storage_usage: z.number() }).loose();
export type AccountInfo = z.infer<typeof AccountInfo>;
const RawAccessKey = z.object({
  public_key: z.string(),
  access_key: z.object({
    nonce: z.union([z.number(), z.string()]),
    permission: z.union([
      z.literal("FullAccess"),
      z.object({ FunctionCall: z.object({ allowance: z.string().nullable(), receiver_id: z.string(), method_names: z.array(z.string()) }) }),
    ]),
  }),
});
export interface AccessKeyInfo {
  public_key: string;
  nonce: bigint;
  permission: { kind: "full" } | { kind: "function_call"; receiver_id: string; method_names: string[]; allowance: bigint | null };
}

export interface SignedInfo {
  tx_hash: string;
  signer_id: string;
  public_key: string;
  nonce: string;
}

export class NearClient {
  readonly provider: Provider;
  private readonly heights = new Map<string, number>();

  /**
   * `finality` governs every state read; `waitUntil` governs `submit`/`resolve`. The demo and sandbox
   * tests read optimistic state; the live runner uses `final()` so reads and outcomes are finalized.
   */
  constructor(
    readonly rpcUrl: string,
    provider?: Provider,
    readonly finality: "final" | "optimistic" = "optimistic",
    readonly waitUntil: "FINAL" | "EXECUTED_OPTIMISTIC" = "EXECUTED_OPTIMISTIC",
  ) {
    this.provider = provider ?? new JsonRpcProvider({ url: rpcUrl });
  }

  /** Same transport, finalized reads and transactions awaited to FINAL. */
  final(): NearClient {
    return new NearClient(this.rpcUrl, this.provider, "final", "FINAL");
  }

  account(accountId: string, key?: KeyPair): Account {
    return key === undefined ? new Account(accountId, this.provider) : new Account(accountId, this.provider, new KeyPairSigner(key));
  }

  async blockHeight(blockHash: string): Promise<number | undefined> {
    const known = this.heights.get(blockHash);
    if (known !== undefined) return known;
    try {
      const block = await this.provider.viewBlock({ blockId: blockHash });
      this.heights.set(blockHash, block.header.height);
      return block.header.height;
    } catch {
      return undefined;
    }
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const raw = await this.provider.callFunctionRaw({ contractId, method, args, blockQuery: { finality: this.finality } });
    const text = Buffer.from(raw.result).toString("utf8");
    return schema.parse(text === "" ? null : JSON.parse(text));
  }

  /** Like `view`, but returns the error message instead of throwing (for views expected to panic). */
  async tryView<T>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
      return { ok: true, value: await this.view(contractId, method, args, schema) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /** Timestamp of a specific block (e.g. the block that executed a receipt). */
  async blockTimestampAt(blockHash: string): Promise<bigint> {
    const block = await this.provider.viewBlock({ blockId: blockHash });
    return BigInt(block.header.timestamp_nanosec);
  }

  async blockTimestampNs(): Promise<bigint> {
    const block = await this.provider.viewBlock({ finality: this.finality });
    return BigInt(block.header.timestamp_nanosec);
  }

  /** Gas price at the latest block of this client's finality. */
  async gasPrice(): Promise<bigint> {
    const block = await this.provider.viewBlock({ finality: this.finality });
    const res = await this.provider.viewGasPrice(block.header.hash);
    return BigInt(res.gas_price);
  }

  /** Signs and sends (near-api-js retries only a stale nonce, which was never accepted). */
  async send(label: string, signer: Account, receiverId: string, txActions: Action[], method = "-"): Promise<Outcome> {
    const base = { label, signer_id: signer.accountId, receiver_id: receiverId, method };
    let response: unknown;
    try {
      response = await signer.signAndSendTransaction({ receiverId, actions: txActions, waitUntil: this.waitUntil, throwOnFailure: false });
    } catch (error) {
      const message = errorMessage(error);
      const definitive = DEFINITIVE_REJECTION.test(message);
      return {
        ...base,
        submitted: false,
        ambiguous: !definitive,
        final: false,
        success: false,
        any_receipt_failed: false,
        fee_yocto: "0",
        deposit_yocto: "0",
        error: definitive ? message : `ambiguous: ${message}`,
        receipts: [],
        logs: [],
        events: [],
      };
    }
    return this.toOutcome(base, TxResponse.parse(response));
  }

  call(
    label: string,
    signer: Account,
    contractId: string,
    method: string,
    args: Record<string, unknown> | Uint8Array,
    opts: { gas?: bigint; deposit?: bigint } = {},
  ): Promise<Outcome> {
    const action = actions.functionCall(method, args, opts.gas ?? MAX_GAS, opts.deposit ?? 0n);
    return this.send(label, signer, contractId, [action], method);
  }

  /**
   * Signs first (hash and nonce known), lets the caller persist that before anything is sent, then sends
   * exactly once. A transport error is followed by one status lookup; if that is inconclusive the outcome
   * is ambiguous and the caller must reconcile from chain state. Never resubmits.
   */
  async submit(
    label: string,
    signer: Account,
    receiverId: string,
    txActions: Action[],
    method: string,
    beforeSend?: (info: SignedInfo) => void | Promise<void>,
  ): Promise<Outcome> {
    const signed = await signer.createSignedTransaction({ receiverId, actions: txActions });
    const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
    const info: SignedInfo = {
      tx_hash: txHash,
      signer_id: signer.accountId,
      public_key: signed.transaction.publicKey.toString(),
      nonce: signed.transaction.nonce.toString(),
    };
    await beforeSend?.(info);
    const base = { label, signer_id: signer.accountId, receiver_id: receiverId, method, nonce: info.nonce, public_key: info.public_key };
    const empty = { final: false, success: false, any_receipt_failed: false, fee_yocto: "0", deposit_yocto: "0", receipts: [], logs: [], events: [], tx_hash: txHash };
    let response: unknown;
    try {
      response = await this.provider.sendTransactionUntil(signed, this.waitUntil);
    } catch (error) {
      const message = errorMessage(error);
      if (DEFINITIVE_REJECTION.test(message)) return { ...base, ...empty, submitted: false, ambiguous: false, error: message };
      const found = await this.resolve(label, signer.accountId, txHash, method);
      if (found !== null) return { ...found, nonce: info.nonce, public_key: info.public_key };
      return { ...base, ...empty, submitted: false, ambiguous: true, error: `ambiguous: ${message}` };
    }
    return { ...(await this.toOutcome(base, TxResponse.parse(response))), nonce: info.nonce, public_key: info.public_key };
  }

  /** Backwards-compatible single send for the filler: ambiguity as a separate result. */
  async sendOnce(
    label: string,
    signer: Account,
    receiverId: string,
    txActions: Action[],
    method: string,
  ): Promise<{ outcome: Outcome } | { ambiguous: true; tx_hash: string; error: string }> {
    const outcome = await this.submit(label, signer, receiverId, txActions, method);
    return outcome.ambiguous ? { ambiguous: true, tx_hash: outcome.tx_hash ?? "", error: outcome.error ?? "ambiguous" } : { outcome };
  }

  /** Looks a transaction up by hash. Returns null when the node does not know it (or cannot say). */
  async resolve(label: string, signerId: string, txHash: string, method = "-"): Promise<Outcome | null> {
    try {
      const response = await this.provider.viewTransactionStatusWithReceipts({ txHash, accountId: signerId, waitUntil: this.waitUntil });
      const tx = TxResponse.parse(response);
      return await this.toOutcome({ label, signer_id: signerId, receiver_id: tx.transaction.receiver_id, method }, tx);
    } catch {
      return null;
    }
  }

  /**
   * Whether the node knows a transaction at all, without waiting for any execution status: a lookup that waits for
   * FINAL blocks until the RPC times out (and the transport retries) when the hash is unknown.
   */
  async txKnown(txHash: string, signerId: string): Promise<"known" | "unknown" | "unreachable"> {
    try {
      const rpc = this.provider as unknown as { sendJsonRpc: (method: string, params: unknown) => Promise<unknown> };
      await rpc.sendJsonRpc("tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "NONE" });
      return "known";
    } catch (error) {
      const text = `${error instanceof Error ? error.name : ""} ${errorMessage(error)}`;
      return /UnknownTransaction|UNKNOWN_TRANSACTION|doesn't exist/i.test(text) ? "unknown" : "unreachable";
    }
  }

  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null> {
    try {
      const key = await this.provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: this.finality } });
      return key.nonce;
    } catch {
      return null;
    }
  }

  private async rawQuery(params: Record<string, unknown>): Promise<unknown> {
    const query = this.provider.query.bind(this.provider) as (p: Record<string, unknown>) => Promise<unknown>;
    return query({ finality: this.finality, ...params });
  }

  /** view_account, validated. */
  async accountView(accountId: string): Promise<AccountInfo> {
    return AccountInfo.parse(await this.rawQuery({ request_type: "view_account", account_id: accountId }));
  }

  /** view_access_key_list, validated and normalized. */
  async accessKeys(accountId: string): Promise<AccessKeyInfo[]> {
    const list = z.object({ keys: z.array(RawAccessKey) }).loose().parse(await this.rawQuery({ request_type: "view_access_key_list", account_id: accountId }));
    return list.keys.map((k) => {
      const p = k.access_key.permission;
      return {
        public_key: k.public_key,
        nonce: BigInt(k.access_key.nonce),
        permission:
          p === "FullAccess"
            ? { kind: "full" as const }
            : { kind: "function_call" as const, receiver_id: p.FunctionCall.receiver_id, method_names: p.FunctionCall.method_names, allowance: p.FunctionCall.allowance === null ? null : BigInt(p.FunctionCall.allowance) },
      };
    });
  }

  /** Deployed code of an account. */
  async code(accountId: string): Promise<Uint8Array> {
    const res = z.object({ code_base64: z.string() }).loose().parse(await this.rawQuery({ request_type: "view_code", account_id: accountId }));
    return Buffer.from(res.code_base64, "base64");
  }

  async nodeStatus(): Promise<{ chain_id: string; genesis_hash: string }> {
    const status = await this.provider.viewNodeStatus();
    return z.object({ chain_id: z.string(), genesis_hash: z.string() }).loose().parse(status);
  }

  private async toOutcome(base: Pick<Outcome, "label" | "signer_id" | "receiver_id" | "method">, tx: TxResponse): Promise<Outcome> {
    const all = [tx.transaction_outcome, ...tx.receipts_outcome];
    let fee = 0n;
    const receipts: ReceiptOutcome[] = all.map((r) => {
      const error = statusError(r.outcome.status);
      const ok = isSuccessStatus(r.outcome.status);
      fee += r.outcome.tokens_burnt ?? 0n;
      return {
        id: r.id,
        executor_id: r.outcome.executor_id,
        block_hash: r.block_hash,
        success: ok,
        unknown: !ok && error === undefined,
        ...(error === undefined ? {} : { error }),
        logs: r.outcome.logs,
        tokens_burnt: (r.outcome.tokens_burnt ?? 0n).toString(),
      };
    });
    const events: EmittedEvent[] = [];
    for (const r of receipts) {
      for (const log of r.logs) {
        const event = parseEventLog(log);
        if (event !== null) events.push({ ...event, emitter: r.executor_id, receipt_id: r.id });
      }
    }
    const error = statusError(tx.status);
    const success = isSuccessStatus(tx.status);
    const unknown = (!success && error === undefined) || receipts.some((r) => r.unknown);
    const height = await this.blockHeight(tx.transaction_outcome.block_hash);
    return {
      ...base,
      submitted: !unknown,
      ambiguous: unknown,
      success: success && !unknown,
      any_receipt_failed: receipts.some((r) => r.error !== undefined),
      tx_hash: tx.transaction.hash,
      block_hash: tx.transaction_outcome.block_hash,
      ...(height === undefined ? {} : { block_height: height }),
      ...(tx.transaction.nonce === undefined ? {} : { nonce: tx.transaction.nonce.toString() }),
      fee_yocto: fee.toString(),
      deposit_yocto: depositOf(tx.transaction.actions ?? []).toString(),
      ...(tx.final_execution_status === undefined ? {} : { final_execution_status: tx.final_execution_status }),
      final: tx.final_execution_status === "FINAL",
      return_value: statusValue(tx.status),
      transaction: {
        hash: tx.transaction.hash,
        signer_id: tx.transaction.signer_id,
        public_key: tx.transaction.public_key ?? null,
        nonce: tx.transaction.nonce === undefined ? null : tx.transaction.nonce.toString(),
        receiver_id: tx.transaction.receiver_id,
        actions: tx.transaction.actions ?? [],
      },
      ...(error === undefined ? (unknown ? { error: "ambiguous: transaction or receipt status unknown" } : {}) : { error }),
      receipts,
      logs: receipts.flatMap((r) => r.logs),
      events,
    };
  }
}

export function toEvidenceReceipt(outcome: Outcome, detail: Record<string, unknown> = {}): Receipt {
  return {
    label: outcome.label,
    ...(outcome.tx_hash === undefined ? {} : { tx_hash: outcome.tx_hash }),
    ...(outcome.block_height === undefined ? {} : { block_height: outcome.block_height }),
    outcome: outcome.success && outcome.submitted && !outcome.any_receipt_failed ? "success" : "failure",
    detail: {
      signer_id: outcome.signer_id,
      receiver_id: outcome.receiver_id,
      method: outcome.method,
      submitted: outcome.submitted,
      ambiguous: outcome.ambiguous,
      final: outcome.final,
      any_receipt_failed: outcome.any_receipt_failed,
      fee_yocto: outcome.fee_yocto,
      deposit_yocto: outcome.deposit_yocto,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      events: outcome.events.map((e) => ({ emitter: e.emitter, event: e.event, data: e.data })),
      receipts: outcome.receipts.map((r) => ({ id: r.id, executor_id: r.executor_id, success: r.success, ...(r.error === undefined ? {} : { error: r.error }) })),
      ...detail,
    },
  };
}
