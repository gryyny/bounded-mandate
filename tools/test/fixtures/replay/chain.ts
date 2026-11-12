// SYNTHETIC archival chain for the historical replay of the withheld order (SPEC.md). Nothing here was read from a
// real chain. It serves the synthetic mainnet run of ../verify/synthetic.ts through a local JSON-RPC stub and adds what
// the replay reads: block headers with a previous hash and a time, state addressed by block hash, simulate_intents,
// the verifier's account, the relayed bundle in the relay transaction and the mandate's signed-order event for it.
// The answer shapes follow read-only observations of https://archival-rpc.mainnet.fastnear.com on third-party trades
// (2026-11-12): a view at block N reflects the state after block N, and a contract panic in a view comes back inside
// the result as `error`.
import { createHash } from "node:crypto";
import { type AddressInfo } from "node:net";
import { createServer } from "node:http";
import { CANDIDATE_CODE_HASH, GRANT_KEY, MANDATE_ORDER, STRANGER_KEY, base58, startChain, stopChain, syntheticLiveEvidence, type ChainOptions } from "../verify/synthetic.js";

export const VERIFIER = "intents.near";
/** NEAR code hash the synthetic run's preflight records for the verifier. */
export const VERIFIER_CODE_HASH = base58(createHash("sha256").update("SYNTHETIC verifier code").digest());
export const OTHER_CODE_HASH = base58(createHash("sha256").update("SYNTHETIC other code").digest());

/** On the synthetic chain the revoke is included in block 130 and its remove_public_key receipt executes in block 132. */
export const REVOKE_INCLUDED_AT = 130;
export const REMOVAL_AT = 132;
export const PRECEDING_AT = REMOVAL_AT - 1;

const blockHash = (h: number): string => `block-${String(h)}`;
const heightOf = (id: unknown): number | null => {
  const m = /^block-(\d+)$/.exec(typeof id === "string" ? id : "");
  return m === null ? null : Number(m[1]);
};
/** Block N is one second after block N-1. */
const blockSeconds = (h: number): number => 1_800_000_000 + h;
export const blockTimeNs = (h: number): string => `${String(blockSeconds(h))}000000000`;
const FAR_DEADLINE = "2099-01-01T00:00:00.000Z";

export type SimAnswer = "invariant" | "partial" | "nonce-used" | "expired";

export interface Unserved {
  /** simulate: simulate_intents. state: every contract view at a block hash. code: accounts at a block hash. */
  what: "simulate" | "state" | "code" | "blocks" | "receipts" | "relay";
  how: "http-429" | "http-503" | "unknown-block" | "garbage-collected" | "other-block";
  /** Only the first `times` matching requests are refused; later ones are served. */
  times?: number;
}

/** How the recorded chain differs from the run in which every rule of the replay holds. */
export interface ReplayOptions extends ChainOptions {
  /** What the relay transaction carries: the withheld bundle, the bundle with the counterparty's leg changed, or nothing. */
  relayed?: "withheld" | "counter-altered" | "nothing";
  /** Where the mandate logged the withheld order as signed: its proposal, nowhere, or a transaction after the removal. */
  signedEvent?: "proposal" | "absent" | "after-removal";
  /** The withheld order is signed with a key that was never a grant key. */
  orderKey?: "stranger";
  /** The order's deadline equals the time of this block (default: far in the future). */
  orderDeadlineAtBlock?: number;
  /** The grant key's registration ends at this block, not at the block in which the removal receipt executed. */
  keyGoneFrom?: number;
  /** The verifier account has another code hash from this block on. */
  verifierCodeFrom?: number;
  /** A simulate_intents answer at one snapshot that replaces the chain model's. */
  simulate?: { preceding?: SimAnswer; removal?: SimAnswer };
  /** The verifier's panic for the relay, instead of the missing-key refusal. */
  relayError?: string;
  /** Contract panics in views come back as CONTRACT_EXECUTION_ERROR, as newer nodes report them. */
  structuredRefusals?: boolean;
  unserved?: Unserved;
}

interface Signed {
  standard: string;
  payload: { message: string; nonce: string; recipient: string };
  public_key: string;
  signature: string;
}

const ev0 = syntheticLiveEvidence();
const MANDATE = (ev0.identifiers as Record<string, string>).mandate ?? "";
const FILLER = (ev0.identifiers as Record<string, string>).filler ?? "";
const firstDiff = (JSON.parse(MANDATE_ORDER.payload.message) as { intents: { diff: Record<string, string> }[] }).intents[0]?.diff ?? {};
const negate = (d: string): string => (d.startsWith("-") ? d.slice(1) : `-${d}`);
const nonce = (salt: string): string => Buffer.from(`SYNTHETIC nonce ${salt}`.padEnd(32, ".")).toString("base64");
const signed = (signer: string, key: string, deadline: string, diff: Record<string, string>, salt: string): Signed => ({
  standard: "nep413",
  payload: { message: JSON.stringify({ signer_id: signer, deadline, intents: [{ intent: "token_diff", diff }] }), nonce: nonce(salt), recipient: VERIFIER },
  public_key: key,
  signature: `ed25519:SYNTHETICsignature${salt}`,
});

const orderKey = (o: ReplayOptions): string => (o.orderKey === "stranger" ? STRANGER_KEY : GRANT_KEY);
const orderDeadline = (o: ReplayOptions): string => (o.orderDeadlineAtBlock === undefined ? FAR_DEADLINE : new Date(blockSeconds(o.orderDeadlineAtBlock) * 1000).toISOString());
/** The second order the synthetic mandate signs: withheld by the counterparty, relayed after the revoke. */
export const withheldOrder = (o: ReplayOptions = {}): Signed => signed(MANDATE, orderKey(o), orderDeadline(o), firstDiff, "order2");
const counterDiff = Object.fromEntries(Object.entries(firstDiff).map(([token, d]) => [token, negate(d)]));
const COUNTER = signed(FILLER, "ed25519:SyntheticFillerKey44444444444444444444444444", FAR_DEADLINE, counterDiff, "filler2");
/** The bundle the counterparty holds: the mandate's order and its own counter order. */
export const withheldBundle = (o: ReplayOptions = {}): Signed[] => [withheldOrder(o), COUNTER];
function relayedBundle(o: ReplayOptions): Signed[] {
  if (o.relayed !== "counter-altered") return withheldBundle(o);
  const altered = Object.fromEntries(Object.entries(counterDiff).map(([token, d]) => [token, d.startsWith("-") ? `${d}0` : d]));
  return [withheldOrder(o), { ...COUNTER, payload: { ...COUNTER.payload, message: JSON.stringify({ signer_id: FILLER, deadline: FAR_DEADLINE, intents: [{ intent: "token_diff", diff: altered }] }) } }];
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64");
const panic = (text: string): unknown => ({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${text}` } } } });
const missingKey = (key: string): string => `public key '${key}' doesn't exist for account '${MANDATE}'`;
const orderSignedLog = (order: Signed): string => `EVENT_JSON:${JSON.stringify({ standard: "bounded_mandate", version: "1.0.0", event: "order_signed", data: { order_id: "2", epoch: 1, signature: order.signature, multi_payload: JSON.stringify(order) } })}`;

interface Receipt {
  label: string;
  tx_hash: string;
  detail: { signer_id: string; method: string };
}
const receiptsOf = (o: ReplayOptions): Receipt[] => syntheticLiveEvidence(o).receipts as Receipt[];
const kind = (r: Receipt): string => r.label.split(" ").at(-1) ?? "";
const ref = (r: Receipt): { tx_hash: string; sender: string } => ({ tx_hash: r.tx_hash, sender: r.detail.signer_id });
const only = (list: Receipt[], what: string): Receipt => {
  const [first] = list;
  if (first === undefined) throw new Error(`the synthetic run has no ${what} transaction`);
  return first;
};
const relayOf = (o: ReplayOptions): Receipt => only(receiptsOf(o).filter((r) => kind(r) === "relay_withheld"), "relay");
const proposalOf = (o: ReplayOptions): Receipt => only(receiptsOf(o).filter((r) => kind(r) === "propose"), "propose");
/** The transaction after the removal whose mandate receipt carries the signed-order event in the "after-removal" case. */
const lateOf = (o: ReplayOptions): Receipt => only(receiptsOf(o).filter((r) => r.detail.method === "recover"), "recover");

export interface ReplayInput {
  mandate: string;
  verifier: string;
  relay: { tx_hash: string; sender: string };
  revokes: { tx_hash: string; sender: string }[];
  proposals: { tx_hash: string; sender: string }[];
  mandate_code_hash: string | null;
  verifier_code_hash: string | null;
}

/** What the run's evidence gives the replay: accounts, transactions and recorded code hashes. Blocks and bundle come from the chain. */
export function replayInput(o: ReplayOptions = {}): ReplayInput {
  const receipts = receiptsOf(o);
  return {
    mandate: MANDATE,
    verifier: VERIFIER,
    relay: ref(relayOf(o)),
    revokes: receipts.filter((r) => r.detail.method === "revoke").map(ref),
    proposals: [proposalOf(o), ...(o.signedEvent === "after-removal" ? [lateOf(o)] : [])].map(ref),
    mandate_code_hash: CANDIDATE_CODE_HASH,
    verifier_code_hash: VERIFIER_CODE_HASH,
  };
}

/** The preflight assertion with which the live runner records the verifier's code hash (tools/src/live/preflight.ts). */
export const verifierPreflight = (): Record<string, unknown> => ({
  id: "preflight-code_hash.verifier",
  gate: "LIVE",
  description: "preflight code_hash.verifier (SYNTHETIC)",
  passed: true,
  observed: { account: VERIFIER, chain: VERIFIER_CODE_HASH, manifest: VERIFIER_CODE_HASH },
});

/** Whether the grant key is registered after block `h`: from the grant's add_public_key receipt (block 102) until its removal. */
export const grantKeyRegisteredAt = (o: ReplayOptions, h: number): boolean => h >= 102 && (o.keyNeverRemoved === true || h < (o.keyGoneFrom ?? REMOVAL_AT));

type Body = Record<string, unknown>;
type Reply = { body: Body } | { http: number };
const result = (value: unknown): Reply => ({ body: { jsonrpc: "2.0", id: "verify", result: value } });
const rpcError = (cause: string, data: string, info: Body = {}): Reply => ({ body: { jsonrpc: "2.0", id: "verify", error: { name: "HANDLER_ERROR", cause: { info, name: cause }, code: -32000, message: "Server error", data } } });

function unservedReply(u: Unserved, params: Body): Reply | null {
  if (u.how === "http-429") return { http: 429 };
  if (u.how === "http-503") return { http: 503 };
  if (u.how === "unknown-block") return rpcError("UNKNOWN_BLOCK", `DB Not Found Error: BLOCK: ${String(params.block_id)} \n Cause: Unknown`);
  if (u.how === "garbage-collected") return rpcError("GARBAGE_COLLECTED_BLOCK", "The data for this block is garbage collected on this node, use an archival node to fetch historical data");
  return null;
}

function matches(u: Unserved, method: string, params: Body, relayHash: string): boolean {
  const atHash = method === "query" && typeof params.block_id === "string";
  if (u.what === "simulate") return atHash && params.method_name === "simulate_intents";
  if (u.what === "state") return atHash && params.request_type === "call_function";
  if (u.what === "code") return atHash && params.request_type === "view_account";
  if (u.what === "blocks") return method === "block";
  if (u.what === "receipts") return method === "EXPERIMENTAL_tx_status";
  return method === "tx" && params.tx_hash === relayHash;
}

export interface ReplayChain {
  url: string;
  /** JSON-RPC methods in the order they were requested. */
  requests: string[];
  /** Every request with its parameters. */
  log: { method: string; params: Body; at: number }[];
  /** Blocks at which the mandate's account was read (see startChain). */
  codeReads: (number | "final")[];
  /** The most requests that were being answered at the same time. */
  concurrency(): number;
  stop(): Promise<void>;
}

/** A local JSON-RPC stub of an archival node serving the synthetic run with what the historical replay reads. */
export async function startReplayChain(o: ReplayOptions = {}): Promise<ReplayChain> {
  const base = await startChain(o);
  const requests: string[] = [];
  const log: ReplayChain["log"] = [];
  const relayHash = relayOf(o).tx_hash;
  const proposalHash = proposalOf(o).tx_hash;
  const lateHash = lateOf(o).tx_hash;
  let refused = 0;
  let [open, mostOpen] = [0, 0];

  const forward = async (method: string, params: unknown): Promise<Body> => {
    const res = await fetch(base.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }) });
    return (await res.json()) as Body;
  };
  const view = async (method: string, args: Body, h: number): Promise<unknown> => {
    const body = await forward("query", { request_type: "call_function", account_id: VERIFIER, method_name: method, args_base64: b64(args), block_id: h });
    return JSON.parse(Buffer.from((body.result as { result: number[] }).result).toString("utf8")) as unknown;
  };
  const registered = async (key: string, h: number): Promise<boolean> => {
    if (key === GRANT_KEY && o.keyGoneFrom !== undefined) return grantKeyRegisteredAt(o, h);
    return (await view("has_public_key", { account_id: MANDATE, public_key: key }, h)) === true;
  };

  /** The verifier's checks in its order: signature, deadline, registered key. */
  const simulate = async (bundle: Signed[], h: number): Promise<{ refusal: string } | { output: Body }> => {
    const override = h === PRECEDING_AT ? o.simulate?.preceding : h === REMOVAL_AT ? o.simulate?.removal : undefined;
    if (override === "nonce-used") return { refusal: "nonce was already used" };
    if (override === "expired") return { refusal: "deadline has expired" };
    const genuine = withheldBundle(o).map((x) => JSON.stringify(x));
    for (const entry of bundle) {
      const message = JSON.parse(entry.payload.message) as { signer_id: string; deadline: string };
      if (!genuine.includes(JSON.stringify(entry))) return { refusal: "invalid signature" };
      if (Date.parse(message.deadline) < blockSeconds(h) * 1000) return { refusal: "deadline has expired" };
      if (message.signer_id === MANDATE && !(await registered(entry.public_key, h))) return { refusal: missingKey(entry.public_key) };
    }
    const executed = bundle.map((entry, i) => ({ intent_hash: `SYNTHETICintentHash${String(i + 1)}`, account_id: (JSON.parse(entry.payload.message) as { signer_id: string }).signer_id, nonce: entry.payload.nonce }));
    const output: Body = { intents_executed: override === "partial" ? executed.slice(0, 1) : executed, logs: [], min_deadline: FAR_DEADLINE, state: { fee: 1, current_salt: "00000000" } };
    return { output: override === "invariant" ? { ...output, invariant_violated: { error: "unmatched_deltas", unmatched_deltas: { "nep141:wrap.near": "-1" } } } : output };
  };

  const patchTx = (body: Body, hash: unknown): Body => {
    const tx = body.result as { status: Body; transaction: { actions: { FunctionCall: { args: string } }[] }; receipts_outcome: { outcome: { executor_id: string; logs: string[]; status: Body } }[] } | undefined;
    if (tx === undefined) return body;
    const logTo = (pick: "first" | "last") => {
      const own = tx.receipts_outcome.filter((x) => x.outcome.executor_id === MANDATE);
      (pick === "first" ? own.at(0) : own.at(-1))?.outcome.logs.push(orderSignedLog(withheldOrder(o)));
    };
    if (hash === relayHash) {
      const call = tx.transaction.actions[0]?.FunctionCall;
      if (call !== undefined && o.relayed !== "nothing") call.args = b64({ signed: relayedBundle(o) });
      if (o.orderKey === "stranger" || o.relayError !== undefined) {
        const failure = panic(o.relayError ?? missingKey(o.rejectedKey ?? orderKey(o)));
        tx.status = { Failure: failure };
        for (const x of tx.receipts_outcome) if ("Failure" in x.outcome.status) x.outcome.status = { Failure: failure };
      }
    }
    if (hash === proposalHash && (o.signedEvent ?? "proposal") === "proposal") logTo("last");
    if (hash === lateHash && o.signedEvent === "after-removal") logTo("first");
    return body;
  };

  const atBlock = async (params: Body, h: number): Promise<Reply> => {
    const other = o.unserved?.how === "other-block" && matches(o.unserved, "query", params, relayHash);
    const where = { block_height: h, block_hash: blockHash(other ? h + 1 : h) };
    if (params.request_type === "view_account") {
      if (params.account_id === VERIFIER) return result({ amount: "1", locked: "0", code_hash: o.verifierCodeFrom !== undefined && h >= o.verifierCodeFrom ? OTHER_CODE_HASH : VERIFIER_CODE_HASH, storage_usage: 1, ...where });
      const body = await forward("query", { ...params, block_id: h });
      return { body: body.result === undefined ? body : { ...body, result: { ...(body.result as Body), ...where } } };
    }
    const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8")) as Body;
    if (params.method_name === "simulate_intents") {
      const sim = await simulate(args.signed as Signed[], h);
      if ("output" in sim) return result({ result: [...Buffer.from(JSON.stringify(sim.output))], logs: [], ...where });
      const text = `wasm execution failed with error: HostError(GuestPanic { panic_msg: ${JSON.stringify(sim.refusal)} })`;
      return o.structuredRefusals === true ? rpcError("CONTRACT_EXECUTION_ERROR", `Function call returned an error: ${text}`, { vm_error: text, ...where }) : result({ error: text, logs: [], ...where });
    }
    const value = params.method_name === "has_public_key" && args.account_id === MANDATE ? await registered(String(args.public_key), h) : await view(String(params.method_name), args, h);
    return result({ result: [...Buffer.from(JSON.stringify(value))], logs: [], ...where });
  };

  const answer = async (method: string, params: Body): Promise<Reply> => {
    const u = o.unserved;
    if (u !== undefined && matches(u, method, params, relayHash) && (u.times === undefined || refused < u.times)) {
      const reply = unservedReply(u, params);
      refused += 1;
      if (reply !== null) return reply;
    }
    if (method === "block") {
      const h = heightOf(params.block_id);
      return h === null ? rpcError("UNKNOWN_BLOCK", `DB Not Found Error: BLOCK: ${String(params.block_id)} \n Cause: Unknown`) : result({ header: { hash: blockHash(h), height: h, prev_hash: blockHash(h - 1), timestamp_nanosec: blockTimeNs(h) } });
    }
    const h = method === "query" ? heightOf(params.block_id) : null;
    if (h !== null) return atBlock(params, h);
    const body = await forward(method, params);
    return { body: method === "tx" || method === "EXPERIMENTAL_tx_status" ? patchTx(body, params.tx_hash) : body };
  };

  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c: Buffer) => (text += c.toString()));
    req.on("end", () => {
      if (o.hang === true) return;
      const { method, params } = JSON.parse(text) as { method: string; params: Body };
      requests.push(method);
      log.push({ method, params, at: Date.now() });
      open += 1;
      mostOpen = Math.max(mostOpen, open);
      res.on("close", () => (open -= 1));
      answer(method, params).then(
        (reply) => {
          if ("http" in reply) res.statusCode = reply.http;
          res.setHeader("Content-Type", "application/json");
          res.end("http" in reply ? "{}" : JSON.stringify(reply.body));
        },
        () => {
          res.destroy();
        },
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    log,
    codeReads: base.codeReads,
    concurrency: () => mostOpen,
    stop: async () => {
      await stopChain(server);
      await stopChain(base.server);
    },
  };
}
