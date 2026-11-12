// Read-only verification that runs in the reader's browser, only after an explicit click. verify.ts serializes
// every function in CLIENT_FUNCTIONS with Function.prototype.toString into the page's single inline script, and
// the tests evaluate that same script. So each function may use only browser globals and the other listed
// functions: no imports and no module-level values. Nothing here signs, sends a transaction or needs a wallet.
//
// Semantics follow classifyRelay in src/live/verify.ts: a relay of the withheld order counts as rejected only when
// the verifier's receipt failed because the order's recorded signing key was not registered, at a block time not
// after the order deadline, with nothing else failing and the relayed bundle bound to the recorded one; a
// successful transaction is "executed"; everything else is inconclusive. That shows the key was absent at relay
// time, not that it was ever registered or that the order was executable before. The browser cannot re-read
// historical balances, so it checks the receipts, not balance deltas. A recorded transaction outcome is compared
// with the chain's outcome computed as the runner records it (toEvidenceReceipt in src/near/client.ts).
//
// The historical replay (SPEC.md "Historical replay of the withheld order") closes that gap from archival state:
// historicalReplay applies the same rules as historicalReplay in verify.mjs, and test/replay-rules.test.ts runs both
// on the same cases and requires the same result. Requests are paced, because public archival endpoints answer
// bursts with HTTP 429.

export interface ExpectedTx {
  label: string;
  tx_hash: string;
  sender: string;
  outcome: "success" | "failure";
}

export interface ExpectedRelay {
  label: string;
  tx_hash: string;
  sender: string;
  verifier: string;
  mandate: string;
  revoked_key: string;
  deadline_ns: string;
  order_id: string;
  /** sha256 of the canonical JSON of the exact signed bundle, as recorded by the live runner. */
  bundle_sha256: string | null;
}

export interface TxRef {
  tx_hash: string;
  sender: string;
}

/** What the run's evidence gives the historical replay. The bundle and both snapshots are read from the chain. */
export interface ExpectedReplay {
  mandate: string;
  verifier: string;
  relay: TxRef;
  /** Recorded revoke transactions; the one whose remove_public_key receipt names the order's signing key is used. */
  revokes: TxRef[];
  /** Recorded proposal transactions, searched for the mandate's signed-order event. */
  proposals: TxRef[];
  /** NEAR code hashes the run's evidence records; null when it records none (the mandate's must be the deployment candidate's). */
  mandate_code_hash: string | null;
  verifier_code_hash: string | null;
}

export interface VerifyData {
  rpc: string;
  chain_id: string;
  genesis_hash: string;
  verifier: string;
  /** base58 sha256 of the pinned verifier WASM fixture. */
  verifier_code_hash: string;
  receipts: ExpectedTx[];
  /** Recorded transactions the browser cannot query (no valid hash or sender), with the reason. */
  unverifiable: { label: string; reason: string }[];
  relay: ExpectedRelay | null;
  /** Why the relay cannot be checked although mainnet receipts exist; null otherwise. */
  relay_problem: string | null;
  /** The historical replay's inputs; null when the evidence names no relay transaction to replay. */
  replay: ExpectedReplay | null;
  replay_problem: string | null;
  current: { mandate: string; grant_key: string | null } | null;
  timeout_ms: number;
  /** Least time between two requests. */
  pace_ms: number;
}

/** A failed call carries the HTTP status, or the JSON-RPC error's cause name and full text, when there is one. */
export type RpcResult = { ok: true; result: unknown } | { ok: false; error: string; http?: number; cause?: string; detail?: string };

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; credentials: "omit"; referrerPolicy: "no-referrer"; cache: "no-store" }) => Promise<FetchResponse>;
export type Call = (method: string, params: unknown) => Promise<RpcResult>;

/** verified: the check holds. failed: the chain contradicts the evidence. info: current state, never a proof. */
export type ItemStatus = "verified" | "failed" | "inconclusive" | "error" | "info" | "none";

export interface Item {
  status: ItemStatus;
  title: string;
  facts: [string, string][];
  reasons: string[];
}

export interface Report {
  rpc: string;
  chain: Item;
  historical: { verdict: Item; items: Item[] };
  current: Item[];
}

export type RelayClassification = "rejected_revoked_key" | "inconclusive" | "executed";

export function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function rpcErrorText(e: unknown): string {
  const o = asObject(e);
  if (o === null) return String(e);
  const cause = asObject(o.cause);
  const name = asString(cause?.name) ?? asString(o.name) ?? "RPC error";
  const detail = asString(o.data) ?? asString(o.message) ?? JSON.stringify(cause?.info ?? o).slice(0, 200);
  return `${name}: ${detail}`;
}

/** One JSON-RPC call; never throws. Times out after `timeoutMs`, whether or not fetch honours the abort signal. */
export async function rpcCall(fetchFn: FetchFn, url: string, method: string, params: unknown, timeoutMs: number): Promise<RpcResult> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RpcResult>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve({ ok: false, error: `timed out after ${String(timeoutMs)} ms` });
    }, timeoutMs);
  });
  const request = (async (): Promise<RpcResult> => {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
        signal: ctrl.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!res.ok) return { ok: false, error: `HTTP ${String(res.status)}`, http: res.status };
      const body = asObject(await res.json());
      if (body === null) return { ok: false, error: "response is not a JSON-RPC object" };
      if (body.error !== undefined && body.error !== null) {
        const cause = asString(asObject(asObject(body.error)?.cause)?.name);
        return { ok: false, error: rpcErrorText(body.error), detail: JSON.stringify(body.error), ...(cause === null ? {} : { cause }) };
      }
      if (!("result" in body) || body.result === undefined || body.result === null) return { ok: false, error: "response has no result" };
      return { ok: true, result: body.result };
    } catch (e) {
      return { ok: false, error: `request failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls of one run, at least `paceMs` apart. A rate-limited request (HTTP 429) is sent again three times with a
 * growing pause; after that the read counts as unavailable.
 */
export function pacedCall(fetchFn: FetchFn, url: string, timeoutMs: number, paceMs: number): Call {
  let next = 0;
  return async (method, params) => {
    const attempts = 4;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const wait = Math.max(next - Date.now(), attempt === 0 ? 0 : paceMs * 2 ** attempt);
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      next = Date.now() + paceMs;
      const r = await rpcCall(fetchFn, url, method, params, timeoutMs);
      if (r.ok || r.http !== 429) return r;
    }
    return { ok: false, error: `HTTP 429 on each of ${String(attempts)} attempts (rate limited)` };
  };
}

export async function checkChain(call: Call, data: VerifyData): Promise<Item> {
  const r = await call("status", []);
  const facts: [string, string][] = [["Expected", `chain id ${data.chain_id}, genesis ${data.genesis_hash}`]];
  if (!r.ok) return { status: "error", title: "Network check: the RPC did not answer", facts, reasons: [r.error] };
  const s = asObject(r.result);
  const chainId = asString(s?.chain_id);
  const genesis = asString(s?.genesis_hash);
  const observed: [string, string][] = [...facts, ["RPC reports", `chain id ${chainId ?? "none"}, genesis ${genesis ?? "none"}`]];
  const reasons = [
    ...(chainId === data.chain_id ? [] : [`chain id is ${JSON.stringify(chainId)}, expected ${JSON.stringify(data.chain_id)}`]),
    ...(genesis === data.genesis_hash ? [] : [`genesis hash is ${JSON.stringify(genesis)}, expected ${JSON.stringify(data.genesis_hash)}`]),
  ];
  return reasons.length === 0
    ? { status: "verified", title: `Network check: NEAR ${data.chain_id}`, facts: observed, reasons }
    : { status: "failed", title: "Network check failed: wrong chain; nothing else is checked", facts: observed, reasons };
}

/** "success", "failure" or "unknown" for a NEAR execution status. */
export function statusKind(status: unknown): "success" | "failure" | "unknown" {
  const o = asObject(status);
  if (o === null) return "unknown";
  if ("Failure" in o) return "failure";
  if ("SuccessValue" in o || "SuccessReceiptId" in o) return "success";
  return "unknown";
}

export interface ReceiptView {
  id: string;
  executor: string;
  block_hash: string;
  kind: "success" | "failure" | "unknown";
  error: string | null;
}

/** The transaction outcome and every receipt outcome, as the runner reads them. */
export function receiptViews(tx: Record<string, unknown>): ReceiptView[] {
  const list = [...(tx.transaction_outcome === undefined ? [] : [tx.transaction_outcome]), ...(Array.isArray(tx.receipts_outcome) ? (tx.receipts_outcome as unknown[]) : [])];
  return list.map((r) => {
    const o = asObject(r);
    const outcome = asObject(o?.outcome);
    const status = asObject(outcome?.status);
    const kind = statusKind(status);
    return {
      id: asString(o?.id) ?? "",
      executor: asString(outcome?.executor_id) ?? "",
      block_hash: asString(o?.block_hash) ?? "",
      kind,
      error: kind === "failure" ? JSON.stringify(status?.Failure) : null,
    };
  });
}

/**
 * The outcome the runner would record: "success" only when the transaction succeeded and no outcome in its tree
 * failed; "unknown" when any status is not final, so nothing can be compared.
 */
export function chainOutcome(tx: Record<string, unknown>): "success" | "failure" | "unknown" {
  const receipts = receiptViews(tx);
  const top = statusKind(tx.status);
  if (top === "unknown" || receipts.length === 0 || receipts.some((r) => r.kind === "unknown")) return "unknown";
  return top === "success" && !receipts.some((r) => r.kind === "failure") ? "success" : "failure";
}

/** Why the transaction is not the expected one at final finality; empty when it is. */
export function identityProblems(tx: Record<string, unknown>, expected: { tx_hash: string; sender: string }, receiver: string | null): string[] {
  const t = asObject(tx.transaction);
  return [
    ...(tx.final_execution_status === "FINAL" ? [] : [`not final (${JSON.stringify(tx.final_execution_status ?? null)})`]),
    ...(asString(t?.hash) === expected.tx_hash ? [] : [`transaction hash ${JSON.stringify(t?.hash ?? null)} differs from the recorded ${expected.tx_hash}`]),
    ...(asString(t?.signer_id) === expected.sender ? [] : [`signer ${JSON.stringify(t?.signer_id ?? null)} differs from the recorded ${expected.sender}`]),
    ...(receiver === null || asString(t?.receiver_id) === receiver ? [] : [`receiver ${JSON.stringify(t?.receiver_id ?? null)} is not ${receiver}`]),
  ];
}

/** The `signed` bundle passed to execute_intents in the transaction's first function call, or null. */
export function relayedBundle(tx: Record<string, unknown>): unknown {
  const actions = asObject(tx.transaction)?.actions;
  if (!Array.isArray(actions)) return null;
  for (const a of actions as unknown[]) {
    const call = asObject(asObject(a)?.FunctionCall);
    const args = asString(call?.args);
    if (call?.method_name !== "execute_intents" || args === null) continue;
    try {
      const bytes = Uint8Array.from(atob(args), (c) => c.charCodeAt(0));
      return asObject(JSON.parse(new TextDecoder().decode(bytes)))?.signed ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Same canonical JSON as src/live/ledger.ts: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v: unknown) => canonicalJson(v)).join(",")}]`;
  const o = asObject(value);
  if (o !== null) {
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Classifies a fetched relay transaction; see the file comment. */
export function classifyRelayTx(
  tx: Record<string, unknown>,
  e: ExpectedRelay,
  blockTimeNs: string | null,
  bundleSha256: string | null,
): { classification: RelayClassification; reasons: string[]; failure: ReceiptView | null } {
  const identity = identityProblems(tx, e, e.verifier);
  // A different transaction proves nothing about the withheld order, in either direction.
  if (identity.length > 0) return { classification: "inconclusive", reasons: identity, failure: null };
  const receipts = receiptViews(tx);
  const failure = receipts.find((r) => r.executor === e.verifier && r.kind === "failure") ?? null;
  if (statusKind(tx.status) === "success") return { classification: "executed", reasons: ["the relay transaction succeeded: the withheld order executed"], failure };
  const expected = `public key '${e.revoked_key}' doesn't exist for account '${e.mandate}'`;
  const reasons = [
    ...(statusKind(tx.status) === "failure" ? [] : ["the transaction status is not a final failure"]),
    ...(failure === null ? [`no failed receipt on ${e.verifier}`] : []),
    ...(failure !== null && failure.error?.includes(expected) !== true ? [`the verifier error is not the unregistered-key rejection (${expected})`] : []),
    ...(blockTimeNs === null
      ? ["the failed receipt's block time could not be read"]
      : BigInt(blockTimeNs) > BigInt(e.deadline_ns)
        ? [`executed after the order deadline (block time ${blockTimeNs} ns, deadline ${e.deadline_ns} ns): an expired order fails whatever the key state`]
        : []),
    ...(receipts.some((r) => r.kind === "failure" && r.executor !== e.verifier) ? ["a receipt outside the verifier failed"] : []),
    ...(receipts.some((r) => r.kind === "unknown") ? ["a receipt has no final status"] : []),
    ...(e.bundle_sha256 === null
      ? ["not checkable: the evidence records no bundle sha256, so the relayed bundle cannot be bound to the withheld order"]
      : bundleSha256 !== e.bundle_sha256
        ? [`the relayed bundle's sha256 ${bundleSha256 ?? "(unreadable)"} differs from the recorded ${e.bundle_sha256}`]
        : []),
  ];
  return { classification: reasons.length === 0 ? "rejected_revoked_key" : "inconclusive", reasons, failure };
}

export async function verifyTx(call: Call, e: ExpectedTx): Promise<Item> {
  const facts: [string, string][] = [
    ["Transaction", e.tx_hash],
    ["Sender", e.sender],
    ["Recorded outcome", e.outcome],
  ];
  const r = await call("tx", { tx_hash: e.tx_hash, sender_account_id: e.sender, wait_until: "FINAL" });
  if (!r.ok) return { status: "error", title: `${e.label}: not confirmed`, facts, reasons: [r.error] };
  const tx = asObject(r.result);
  if (tx === null) return { status: "error", title: `${e.label}: not confirmed`, facts, reasons: ["the RPC returned no transaction"] };
  const kind = chainOutcome(tx);
  const blocks = receiptViews(tx).map((x) => `${x.executor} ${x.kind} in block ${x.block_hash}`);
  const observed: [string, string][] = [...facts, ["Chain outcome (whole receipt tree)", kind], ["Receipts", blocks.join("; ") || "none"]];
  const identity = identityProblems(tx, e, null);
  if (identity.length === 0 && kind === "unknown") {
    return { status: "inconclusive", title: `${e.label}: outcome not final, cannot be compared`, facts: observed, reasons: ["a transaction or receipt status is neither success nor failure"] };
  }
  const reasons = [...identity, ...(kind === e.outcome ? [] : [`chain outcome ${kind} differs from the recorded ${e.outcome}`])];
  return {
    status: reasons.length === 0 ? "verified" : "failed",
    title: `${e.label}: ${reasons.length === 0 ? `final, ${kind}, as recorded` : "does not match the evidence"}`,
    facts: observed,
    reasons,
  };
}

export async function verifyRelay(call: Call, e: ExpectedRelay): Promise<Item> {
  const facts: [string, string][] = [
    ["Transaction", e.tx_hash],
    ["Relayed by", e.sender],
    ["Verifier", e.verifier],
    ["Mandate", e.mandate],
    ["Order", e.order_id],
    ["Signing key recorded for the order", e.revoked_key],
    ["Order deadline", `${new Date(Number(BigInt(e.deadline_ns) / 1000000n)).toISOString()} (${e.deadline_ns} ns)`],
    ["Recorded bundle sha256", e.bundle_sha256 ?? "not recorded"],
  ];
  const title = `${e.label}: withheld order relayed after revocation`;
  const r = await call("tx", { tx_hash: e.tx_hash, sender_account_id: e.sender, wait_until: "FINAL" });
  if (!r.ok) return { status: "error", title: `${title}: not confirmed`, facts, reasons: [r.error] };
  const tx = asObject(r.result);
  if (tx === null) return { status: "error", title: `${title}: not confirmed`, facts, reasons: ["the RPC returned no transaction"] };
  const failure = receiptViews(tx).find((x) => x.executor === e.verifier && x.kind === "failure") ?? null;
  let blockTime: string | null = null;
  const lookups: string[] = [];
  if (failure !== null) {
    const b = await call("block", { block_id: failure.block_hash });
    if (b.ok) blockTime = asString(asObject(asObject(b.result)?.header)?.timestamp_nanosec);
    else lookups.push(`block ${failure.block_hash}: ${b.error}`);
  }
  const bundle = relayedBundle(tx);
  const bundleSha = bundle === null ? null : await sha256Hex(canonicalJson(bundle));
  const c = classifyRelayTx(tx, e, blockTime, bundleSha);
  const observed: [string, string][] = [
    ...facts,
    ["Relayed bundle sha256", bundleSha ?? "unreadable"],
    ["Rejection receipt", c.failure === null ? "none" : `${c.failure.id} in block ${c.failure.block_hash}`],
    ["Block time", blockTime === null ? "unknown" : `${new Date(Number(BigInt(blockTime) / 1000000n)).toISOString()} (${blockTime} ns)`],
    ["Rejection reason", c.failure?.error ?? "none"],
    ["Not shown by this check", "that this key was ever registered, or that the order was executable before revocation. The historical replay below reads both from archival state; the recorded transactions above are checked separately."],
  ];
  if (c.classification === "rejected_revoked_key") {
    return { status: "verified", title: `${title}: rejected before its deadline because the signing key recorded for the withheld order was not registered on ${e.verifier}`, facts: observed, reasons: [] };
  }
  return {
    status: c.classification === "executed" ? "failed" : "inconclusive",
    title: `${title}: ${c.classification === "executed" ? "EXECUTED — revocation did not stop it" : "inconclusive, not evidence that revocation stopped it"}`,
    facts: observed,
    reasons: [...lookups, ...c.reasons],
  };
}

export type ReplayStatus = "verified" | "failed" | "inconclusive";
export type ReplayItemId = "bundle" | "preceding" | "removal" | "deadlines" | "relay" | "code";

export interface ReplayResult {
  status: ReplayStatus;
  /** One entry per rule of the spec, in its order. */
  items: { id: ReplayItemId; status: ReplayStatus; reasons: string[] }[];
  facts: [string, string][];
}

export type HeaderRead = { ok: true; hash: string; height: number; prev: string; time: bigint } | { ok: false; error: string };
/** A value, a refusal by the contract (evidence about that state), or state the RPC did not serve. */
export type ViewRead = { kind: "value"; value: unknown } | { kind: "refused"; error: string } | { kind: "unavailable"; error: string };

/** The deadline of one signed intent in nanoseconds, or null when it carries none this check can read. */
export function deadlineNs(entry: unknown): bigint | null {
  const payload = asObject(entry)?.payload;
  const text = asString(payload) ?? asString(asObject(payload)?.message);
  let deadline: string | null;
  try {
    deadline = text === null ? null : asString(asObject(JSON.parse(text) as unknown)?.deadline);
  } catch {
    return null;
  }
  if (deadline === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(deadline)) return null;
  // Digits below a millisecond are dropped, which can only make the deadline earlier.
  const ms = Date.parse(deadline.replace(/(\.\d{3})\d+Z$/, "$1Z"));
  return Number.isFinite(ms) ? BigInt(ms) * 1000000n : null;
}

/** The hash of the block in which the mandate logged `order` as signed (order_signed) in this transaction, or null. */
export function signedOrderBlock(tx: Record<string, unknown>, mandate: string, order: Record<string, unknown>): string | null {
  const same = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
    const [p, q] = [asObject(a.payload), asObject(b.payload)];
    return p !== null && q !== null && a.standard === b.standard && a.public_key === b.public_key && a.signature === b.signature && p.message === q.message && p.nonce === q.nonce && p.recipient === q.recipient;
  };
  for (const raw of Array.isArray(tx.receipts_outcome) ? (tx.receipts_outcome as unknown[]) : []) {
    const o = asObject(raw);
    const outcome = asObject(o?.outcome);
    if (o === null || outcome?.executor_id !== mandate || statusKind(outcome.status) !== "success") continue;
    for (const log of Array.isArray(outcome.logs) ? (outcome.logs as unknown[]) : []) {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
      try {
        const event = asObject(JSON.parse(log.slice("EVENT_JSON:".length)) as unknown);
        if (event?.standard !== "bounded_mandate" || event.event !== "order_signed") continue;
        const logged = asObject(event.data)?.multi_payload;
        const mp = asObject(typeof logged === "string" ? (JSON.parse(logged) as unknown) : logged);
        if (mp !== null && same(mp, order) && typeof o.block_hash === "string") return o.block_hash;
      } catch {
        // Not an event of the mandate: nothing is read from it.
      }
    }
  }
  return null;
}

/** Whether a receipt of EXPERIMENTAL_tx_status is the mandate's remove_public_key call on the verifier for `key`. */
export function removesKey(receipt: unknown, mandate: string, verifier: string, key: string): boolean {
  const r = asObject(receipt);
  if (r === null || r.predecessor_id !== mandate || r.receiver_id !== verifier) return false;
  const actions = asObject(asObject(r.receipt)?.Action)?.actions;
  const call = (Array.isArray(actions) ? (actions as unknown[]) : []).map((a) => asObject(asObject(a)?.FunctionCall)).find((c) => c?.method_name === "remove_public_key");
  try {
    const bytes = Uint8Array.from(atob(asString(call?.args) ?? ""), (c) => c.charCodeAt(0));
    return asObject(JSON.parse(new TextDecoder().decode(bytes)) as unknown)?.public_key === key;
  } catch {
    return false;
  }
}

/** A block by hash: its height, the hash before it and its time. Anything else is state the RPC did not serve. */
export async function replayHeader(call: Call, hash: string): Promise<HeaderRead> {
  const r = await call("block", { block_id: hash });
  if (!r.ok) return { ok: false, error: `block ${hash}: ${r.error}` };
  const h = asObject(asObject(r.result)?.header);
  const [prev, time] = [asString(h?.prev_hash), asString(h?.timestamp_nanosec)];
  if (h === null || h.hash !== hash || typeof h.height !== "number" || !Number.isInteger(h.height) || prev === null || time === null || !/^[0-9]+$/.test(time))
    return { ok: false, error: `block ${hash}: the RPC returned no header of that block with a height, a previous hash and a time` };
  return { ok: true, hash, height: h.height, prev, time: BigInt(time) };
}

/** One contract view at a block hash. A node reports a panic inside the result (`error`) or as a CONTRACT_EXECUTION_ERROR. */
export async function replayView(call: Call, account: string, method: string, argsBase64: string, hash: string): Promise<ViewRead> {
  const r = await call("query", { request_type: "call_function", account_id: account, method_name: method, args_base64: argsBase64, block_id: hash });
  if (!r.ok) return r.cause === "CONTRACT_EXECUTION_ERROR" ? { kind: "refused", error: r.detail ?? r.error } : { kind: "unavailable", error: r.error };
  const res = asObject(r.result);
  if (res === null || res.block_hash !== hash) return { kind: "unavailable", error: `the RPC did not answer for block ${hash}` };
  if (typeof res.error === "string") return { kind: "refused", error: res.error };
  try {
    return { kind: "value", value: decodeView(res) };
  } catch {
    return { kind: "unavailable", error: `${method} returned no JSON result` };
  }
}

export async function replayCodeHash(call: Call, account: string, hash: string): Promise<ViewRead> {
  const r = await call("query", { request_type: "view_account", account_id: account, block_id: hash });
  if (!r.ok) return { kind: "unavailable", error: r.error };
  const res = asObject(r.result);
  const code = asString(res?.code_hash);
  if (res === null || res.block_hash !== hash || code === null) return { kind: "unavailable", error: `the RPC returned no account with a code hash for block ${hash}` };
  return { kind: "value", value: code };
}

/** Why a simulate_intents result is not an acceptance of the whole bundle; null when it is. */
export function simulationProblem(value: unknown, bundle: readonly unknown[]): string | null {
  const v = asObject(value);
  if (v === null) return "simulate_intents returned no simulation output at the preceding snapshot";
  if (v.invariant_violated !== undefined && v.invariant_violated !== null) return `simulate_intents reports an invariant violation at the preceding snapshot: ${JSON.stringify(v.invariant_violated).slice(0, 300)}`;
  const executed = Array.isArray(v.intents_executed) ? (v.intents_executed as unknown[]) : [];
  if (executed.length !== bundle.length) return `simulate_intents executed ${String(executed.length)} of the bundle's ${String(bundle.length)} signed intents at the preceding snapshot`;
  const differs = bundle.some((x, i) => {
    const nonce = asObject(asObject(x)?.payload)?.nonce;
    return typeof nonce === "string" && asObject(executed[i])?.nonce !== nonce;
  });
  return differs ? "simulate_intents reported other intents than the relayed bundle's at the preceding snapshot" : null;
}

/**
 * The historical replay of the withheld order, read-only. Everything but the accounts, the transaction hashes and the
 * recorded code hashes is read from the chain: the bundle from the relay transaction, the removal snapshot from the
 * block in which the mandate's successful remove_public_key receipt for the order's signing key executed, the
 * preceding snapshot from that block's prev_hash. An item is "failed" when what was read contradicts it and
 * "inconclusive" when the RPC did not serve what it needs; the status is "failed" if any item failed, else
 * "inconclusive" if any is inconclusive, else "verified".
 */
export async function historicalReplay(call: Call, e: ExpectedReplay): Promise<ReplayResult> {
  const ids: ReplayItemId[] = ["bundle", "preceding", "removal", "deadlines", "relay", "code"];
  const state = (): { problems: string[]; missing: string[]; done: boolean } => ({ problems: [], missing: [], done: false });
  const items: Record<ReplayItemId, ReturnType<typeof state>> = { bundle: state(), preceding: state(), removal: state(), deadlines: state(), relay: state(), code: state() };
  const facts: [string, string][] = [];
  const fail = (id: ReplayItemId, text: string): void => {
    items[id].problems.push(text);
  };
  const miss = (id: ReplayItemId, text: string): void => {
    items[id].missing.push(text);
  };
  // Ends the replay. `text` is why the items not judged so far cannot be: unserved state or a contradiction.
  const finish = (unserved: boolean, text: string | null): ReplayResult => {
    const out = ids.map((id) => {
      const it = items[id];
      if (!it.done && text !== null) (unserved ? it.missing : it.problems).push(text);
      const status: ReplayStatus = it.problems.length > 0 ? "failed" : it.missing.length > 0 || !it.done ? "inconclusive" : "verified";
      return { id, status, reasons: [...it.problems, ...it.missing] };
    });
    const status: ReplayStatus = out.some((x) => x.status === "failed") ? "failed" : out.some((x) => x.status === "inconclusive") ? "inconclusive" : "verified";
    return { status, items: out, facts };
  };
  const txParams = (x: TxRef): Record<string, string> => ({ tx_hash: x.tx_hash, sender_account_id: x.sender, wait_until: "FINAL" });
  const finalTx = (result: unknown, x: TxRef): Record<string, unknown> | null => {
    const tx = asObject(result);
    return tx !== null && tx.final_execution_status === "FINAL" && asObject(tx.transaction)?.hash === x.tx_hash ? tx : null;
  };
  const ns = (n: bigint): string => `${n.toString()} ns`;

  // The bundle, from the relay transaction on chain.
  const relay = await call("tx", txParams(e.relay));
  if (!relay.ok) return finish(true, `the relay transaction ${e.relay.tx_hash} could not be read: ${relay.error}`);
  const tx = finalTx(relay.result, e.relay);
  const t = asObject(tx?.transaction);
  if (tx === null || t === null) return finish(true, `the RPC returned no final transaction ${e.relay.tx_hash}`);
  if (t.signer_id !== e.relay.sender || t.receiver_id !== e.verifier) return finish(false, `the relay transaction was sent by ${String(t.signer_id)} to ${String(t.receiver_id)}, not by ${e.relay.sender} to ${e.verifier}`);
  const fc = (Array.isArray(t.actions) ? (t.actions as unknown[]) : []).map((a) => asObject(asObject(a)?.FunctionCall)).find((c) => c?.method_name === "execute_intents");
  const args = asString(fc?.args) ?? "";
  let bundle: unknown[] = [];
  try {
    const bytes = Uint8Array.from(atob(args), (c) => c.charCodeAt(0));
    const signed = asObject(JSON.parse(new TextDecoder().decode(bytes)) as unknown)?.signed;
    if (Array.isArray(signed)) bundle = signed as unknown[];
  } catch {
    // No readable arguments: no bundle.
  }
  if (bundle.length === 0) return finish(false, "the relay transaction carries no signed intents, so there is no bundle to replay");
  const signerOf = (x: unknown): unknown => {
    try {
      return asObject(JSON.parse(asString(asObject(asObject(x)?.payload)?.message) ?? "") as unknown)?.signer_id;
    } catch {
      return undefined;
    }
  };
  const mine = bundle.filter((x) => signerOf(x) === e.mandate);
  const order = asObject(mine[0]);
  if (mine.length !== 1 || order === null) return finish(false, `the relayed bundle of ${String(bundle.length)} signed intents carries ${String(mine.length)} signed for ${e.mandate}, expected exactly one`);
  const key = asString(order.public_key);
  if (key === null || order.standard !== "nep413" || asObject(order.payload)?.recipient !== e.verifier) return finish(false, `the bundle's payload for ${e.mandate} is not a NEP-413 order for ${e.verifier} with a signing key`);
  const refusal = `public key '${key}' doesn't exist for account '${e.mandate}'`;
  const deadlines = bundle.map((x) => deadlineNs(x));
  const orderDeadline = deadlineNs(order);
  deadlines.forEach((d, i) => {
    if (d === null) fail("deadlines", `signed intent ${String(i + 1)} of the bundle carries no deadline this check can read`);
  });
  facts.push(["Relayed bundle", `${String(bundle.length)} signed intents read from the relay transaction ${e.relay.tx_hash}; the order of ${e.mandate} is signed with ${key}`]);

  // The relay itself: failed on the verifier for that key, before the order's deadline.
  const outcomes = receiptViews(tx);
  let relayBlock: { height: number } | null = null;
  if (statusKind(tx.status) === "success") fail("relay", "the relay transaction succeeded: the withheld order executed");
  else {
    const failure = outcomes.find((x) => x.executor === e.verifier && x.kind === "failure");
    if (statusKind(tx.status) !== "failure") fail("relay", "the relay transaction has no final failure status");
    if (failure === undefined) fail("relay", `no receipt of the relay failed on ${e.verifier}`);
    else {
      if (failure.error?.includes(refusal) !== true) fail("relay", `the verifier's error for the relay is not the missing-key refusal (${refusal})`);
      const b = await replayHeader(call, failure.block_hash);
      if (!b.ok) miss("relay", `the block in which the relay failed could not be read: ${b.error}`);
      else {
        relayBlock = b;
        if (orderDeadline !== null && b.time >= orderDeadline) fail("relay", `the relay failed at block time ${ns(b.time)}, not before the order's deadline ${ns(orderDeadline)}: an expired order fails whatever the key state`);
      }
    }
    if (outcomes.some((x) => x.kind === "failure" && x.executor !== e.verifier)) fail("relay", "a receipt of the relay failed outside the verifier");
    if (outcomes.some((x) => x.kind === "unknown")) fail("relay", "a receipt of the relay has no final status");
  }
  items.relay.done = true;

  // The order is one the mandate logged as signed.
  let signedIn: string | null = null;
  const unread: string[] = [];
  for (const p of e.proposals) {
    const got = await call("tx", txParams(p));
    const proposal = got.ok ? finalTx(got.result, p) : null;
    if (!got.ok) unread.push(`${p.tx_hash}: ${got.error}`);
    else if (proposal === null) unread.push(`${p.tx_hash}: the RPC returned no final transaction with that hash`);
    else signedIn = signedOrderBlock(proposal, e.mandate, order);
    if (signedIn !== null) break;
  }
  if (signedIn === null) {
    if (unread.length > 0) miss("bundle", `a recorded proposal transaction could not be read, so the order's signed-order event was not found: ${unread.join("; ")}`);
    else fail("bundle", `the bundle's order for ${e.mandate} is not one the mandate logged as signed (order_signed) in the ${String(e.proposals.length)} recorded proposal transactions`);
  }

  // The removal snapshot: the block in which the mandate's successful remove_public_key receipt for that key executed.
  let removal: { tx: string; id: string; kind: string; block: string | null } | null = null;
  const unreadRevokes: string[] = [];
  for (const v of e.revokes) {
    const got = await call("EXPERIMENTAL_tx_status", txParams(v));
    const full = got.ok ? finalTx(got.result, v) : null;
    if (!got.ok) unreadRevokes.push(`${v.tx_hash}: ${got.error}`);
    else if (full === null) unreadRevokes.push(`${v.tx_hash}: the RPC returned no final transaction with that hash`);
    else {
      const receipt = asObject((Array.isArray(full.receipts) ? (full.receipts as unknown[]) : []).find((x) => removesKey(x, e.mandate, e.verifier, key)));
      const outcome = receipt === null ? null : asObject((Array.isArray(full.receipts_outcome) ? (full.receipts_outcome as unknown[]) : []).find((o) => asObject(o)?.id === receipt.receipt_id));
      if (receipt !== null) removal = { tx: v.tx_hash, id: String(receipt.receipt_id), kind: statusKind(asObject(outcome?.outcome)?.status), block: asString(outcome?.block_hash) };
    }
    if (removal !== null) break;
  }
  if (removal === null && unreadRevokes.length > 0) return finish(true, `a recorded revoke transaction could not be read, so the removal snapshot is unknown: ${unreadRevokes.join("; ")}`);
  if (removal === null) return finish(false, `none of the ${String(e.revokes.length)} recorded revoke transactions has a receipt ${e.mandate} -> ${e.verifier}.remove_public_key for the order's signing key ${key}, so there is no removal snapshot`);
  if (removal.kind !== "success" || removal.block === null) return finish(false, `the remove_public_key receipt ${removal.id} of the revoke ${removal.tx} did not succeed, so there is no removal snapshot`);
  const after = await replayHeader(call, removal.block);
  if (!after.ok) return finish(true, `the removal snapshot could not be read: ${after.error}`);
  const before = await replayHeader(call, after.prev);
  if (!before.ok) return finish(true, `the preceding snapshot could not be read: ${before.error}`);
  if (before.height >= after.height) return finish(true, `the RPC returned block ${String(before.height)} as the block before block ${String(after.height)}`);
  const snapshots: ["preceding" | "removal", typeof after][] = [["preceding", before], ["removal", after]];
  facts.push(["Removal snapshot", `block ${String(after.height)} (${after.hash}), time ${ns(after.time)}: the block in which the remove_public_key receipt ${removal.id} of the revoke ${removal.tx} executed`]);
  facts.push(["Preceding snapshot", `block ${String(before.height)} (${before.hash}), time ${ns(before.time)}: that block's prev_hash`]);

  if (signedIn !== null) {
    const s = await replayHeader(call, signedIn);
    if (!s.ok) miss("bundle", `the block of the order's signed-order event could not be read: ${s.error}`);
    else if (s.height >= after.height) fail("bundle", `the mandate logged the order as signed in block ${String(s.height)}, not in a block before the removal snapshot (block ${String(after.height)})`);
    else facts.push(["Signed-order event", `the mandate logged the bundle's order as signed in block ${String(s.height)}`]);
  }
  items.bundle.done = true;
  if (relayBlock !== null && relayBlock.height < after.height) fail("relay", `the relay failed in block ${String(relayBlock.height)}, before the removal snapshot (block ${String(after.height)})`);

  for (const [name, s] of snapshots) {
    deadlines.forEach((d, i) => {
      if (d !== null && s.time >= d) fail("deadlines", `the ${name} snapshot's block time ${ns(s.time)} is not before the deadline ${ns(d)} of signed intent ${String(i + 1)}`);
    });
  }
  items.deadlines.done = true;

  const recorded: [string, string | null][] = [[e.mandate, e.mandate_code_hash], [e.verifier, e.verifier_code_hash]];
  for (const [account, want] of recorded) if (want === null) fail("code", `the run's evidence records no code hash for ${account}`);
  const keyArgs = btoa(JSON.stringify({ account_id: e.mandate, public_key: key }));
  for (const [name, s] of snapshots) {
    const registered = name === "preceding";
    const has = await replayView(call, e.verifier, "has_public_key", keyArgs, s.hash);
    if (has.kind === "unavailable") miss(name, `has_public_key at the ${name} snapshot: ${has.error}`);
    else if (has.kind === "refused" || has.value !== registered) fail(name, `the signing key ${key} is ${registered ? "not registered" : "still registered"} for ${e.mandate} on ${e.verifier} at the ${name} snapshot`);
    // The exact argument bytes of the relay transaction, so the simulated bundle is the relayed one.
    const sim = await replayView(call, e.verifier, "simulate_intents", args, s.hash);
    if (sim.kind === "unavailable") miss(name, `simulate_intents at the ${name} snapshot: ${sim.error}`);
    else if (registered) {
      const problem = sim.kind === "refused" ? `simulate_intents refused the relayed bundle at the preceding snapshot: ${sim.error.slice(0, 300)}` : simulationProblem(sim.value, bundle);
      if (problem !== null) fail(name, problem);
    } else if (sim.kind === "value") fail(name, "simulate_intents did not refuse the relayed bundle at the removal snapshot");
    else if (!sim.error.includes(refusal)) fail(name, `simulate_intents refused the relayed bundle at the removal snapshot for another reason than the missing key (${refusal}): ${sim.error.slice(0, 300)}`);
    items[name].done = true;
    for (const [account, want] of recorded) {
      if (want === null) continue;
      const got = await replayCodeHash(call, account, s.hash);
      if (got.kind !== "value") miss("code", `code hash of ${account} at the ${name} snapshot: ${got.error}`);
      else if (got.value !== want) fail("code", `${account} has code hash ${String(got.value)} at the ${name} snapshot, the run's evidence records ${want}`);
    }
  }
  items.code.done = true;
  return finish(false, null);
}

/** The historical replay as one item of the panel. */
export async function verifyReplay(call: Call, e: ExpectedReplay): Promise<Item> {
  const r = await historicalReplay(call, e);
  const names: Record<ReplayItemId, string> = {
    bundle: "1. Bundle read from the relay transaction, its order logged as signed by the mandate in an earlier block",
    preceding: "2. Preceding snapshot: signing key registered, simulate_intents accepts the bundle",
    removal: "3. Removal snapshot: signing key absent, simulate_intents refuses the bundle for that key",
    deadlines: "4. Both snapshots before every deadline in the bundle",
    relay: "5. Relay failed on the verifier for that key, before the order's deadline",
    code: "6. Mandate and verifier have the recorded code hashes at both snapshots",
  };
  const facts: [string, string][] = [
    ["Mandate", e.mandate],
    ["Relay transaction", e.relay.tx_hash],
    ["Recorded code hashes", `${e.mandate}: ${e.mandate_code_hash ?? "not recorded"}; ${e.verifier}: ${e.verifier_code_hash ?? "not recorded"}`],
    ...r.facts,
    ...r.items.map((i): [string, string] => [names[i.id], i.status]),
    ["What this shows", "A historical replay of chain state: the relayed bundle was executable at the preceding snapshot. It does not show when the counterparty created its signature."],
  ];
  const title = "Historical replay of the withheld order";
  // A reason that keeps several rules from being judged is listed once, with the rules it applies to.
  const texts = [...new Set(r.items.flatMap((i) => i.reasons))];
  const reasons = texts.map((text) => `Rule ${r.items.flatMap((i, n) => (i.reasons.includes(text) ? [String(n + 1)] : [])).join(", ")}: ${text}`);
  if (r.status === "verified") {
    return { status: "verified", title: `${title}: simulate_intents accepted the relayed bundle at the preceding snapshot and refused the identical bundle at the removal snapshot because its signing key did not exist for ${e.mandate}`, facts, reasons };
  }
  return { status: r.status, title: `${title}: ${r.status === "failed" ? "failed, the chain contradicts the record" : "inconclusive, the RPC did not serve the archival state it needs"}`, facts, reasons };
}

export async function verifyHistorical(call: Call, data: VerifyData): Promise<{ verdict: Item; items: Item[] }> {
  if (data.receipts.length === 0 && data.unverifiable.length === 0 && data.relay === null && data.relay_problem === null && data.replay === null) {
    return { verdict: { status: "none", title: "No mainnet receipts yet: the approved mainnet run has not happened, so there is nothing historical to verify", facts: [], reasons: [] }, items: [] };
  }
  const items: Item[] = [];
  for (const e of data.receipts) items.push(await verifyTx(call, e));
  for (const u of data.unverifiable) items.push({ status: "inconclusive", title: `${u.label}: inconclusive, not checkable`, facts: [], reasons: [u.reason] });
  if (data.relay !== null) items.push(await verifyRelay(call, data.relay));
  else items.push({ status: "inconclusive", title: "Withheld-order relay: cannot be checked", facts: [], reasons: [data.relay_problem ?? "the evidence records no relay of the withheld order"] });
  const transactions = items.length;
  if (data.replay !== null) items.push(await verifyReplay(call, data.replay));
  else items.push({ status: "inconclusive", title: "Historical replay of the withheld order: cannot be checked", facts: [], reasons: [data.replay_problem ?? "the evidence records no relay of the withheld order"] });
  const bad = items.filter((i) => i.status !== "verified");
  const verdict: Item =
    bad.length === 0
      ? {
          status: "verified",
          title: `All ${String(transactions)} recorded mainnet transactions match the chain, the withheld order's relay was rejected before its deadline because its recorded signing key was not registered on ${data.relay?.verifier ?? "the verifier"}, and the historical replay of chain state shows the relayed bundle accepted at the preceding snapshot and refused at the removal snapshot`,
          facts: [],
          reasons: [],
        }
      : {
          status: bad.some((i) => i.status === "failed") ? "failed" : bad.some((i) => i.status === "error") ? "error" : "inconclusive",
          title: `Not verified: ${String(bad.length)} of ${String(items.length)} checks did not hold`,
          facts: [],
          reasons: bad.map((i) => i.title),
        };
  return { verdict, items };
}

export function decodeView(result: unknown): unknown {
  const bytes = asObject(result)?.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => typeof b === "number")) throw new Error("call_function returned no result bytes");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
}

export async function viewCall(call: Call, account: string, method: string, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const r = await call("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (!r.ok) return r;
  try {
    return { ok: true, value: decodeView(r.result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function verifyCurrent(call: Call, data: VerifyData): Promise<Item[]> {
  const items: Item[] = [];
  const acc = await call("query", { request_type: "view_account", finality: "final", account_id: data.verifier });
  const codeHash = acc.ok ? asString(asObject(acc.result)?.code_hash) : null;
  const facts: [string, string][] = [
    ["Account", data.verifier],
    ["Pinned fixture", data.verifier_code_hash],
    ["Current code hash", codeHash ?? "unknown"],
  ];
  if (!acc.ok) items.push({ status: "error", title: `Code of ${data.verifier}: not read`, facts, reasons: [acc.error] });
  else if (codeHash === data.verifier_code_hash) items.push({ status: "verified", title: `Code of ${data.verifier} now equals the verifier WASM the tests ran (current state)`, facts, reasons: [] });
  else items.push({ status: "failed", title: `Code of ${data.verifier} now differs from the pinned verifier WASM (current state)`, facts, reasons: ["an upgrade of the verifier changes this value"] });
  const cur = data.current;
  if (cur === null) return items;
  const caveat = "Current state only: a key absent now cannot show that a historical order was rejected before its deadline.";
  if (cur.grant_key !== null) {
    const has = await viewCall(call, data.verifier, "has_public_key", { account_id: cur.mandate, public_key: cur.grant_key });
    items.push(
      has.ok
        ? { status: "info", title: `Grant key registered on ${data.verifier} now: ${has.value === true ? "yes" : has.value === false ? "no" : JSON.stringify(has.value)}`, facts: [["Mandate", cur.mandate], ["Key", cur.grant_key]], reasons: [caveat] }
        : { status: "error", title: "Grant key registration: not read", facts: [["Mandate", cur.mandate], ["Key", cur.grant_key]], reasons: [has.error] },
    );
  }
  const grant = await viewCall(call, cur.mandate, "get_grant", {});
  const g = grant.ok ? asObject(grant.value) : null;
  items.push(
    grant.ok
      ? { status: "info", title: `Grant of ${cur.mandate} now: ${g === null ? "none" : `epoch ${JSON.stringify(g.epoch)}, ${JSON.stringify(g.status)}`}`, facts: [["Mandate", cur.mandate]], reasons: [caveat] }
      : { status: "error", title: "Grant state: not read", facts: [["Mandate", cur.mandate]], reasons: [grant.error] },
  );
  return items;
}

/** Runs every check against `url`. Nothing is read from the chain unless the network check holds. */
export async function runVerification(fetchFn: FetchFn, url: string, data: VerifyData): Promise<Report> {
  const call = pacedCall(fetchFn, url, data.timeout_ms, data.pace_ms);
  const chain = await checkChain(call, data);
  if (chain.status !== "verified") {
    const skipped: Item = { status: "error", title: "Not checked: the network check did not hold", facts: [], reasons: [] };
    return { rpc: url, chain, historical: { verdict: skipped, items: [] }, current: [skipped] };
  }
  const historical = await verifyHistorical(call, data);
  const current = await verifyCurrent(call, data);
  return { rpc: url, chain, historical, current };
}

export interface DomEl {
  textContent: string | null;
  className: string;
  appendChild(child: DomEl): DomEl;
  replaceChildren(...children: DomEl[]): void;
}
export interface DomDoc {
  createElement(tag: string): DomEl;
  getElementById(id: string): unknown;
}

export function renderItem(doc: DomDoc, item: Item): DomEl {
  const li = doc.createElement("li");
  li.className = `vitem ${item.status}`;
  const head = doc.createElement("p");
  const badge = doc.createElement("span");
  badge.className = `status ${item.status === "verified" ? "success" : item.status === "failed" ? "failure" : item.status === "info" || item.status === "none" ? "not-run" : "inconclusive"}`;
  badge.textContent = item.status === "info" ? "current state" : item.status === "none" ? "none" : item.status;
  head.appendChild(badge);
  const title = doc.createElement("span");
  title.textContent = ` ${item.title}`;
  head.appendChild(title);
  li.appendChild(head);
  if (item.facts.length > 0) {
    const dl = doc.createElement("dl");
    dl.className = "kv";
    for (const [k, v] of item.facts) {
      const dt = doc.createElement("dt");
      dt.textContent = k;
      const dd = doc.createElement("dd");
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    li.appendChild(dl);
  }
  if (item.reasons.length > 0) {
    const ul = doc.createElement("ul");
    for (const r of item.reasons) {
      const x = doc.createElement("li");
      x.textContent = r;
      ul.appendChild(x);
    }
    li.appendChild(ul);
  }
  return li;
}

export function renderList(doc: DomDoc, target: DomEl, items: Item[]): void {
  const ol = doc.createElement("ol");
  ol.className = "vitems";
  for (const i of items) ol.appendChild(renderItem(doc, i));
  target.replaceChildren(ol);
}

/** Wires the button. Nothing is fetched and nothing on the page changes until it is clicked. */
export function install(doc: DomDoc, fetchFn: FetchFn): void {
  const panel = doc.getElementById("verify-panel") as { getAttribute(name: string): string | null } | null;
  const button = doc.getElementById("verify-run") as { disabled: boolean; addEventListener(type: string, fn: () => void): void } | null;
  const input = doc.getElementById("verify-rpc") as { value: string } | null;
  const out = {
    status: doc.getElementById("verify-status") as DomEl | null,
    chain: doc.getElementById("verify-chain") as DomEl | null,
    historical: doc.getElementById("verify-historical") as DomEl | null,
    current: doc.getElementById("verify-current") as DomEl | null,
  };
  const raw = panel?.getAttribute("data-verify") ?? null;
  if (button === null || input === null || raw === null || out.status === null || out.chain === null || out.historical === null || out.current === null) return;
  const data = JSON.parse(raw) as VerifyData;
  const target = { status: out.status, chain: out.chain, historical: out.historical, current: out.current };
  button.addEventListener("click", () => {
    const url = input.value.trim();
    if (!/^https:\/\/[^\s]+$/.test(url)) {
      target.status.textContent = "Enter an RPC URL that starts with https.";
      return;
    }
    button.disabled = true;
    target.status.textContent = `Querying ${url} …`;
    target.chain.replaceChildren();
    target.historical.replaceChildren();
    target.current.replaceChildren();
    void runVerification(fetchFn, url, data)
      .then((report) => {
        renderList(doc, target.chain, [report.chain]);
        renderList(doc, target.historical, [report.historical.verdict, ...report.historical.items]);
        renderList(doc, target.current, report.current);
        target.status.textContent = `Checked against ${report.rpc} at ${new Date().toISOString()}. Results are this browser's live queries; nothing recorded is substituted for a failed query.`;
      })
      .catch((e: unknown) => {
        target.status.textContent = `Verification stopped: ${e instanceof Error ? e.message : String(e)}`;
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

/** Every function the inline script contains, in order. */
export const CLIENT_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  asObject,
  asString,
  rpcErrorText,
  rpcCall,
  pacedCall,
  checkChain,
  statusKind,
  receiptViews,
  chainOutcome,
  identityProblems,
  relayedBundle,
  canonicalJson,
  sha256Hex,
  classifyRelayTx,
  verifyTx,
  verifyRelay,
  deadlineNs,
  signedOrderBlock,
  removesKey,
  replayHeader,
  replayView,
  replayCodeHash,
  simulationProblem,
  historicalReplay,
  verifyReplay,
  verifyHistorical,
  decodeView,
  viewCall,
  verifyCurrent,
  runVerification,
  renderItem,
  renderList,
  install,
];
