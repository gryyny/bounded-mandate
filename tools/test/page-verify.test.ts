// The opt-in verification panel. The browser code is exercised as the page inlines it: clientScript() is evaluated
// and its functions are called with a mocked fetch that answers from SYNTHETIC fixtures (test/fixtures/page-verify).
// No network request is made.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonical } from "../src/live/ledger.js";
import { liveView } from "../src/page/mainnet.js";
import { renderHtml } from "../src/page/render.js";
import type { DomDoc, DomEl, ExpectedRelay, FetchFn, FetchResponse, Item, RelayClassification, Report, VerifyData } from "../src/page/verify-client.js";
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
    identifiers: { mandate: X.mandate, verifier: X.verifier, owner: X.owner, filler: X.filler },
    receipts: [
      { label: `owner grant (${SYN})`, tx_hash: X.grant_tx_hash, outcome: "success", detail: { step: 1, signer_id: X.owner } },
      { label: `filler relay_withheld (${SYN})`, tx_hash: X.relay_tx_hash, outcome: "failure", detail: { step: 7, signer_id: X.filler, withheld_relay: true, order_id: X.order_id, bundle_sha256: BUNDLE_SHA } },
    ],
    assertions: [held("step-7-relay_withheld", { classification: "rejected_revoked_key", revoked_key: X.key, deadline_ns: X.deadline_ns, order_id: X.order_id })],
    unknowns: [],
    ...over,
  });
const demo = (): Evidence => {
  const ev = storyEvidence();
  return { ...ev, source: { ...ev.source, fixtures: { "verifier/defuse-0.4.5.wasm": VERIFIER_SHA256_HEX } } };
};
const mainnetData = (over: Partial<Evidence> = {}): VerifyData => verifyData(demo(), liveView(liveEvidence(over)));

type Route = (method: string, params: Record<string, unknown>) => Record<string, unknown> | "hang" | number;
const ok = (name: string) => fixture(name);
/** Answers like a mainnet archival RPC holding exactly the fixtures. */
const mainnet: Route = (method, params) => {
  if (method === "status") return ok("status-mainnet");
  if (method === "tx") return params.tx_hash === X.relay_tx_hash ? ok("tx-relay-rejected") : params.tx_hash === X.grant_tx_hash ? ok("tx-grant") : ok("error-unknown-tx");
  if (method === "block") return ok("block-reject");
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
const run = (route: Route, data = mainnetData()) => client().runVerification(fetchFrom(route), "https://rpc.synthetic.invalid", data);
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
    expect(d.receipts.map((r) => r.tx_hash)).toEqual([X.grant_tx_hash]);
    expect(d.relay).toEqual({ label: `filler relay_withheld (${SYN})`, tx_hash: X.relay_tx_hash, sender: X.filler, verifier: X.verifier, mandate: X.mandate, revoked_key: X.key, deadline_ns: X.deadline_ns, order_id: X.order_id, bundle_sha256: BUNDLE_SHA });
    expect(d.current).toEqual({ mandate: X.mandate, grant_key: X.key });
    expect(verifyData(demo(), liveView(liveEvidence({ assertions: [] }))).relay_problem).toContain("no relay verification");
  });
});

describe("verification panel: browser checks against a mocked RPC (SYNTHETIC fixtures)", () => {
  it("verifies the receipts and the relay only on the expected chain, and labels current state as such", async () => {
    const r = await run(mainnet);
    expect(r.chain.status).toBe("verified");
    expect(statuses(r.historical.items)).toEqual(["verified", "verified"]);
    expect(r.historical.verdict.status).toBe("verified");
    const relay = r.historical.items[1];
    expect(relay?.title).toContain(`rejected before its deadline because the signing key recorded for the withheld order was not registered on ${X.verifier}`);
    expect(r.historical.verdict.title).toContain("All 2 recorded mainnet transactions match the chain");
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
    const relay = notFound.historical.items[1];
    expect(relay?.status).toBe("error");
    expect(relay?.reasons.join(" ")).toContain("UNKNOWN_TRANSACTION");
    expect(relay?.facts.map(([k]) => k)).not.toContain("Rejection reason");
    expect(notFound.historical.verdict.status).toBe("error");

    const http = await run((m, p) => (m === "tx" ? 503 : mainnet(m, p)));
    expect(statuses(http.historical.items)).toEqual(["error", "error"]);
    expect(http.historical.items[0]?.reasons).toEqual(["HTTP 503"]);

    const data = { ...mainnetData(), timeout_ms: 20 };
    const slow = await run((m, p) => (m === "block" ? "hang" : mainnet(m, p)), data);
    expect(slow.historical.items[1]?.status).toBe("inconclusive");
    expect(slow.historical.items[1]?.reasons.join(" ")).toContain("timed out after 20 ms");
    const down = await run(() => "hang", data);
    expect(down.chain.status).toBe("error");
    expect(down.chain.reasons).toEqual(["timed out after 20 ms"]);
    expect(down.historical.verdict.status).not.toBe("verified");
  });

  it("never shows a relay after the deadline as rejected by revocation", async () => {
    const late = withResult("block-reject", (b) => {
      (b.header as Record<string, unknown>).timestamp_nanosec = (BigInt(X.deadline_ns) + 1n).toString();
    });
    const r = await run((m, p) => (m === "block" ? late : mainnet(m, p)));
    expect(r.historical.items[1]?.status).toBe("inconclusive");
    expect(r.historical.items[1]?.reasons.join(" ")).toContain("executed after the order deadline");
    expect(r.historical.verdict.status).toBe("inconclusive");
    // At the deadline itself, as classifyRelay in src/live/verify.ts: not after it.
    const atDeadline = withResult("block-reject", (b) => {
      (b.header as Record<string, unknown>).timestamp_nanosec = X.deadline_ns;
    });
    expect((await run((m, p) => (m === "block" ? atDeadline : mainnet(m, p)))).historical.items[1]?.status).toBe("verified");
  });

  it("shows an executed relay as a failed revocation", async () => {
    const executed = withResult("tx-relay-rejected", (t) => {
      t.status = { SuccessValue: "" };
      t.receipts_outcome = [{ id: "SYNTHETICreceiptVerifier", block_hash: "SYNTHETICblockReject", outcome: { executor_id: X.verifier, status: { SuccessValue: "" } } }];
    });
    const r = await run((m, p) => (m === "tx" && p.tx_hash === X.relay_tx_hash ? executed : mainnet(m, p)));
    expect(r.historical.items[1]?.status).toBe("failed");
    expect(r.historical.items[1]?.title).toContain("EXECUTED");
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
    expect(r.historical.items[1]?.status).toBe("inconclusive");
    expect(r.historical.items[1]?.reasons.join(" ")).toContain(reason);
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
    expect(r.historical.items[1]?.status).toBe("inconclusive");
    expect(r.historical.items[1]?.reasons.join(" ")).toContain("not checkable: the evidence records no bundle sha256");
    expect(r.historical.verdict.status).toBe("inconclusive");
  });

  it("lists recorded transactions it cannot query as inconclusive, and counts them", async () => {
    const live = liveEvidence();
    const extra = { label: `owner revoke (${SYN})`, tx_hash: X.grant_tx_hash, outcome: "success" as const, detail: { step: 6 } };
    const data = verifyData(demo(), liveView({ ...live, receipts: [...live.receipts, extra] }));
    expect(data.unverifiable).toEqual([{ label: extra.label, reason: "its sender (signer_id) is not recorded, and the RPC needs it to look the transaction up" }]);
    const r = await run(mainnet, data);
    expect(statuses(r.historical.items)).toEqual(["verified", "inconclusive", "verified"]);
    expect(r.historical.items[1]?.title).toBe(`${extra.label}: inconclusive, not checkable`);
    expect(r.historical.verdict.title).toBe("Not verified: 1 of 3 checks did not hold");
    const html = renderHtml(demo(), { acceptance: null, live: { ...live, receipts: [...live.receipts, extra] } });
    expect(html).toContain("1 recorded transactions to check, 1 more that cannot be checked (shown as inconclusive)");
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
    await vi.waitFor(() => {
      expect(status.text()).toContain("Checked against https://rpc.synthetic.invalid");
    });
    expect(f.mock.calls[0]?.[0]).toBe("https://rpc.synthetic.invalid");
    expect(chain.text()).toContain("Network check: NEAR mainnet");
    expect(historical.text()).toContain("No mainnet receipts yet");
    expect(current.text()).toContain("now equals the verifier WASM the tests ran (current state)");
    expect(button.disabled).toBe(false);
  });
});
