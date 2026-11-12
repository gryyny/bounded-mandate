// gate: REPLAY — the historical replay of the withheld order (SPEC.md "Historical replay of the withheld order"): the
// rules of verify.mjs and of the page's verification panel on the same cases (test/fixtures/replay), each through its
// own transport against a local stub of an archival node. Every chain answer here is SYNTHETIC; nothing is read from
// a real network, and no case shows anything about mainnet.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CaseRecorder } from "../src/evidence/report.js";
import type { Call, ExpectedReplay, FetchFn, ReplayResult } from "../src/page/verify-client.js";
import { clientScript } from "../src/page/verify.js";
import { REPLAY_CASES, REPLAY_ITEMS, expectedStatus, type ReplayCase } from "./fixtures/replay/cases.js";
import { PRECEDING_AT, REMOVAL_AT, REVOKE_INCLUDED_AT, grantKeyRegisteredAt, replayInput, startReplayChain, withheldBundle, type ReplayChain, type ReplayOptions } from "./fixtures/replay/chain.js";

// REPLAY.historical-rules passes only if every check below ran and passed (src/evidence/report.ts).
const evidence = new CaseRecorder("REPLAY", "historical-rules", [
  "cases-cover-the-spec",
  "same-result-per-case",
  "verified-needs-every-item",
  "snapshots-from-the-removal-receipt",
  "exact-relayed-bytes",
  "bounded-retries-then-inconclusive",
  "requests-are-paced",
]);
afterAll(() => {
  evidence.write("unit", {}, { note: "TypeScript test of verify.mjs and the page's browser verifier against a local SYNTHETIC archival RPC stub; no chain, no mainnet" });
});

interface Implementation {
  name: string;
  run(url: string, input: ExpectedReplay, paceMs?: number): Promise<ReplayResult>;
}

interface VerifyModule {
  Rpc: new (url: string, timeoutMs: number, paceMs: number) => { call: Call };
  historicalReplay(call: Call, input: ExpectedReplay): Promise<ReplayResult>;
}
const TIMEOUT_MS = 10_000;

/** verify.mjs: its own Rpc class over Node's fetch (the script is dependency-free JavaScript outside the package). */
const cli: Implementation = {
  name: "verify.mjs",
  run: async (url, input, paceMs = 0) => {
    const mod = (await import(pathToFileURL(join(import.meta.dirname, "../../verify.mjs")).href)) as VerifyModule;
    const rpc = new mod.Rpc(url, TIMEOUT_MS, paceMs);
    return mod.historicalReplay((method, params) => rpc.call(method, params), input);
  },
};

interface Client {
  pacedCall(fetchFn: FetchFn, url: string, timeoutMs: number, paceMs: number): Call;
  historicalReplay(call: Call, input: ExpectedReplay): Promise<ReplayResult>;
}
/** The panel: the exact inline script of the page, evaluated with no document elements, over Node's fetch. */
const panel: Implementation = {
  name: "verification panel",
  run: (url, input, paceMs = 0) => {
    // Evaluating the page's own script text is the point: the tested code is byte-for-byte the inlined code.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function("document", "fetch", `${clientScript()}\nreturn { pacedCall, historicalReplay };`) as (doc: unknown, f: unknown) => Client;
    const client = factory({ getElementById: () => null, createElement: () => null }, () => {
      throw new Error("the bootstrap must not fetch");
    });
    return client.historicalReplay(client.pacedCall((u, init) => fetch(u, init), url, TIMEOUT_MS, paceMs), input);
  },
};
const IMPLEMENTATIONS = [cli, panel] as const;

const chains: ReplayChain[] = [];
afterEach(async () => {
  for (const c of chains.splice(0)) await c.stop();
});
async function chain(o: ReplayOptions): Promise<ReplayChain> {
  const c = await startReplayChain(o);
  chains.push(c);
  return c;
}
/** One implementation on a fresh chain, so a chain that refuses only its first requests starts over. */
async function replay(impl: Implementation, c: ReplayCase, paceMs = 0): Promise<{ result: ReplayResult; chain: ReplayChain }> {
  const served = await chain(c.options);
  return { result: await impl.run(served.url, { ...replayInput(c.options), ...c.input }, paceMs), chain: served };
}
const statuses = (r: ReplayResult): string[] => r.items.map((i) => `${i.id}:${i.status}`);
const byId = (id: string): ReplayCase => {
  const c = REPLAY_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no replay case ${id}`);
  return c;
};
const atSnapshot = (c: ReplayChain) => c.log.filter((x) => x.method === "query" && typeof x.params.block_id === "string");

describe("historical replay of the withheld order: shared cases (SYNTHETIC chain)", () => {
  // gate: REPLAY
  it("the cases cover every case the spec lists, with unique ids", () =>
    evidence.check("cases-cover-the-spec", () => {
      const ids = REPLAY_CASES.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      // SPEC.md "Also require": the verified result; an altered bundle; a bundle not bound to a signed-order event;
      // another key; the inclusion block or any other wrong snapshot; an expired order; a changed code hash; a relay
      // that did not fail for that key; unavailable archival state.
      const required: [string, "verified" | "failed" | "inconclusive"][] = [
        ["verified", "verified"],
        ["altered-bundle", "failed"],
        ["unbound-order", "failed"],
        ["another-key", "failed"],
        ["inclusion-block", "failed"],
        ["one-block-late", "failed"],
        ["expired-order", "failed"],
        ["mandate-code-changed", "failed"],
        ["verifier-code-changed", "failed"],
        ["relay-other-key", "failed"],
        ["relay-other-error", "failed"],
        ["pruned-state", "inconclusive"],
        ["rate-limited", "inconclusive"],
      ];
      for (const [id, status] of required) expect([id, expectedStatus(byId(id))]).toEqual([id, status]);
      // Every rule of the spec's list is contradicted by at least one case.
      for (const item of REPLAY_ITEMS) expect(REPLAY_CASES.some((c) => c.contradicts.includes(item))).toBe(true);
    }));

  // The inclusion-block case separates the two boundaries: the state changes across the block that included the revoke
  // transaction and is the same on both sides of the block in which the removal receipt executed.
  // gate: REPLAY
  it("the inclusion-block case would pass at the inclusion block and does not at the removal receipt's block", () => {
    const o = byId("inclusion-block").options;
    expect([grantKeyRegisteredAt(o, REVOKE_INCLUDED_AT - 1), grantKeyRegisteredAt(o, REVOKE_INCLUDED_AT)]).toEqual([true, false]);
    expect([grantKeyRegisteredAt(o, PRECEDING_AT), grantKeyRegisteredAt(o, REMOVAL_AT)]).toEqual([false, false]);
    expect([grantKeyRegisteredAt({}, PRECEDING_AT), grantKeyRegisteredAt({}, REMOVAL_AT)]).toEqual([true, false]);
  });

  const outcomes = new Map<string, string[]>();
  // gate: REPLAY
  it.each(REPLAY_CASES.map((c) => [c.id, c] as const))("%s: both implementations return the result the rules give", async (_id, c) => {
    const expected = expectedStatus(c);
    const results: ReplayResult[] = [];
    for (const impl of IMPLEMENTATIONS) {
      const { result } = await replay(impl, c);
      const what = `${impl.name} on ${c.id} (${c.shows})`;
      expect([what, result.status]).toEqual([what, expected]);
      expect(result.items.map((i) => i.id)).toEqual([...REPLAY_ITEMS]);
      // Each rule the case's chain contradicts is reported as failed, with a reason.
      for (const id of c.contradicts) {
        const item = result.items.find((i) => i.id === id);
        expect([what, id, item?.status]).toEqual([what, id, "failed"]);
        expect(item?.reasons.length).toBeGreaterThan(0);
      }
      if (expected === "verified") expect(statuses(result)).toEqual(REPLAY_ITEMS.map((id) => `${id}:verified`));
      if (expected === "inconclusive") {
        expect(result.items.filter((i) => i.status === "failed")).toEqual([]);
        expect(result.items.some((i) => i.status === "inconclusive" && i.reasons.length > 0)).toBe(true);
      }
      // Nothing that is not verified is ever reported without a reason.
      for (const i of result.items) expect(i.status === "verified" ? i.reasons : i.reasons.length > 0).toEqual(i.status === "verified" ? [] : true);
      results.push(result);
    }
    const [a, b] = results;
    if (a === undefined || b === undefined) throw new Error("both implementations must have run");
    expect(statuses(b)).toEqual(statuses(a));
    expect(b.status).toBe(a.status);
    outcomes.set(c.id, [a.status, b.status]);
  });

  // gate: REPLAY
  it("every case ran through both implementations with the same result", () =>
    evidence.check("same-result-per-case", () => {
      expect([...outcomes.keys()].sort()).toEqual(REPLAY_CASES.map((c) => c.id).sort());
      for (const c of REPLAY_CASES) expect([c.id, ...(outcomes.get(c.id) ?? [])]).toEqual([c.id, expectedStatus(c), expectedStatus(c)]);
    }));

  // gate: REPLAY
  it("the verified result needs every item: each single contradiction or unserved read takes it away", () =>
    evidence.check("verified-needs-every-item", () => {
      const verified = REPLAY_CASES.filter((c) => expectedStatus(c) === "verified");
      expect(verified.every((c) => c.contradicts.length === 0 && !c.unserved)).toBe(true);
      for (const c of REPLAY_CASES.filter((x) => x.contradicts.length > 0 || x.unserved)) expect([c.id, outcomes.get(c.id)?.includes("verified")]).toEqual([c.id, false]);
    }));

  // gate: REPLAY
  it("state is read only at the block in which the removal receipt executed and at its prev_hash, never at the inclusion block", () =>
    evidence.check("snapshots-from-the-removal-receipt", async () => {
      for (const impl of IMPLEMENTATIONS) {
        const { result, chain: served } = await replay(impl, byId("verified"));
        expect(result.status).toBe("verified");
        const blocks = [...new Set(atSnapshot(served).map((x) => x.params.block_id))].sort();
        expect(blocks).toEqual([`block-${String(PRECEDING_AT)}`, `block-${String(REMOVAL_AT)}`]);
        expect(REVOKE_INCLUDED_AT).toBeLessThan(PRECEDING_AT);
        // At each snapshot: the key's registration, the simulation, and both accounts.
        for (const h of [PRECEDING_AT, REMOVAL_AT]) {
          const reads = atSnapshot(served).filter((x) => x.params.block_id === `block-${String(h)}`).map((x) => (typeof x.params.method_name === "string" ? x.params.method_name : `${String(x.params.request_type)} ${String(x.params.account_id)}`));
          expect(reads.sort()).toEqual(["has_public_key", "simulate_intents", "view_account intents.near", "view_account mandate.synthetic.near"]);
        }
        expect(Object.fromEntries(result.facts)["Removal snapshot"]).toContain(`block ${String(REMOVAL_AT)} (block-${String(REMOVAL_AT)})`);
        expect(Object.fromEntries(result.facts)["Preceding snapshot"]).toContain(`block ${String(PRECEDING_AT)} (block-${String(PRECEDING_AT)})`);
      }
    }));

  // gate: REPLAY
  it("simulates the exact argument bytes of the relay transaction at both snapshots", () =>
    evidence.check("exact-relayed-bytes", async () => {
      const relayed = Buffer.from(JSON.stringify({ signed: withheldBundle() })).toString("base64");
      for (const impl of IMPLEMENTATIONS) {
        const { chain: served } = await replay(impl, byId("verified"));
        const simulated = atSnapshot(served).filter((x) => x.params.method_name === "simulate_intents");
        expect(simulated.map((x) => [x.params.account_id, x.params.args_base64])).toEqual([
          ["intents.near", relayed],
          ["intents.near", relayed],
        ]);
      }
    }));

  // gate: REPLAY
  it("a rate-limited read is retried a bounded number of times, then the replay is inconclusive", () =>
    evidence.check("bounded-retries-then-inconclusive", async () => {
      for (const impl of IMPLEMENTATIONS) {
        const always = await replay(impl, byId("rate-limited"));
        expect(always.result.status).toBe("inconclusive");
        // One request and three retries per snapshot, no more.
        expect(atSnapshot(always.chain).filter((x) => x.params.method_name === "simulate_intents")).toHaveLength(8);
        expect(always.result.items.flatMap((i) => i.reasons).join(" ")).toContain("HTTP 429 on each of 4 attempts");
        const twice = await replay(impl, byId("rate-limited-then-served"));
        expect(twice.result.status).toBe("verified");
        expect(atSnapshot(twice.chain).filter((x) => x.params.method_name === "simulate_intents")).toHaveLength(4);
      }
    }));

  // gate: REPLAY
  it("requests are at least the pace apart, one at a time", () =>
    evidence.check("requests-are-paced", async () => {
      const PACE_MS = 25;
      for (const impl of IMPLEMENTATIONS) {
        const { result, chain: served } = await replay(impl, byId("verified"), PACE_MS);
        expect(result.status).toBe("verified");
        const times = served.log.map((x) => x.at);
        expect(times.length).toBeGreaterThan(10);
        expect(served.concurrency()).toBe(1);
        // Request n leaves no earlier than n paces after the first. The stub stamps arrival, so the first stamp may
        // be late by the time one local request takes; the last cannot be early.
        const span = (times.at(-1) ?? 0) - (times[0] ?? 0);
        expect(span).toBeGreaterThanOrEqual((times.length - 1) * PACE_MS - 100);
      }
    }));
});
