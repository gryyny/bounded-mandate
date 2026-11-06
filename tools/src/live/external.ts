// External owner actions: the interface between the live runner and the owner console (tools/src/console).
// The runner persists an intent before the owner signs: signer, approved key, receiver, the complete action list with
// exact arguments, gas/deposit bounds and the expected end state. The console signs exactly those actions outside
// the page's custody and hands back {intent_sha256, tx_hash, signer_id}. The runner imports that hash and verifies
// the transaction and its receipts itself (main.ts); a handoff is a claim, never evidence.
// Pure (zod and WebCrypto only), so the static console can import it in a browser.
import { z } from "zod";
import type { TransactionView } from "../near/client.js";

export const EXTERNAL_INTENT_SCHEMA = "bounded-mandate/external-intent@1";
export const EXTERNAL_HANDOFF_SCHEMA = "bounded-mandate/external-handoff@1";

export const EXTERNAL_KINDS = ["revoke_external", "recover_external", "withdraw_external"] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];

const Units = z.string().regex(/^(0|[1-9][0-9]*)$/, "decimal integer string");
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const TxHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "base58 transaction hash");
const PublicKey = z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/, "ed25519 public key");

/** One FunctionCall action: exact method and arguments; gas and deposit as proposed and their accepted bounds. */
export const ExternalAction = z
  .object({
    method: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    /** Proposed prepaid gas (gas units). */
    gas: Units,
    /** Proposed attached deposit (yocto). */
    deposit: Units,
    gas_min: Units,
    gas_max: Units,
    deposit_min: Units,
    deposit_max: Units,
  })
  .strict();
export type ExternalAction = z.infer<typeof ExternalAction>;

export const ExternalIntent = z
  .object({
    schema: z.literal(EXTERNAL_INTENT_SCHEMA),
    /** The approved manifest this intent belongs to. */
    manifest_sha256: Hex64,
    /** Manifest step number, 1-based. */
    step: z.number().int().positive(),
    kind: z.enum(EXTERNAL_KINDS),
    /** 1 for the first intent of a step; a refunded withdrawal is retried under a new attempt. */
    attempt: z.number().int().positive(),
    network: z.object({ name: z.enum(["mainnet", "sandbox"]), chain_id: z.string().min(1), genesis_hash: z.string().min(1), rpc_url: z.string() }).strict(),
    signer_id: z.string().min(2),
    /** The approved owner key; a transaction signed with any other key is refused. */
    public_key: PublicKey,
    receiver_id: z.string().min(2),
    /** The complete action list, in order. Extra, missing or reordered actions are refused. */
    actions: z.array(ExternalAction).min(1),
    /** What the runner will verify after import, for people to read; verification itself reads chain state. */
    expected: z.object({ summary: z.string(), state: z.record(z.string(), z.string()) }).strict(),
    created_at: z.string(),
  })
  .strict();
export type ExternalIntent = z.infer<typeof ExternalIntent>;

export const ExternalHandoff = z
  .object({
    schema: z.literal(EXTERNAL_HANDOFF_SCHEMA),
    intent_sha256: Hex64,
    tx_hash: TxHash,
    signer_id: z.string().min(2),
  })
  .strict();
export type ExternalHandoff = z.infer<typeof ExternalHandoff>;

/** Canonical JSON with sorted keys, so hashes do not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 (hex) of the intent's canonical JSON: the identity a handoff names. */
export async function intentSha256(intent: ExternalIntent): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(ExternalIntent.parse(intent))));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const handoffOf = (intentSha: string, txHash: string, signerId: string): ExternalHandoff =>
  ExternalHandoff.parse({ schema: EXTERNAL_HANDOFF_SCHEMA, intent_sha256: intentSha, tx_hash: txHash, signer_id: signerId });

/** File stem the runner writes the intent under (`<stem>.intent.json`); the console writes `<stem>.handoff.json`. */
export const intentStem = (intent: Pick<ExternalIntent, "step" | "kind" | "attempt">): string => `step-${intent.step}-${intent.kind}-attempt-${intent.attempt}`;

interface RpcCall {
  method: string | null;
  /** Decoded JSON arguments; undefined when they are not JSON. */
  args: unknown;
  gas: bigint | null;
  deposit: bigint | null;
  kind: string;
}

const decodeArgs = (b64: unknown): unknown => {
  if (typeof b64 !== "string") return undefined;
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
};

const big = (v: unknown): bigint | null => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  return null;
};

/** The RPC's action JSON ({"FunctionCall": {...}}, or a bare "CreateAccount" string) as calls. */
function rpcCalls(actions: unknown[]): RpcCall[] {
  return actions.map((a) => {
    if (typeof a === "string") return { kind: a, method: null, args: undefined, gas: null, deposit: null };
    const entries: [string, unknown][] = typeof a === "object" && a !== null ? Object.entries(a as Record<string, unknown>) : [];
    const [kind, body]: [string, unknown] = entries.length === 1 && entries[0] !== undefined ? entries[0] : ["unknown", undefined];
    if (kind !== "FunctionCall" || typeof body !== "object" || body === null) return { kind, method: null, args: undefined, gas: null, deposit: null };
    const fc = body as Record<string, unknown>;
    return { kind, method: typeof fc.method_name === "string" ? fc.method_name : null, args: decodeArgs(fc.args), gas: big(fc.gas), deposit: big(fc.deposit) };
  });
}

/**
 * Why a looked-up transaction is not exactly the intent's signed action, or [] when it is: signer, approved key,
 * receiver, the complete action list (FunctionCall only), each method and canonical argument object, and gas and
 * deposit within bounds. Every problem starts with a stable tag (wrong signer, wrong key, ...).
 */
export function transactionProblems(intent: ExternalIntent, tx: TransactionView): string[] {
  const p: string[] = [];
  if (tx.signer_id !== intent.signer_id) p.push(`wrong signer: transaction signed by ${tx.signer_id}, intent requires ${intent.signer_id}`);
  if (tx.public_key !== intent.public_key) p.push(`wrong key: transaction signed with ${String(tx.public_key)}, the approved key is ${intent.public_key}`);
  if (tx.receiver_id !== intent.receiver_id) p.push(`wrong receiver: transaction sent to ${tx.receiver_id}, intent requires ${intent.receiver_id}`);
  const calls = rpcCalls(tx.actions);
  if (calls.length !== intent.actions.length) p.push(`extra or missing action: transaction has ${calls.length} actions, intent has ${intent.actions.length}`);
  calls.forEach((c, i) => {
    const want = intent.actions[i];
    if (want === undefined) return;
    if (c.kind !== "FunctionCall") {
      p.push(`extra or missing action: action ${i + 1} is ${c.kind}, not a function call`);
      return;
    }
    if (c.method !== want.method) p.push(`wrong method: action ${i + 1} calls ${String(c.method)}, intent requires ${want.method}`);
    if (c.args === undefined || canonicalJson(c.args) !== canonicalJson(want.args)) p.push(`altered args: action ${i + 1} arguments ${c.args === undefined ? "are not JSON" : canonicalJson(c.args)} differ from ${canonicalJson(want.args)}`);
    if (c.gas === null || c.gas < BigInt(want.gas_min) || c.gas > BigInt(want.gas_max)) p.push(`gas out of bounds: action ${i + 1} attaches ${String(c.gas)} gas, bounds [${want.gas_min}, ${want.gas_max}]`);
    if (c.deposit === null || c.deposit < BigInt(want.deposit_min) || c.deposit > BigInt(want.deposit_max)) {
      p.push(`deposit out of bounds: action ${i + 1} attaches ${String(c.deposit)} yocto, bounds [${want.deposit_min}, ${want.deposit_max}]`);
    }
  });
  return p;
}
