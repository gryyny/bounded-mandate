// The opt-in verification panel. The browser code is exercised as the page inlines it: clientScript() is evaluated
// and its functions are called with a mocked fetch that answers from SYNTHETIC fixtures (test/fixtures/page-verify).
// No network request is made. The historical replay's rules are tested on the shared cases in replay-rules.test.ts;
// here it runs as one item of the panel.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonical } from "../src/live/ledger.js";
import { liveView } from "../src/page/mainnet.js";
import { renderHtml } from "../src/page/render.js";
import type { DomDoc, DomEl, ExpectedRelay, ExpectedReplay, FetchFn, FetchResponse, Item, RelayClassification, Report, VerifyData } from "../src/page/verify-client.js";
import { MAINNET_GENESIS_HASH, MAINNET_VERIFIER, clientScript, hexToBase58, verifyData } from "../src/page/verify.js";
import { type Assertion, Evidence } from "../src/types.js";
import { evidence, storyEvidence } from "./video-story-specimen.js";

const repo = resolve(import.meta.dirname, "../..");
const FIXTURES = join(import.meta.dirname, "fixtures/page-verify");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, `synthetic-${name}.json`), "utf8")) as Record<string, unknown>;
const X = fixture("expectations") as { mandate: string; filler: string; owner: string; verifier: string; key: string; relay_tx_hash: string; grant_tx_hash: string; deadline_ns: string; order_id: string; bundle: unknown };
/** Independent of the client: node's sha256 over the live runner's canonical JSON. */
const BUNDLE_SHA = createHash("sha256").update(canonical(X.bundle)).digest("hex");
const VERIFIER_SHA256_HEX = createHash("sha256").update(readFileSync(join(repo, "fixtures/verifier/defuse-0.4.5.wasm"))).digest("hex");

// SYNTHETIC additions for the historical replay: the proposal that signed the withheld order, the revoke whose
// remove_public_key receipt executed in SYNTHETICblockRemoval, and the code hashes the run records.
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const AGENT = "agent.synthetic.near";
const PROPOSE_TX = hexToBase58(sha("SYNTHETIC propose transaction"));
const REVOKE_TX = hexToBase58(sha("SYNTHETIC revoke transaction"));
const CANDIDATE_SHA256_HEX = sha("SYNTHETIC deployment candidate");
const MANDATE_CODE = hexToBase58(CANDIDATE_SHA256_HEX);
const VERIFIER_CODE = String((fixture("view-account-intents").result as Record<string, unknown>).code_hash);
const BLOCKS: Record<string, { height: number; time: string; prev: string }> = {
  SYNTHETICblockSigned: { height: 199999900, time: "1800000001000000000", prev: "SYNTHETICblockBeforeSigned" },
  SYNTHETICblockBeforeRemoval: { height: 199999989, time: "1800000004000000000", prev: "SYNTHETICblockEarlier" },
  SYNTHETICblockRemoval: { height: 199999990, time: "1800000005000000000", prev: "SYNTHETICblockBeforeRemoval" },
  SYNTHETICblockReject: { height: 200000000, time: "1800000010000000000", prev: "SYNTHETICblockBeforeReject" },
};
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64");
const rpcResult = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id: "verify", result });
const MISSING_KEY = `public key '${X.key}' doesn't exist for account '${X.mandate}'`;
const txResult = (hash: string, signer: string, receiver: string, method: string, receipts: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  rpcResult({
    final_execution_status: "FINAL",
    status: { SuccessValue: "" },
    transaction: { hash, signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args: b64({}), gas: 1, deposit: "0" } }] },
    transaction_outcome: { id: hash, block_hash: "SYNTHETICblockIncluded", outcome: { executor_id: signer, status: { SuccessReceiptId: "SYNTHETICreceiptFirst" } } },
    receipts_outcome: receipts,
    ...extra,
  });
const orderSigned = `EVENT_JSON:${JSON.stringify({ standard: "bounded_mandate", version: "1.0.0", event: "order_signed", data: { order_id: X.order_id, epoch: 1, multi_payload: JSON.stringify((X.bundle as unknown[])[0]) } })}`;
const PROPOSE = txResult(PROPOSE_TX, AGENT, X.mandate, "propose_order", [{ id: "SYNTHETICreceiptSigned", block_hash: "SYNTHETICblockSigned", outcome: { executor_id: X.mandate, logs: [orderSigned], status: { SuccessValue: "" } } }]);
const REVOKE = txResult(
  REVOKE_TX,
  X.owner,
  X.mandate,
  "revoke",
  [
    { id: "SYNTHETICreceiptRevoke", block_hash: "SYNTHETICblockBeforeRemoval", outcome: { executor_id: X.mandate, logs: [], status: { SuccessReceiptId: "SYNTHETICreceiptRemove" } } },
    { id: "SYNTHETICreceiptRemove", block_hash: "SYNTHETICblockRemoval", outcome: { executor_id: X.verifier, logs: [], status: { SuccessValue: "" } } },
  ],
  { receipts: [{ receipt_id: "SYNTHETICreceiptRemove", predecessor_id: X.mandate, receiver_id: X.verifier, receipt: { Action: { actions: [{ FunctionCall: { method_name: "remove_public_key", args: b64({ public_key: X.key }), gas: 1, deposit: "0" } }] } } }] },
);
/** What an archival node answers at one of the two snapshots, in the shapes the public archival endpoint uses. */
function atSnapshot(params: Record<string, unknown>): Record<string, unknown> | number {
  const block = String(params.block_id);
  const where = { block_hash: block, block_height: BLOCKS[block]?.height ?? 0 };
  const registered = block === "SYNTHETICblockBeforeRemoval";
  const value = (v: unknown) => rpcResult({ result: [...Buffer.from(JSON.stringify(v))], logs: [], ...where });
  if (params.request_type === "view_account") return rpcResult({ amount: "1", locked: "0", code_hash: params.account_id === X.verifier ? VERIFIER_CODE : MANDATE_CODE, storage_usage: 1, ...where });
  if (params.method_name === "has_public_key") return value(registered);
  if (params.method_name !== "simulate_intents") return 404;
  const signed = (JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8")) as { signed: { payload: { nonce: string } }[] }).signed;
  if (!registered) return rpcResult({ error: `wasm execution failed with error: HostError(GuestPanic { panic_msg: ${JSON.stringify(MISSING_KEY)} })`, logs: [], ...where });
  return value({ intents_executed: signed.map((x, i) => ({ intent_hash: `SYNTHETICintentHash${String(i + 1)}`, account_id: "SYNTHETIC", nonce: x.payload.nonce })), logs: [], min_deadline: "2027-01-15T08:01:00Z", state: { fee: 1, current_salt: "00000000" } });
}

interface Client {
  runVerification(fetchFn: FetchFn, url: string, data: VerifyData): Promise<Report>;
  classifyRelayTx(tx: Record<string, unknown>, e: ExpectedRelay, blockTimeNs: string | null, bundleSha256: string | null): { classification: RelayClassification; reasons: string[] };
  canonicalJson(v: unknown): string;
  install(doc: DomDoc, fetchFn: FetchFn): void;
}
/** The exact inline script of the page, evaluated with no document elements, so its bootstrap wires nothing. */
function client(): Client {
  const emptyDoc = { getElementById: () => null, createElement: () => null };
  // Evaluating the page's own script text is the point: the tested code is byte-for-byte the inlined code.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("document", "fetch", `${clientScript()}\nreturn { runVerification, classifyRelayTx, canonicalJson, install };`) as (doc: unknown, f: unknown) => Client;
  return factory(emptyDoc, () => {
    throw new Error("the bootstrap must not fetch");
  });
}

const SYN = "SYNTHETIC";
const held = (id: string, observed: unknown): Assertion => ({ id, gate: "LIVE", description: `${SYN} ${id}`, passed: true, observed });
/** SYNTHETIC mainnet evidence matching the fixtures: one grant transaction and the withheld order's relay. */
const liveEvidence = (over: Partial<Evidence> = {}): Evidence =>
  Evidence.parse({
    ...evidence({}),
    mode: "mainnet",
    command: `MANDATE_LIVE=1 make live (${SYN})`,
    environment: { chain_id: "mainnet", label: SYN },
    identifiers: { mandate: X.mandate, verifier: X.verifier, owner: X.owner, filler: X.filler, mandate_code_hash: MANDATE_CODE },
    receipts: [
      { label: `owner grant (${SYN})`, tx_hash: X.grant_tx_hash, outcome: "success", detail: { step: 1, signer_id: X.owner, method: "grant" } },
      { label: `agent propose (${SYN})`, tx_hash: PROPOSE_TX, outcome: "success", detail: { step: 4, signer_id: AGENT, method: "propose_order" } },
      { label: `owner revoke (${SYN})`, tx_hash: REVOKE_TX, outcome: "success", detail: { step: 6, signer_id: X.owner, method: "revoke" } },
      { label: `filler relay_withheld (${SYN})`, tx_hash: X.relay_tx_hash, outcome: "failure", detail: { step: 7, signer_id: X.filler, method: "execute_intents", withheld_relay: true, order_id: X.order_id, bundle_sha256: BUNDLE_SHA } },
    ],
    assertions: [
      held("preflight-code_hash.verifier", { account: X.verifier, chain: VERIFIER_CODE, manifest: VERIFIER_CODE }),
      held("step-7-relay_withheld", { classification: "rejected_revoked_key", revoked_key: X.key, deadline_ns: X.deadline_ns, order_id: X.order_id }),
    ],
    unknowns: [],
    ...over,
  });
const demo = (): Evidence => {
  const ev = storyEvidence();
  return { ...ev, source: { ...ev.source, fixtures: { "verifier/defuse-0.4.5.wasm": VERIFIER_SHA256_HEX, "deploy/synthetic-candidate.wasm": CANDIDATE_SHA256_HEX } } };
};
const mainnetData = (over: Partial<Evidence> = {}): VerifyData => verifyData(demo(), liveView(liveEvidence(over)));
/** The items of the panel for liveEvidence(): three recorded transactions, the relay, the replay. */
const [RELAY, REPLAY] = [3, 4];

type Route = (method: string, params: Record<string, unknown>) => Record<string, unknown> | "hang" | number;
const ok = (name: string) => fixture(name);
/** Answers like a mainnet archival RPC holding exactly the fixtures. */
const mainnet: Route = (method, params) => {
  if (method === "status") return ok("status-mainnet");
  if (method === "tx" && params.tx_hash === PROPOSE_TX) return PROPOSE;
  if ((method === "tx" || method === "EXPERIMENTAL_tx_status") && params.tx_hash === REVOKE_TX) return REVOKE;
  if (method === "tx") return params.tx_hash === X.relay_tx_hash ? ok("tx-relay-rejected") : params.tx_hash === X.grant_tx_hash ? ok("tx-grant") : ok("error-unknown-tx");
  if (method === "block") {
    const b = BLOCKS[String(params.block_id)];
    return b === undefined ? 404 : rpcResult({ header: { hash: params.block_id, height: b.height, prev_hash: b.prev, timestamp_nanosec: b.time } });
  }
  if (method === "query" && typeof params.block_id === "string") return atSnapshot(params);
  if (method === "query" && params.request_type === "view_account") return ok("view-account-intents");
  if (method === "query" && params.method_name === "has_public_key") return ok("call-has-public-key-false");
  if (method === "query" && params.method_name === "get_grant") return ok("call-get-grant-revoked");
  return 404;
};
const fetchFrom = (route: Route) =>
  vi.fn<FetchFn>((_url, init) => {
    const body = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    const r = route(body.method, body.params);
    if (r === "hang") return new Promise<FetchResponse>(() => undefined);
    if (typeof r === "number") return Promise.resolve({ ok: false, status: r, json: () => Promise.resolve(null) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(r) });
  });
const withResult = (name: string, edit: (result: Record<string, unknown>) => void): Record<string, unknown> => {
  const f = structuredClone(fixture(name));
  edit(f.result as Record<string, unknown>);
  return f;
};
/** The mocked RPC answers at once, so these runs are not paced; pacing has its own test (replay-rules.test.ts). */
const run = (route: Route, data = mainnetData()) => client().runVerification(fetchFrom(route), "https://rpc.synthetic.invalid", { ...data, pace_ms: 0 });
const rejectBlock = (edit: (header: Record<string, unknown>) => void): Route => (m, p) => {
  const answer = mainnet(m, p);
  if (m === "block" && p.block_id === "SYNTHETICblockReject" && typeof answer === "object") edit((answer.result as { header: Record<string, unknown> }).header);
  return answer;
};
const statuses = (items: readonly Item[]) => items.map((i) => i.status);

describe("verification panel: data from the evidence", () => {
  it("pins intents.near's code hash from the verifier fixture's sha256", () => {
    // fixtures/manifest.json records the on-chain code_hash this must equal.
    const manifest = readFileSync(join(repo, "fixtures/manifest.json"), "utf8");
    const recorded = /code_hash ([1-9A-HJ-NP-Za-km-z]+) equals base58\(sha256\)/.exec(manifest)?.[1];
    expect(recorded).toBeDefined();
    expect(hexToBase58(VERIFIER_SHA256_HEX)).toBe(recorded);
    expect(hexToBase58("0001")).toBe("12");
  });

  it("has no receipts without mainnet evidence, and the relay expectation from mainnet evidence", () => {
    const none = verifyData(demo(), liveView(null));
    expect(none.receipts).toEqual([]);
    expect(none.relay).toBeNull();
    expect(none.unverifiable).toEqual([]);
    expect(none.current).toBeNull();
    const d = mainnetData();
    expect(d.receipts.map((r) => r.tx_hash)).toEqual([X.grant_tx_hash, PROPOSE_TX, REVOKE_TX]);
    expect(d.relay).toEqual({ label: `filler relay_withheld (${SYN})`, tx_hash: X.relay_tx_hash, sender: X.filler, verifier: X.verifier, mandate: X.mandate, revoked_key: X.key, deadline_ns: X.deadline_ns, order_id: X.order_id, bundle_sha256: BUNDLE_SHA });
    expect(d.current).toEqual({ mandate: X.mandate, grant_key: X.key });
    expect(verifyData(demo(), liveView(liveEvidence({ assertions: [] }))).relay_problem).toContain("no relay verification");
  });
});

describe("verification panel: browser checks against a mocked RPC (SYNTHETIC fixtures)", () => {
  it("verifies the receipts and the relay only on the expected chain, and labels current state as such", async () => {
    const r = await run(mainnet);
    expect(r.chain.status).toBe("verified");
    expect(statuses(r.historical.items)).toEqual(["verified", "verified", "verified", "verified", "verified"]);
    expect(r.historical.verdict.status).toBe("verified");
    const relay = r.historical.items[RELAY];
    expect(relay?.title).toContain(`rejected before its deadline because the signing key recorded for the withheld order was not registered on ${X.verifier}`);
    expect(r.historical.verdict.title).toContain("All 4 recorded mainnet transactions match the chain");
    expect(r.historical.verdict.title).toContain("the historical replay of chain state shows the relayed bundle accepted at the preceding snapshot and refused at the removal snapshot");
    // It states what the check cannot show.
    expect(Object.fromEntries(relay?.facts ?? [])["Not shown by this check"]).toContain("that this key was ever registered, or that the order was executable before revocation");
    for (const i of [relay, r.historical.verdict]) expect(i?.title).not.toMatch(/removed key|revoked key|revocation stopped/);
    const facts = Object.fromEntries(relay?.facts ?? []);
    expect(facts["Relayed bundle sha256"]).toBe(BUNDLE_SHA);
    expect(facts["Rejection reason"]).toContain(`public key '${X.key}' doesn't exist for account '${X.mandate}'`);
    expect(facts["Rejection receipt"]).toBe("SYNTHETICreceiptVerifier in block SYNTHETICblockReject");
    expect(facts["Block time"]).toContain("1800000010000000000");
    expect(statuses(r.current)).toEqual(["verified", "info", "info"]);
    expect(r.current[1]?.title).toBe(`Grant key registered on ${MAINNET_VERIFIER} now: no`);
    for (const i of r.current.slice(1)) expect(i.reasons.join(" ")).toContain("cannot show that a historical order was rejected before its deadline");
  });

  it("checks the network before anything else and stops on a wrong chain or genesis", async () => {
    for (const status of ["status-testnet", "status-wrong-genesis"]) {
      const f = fetchFrom((m, p) => (m === "status" ? ok(status) : mainnet(m, p)));
      const r = await client().runVerification(f, "https://rpc.synthetic.invalid", mainnetData());
      expect(r.chain.status).toBe("failed");
      expect(r.historical.verdict.status).not.toBe("verified");
      expect(r.historical.items).toEqual([]);
      expect(statuses(r.current)).toEqual(["error"]);
      expect(f).toHaveBeenCalledTimes(1);
    }
    const r = await run((m, p) => (m === "status" ? ok("status-wrong-genesis") : mainnet(m, p)));
    expect(r.chain.reasons.join(" ")).toContain(`expected "${MAINNET_GENESIS_HASH}"`);
  });

  it("reports a missing transaction, an RPC error and a timeout as errors, without recorded values as results", async () => {
    const notFound = await run((m, p) => (m === "tx" && p.tx_hash === X.relay_tx_hash ? ok("error-unknown-tx") : mainnet(m, p)));
    const relay = notFound.historical.items[RELAY];
    expect(relay?.status).toBe("error");
    // The replay cannot read the bundle either: inconclusive, never verified from the record.
    expect(notFound.historical.items[REPLAY]?.status).toBe("inconclusive");
    expect(relay?.reasons.join(" ")).toContain("UNKNOWN_TRANSACTION");
    expect(relay?.facts.map(([k]) => k)).not.toContain("Rejection reason");
    expect(notFound.historical.verdict.status).toBe("error");

    const http = await run((m, p) => (m === "tx" ? 503 : mainnet(m, p)));
    expect(statuses(http.historical.items)).toEqual(["error", "error", "error", "error", "inconclusive"]);
    expect(http.historical.items[0]?.reasons).toEqual(["HTTP 503"]);

    const data = { ...mainnetData(), timeout_ms: 20 };
    const slow = await run((m, p) => (m === "block" ? "hang" : mainnet(m, p)), data);
    expect(slow.historical.items[RELAY]?.status).toBe("inconclusive");
    expect(slow.historical.items[RELAY]?.reasons.join(" ")).toContain("timed out after 20 ms");
    expect(slow.historical.items[REPLAY]?.status).toBe("inconclusive");
    const down = await run(() => "hang", data);
    expect(down.chain.status).toBe("error");
    expect(down.chain.reasons).toEqual(["timed out after 20 ms"]);
    expect(down.historical.verdict.status).not.toBe("verified");
  });

  it("never shows a relay after the deadline as rejected by revocation", async () => {
    const r = await run(
      rejectBlock((h) => {
        h.timestamp_nanosec = (BigInt(X.deadline_ns) + 1n).toString();
      }),
    );
    expect(r.historical.items[RELAY]?.status).toBe("inconclusive");
    expect(r.historical.items[RELAY]?.reasons.join(" ")).toContain("executed after the order deadline");
    // The replay's rule is that the relay failed before the order's deadline, so for it this chain is a contradiction.
    expect(r.historical.items[REPLAY]?.status).toBe("failed");
    expect(r.historical.items[REPLAY]?.reasons.join(" ")).toContain("not before the order's deadline");
    expect(r.historical.verdict.status).toBe("failed");
    // At the deadline itself, as classifyRelay in src/live/verify.ts: not after it. The replay asks for a block time
    // before the deadline (SPEC.md), so it does not hold there.
    const atDeadline = await run(
      rejectBlock((h) => {
        h.timestamp_nanosec = X.deadline_ns;
      }),
    );
    expect(atDeadline.historical.items[RELAY]?.status).toBe("verified");
    expect(atDeadline.historical.items[REPLAY]?.status).toBe("failed");
    expect(atDeadline.historical.verdict.status).toBe("failed");
  });

  it("shows an executed relay as a failed revocation", async () => {
    const executed = withResult("tx-relay-rejected", (t) => {
      t.status = { SuccessValue: "" };
      t.receipts_outcome = [{ id: "SYNTHETICreceiptVerifier", block_hash: "SYNTHETICblockReject", outcome: { executor_id: X.verifier, status: { SuccessValue: "" } } }];
    });
    const r = await run((m, p) => (m === "tx" && p.tx_hash === X.relay_tx_hash ? executed : mainnet(m, p)));
    expect(r.historical.items[RELAY]?.status).toBe("failed");
    expect(r.historical.items[RELAY]?.title).toContain("EXECUTED");
    expect(r.historical.items[REPLAY]?.status).toBe("failed");
    expect(r.historical.verdict.status).toBe("failed");
  });

  const transaction = (t: Record<string, unknown>) => t.transaction as Record<string, unknown>;
  const firstReceipt = (t: Record<string, unknown>) => (t.receipts_outcome as { outcome: { status: unknown } }[])[0] ?? { outcome: { status: null } };
  const firstCall = (t: Record<string, unknown>) => (transaction(t).actions as { FunctionCall: { args: string } }[])[0] ?? { FunctionCall: { args: "" } };
  const mismatches: [string, (t: Record<string, unknown>) => void, string][] = [
    ["signer", (t) => { transaction(t).signer_id = "someone.near"; }, "signer"],
    ["hash", (t) => { transaction(t).hash = X.grant_tx_hash; }, "transaction hash"],
    ["receiver", (t) => { transaction(t).receiver_id = "intents.other.near"; }, "receiver"],
    ["finality", (t) => { t.final_execution_status = "EXECUTED_OPTIMISTIC"; }, "not final"],
    ["error account", (t) => { firstReceipt(t).outcome.status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `public key '${X.key}' doesn't exist for account 'other.near'` } } } } }; }, "unregistered-key rejection"],
    ["bundle", (t) => { firstCall(t).FunctionCall.args = Buffer.from(JSON.stringify({ signed: [] })).toString("base64"); }, "bundle"],
    ["other failure", (t) => { (t.receipts_outcome as unknown[]).push({ id: "x", block_hash: "y", outcome: { executor_id: X.filler, status: { Failure: {} } } }); }, "outside the verifier"],
  ];
  it.each(mismatches)("a mismatched %s is inconclusive, never verified", async (_what, edit, reason) => {
    const tx = withResult("tx-relay-rejected", edit);
    const r = await run((m, p) => (m === "tx" && p.tx_hash === X.relay_tx_hash ? tx : mainnet(m, p)));
    expect(r.historical.items[RELAY]?.status).toBe("inconclusive");
    expect(r.historical.items[RELAY]?.reasons.join(" ")).toContain(reason);
    expect(r.historical.verdict.status).not.toBe("verified");
  });

  it("a recorded receipt whose chain outcome or signer differs fails", async () => {
    const r = await run((m, p) => (m === "tx" && p.tx_hash === X.grant_tx_hash ? withResult("tx-grant", (t) => (t.status = { Failure: {} })) : mainnet(m, p)));
    expect(r.historical.items[0]?.status).toBe("failed");
    expect(r.historical.items[0]?.reasons).toEqual(["chain outcome failure differs from the recorded success"]);
  });

  it("compares the recorded outcome with the whole receipt tree, as the runner records it", async () => {
    // Top-level SuccessValue with a failed detached receipt: the runner records "failure" (toEvidenceReceipt).
    const detached = (m: string, p: Record<string, unknown>) => (m === "tx" && p.tx_hash === X.grant_tx_hash ? ok("tx-grant-detached-failure") : mainnet(m, p));
    const recordedSuccess = await run(detached);
    expect(recordedSuccess.historical.items[0]?.status).toBe("failed");
    expect(recordedSuccess.historical.items[0]?.reasons).toEqual(["chain outcome failure differs from the recorded success"]);
    expect(recordedSuccess.historical.verdict.status).toBe("failed");
    const failureLive = liveEvidence();
    const recordedFailure = { ...failureLive, receipts: failureLive.receipts.map((r) => (r.tx_hash === X.grant_tx_hash ? { ...r, outcome: "failure" as const } : r)) };
    const asRecorded = await run(detached, verifyData(demo(), liveView(recordedFailure)));
    expect(asRecorded.historical.items[0]?.status).toBe("verified");
    expect(asRecorded.historical.items[0]?.title).toContain("final, failure, as recorded");
    const notFinal = await run((m, p) => (m === "tx" && p.tx_hash === X.grant_tx_hash ? withResult("tx-grant", (t) => {
      for (const x of t.receipts_outcome as { outcome: { status: unknown } }[]) x.outcome.status = "Unknown";
    }) : mainnet(m, p)));
    expect(notFinal.historical.items[0]?.status).toBe("inconclusive");
  });

  it("is inconclusive, not silently checked, when the evidence records no bundle sha256", async () => {
    const live = liveEvidence();
    const noBundle = { ...live, receipts: live.receipts.map((r) => (r.tx_hash === X.relay_tx_hash ? { ...r, detail: { ...(r.detail as object), bundle_sha256: undefined } } : r)) };
    const data = verifyData(demo(), liveView(noBundle));
    expect(data.relay?.bundle_sha256).toBeNull();
    const r = await run(mainnet, data);
    expect(r.historical.items[RELAY]?.status).toBe("inconclusive");
    expect(r.historical.items[RELAY]?.reasons.join(" ")).toContain("not checkable: the evidence records no bundle sha256");
    expect(r.historical.verdict.status).toBe("inconclusive");
  });

  it("lists recorded transactions it cannot query as inconclusive, and counts them", async () => {
    const live = liveEvidence();
    const extra = { label: `owner recover (${SYN})`, tx_hash: X.grant_tx_hash, outcome: "success" as const, detail: { step: 8 } };
    const data = verifyData(demo(), liveView({ ...live, receipts: [...live.receipts, extra] }));
    expect(data.unverifiable).toEqual([{ label: extra.label, reason: "its sender (signer_id) is not recorded, and the RPC needs it to look the transaction up" }]);
    const r = await run(mainnet, data);
    expect(statuses(r.historical.items)).toEqual(["verified", "verified", "verified", "inconclusive", "verified", "verified"]);
    expect(r.historical.items[3]?.title).toBe(`${extra.label}: inconclusive, not checkable`);
    expect(r.historical.verdict.title).toBe("Not verified: 1 of 6 checks did not hold");
    const html = renderHtml(demo(), { acceptance: null, live: { ...live, receipts: [...live.receipts, extra] } });
    expect(html).toContain("3 recorded transactions to check, 1 more that cannot be checked (shown as inconclusive)");
  });

  it("says there are no mainnet receipts yet, and still checks the current code hash", async () => {
    const data = verifyData(demo(), liveView(null));
    const r = await run(mainnet, data);
    expect(r.historical.verdict.status).toBe("none");
    expect(r.historical.verdict.title).toContain("No mainnet receipts yet");
    expect(statuses(r.current)).toEqual(["verified"]);
    const differs = await run((m, p) => (m === "query" ? withResult("view-account-intents", (a) => (a.code_hash = "11111111111111111111111111111111")) : mainnet(m, p)), data);
    expect(statuses(differs.current)).toEqual(["failed"]);
  });

  it("classifies like classifyRelay: executed, inconclusive without a verifier failure, rejected only with every check", () => {
    const c = client();
    const relay = mainnetData().relay;
    if (relay === null) throw new Error("no relay");
    const tx = fixture("tx-relay-rejected").result as Record<string, unknown>;
    expect(c.classifyRelayTx(tx, relay, "1800000010000000000", BUNDLE_SHA).classification).toBe("rejected_revoked_key");
    expect(c.classifyRelayTx(tx, relay, null, BUNDLE_SHA).classification).toBe("inconclusive");
    expect(c.classifyRelayTx({ ...tx, receipts_outcome: [] }, relay, "1800000010000000000", BUNDLE_SHA).reasons).toContain(`no failed receipt on ${X.verifier}`);
    expect(c.classifyRelayTx({ ...tx, status: { SuccessValue: "" } }, relay, "1800000010000000000", BUNDLE_SHA).classification).toBe("executed");
    expect(c.canonicalJson(X.bundle)).toBe(canonical(X.bundle));
  });
});

describe("verification panel: historical replay of the withheld order (SYNTHETIC fixtures)", () => {
  /** The replay is the last item of the historical part. */
  const replayOf = (r: Report): Item => {
    const item = r.historical.items.at(-1);
    if (item?.title.startsWith("Historical replay of the withheld order") !== true) throw new Error("no replay item");
    return item;
  };
  const snapshot = (edit: (params: Record<string, unknown>) => Record<string, unknown> | number | null): Route => (m, p) => (m === "query" && typeof p.block_id === "string" ? (edit(p) ?? mainnet(m, p)) : mainnet(m, p));

  // gate: REPLAY
  it("takes the replay's inputs from the evidence: transactions and recorded code hashes, no block and no bundle", () => {
    const expected: ExpectedReplay = {
      mandate: X.mandate,
      verifier: X.verifier,
      relay: { tx_hash: X.relay_tx_hash, sender: X.filler },
      revokes: [{ tx_hash: REVOKE_TX, sender: X.owner }],
      proposals: [{ tx_hash: PROPOSE_TX, sender: AGENT }],
      mandate_code_hash: MANDATE_CODE,
      verifier_code_hash: VERIFIER_CODE,
    };
    expect(mainnetData().replay).toEqual(expected);
    expect(mainnetData().pace_ms).toBe(500);
    // The mandate's hash counts only if it is a deployment candidate of the page's source.
    const other = verifyData(demo(), liveView(liveEvidence({ identifiers: { mandate: X.mandate, verifier: X.verifier, mandate_code_hash: VERIFIER_CODE } })));
    expect(other.replay?.mandate_code_hash).toBeNull();
    // The verifier's hash is the one the run's preflight read from the chain and found equal to its manifest.
    const noPreflight = liveEvidence();
    expect(verifyData(demo(), liveView({ ...noPreflight, assertions: noPreflight.assertions.filter((a) => a.id !== "preflight-code_hash.verifier") })).replay?.verifier_code_hash).toBeNull();
    const failedPreflight = { ...noPreflight, assertions: noPreflight.assertions.map((a) => (a.id === "preflight-code_hash.verifier" ? { ...a, passed: false } : a)) };
    expect(verifyData(demo(), liveView(failedPreflight)).replay?.verifier_code_hash).toBeNull();
    const withoutRelay = liveEvidence();
    const none = verifyData(demo(), liveView({ ...withoutRelay, receipts: withoutRelay.receipts.filter((r) => r.tx_hash !== X.relay_tx_hash) }));
    expect(none.replay).toBeNull();
    expect(none.replay_problem).toContain("no relay transaction of the withheld order");
  });

  // gate: REPLAY
  it("verified: both snapshots are named, and the item says what a replay of chain state does not show", async () => {
    const item = replayOf(await run(mainnet));
    expect(item.status).toBe("verified");
    expect(item.title).toBe(`Historical replay of the withheld order: simulate_intents accepted the relayed bundle at the preceding snapshot and refused the identical bundle at the removal snapshot because its signing key did not exist for ${X.mandate}`);
    const facts = Object.fromEntries(item.facts);
    expect(facts["Removal snapshot"]).toContain("block 199999990 (SYNTHETICblockRemoval)");
    expect(facts["Removal snapshot"]).toContain("the block in which the remove_public_key receipt SYNTHETICreceiptRemove");
    expect(facts["Preceding snapshot"]).toContain("block 199999989 (SYNTHETICblockBeforeRemoval)");
    expect(facts["What this shows"]).toBe("A historical replay of chain state: the relayed bundle was executable at the preceding snapshot. It does not show when the counterparty created its signature.");
    expect(item.facts.filter(([k]) => /^[1-6]\. /.test(k)).map(([, v]) => v)).toEqual(["verified", "verified", "verified", "verified", "verified", "verified"]);
    expect(item.reasons).toEqual([]);
  });

  // gate: REPLAY
  it("failed: a bundle the verifier refuses at the preceding snapshot is never shown as verified", async () => {
    const refused = { jsonrpc: "2.0", id: "verify", result: { error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "nonce was already used" })', logs: [], block_hash: "SYNTHETICblockBeforeRemoval", block_height: 199999989 } };
    const r = await run(snapshot((p) => (p.method_name === "simulate_intents" && p.block_id === "SYNTHETICblockBeforeRemoval" ? refused : null)));
    const item = replayOf(r);
    expect(item.status).toBe("failed");
    expect(item.title).toBe("Historical replay of the withheld order: failed, the chain contradicts the record");
    expect(item.reasons).toEqual(['Rule 2: simulate_intents refused the relayed bundle at the preceding snapshot: wasm execution failed with error: HostError(GuestPanic { panic_msg: "nonce was already used" })']);
    expect(r.historical.items[RELAY]?.status).toBe("verified");
    expect(r.historical.verdict.status).toBe("failed");
  });

  // gate: REPLAY
  it("inconclusive: archival state the RPC does not serve, a rate limit after bounded retries included", async () => {
    const limited = fetchFrom(snapshot((p) => (p.method_name === "simulate_intents" ? 429 : null)));
    const r = await client().runVerification(limited, "https://rpc.synthetic.invalid", { ...mainnetData(), pace_ms: 0 });
    const item = replayOf(r);
    expect(item.status).toBe("inconclusive");
    expect(item.title).toBe("Historical replay of the withheld order: inconclusive, the RPC did not serve the archival state it needs");
    expect(item.reasons.join(" ")).toContain("HTTP 429 on each of 4 attempts (rate limited)");
    expect(limited.mock.calls.filter(([, init]) => init.body.includes("simulate_intents"))).toHaveLength(8);
    expect(r.historical.verdict.status).toBe("inconclusive");

    const pruned = { jsonrpc: "2.0", id: "verify", error: { name: "HANDLER_ERROR", cause: { info: {}, name: "UNKNOWN_BLOCK" }, code: -32000, message: "Server error", data: "DB Not Found Error: BLOCK: SYNTHETIC \n Cause: Unknown" } };
    const gone = replayOf(await run(snapshot(() => pruned)));
    expect(gone.status).toBe("inconclusive");
    expect(gone.reasons.join(" ")).toContain("UNKNOWN_BLOCK");
  });

  // gate: REPLAY
  it("failed without recorded code hashes or a recorded revoke: nothing is assumed from the chain alone", async () => {
    const live = liveEvidence();
    const noRevoke = verifyData(demo(), liveView({ ...live, receipts: live.receipts.filter((r) => r.tx_hash !== REVOKE_TX) }));
    expect(noRevoke.replay?.revokes).toEqual([]);
    const item = replayOf(await run(mainnet, noRevoke));
    expect(item.status).toBe("failed");
    expect(item.reasons.join(" ")).toContain("none of the 0 recorded revoke transactions has a receipt");
    const noCode = replayOf(await run(mainnet, verifyData(demo(), liveView({ ...live, assertions: live.assertions.filter((a) => a.id !== "preflight-code_hash.verifier") }))));
    expect(noCode.status).toBe("failed");
    expect(noCode.reasons).toEqual([`Rule 6: the run's evidence records no code hash for ${X.verifier}`]);
  });

  // gate: REPLAY
  it("the page describes the replay as a historical replay of chain state and states its pace", () => {
    const html = renderHtml(demo(), { acceptance: null, live: liveEvidence() });
    expect(html).toContain("<strong>Historical replay of the withheld order.</strong>");
    expect(html).toContain("The removal snapshot is the block in which the successful <code>remove_public_key</code> receipt of the revoke executed; the preceding snapshot is that block's <code>prev_hash</code>; neither is the block that included the revoke transaction.");
    expect(html).toContain("This is a historical replay of chain state: it shows the bundle was executable at the preceding snapshot, and it does not show when the counterparty created its signature.");
    expect(html).toContain("one request at a time and at least 500 ms apart");
    const pending = renderHtml(demo(), { acceptance: null, live: null });
    expect(pending).toContain("replays the withheld bundle read-only against archival state at the block before the key's removal executed and at the block of the removal");
  });
});

/** Minimal DOM for the click wiring; textContent of descendants is joined like the browser's. */
class FakeEl implements DomEl {
  textContent: string | null = "";
  className = "";
  children: FakeEl[] = [];
  value = "";
  disabled = false;
  private listeners: (() => void)[] = [];
  constructor(private readonly attrs: Record<string, string> = {}) {}
  appendChild(c: DomEl): DomEl {
    this.children.push(c as FakeEl);
    return c;
  }
  replaceChildren(...c: DomEl[]): void {
    this.children = c as FakeEl[];
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  addEventListener(_type: string, fn: () => void): void {
    this.listeners.push(fn);
  }
  click(): void {
    for (const l of this.listeners) l();
  }
  text(): string {
    return `${this.textContent ?? ""}${this.children.map((c) => c.text()).join(" ")}`;
  }
}

describe("verification panel: opt-in wiring", () => {
  const html = renderHtml(demo(), { acceptance: null, live: null });
  const attr = /data-verify="([^"]*)"/.exec(html)?.[1] ?? "";
  const unescape = (s: string) => s.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

  it("renders the panel with no mainnet receipts and the default archival RPC, and fetches nothing before the click", async () => {
    expect(html).toContain("No mainnet receipts yet.");
    expect(html).toContain('id="verify-rpc" type="url" value="https://archival-rpc.mainnet.fastnear.com"');
    expect(html).toContain("Current state, not history:");
    expect(html).toContain("Each run first checks once that the RPC reports NEAR");
    expect(html).toContain("The RPC you choose is trusted for every answer it returns.</strong> The genesis check only catches a wrong network, not an RPC that returns false data. For an independent result, run the checks again against a second RPC.");
    expect(html).not.toContain("Every query first checks");
    expect(html).toContain("c. Recorded sandbox evidence");
    const data = JSON.parse(unescape(attr)) as VerifyData;
    expect(data.receipts).toEqual([]);
    expect(data.verifier_code_hash).toBe(hexToBase58(VERIFIER_SHA256_HEX));

    const [panel, button, input, status, chain, historical, current] = [new FakeEl({ "data-verify": unescape(attr) }), new FakeEl(), new FakeEl(), new FakeEl(), new FakeEl(), new FakeEl(), new FakeEl()];
    const els: Record<string, FakeEl> = { "verify-panel": panel, "verify-run": button, "verify-rpc": input, "verify-status": status, "verify-chain": chain, "verify-historical": historical, "verify-current": current };
    const doc: DomDoc = { createElement: () => new FakeEl(), getElementById: (id: string) => els[id] ?? null };
    const f = fetchFrom(mainnet);
    client().install(doc, f);
    expect(f).not.toHaveBeenCalled();
    expect(Object.values(els).every((e) => e.text() === "")).toBe(true);

    input.value = "http://plain.synthetic.invalid";
    button.click();
    expect(f).not.toHaveBeenCalled();
    expect(status.text()).toContain("starts with https");

    input.value = "https://rpc.synthetic.invalid";
    button.click();
    // The page paces its requests (500 ms apart), so the two requests of this run take longer than the default wait.
    await vi.waitFor(
      () => {
        expect(status.text()).toContain("Checked against https://rpc.synthetic.invalid");
      },
      { timeout: 5000 },
    );
    expect(f.mock.calls[0]?.[0]).toBe("https://rpc.synthetic.invalid");
    expect(chain.text()).toContain("Network check: NEAR mainnet");
    expect(historical.text()).toContain("No mainnet receipts yet");
    expect(current.text()).toContain("now equals the verifier WASM the tests ran (current state)");
    expect(button.disabled).toBe(false);
  });
});
