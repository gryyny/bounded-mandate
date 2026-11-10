// gate: LIVE — the runner's reports (no network): every session's report is preserved under its manifest's ledger and
// never written over, the latest copy stays where the page and the verifier read it, and every report records the
// manifest's step kinds. Preflight is replaced by a labelled offline fixture; the client is a fake with no transport.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ChallengeRecord, runChallenge } from "../src/live/challenge.js";
import { evidenceFile, preserveReport, reportsDir, runLive } from "../src/live/main.js";
import { LiveManifest, loadManifest } from "../src/live/manifest.js";
import type { NearClient } from "../src/near/client.js";
import { DEMO_POLICY } from "../src/demo/market.js";
import { offlineManifest, writeJson } from "./live-helpers.js";
import { record } from "./page-challenge-specimen.js";

vi.mock("../src/live/preflight.js", async (original) => ({
  ...(await original<typeof import("../src/live/preflight.js")>()),
  preflight: ({ manifest: m }: { manifest: LiveManifest }) =>
    Promise.resolve({
      passed: true,
      checks: [{ id: "offline-fixture", passed: true, observed: "SYNTHETIC: preflight replaced in this test" }],
      facts: { chain_id: m.network.chain_id, genesis_hash: m.network.genesis_hash, gas_price: "1", storage_amount_per_byte: "1", nonces: { owner: "1", agent: "1", filler: "1" }, mandate_balances: { usdc: "0", wnear: "0" }, filler_balances: { usdc: "0", wnear: "0" }, open_orders: [], owner_keys: [{ public_key: m.keys.owner.public_key, permission: "full_access", nonce: "1" }] },
    }),
}));

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bm-live-reports-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Report {
  environment: Record<string, string>;
  unknowns: string[];
  assertions: { id: string }[];
}
const read = (path: string): Report => JSON.parse(readFileSync(path, "utf8")) as Report;

describe("live runner reports", () => {
  // gate: LIVE
  it("keeps every report of every manifest: a later run replaces only the latest copy", async () => {
    const root = tmp();
    const first = offlineManifest(root);
    const state = { fail: false };
    const fake = {
      final: () => fake,
      account: (accountId: string) => ({ accountId }),
      nodeStatus: () => Promise.resolve({ chain_id: first.network.chain_id, genesis_hash: first.network.genesis_hash }),
      gasPrice: () => Promise.resolve(1n),
      view: (_id: string, method: string) => {
        if (state.fail) return Promise.reject(new Error("SYNTHETIC: the second run stops before completing its check"));
        if (method === "get_grant") return Promise.resolve(null);
        if (method === "mt_balance_of") return Promise.resolve("0");
        return Promise.reject(new Error(`unexpected view ${method}`));
      },
      accessKeyNonce: () => Promise.resolve(1n),
      accessKeys: () => Promise.resolve([{ public_key: first.keys.owner.public_key, nonce: 1n, permission: { kind: "full" } }]),
    };
    const outRoot = join(root, "live");
    const deps = { client: fake as unknown as NearClient, outRoot };
    const latest = evidenceFile(outRoot, "sandbox");
    const env = (path: string, extra: Record<string, string> = {}) => ({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path, ...extra });

    const p1 = writeJson(root, "first.json", first);
    const sha1 = loadManifest(env(p1)).sha256;
    const r1 = await runLive(env(p1), deps);
    expect([r1.exitCode, r1.message]).toEqual([0, "completed"]);
    const firstBytes = readFileSync(latest, "utf8");
    expect(r1.reportPath).toBe(join(reportsDir(join(outRoot, sha1)), "0001.json"));
    expect(readFileSync(r1.reportPath ?? "", "utf8")).toBe(firstBytes);
    expect(read(latest).environment.manifest_steps).toBe("check");

    // Another manifest of the same kind (separately approved, so another sha256), and its run stops.
    const second: LiveManifest = { ...first, approval: { ...first.approval, reference: "separately approved second attempt" }, steps: [{ kind: "check" }, { kind: "grant", policy: DEMO_POLICY }, { kind: "check" }] };
    const p2 = writeJson(root, "second.json", second);
    const sha2 = loadManifest(env(p2)).sha256;
    expect(sha2).not.toBe(sha1);
    state.fail = true;
    const r2 = await runLive(env(p2), deps);
    expect(r2.exitCode).toBe(1);
    const secondBytes = readFileSync(latest, "utf8");
    // The latest copy is the second run's (the page, the verifier and the docs read this path) ...
    expect(read(latest).environment.manifest_sha256).toBe(sha2);
    expect(read(latest).unknowns).toHaveLength(1);
    // ... every step kind of the manifest is recorded in manifest order, although the run stopped at step 1 ...
    expect(read(latest).environment.manifest_steps).toBe("check,grant,check");
    expect(read(latest).assertions.filter((a) => a.id.startsWith("step-"))).toEqual([]);
    // ... and the first run's report, which the latest copy no longer holds, is intact under its own manifest.
    expect(secondBytes).not.toBe(firstBytes);
    expect(readFileSync(join(outRoot, sha1, "reports", "0001.json"), "utf8")).toBe(firstBytes);
    expect(r2.reportPath).toBe(join(outRoot, sha2, "reports", "0001.json"));
    expect(readFileSync(r2.reportPath ?? "", "utf8")).toBe(secondBytes);

    // A resume of the second manifest is another attempt: a new report beside the stopped one, which stays.
    state.fail = false;
    const r3 = await runLive(env(p2, { MANDATE_LIVE_RESUME: "1" }), deps);
    expect(r3.exitCode).toBe(1); // step 2 (grant) cannot be sent through the fake client
    expect(r3.reportPath).toBe(join(outRoot, sha2, "reports", "0002.json"));
    expect(readFileSync(join(outRoot, sha2, "reports", "0001.json"), "utf8")).toBe(secondBytes);
    expect(readFileSync(r3.reportPath ?? "", "utf8")).toBe(readFileSync(latest, "utf8"));
    expect(read(latest).assertions.filter((a) => a.id.startsWith("step-")).map((a) => a.id)).toEqual(["step-1-check"]);
    expect(readdirSync(join(outRoot, sha1, "reports"))).toEqual(["0001.json"]);
    expect(readdirSync(join(outRoot, sha2, "reports")).sort()).toEqual(["0001.json", "0002.json"]);
    // Only the latest copy lives in the evidence directory.
    expect(readdirSync(join(root, "evidence"))).toEqual(["live-sandbox.json"]);
  });

  // gate: LIVE
  it("a failed challenge opening keeps another mandate's record aside instead of inheriting or losing it", async () => {
    const root = tmp();
    const tpl = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.open-challenge.example.json"), "utf8")) as { budget: LiveManifest["budget"]; gas_tgas: LiveManifest["gas_tgas"]; steps: unknown[] };
    const m = offlineManifest(root, { budget: tpl.budget, gas_tgas: tpl.gas_tgas, agent_key_published: true, steps: LiveManifest.shape.steps.parse(tpl.steps) });
    const fake = {
      final: () => fake,
      account: (accountId: string) => ({ accountId }),
      provider: { viewBlock: () => Promise.resolve({ header: { height: 100, hash: "SYNTHETICblock100", timestamp_nanosec: "100" } }) },
      nodeStatus: () => Promise.resolve({ chain_id: m.network.chain_id, genesis_hash: m.network.genesis_hash }),
      view: (_id: string, method: string) => {
        if (method === "get_grant") return Promise.resolve(null);
        if (method === "list_orders") return Promise.resolve([]);
        if (method === "mt_balance_of") return Promise.resolve("0");
        return Promise.reject(new Error(`unexpected view ${method}`));
      },
      accessKeyNonce: () => Promise.resolve(1n),
      accessKeys: () => Promise.resolve([{ public_key: m.keys.owner.public_key, nonce: 1n, permission: { kind: "full" } }]),
    };
    // Another mandate's closed challenge is the record on disk (SYNTHETIC specimen).
    const outRoot = join(root, "challenge", "live");
    const recordPath = join(root, "challenge", "evidence", "challenge-sandbox.json");
    mkdirSync(join(root, "challenge", "evidence"), { recursive: true });
    const earlier = `${JSON.stringify(record("closed"), null, 2)}\n`;
    writeFileSync(recordPath, earlier);
    // The open stops at its grant step: the fake client has no way to send anything.
    const r = await runChallenge({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(root, "open.json", m) }, { client: fake as unknown as NearClient, outRoot });
    expect(r.exitCode).toBe(1);
    expect(r.evidence?.receipts).toEqual([]);
    expect(r.evidence?.environment.manifest_steps).toBe("check,grant,check");
    const rec = ChallengeRecord.parse(JSON.parse(readFileSync(recordPath, "utf8")));
    expect([rec.status, rec.opened, rec.grant, rec.accounts.mandate]).toEqual(["not-opened", null, null, m.accounts.mandate]);
    expect(rec.previous_record_ignored?.join("; ")).toContain(`mandate account was ${record("closed").accounts.mandate}, this manifest's is ${m.accounts.mandate}`);
    const kept = join(root, "challenge", "evidence", "replaced", "challenge-sandbox-1.json");
    expect(readFileSync(kept, "utf8")).toBe(earlier);
    expect(r.message).toContain(`challenge: the earlier record was not carried forward (${rec.previous_record_ignored?.join("; ") ?? ""}); it is kept as ${kept}`);
    expect(existsSync(r.reportPath ?? "")).toBe(true);
  });

  // gate: LIVE
  it("creates each preserved report exclusively and never writes over a file that is already there", () => {
    const ledgerDir = join(tmp(), "ledger");
    expect(existsSync(reportsDir(ledgerDir))).toBe(false);
    // A file already sits where the count-based name would land.
    mkdirSync(reportsDir(ledgerDir), { recursive: true });
    writeFileSync(join(reportsDir(ledgerDir), "0002.json"), "EARLIER");
    const a = preserveReport(ledgerDir, "A");
    const b = preserveReport(ledgerDir, "B");
    expect([a, b]).toEqual([join(reportsDir(ledgerDir), "0003.json"), join(reportsDir(ledgerDir), "0004.json")]);
    expect(readFileSync(join(reportsDir(ledgerDir), "0002.json"), "utf8")).toBe("EARLIER");
    expect([readFileSync(a, "utf8"), readFileSync(b, "utf8")]).toEqual(["A", "B"]);
    // Control: an empty ledger directory starts at 0001.
    const fresh = join(tmp(), "ledger");
    expect(preserveReport(fresh, "C")).toBe(join(reportsDir(fresh), "0001.json"));
  });
});
