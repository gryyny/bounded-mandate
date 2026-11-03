// Thin helpers over near-api-js 7: transactions with full receipt capture, views and evidence receipts.
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

const ExecutionOutcome = z.object({
  logs: z.array(z.string()),
  receipt_ids: z.array(z.string()),
  executor_id: z.string(),
  status: z.unknown(),
});
const OutcomeWithId = z.object({ id: z.string(), block_hash: z.string(), outcome: ExecutionOutcome });
const TxResponse = z.object({
  status: z.unknown(),
  transaction: z.object({ hash: z.string(), signer_id: z.string(), receiver_id: z.string() }).loose(),
  transaction_outcome: OutcomeWithId,
  receipts_outcome: z.array(OutcomeWithId),
});
type TxResponse = z.infer<typeof TxResponse>;

export interface ReceiptOutcome {
  id: string;
  executor_id: string;
  block_hash: string;
  success: boolean;
  error?: string;
  logs: string[];
}

/** One transaction attempt. `submitted: false` means the network refused it before execution. */
export interface Outcome {
  label: string;
  signer_id: string;
  receiver_id: string;
  method: string;
  submitted: boolean;
  /** Final status of the transaction (the returned promise chain). */
  success: boolean;
  /** Any receipt in the tree failed, including detached ones. */
  any_receipt_failed: boolean;
  tx_hash?: string;
  block_hash?: string;
  block_height?: number;
  return_value?: unknown;
  error?: string;
  receipts: ReceiptOutcome[];
  logs: string[];
  events: EmittedEvent[];
}

const stringify = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

const statusError = (status: unknown): string | undefined =>
  typeof status === "object" && status !== null && "Failure" in status ? stringify(status.Failure) : undefined;

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

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const typed = "type" in error && typeof error.type === "string" ? `${error.type}: ` : "";
    return `${typed}${error.message}`;
  }
  return stringify(error);
}

export class NearClient {
  readonly provider: Provider;
  private readonly heights = new Map<string, number>();

  constructor(readonly rpcUrl: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  account(accountId: string, key?: KeyPair): Account {
    return key === undefined
      ? new Account(accountId, this.provider)
      : new Account(accountId, this.provider, new KeyPairSigner(key));
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
    const raw = await this.provider.callFunctionRaw({ contractId, method, args, blockQuery: { finality: "optimistic" } });
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

  async blockTimestampNs(): Promise<bigint> {
    const block = await this.provider.viewBlock({ finality: "optimistic" });
    return BigInt(block.header.timestamp_nanosec);
  }

  async send(label: string, signer: Account, receiverId: string, txActions: Action[], method = "-"): Promise<Outcome> {
    const base = { label, signer_id: signer.accountId, receiver_id: receiverId, method };
    let response: unknown;
    try {
      response = await signer.signAndSendTransaction({
        receiverId,
        actions: txActions,
        waitUntil: "EXECUTED_OPTIMISTIC",
        throwOnFailure: false,
      });
    } catch (error) {
      return {
        ...base,
        submitted: false,
        success: false,
        any_receipt_failed: false,
        error: errorMessage(error),
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
   * Signs first so the hash is known, then sends once. A transport error after sending is reported as
   * ambiguous: the caller must check chain state, never blindly resubmit.
   */
  async sendOnce(
    label: string,
    signer: Account,
    receiverId: string,
    txActions: Action[],
    method: string,
  ): Promise<{ outcome: Outcome } | { ambiguous: true; tx_hash: string; error: string }> {
    const signed = await signer.createSignedTransaction({ receiverId, actions: txActions });
    const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
    const base = { label, signer_id: signer.accountId, receiver_id: receiverId, method };
    let response: unknown;
    try {
      response = await this.provider.sendTransactionUntil(signed, "EXECUTED_OPTIMISTIC");
    } catch (error) {
      const message = errorMessage(error);
      // An invalid transaction is rejected before inclusion and cannot execute later.
      if (/InvalidTx|InvalidNonce|InvalidAccessKey|NotEnoughBalance|Expired/i.test(message)) {
        return {
          outcome: {
            ...base,
            submitted: false,
            success: false,
            any_receipt_failed: false,
            tx_hash: txHash,
            error: message,
            receipts: [],
            logs: [],
            events: [],
          },
        };
      }
      return { ambiguous: true, tx_hash: txHash, error: message };
    }
    return { outcome: await this.toOutcome(base, TxResponse.parse(response)) };
  }

  private async toOutcome(
    base: Pick<Outcome, "label" | "signer_id" | "receiver_id" | "method">,
    tx: TxResponse,
  ): Promise<Outcome> {
    const all = [tx.transaction_outcome, ...tx.receipts_outcome];
    const receipts: ReceiptOutcome[] = all.map((r) => {
      const error = statusError(r.outcome.status);
      return {
        id: r.id,
        executor_id: r.outcome.executor_id,
        block_hash: r.block_hash,
        success: error === undefined,
        ...(error === undefined ? {} : { error }),
        logs: r.outcome.logs,
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
    const height = await this.blockHeight(tx.transaction_outcome.block_hash);
    return {
      ...base,
      submitted: true,
      success: error === undefined,
      any_receipt_failed: receipts.some((r) => !r.success),
      tx_hash: tx.transaction.hash,
      block_hash: tx.transaction_outcome.block_hash,
      ...(height === undefined ? {} : { block_height: height }),
      return_value: statusValue(tx.status),
      ...(error === undefined ? {} : { error }),
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
    outcome: outcome.success && outcome.submitted ? "success" : "failure",
    detail: {
      signer_id: outcome.signer_id,
      receiver_id: outcome.receiver_id,
      method: outcome.method,
      submitted: outcome.submitted,
      any_receipt_failed: outcome.any_receipt_failed,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      events: outcome.events.map((e) => ({ emitter: e.emitter, event: e.event, data: e.data })),
      receipts: outcome.receipts.map((r) => ({ id: r.id, executor_id: r.executor_id, success: r.success })),
      ...detail,
    },
  };
}
