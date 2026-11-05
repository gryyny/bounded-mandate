// Read-only verification that runs in the reader's browser, only after an explicit click. verify.ts serializes
// every function in CLIENT_FUNCTIONS with Function.prototype.toString into the page's single inline script, and
// the tests evaluate that same script. So each function may use only browser globals and the other listed
// functions: no imports and no module-level values. Nothing here signs, sends a transaction or needs a wallet.
//
// Semantics follow classifyRelay in src/live/verify.ts: a relay of the withheld order counts as rejected for the
// removed key only when the verifier's receipt failed with that key's error, at a block time not after the
// order deadline, with nothing else failing; a successful transaction is "executed"; everything else is
// inconclusive. The browser cannot re-read historical balances, so it checks the receipts, not balance deltas.

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

export interface VerifyData {
  rpc: string;
  chain_id: string;
  genesis_hash: string;
  verifier: string;
  /** base58 sha256 of the pinned verifier WASM fixture. */
  verifier_code_hash: string;
  receipts: ExpectedTx[];
  relay: ExpectedRelay | null;
  /** Why the relay cannot be checked although mainnet receipts exist; null otherwise. */
  relay_problem: string | null;
  current: { mandate: string; grant_key: string | null } | null;
  timeout_ms: number;
}

export type RpcResult = { ok: true; result: unknown } | { ok: false; error: string };

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
      if (!res.ok) return { ok: false, error: `HTTP ${String(res.status)}` };
      const body = asObject(await res.json());
      if (body === null) return { ok: false, error: "response is not a JSON-RPC object" };
      if (body.error !== undefined && body.error !== null) return { ok: false, error: rpcErrorText(body.error) };
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

export function receiptViews(tx: Record<string, unknown>): ReceiptView[] {
  const list = Array.isArray(tx.receipts_outcome) ? (tx.receipts_outcome as unknown[]) : [];
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
    ...(failure !== null && failure.error?.includes(expected) !== true ? [`the verifier error is not the removed-key rejection (${expected})`] : []),
    ...(blockTimeNs === null
      ? ["the failed receipt's block time could not be read"]
      : BigInt(blockTimeNs) > BigInt(e.deadline_ns)
        ? [`executed after the order deadline (block time ${blockTimeNs} ns, deadline ${e.deadline_ns} ns): an expired order fails whatever the key state`]
        : []),
    ...(receipts.some((r) => r.kind === "failure" && r.executor !== e.verifier) ? ["a receipt outside the verifier failed"] : []),
    ...(receipts.some((r) => r.kind === "unknown") ? ["a receipt has no final status"] : []),
    ...(e.bundle_sha256 !== null && bundleSha256 !== e.bundle_sha256 ? [`the relayed bundle's sha256 ${bundleSha256 ?? "(unreadable)"} differs from the recorded ${e.bundle_sha256}`] : []),
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
  const kind = statusKind(tx.status);
  const blocks = receiptViews(tx).map((x) => `${x.executor} ${x.kind} in block ${x.block_hash}`);
  const reasons = [...identityProblems(tx, e, null), ...(kind === e.outcome ? [] : [`chain outcome ${kind} differs from the recorded ${e.outcome}`])];
  return {
    status: reasons.length === 0 ? "verified" : "failed",
    title: `${e.label}: ${reasons.length === 0 ? `final, ${kind}, as recorded` : "does not match the evidence"}`,
    facts: [...facts, ["Chain outcome", kind], ["Receipts", blocks.join("; ") || "none"]],
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
    ["Removed key", e.revoked_key],
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
  ];
  if (c.classification === "rejected_revoked_key") {
    return { status: "verified", title: `${title}: rejected for the removed key before its deadline (rejected_revoked_key)`, facts: observed, reasons: [] };
  }
  return {
    status: c.classification === "executed" ? "failed" : "inconclusive",
    title: `${title}: ${c.classification === "executed" ? "EXECUTED — revocation did not stop it" : "inconclusive, not evidence that revocation stopped it"}`,
    facts: observed,
    reasons: [...lookups, ...c.reasons],
  };
}

export async function verifyHistorical(call: Call, data: VerifyData): Promise<{ verdict: Item; items: Item[] }> {
  if (data.receipts.length === 0 && data.relay === null) {
    return { verdict: { status: "none", title: "No mainnet receipts yet: the approved mainnet run has not happened, so there is nothing historical to verify", facts: [], reasons: [] }, items: [] };
  }
  const items: Item[] = [];
  for (const e of data.receipts) items.push(await verifyTx(call, e));
  if (data.relay !== null) items.push(await verifyRelay(call, data.relay));
  else items.push({ status: "inconclusive", title: "Withheld-order relay: cannot be checked", facts: [], reasons: [data.relay_problem ?? "the evidence records no relay of the withheld order"] });
  const bad = items.filter((i) => i.status !== "verified");
  const verdict: Item =
    bad.length === 0
      ? { status: "verified", title: `All ${String(items.length)} recorded mainnet transactions confirmed, and the withheld order's relay was rejected for the removed key before its deadline`, facts: [], reasons: [] }
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
  const call: Call = (method, params) => rpcCall(fetchFn, url, method, params, data.timeout_ms);
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
  checkChain,
  statusKind,
  receiptViews,
  identityProblems,
  relayedBundle,
  canonicalJson,
  sha256Hex,
  classifyRelayTx,
  verifyTx,
  verifyRelay,
  verifyHistorical,
  decodeView,
  viewCall,
  verifyCurrent,
  runVerification,
  renderItem,
  renderList,
  install,
];
