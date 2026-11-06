// gate: AGENT — the no-transaction provider rehearsal: stub providers only (a SYNTHETIC answer or NearAiProvider over
// a mocked fetch); no real provider call, no credential, no chain. Records are integrity-checked, keep planned and
// observed inventory apart, and cannot reach a transaction path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/agent/decision.js";
import type { FreshObservations } from "../src/agent/objective.js";
import { BUDGETED_PROMPT_VERSION } from "../src/agent/prompt.js";
import { NearAiProvider } from "../src/agent/providers.js";
import { rehearsalInput, rehearsalProvider } from "../src/agent/rehearse.js";
import {
  NO_APPROVAL,
  RehearsalRefusal,
  StubProvider,
  canonicalJson,
  rehearse,
  verifyRehearsal,
  writeRehearsal,
  type RehearsalInput,
  type RehearsalProvider,
  type RehearsalRecord,
} from "../src/agent/rehearsal.js";
import { CaseRecorder } from "../src/evidence/report.js";
import type { Asset } from "../src/types.js";
import { DECIMALS, ONE_USD_PRICE, SyntheticProvider, USDC, WNEAR, grantFor, priceObs, proposeJson, saleBudget } from "./agent-live-helpers.js";

// AGENT.rehearsal passes only if every check below ran and passed (src/evidence/report.ts).
const evidence = new CaseRecorder("AGENT", "rehearsal", [
  "stub-timeout",
  "wrong-model-id",
  "invalid-output",
  "decline",
  "valid-proposal",
  "balanced-no-call",
  "record-integrity",
  "planned-vs-observed",
  "real-provider-needs-approval",
  "qualification",
  "no-transaction-path",
  "cli-stub-run",
]);

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bm-rehearsal-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  evidence.write("unit", {}, { note: "TypeScript unit test of the agent rehearsal; stub providers only, no VM, chain or model" });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOOLS = resolve(import.meta.dirname, "..");
const prices = { usdc: priceObs("usdc", ONE_USD_PRICE), wnear: priceObs("wnear", 3n * ONE_USD_PRICE) };
const reading = (asset: Asset, mantissa: bigint) => ({ price_id: prices[asset].price_id, max_age_sec: 60, price: mantissa.toString(), conf: "1000", expo: -8, publish_time: 1_000, age_sec: 10 });
// Observed: $1000 USDC vs $600 wNEAR (USDC-heavy, 200 USDC needed). Planned (approved): 1000 USDC + 250 wNEAR.
const observations = (balances: Record<Asset, bigint> = { usdc: 1_000n * USDC, wnear: 200n * WNEAR }): FreshObservations => ({
  block: { height: 77, hash: "synthetic-block-hash", timestamp_ns: "1010000000000" },
  grant: grantFor(balances, prices),
  balances: { usdc: balances.usdc.toString(), wnear: balances.wnear.toString() },
  prices: { usdc: reading("usdc", ONE_USD_PRICE), wnear: reading("wnear", 3n * ONE_USD_PRICE) },
  read_errors: [],
});
const PLANNED = { usdc: 1_000n * USDC, wnear: 250n * WNEAR };
const input = (obs = observations()): RehearsalInput => ({
  observations: obs,
  decimals: DECIMALS,
  notes: ["synthetic market note"],
  sale_budget: saleBudget([200n * USDC, 400n * USDC], [50n * WNEAR, 100n * WNEAR]),
  sale_budget_source: "test",
  planned_inventory: { source: "synthetic approval", units: { usdc: PLANNED.usdc.toString(), wnear: PLANNED.wnear.toString() } },
});

const KEY = "sk-synthetic-rehearsal-key";
const MODEL = "synthetic/model-id";
const completion = (content: string, model = MODEL) => JSON.stringify({ model, choices: [{ message: { content }, finish_reason: "stop" }] });
/** NearAiProvider over a mocked fetch: the live parsing and validation path, with a STUB transport. */
const stubNearAi = (fetchImpl: typeof fetch, timeoutMs = 5_000): RehearsalProvider => ({
  provider: new NearAiProvider({ model: MODEL, timeoutMs, maxTokens: 500 }, KEY, fetchImpl),
  class: "stub",
  requested_model: MODEL,
});
const answering = (body: string, status = 200): typeof fetch => () => Promise.resolve(new Response(body, { status }));
const synthetic = (answer: string): RehearsalProvider => ({ provider: new SyntheticProvider(answer), class: "stub", requested_model: "synthetic" });

/** Re-seals a (possibly altered) record with a correct integrity hash, as a tamperer could. */
const resealed = (r: RehearsalRecord): string => {
  const body: Partial<RehearsalRecord> = { ...r };
  delete body.integrity;
  return JSON.stringify({ ...body, integrity: { algorithm: "sha256/canonical-json", sha256: sha256Hex(canonicalJson(body)) } });
};

const roundTrip = (rec: RehearsalRecord): RehearsalRecord => {
  const { path } = writeRehearsal(tmp(), rec);
  const text = readFileSync(path, "utf8");
  expect(text).not.toContain(KEY);
  return verifyRehearsal(text);
};

describe("rehearsal outcomes (stub providers)", () => {
  // gate: AGENT
  it("a provider timeout is a provider rejection; one attempt, no transaction", () =>
    evidence.check("stub-timeout", async () => {
      let attempts = 0;
      const hang: typeof fetch = (_url, init) => {
        attempts += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("synthetic abort"));
          });
        });
      };
      const rec = await rehearse(input(), stubNearAi(hang, 50));
      expect(attempts).toBe(1);
      expect(rec.transaction).toBe("none");
      expect(rec.verdict).toEqual({ kind: "rejected", boundary: "provider", problems: [`near-ai: no complete response within 50 ms (aborted)`] });
      expect(rec).toMatchObject({ model_called: true, raw_output: null, provider_error: "near-ai: no complete response within 50 ms (aborted)", qualifies_live_provider: false });
      expect(rec.request_body_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(roundTrip(rec)).toEqual(rec);
    }));

  // gate: AGENT
  it("a reply naming a different model is rejected as a fallback", () =>
    evidence.check("wrong-model-id", async () => {
      const body = completion(proposeJson("usdc", 150n * USDC), "synthetic/other-model");
      const rec = await rehearse(input(), stubNearAi(answering(body)));
      expect(rec.verdict).toEqual({ kind: "rejected", boundary: "provider", problems: [`response reports model synthetic/other-model, requested ${MODEL}`] });
      expect(rec.provider).toMatchObject({ requested_model: MODEL, reported_model: "synthetic/other-model" });
      expect(rec.raw_output).toBe(body);
      expect(rec.raw_output_sha256).toBe(sha256Hex(body));
      expect(roundTrip(rec)).toEqual(rec);
    }));

  // gate: AGENT
  it("invalid output is rejected at the adapter schema, an over-budget proposal at the objective", () =>
    evidence.check("invalid-output", async () => {
      for (const text of ["propose usdc 1", JSON.stringify({ action: "propose", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 1, recipient: "evil.near" }, reason: "x" })]) {
        const rec = await rehearse(input(), stubNearAi(answering(completion(text))));
        expect(rec.verdict).toMatchObject({ kind: "rejected", boundary: "adapter-schema" });
        expect(rec.qualifies_live_provider).toBe(false);
        expect(roundTrip(rec)).toEqual(rec);
      }
      // 200 USDC needed and per-order budget 200 USDC: 200 USDC + 1 is over budget, rejected not clipped.
      const over = await rehearse(input(), synthetic(proposeJson("usdc", 200n * USDC + 1n)));
      expect(over.verdict).toEqual({ kind: "rejected", boundary: "objective", problems: [`sells ${200n * USDC + 1n} units of usdc, above the runner's per-order sale budget ${200n * USDC}`] });
      expect(over.pre_signing_check).toBeNull();
    }));

  // gate: AGENT
  it("a decline is a recorded no-action", () =>
    evidence.check("decline", async () => {
      const rec = await rehearse(input(), stubNearAi(answering(completion(JSON.stringify({ action: "decline", proposal: null, reason: "synthetic decline" })))));
      expect(rec.verdict).toEqual({ kind: "no-action", reason: "model-declined", detail: "synthetic decline" });
      expect(rec.adapter_verdict).toEqual({ kind: "decline", reason: "synthetic decline" });
      expect(roundTrip(rec)).toEqual(rec);
    }));

  // gate: AGENT
  it("a valid proposal is validated as live would, with the pre-signing checks on the same observations", () =>
    evidence.check("valid-proposal", async () => {
      const rec = await rehearse(input(), stubNearAi(answering(completion(proposeJson("usdc", 150n * USDC)))));
      expect(rec.verdict).toEqual({ kind: "proposal", proposal: { sell: "usdc", sell_amount: (150n * USDC).toString(), max_concession_bps: 30 }, reason: "synthetic rebalance" });
      expect(rec.pre_signing_check).toEqual({ observations: "same as decision", problems: [] });
      expect(rec.prompt?.version).toBe(BUDGETED_PROMPT_VERSION);
      expect(rec.prompt?.user).toContain('"runner_sale_budget"');
      expect(rec.provider).toEqual({ name: "near-ai", class: "stub", requested_model: MODEL, reported_model: MODEL, harness_note: expect.stringContaining("NEAR AI Cloud") as unknown });
      expect(rec.transaction).toBe("none");
      expect(rec.timing.duration_ms).toBe(Date.parse(rec.timing.finished_at) - Date.parse(rec.timing.started_at));
      expect(roundTrip(rec)).toEqual(rec);
      // A price that has aged since keeps the decision but fails the live pre-signing margin (min_remaining_sec + 15 s).
      const aged = observations();
      aged.prices.usdc = { ...reading("usdc", ONE_USD_PRICE), age_sec: 31 };
      const late = await rehearse(input(aged), synthetic(proposeJson("usdc", 150n * USDC)));
      expect(late.verdict.kind).toBe("proposal");
      expect(late.pre_signing_check?.problems).toEqual(["usdc: price has 29 s of its 60 s maximum age left, below the 30 s margin (min_remaining_sec + 15)"]);
    }));

  // gate: AGENT
  it("within 2 points of 50/50 the provider is not called; stale inputs are refused without a call", () =>
    evidence.check("balanced-no-call", async () => {
      const p = new SyntheticProvider(proposeJson("usdc", USDC));
      const rp: RehearsalProvider = { provider: p, class: "stub", requested_model: "synthetic" };
      const balanced = await rehearse(input(observations({ usdc: 520n * USDC, wnear: 160n * WNEAR })), rp);
      expect(balanced.verdict).toMatchObject({ kind: "no-action", reason: "balanced" });
      const stale = observations();
      stale.prices.wnear = { ...reading("wnear", 3n * ONE_USD_PRICE), age_sec: 61 };
      const refused = await rehearse(input(stale), rp);
      expect(refused.verdict).toMatchObject({ kind: "rejected", boundary: "inputs" });
      expect(p.calls).toBe(0);
      for (const rec of [balanced, refused]) {
        expect(rec).toMatchObject({ model_called: false, prompt: null, raw_output: null, qualifies_live_provider: false });
        expect(roundTrip(rec)).toEqual(rec);
      }
    }));
});

describe("rehearsal record", () => {
  // gate: AGENT
  it("detects tampering: a changed byte, and a re-sealed record whose verdict or claim does not follow from its inputs", () =>
    evidence.check("record-integrity", async () => {
      const rec = await rehearse(input(), synthetic(proposeJson("usdc", 150n * USDC)));
      const { path } = writeRehearsal(tmp(), rec);
      const text = readFileSync(path, "utf8");
      expect(verifyRehearsal(text)).toEqual(rec);
      expect(() => verifyRehearsal(text.replace(`"sell_amount": "${(150n * USDC).toString()}"`, `"sell_amount": "${(160n * USDC).toString()}"`))).toThrow(/integrity sha256/);
      expect(() => verifyRehearsal(text.replace('"height": 77', '"height": 78'))).toThrow(/integrity sha256/);
      const reseal = (mutate: (r: RehearsalRecord) => RehearsalRecord): string => resealed(mutate(structuredClone(rec)));
      expect(verifyRehearsal(reseal((r) => r))).toEqual(rec);
      expect(() => verifyRehearsal(reseal((r) => ({ ...r, verdict: { kind: "no-action", reason: "model-declined", detail: "forged" } })))).toThrow(/verdict differs/);
      expect(() => verifyRehearsal(reseal((r) => ({ ...r, qualifies_live_provider: true })))).toThrow(/only an approved real call/);
      expect(() => verifyRehearsal(reseal((r) => ({ ...r, sale_budget: saleBudget([999n * USDC, 999n * USDC], [0n, 0n]) })))).toThrow(/snapshot or prompt differs/);
      expect(() => verifyRehearsal(reseal((r) => ({ ...r, raw_output: `${r.raw_output ?? ""} ` })))).toThrow(/raw output hash/);
      // The writer never overwrites a record.
      expect(() => writeRehearsal(dirname(path), rec)).toThrow(/EEXIST/);
    }));

  // gate: AGENT
  it("keeps planned (approved) inventory apart from observed chain balances", () =>
    evidence.check("planned-vs-observed", async () => {
      const rec = await rehearse(input(), synthetic(proposeJson("usdc", 150n * USDC)));
      expect(rec.inventory.planned).toEqual({ source: "synthetic approval", units: { usdc: PLANNED.usdc.toString(), wnear: PLANNED.wnear.toString() } });
      expect(rec.inventory.observed).toEqual({
        source: "mandate verifier balances in the given chain observations",
        block: { height: 77, hash: "synthetic-block-hash" },
        units: { usdc: (1_000n * USDC).toString(), wnear: (200n * WNEAR).toString() },
      });
      expect(rec.inventory.observed_minus_planned).toEqual({ usdc: "0", wnear: (-50n * WNEAR).toString() });
      // The decision uses observed balances only: 200 USDC needed at $1000 vs $600 observed, not the planned $750.
      expect(rec.allocation?.needed_units).toBe((200n * USDC).toString());
      const bad = { ...rec, inventory: { ...rec.inventory, observed: { ...rec.inventory.observed, units: rec.inventory.planned.units } } };
      expect(() => verifyRehearsal(resealed(bad))).toThrow(/observed wnear inventory is not the observed balance/);
    }));
});

describe("paid inference and qualification", () => {
  // gate: AGENT
  it("a real provider refuses to run without explicit approval; the CLI reads no key without it", () =>
    evidence.check("real-provider-needs-approval", async () => {
      const p = new SyntheticProvider(proposeJson("usdc", 150n * USDC));
      await expect(rehearse(input(), { provider: p, class: "real", requested_model: MODEL }, NO_APPROVAL)).rejects.toThrow(RehearsalRefusal);
      await expect(rehearse(input(), { provider: p, class: "real", requested_model: MODEL }, { approved: true, reference: " " })).rejects.toThrow(/needs a reference/);
      expect(p.calls).toBe(0);
      const read: string[] = [];
      const target: NodeJS.ProcessEnv = { NEAR_AI_API_KEY: KEY };
      const env = new Proxy(target, {
        get: (t, key): string | undefined => {
          if (typeof key !== "string") return undefined;
          read.push(key);
          return t[key];
        },
      });
      const args = { provider: "near-ai", model: MODEL, "timeout-ms": "30000", "max-tokens": "500" };
      expect(() => rehearsalProvider(args, env)).toThrow(/paid inference/);
      expect(() => rehearsalProvider({ ...args, "approve-paid-inference": true }, env)).toThrow(/paid inference/);
      expect(() => rehearsalProvider({ ...args, "approval-reference": "owner said so" }, env)).toThrow(/paid inference/);
      expect(() => rehearsalProvider({ provider: "anthropic" }, env)).toThrow(/unknown provider/);
      expect(() => rehearsalProvider({ provider: "stub", "approve-paid-inference": true }, env)).toThrow(/only to a real provider/);
      expect(read).toEqual([]);
      // With approval the real provider is constructed (no call is made here) and the key is read only then.
      const approved = rehearsalProvider({ ...args, "approve-paid-inference": true, "approval-reference": "synthetic approval ref" }, env);
      expect(approved.rp.class).toBe("real");
      expect(approved.approval).toEqual({ approved: true, reference: "synthetic approval ref" });
      expect(read).toContain("NEAR_AI_API_KEY");
      expect(JSON.stringify(approved)).not.toContain(KEY);
    }));

  // gate: AGENT
  it("only an approved real call answered by the requested model with a valid decision qualifies a live provider", () =>
    evidence.check("qualification", async () => {
      const stub = await rehearse(input(), stubNearAi(answering(completion(proposeJson("usdc", 150n * USDC)))));
      expect(stub.qualifies_live_provider).toBe(false);
      expect(stub.qualification).toMatch(/^STUB provider/);
      // Rule test only: a mocked transport flagged "real" by the caller. The CLI flags only NearAiProvider over the
      // global fetch as real; this record is never written as evidence.
      const approval = { approved: true, reference: "synthetic approval ref" };
      const flagged = (body: string): RehearsalProvider => ({ ...stubNearAi(answering(body)), class: "real" });
      const ok = await rehearse(input(), flagged(completion(proposeJson("usdc", 150n * USDC))), approval);
      expect(ok).toMatchObject({ qualifies_live_provider: true, paid_inference_approval: approval });
      expect(verifyRehearsal(JSON.stringify(ok))).toEqual(ok);
      const declined = await rehearse(input(), flagged(completion(JSON.stringify({ action: "decline", proposal: null, reason: "d" }))), approval);
      expect(declined.qualifies_live_provider).toBe(true);
      for (const body of [completion(proposeJson("usdc", 150n * USDC), "synthetic/other-model"), completion("not json"), JSON.stringify({ model: MODEL, choices: [{ message: { content: "{" }, finish_reason: "length" }] })]) {
        expect((await rehearse(input(), flagged(body), approval)).qualifies_live_provider).toBe(false);
      }
      expect((await rehearse(input(observations({ usdc: 520n * USDC, wnear: 160n * WNEAR })), flagged(completion(proposeJson("usdc", USDC))), approval)).qualification).toMatch(/no provider call/);
    }));
});

/** Runtime (non-type) imports of a TypeScript module: relative paths resolved to files, bare specifiers as-is. */
function runtimeImports(file: string): { local: string[]; packages: string[] } {
  const text = readFileSync(file, "utf8");
  const specs = [
    ...[...text.matchAll(/^\s*(?:import|export)(?!\s+type\b)[^;"']*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1]),
    ...[...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ].filter((s): s is string => s !== undefined);
  const local = specs.filter((s) => s.startsWith(".")).map((s) => resolve(dirname(file), s.replace(/\.js$/, ".ts")));
  return { local, packages: specs.filter((s) => !s.startsWith(".")) };
}

function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [resolve(entry)];
  for (let f = todo.pop(); f !== undefined; f = todo.pop()) {
    if (files.has(f)) continue;
    if (!existsSync(f)) throw new Error(`unresolved import ${f}`);
    files.add(f);
    const { local, packages: pk } = runtimeImports(f);
    for (const p of pk) packages.add(p);
    todo.push(...local);
  }
  return { files, packages };
}

const SRC = join(TOOLS, "src");
const forbidden = (c: { files: Set<string>; packages: Set<string> }): string[] => [
  ...[...c.files].filter((f) => /\/src\/(near|live|demo|filler|attacks)\//.test(f) || f === join(SRC, "agent/adapter.ts") || f === join(SRC, "agent/rebalance.ts")).map((f) => f.slice(SRC.length + 1)),
  ...[...c.packages].filter((p) => /^(near-api-js|near-sandbox|@near-js\/)/.test(p)),
];

describe("no transaction path", () => {
  // gate: AGENT
  it("neither the rehearsal module nor its CLI imports a chain client, signer, key store or the live runner", () =>
    evidence.check("no-transaction-path", () => {
      const rehearsal = closure(join(SRC, "agent/rehearsal.ts"));
      const cli = closure(join(SRC, "agent/rehearse.ts"));
      // The walk is not vacuous: it reaches the decision code it must reach.
      for (const f of ["agent/objective.ts", "agent/decision.ts", "agent/prompt.ts", "agent/snapshot.ts", "types.ts"]) expect(rehearsal.files).toContain(join(SRC, f));
      expect(cli.files).toContain(join(SRC, "agent/providers.ts"));
      expect(forbidden(rehearsal)).toEqual([]);
      expect(forbidden(cli)).toEqual([]);
      // Control: the detector does flag the live adapter, which submits propose_order through near-api-js.
      expect(forbidden(closure(join(SRC, "agent/adapter.ts")))).toEqual(expect.arrayContaining(["agent/adapter.ts", "near/client.ts", "near-api-js"]));
      expect(forbidden(closure(join(SRC, "agent/rebalance.ts")))).toEqual(expect.arrayContaining(["near/contracts.ts"]));
    }));

  // gate: AGENT
  it("the CLI runs a stub rehearsal from files and refuses a real provider without approval (no file written)", () =>
    evidence.check("cli-stub-run", () => {
      const dir = tmp();
      const out = join(dir, "out");
      const state = join(dir, "state.json");
      const manifest = join(dir, "manifest.json");
      const full = input();
      const stateOnly = { observations: full.observations, decimals: full.decimals, notes: full.notes };
      writeFileSync(state, JSON.stringify(stateOnly));
      // Only the caps the rehearsal reads; a synthetic stand-in, not an approved manifest.
      const caps = { usdc: "1000000000", wnear: (250n * WNEAR).toString() };
      writeFileSync(manifest, JSON.stringify({ budget: { owner_inventory_max: caps, max_order_sell: { usdc: (100n * USDC).toString(), wnear: WNEAR.toString() }, max_total_sell: { usdc: (300n * USDC).toString(), wnear: WNEAR.toString() } } }));
      const env = { ...process.env };
      delete env.NEAR_AI_API_KEY;
      delete env.ANTHROPIC_API_KEY;
      const cli = (args: string[]) => spawnSync(join(TOOLS, "node_modules/.bin/tsx"), ["src/agent/rehearse.ts", ...args], { cwd: TOOLS, env, encoding: "utf8" });
      const r = cli(["--state", state, "--manifest", manifest, "--out", out, "--stub-answer", proposeJson("usdc", 100n * USDC)]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      const summary = JSON.parse(r.stdout) as { path: string; integrity_sha256: string; qualifies_live_provider: boolean; transaction: string };
      expect(summary).toMatchObject({ transaction: "none", qualifies_live_provider: false });
      const rec = verifyRehearsal(readFileSync(summary.path, "utf8"));
      expect(rec.integrity.sha256).toBe(summary.integrity_sha256);
      expect(rec.verdict.kind).toBe("proposal");
      expect(rec.sale_budget).toEqual(saleBudget([100n * USDC, 300n * USDC], [WNEAR, WNEAR]));
      expect(rec.sale_budget_source).toMatch(/nothing sold yet/);
      expect(rec.inventory.planned.units).toEqual(caps);
      expect(rec.inventory.planned.source).toMatch(/budget\.owner_inventory_max/);
      expect(rehearsalInput(stateOnly, { path: manifest, text: readFileSync(manifest, "utf8") }).sale_budget).toEqual(rec.sale_budget);
      const refused = cli(["--state", state, "--manifest", manifest, "--out", join(dir, "refused"), "--provider", "near-ai", "--model", MODEL, "--timeout-ms", "30000", "--max-tokens", "500"]);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toMatch(/paid inference/);
      expect(existsSync(join(dir, "refused"))).toBe(false);
      expect(readdirSync(out).length).toBe(1);
      expect(() => rehearsalInput(stateOnly, null)).toThrow(/planned inventory is required/);
    }));
});

describe("stub provider", () => {
  it("is labelled synthetic and declines by default", async () => {
    const s = new StubProvider();
    const rec = await rehearse(input(), { provider: s, class: "stub", requested_model: s.model });
    expect(rec.verdict).toMatchObject({ kind: "no-action", reason: "model-declined" });
    expect(rec.provider).toMatchObject({ name: "synthetic", class: "stub", harness_note: "SYNTHETIC stub provider; not model output" });
  });
});
