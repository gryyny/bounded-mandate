// SYNTHETIC specimens only: every evidence and acceptance object below is built here for testing
// the renderer and is labelled as such; none is a recorded run.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_CASES } from "../src/evidence/required.js";
import { ACCEPTANCE_SCHEMA, type Acceptance, type BaselineOutcome, type CaseResult, type T5Data } from "../src/evidence/schema.js";
import { escapeHtml, renderHtml, renderLegacyBundle, renderPage } from "../src/page/render.js";
import { type Assertion, Evidence, type Receipt } from "../src/types.js";

const REV = "a".repeat(40);
const FIXTURES = { "verifier/defuse-0.4.5.wasm": "e".repeat(64) };
const WASM = { bounded_mandate: "1".repeat(64), bounded_mandate_fault: "2".repeat(64), mock_mpc: "3".repeat(64) };
const repo = resolve(import.meta.dirname, "../..");

const specimen = (over: Partial<Evidence> = {}, source: Partial<Evidence["source"]> = {}): Evidence =>
  Evidence.parse({
    schema_version: 1,
    generated_at: "2026-11-04T00:00:00Z",
    mode: "sandbox",
    source: {
      product_commit: REV,
      dirty: false,
      spec_sha256: "b".repeat(64),
      spec_commit: "c".repeat(40),
      contract_wasm_sha256: WASM.bounded_mandate,
      fixtures: FIXTURES,
      fixture_manifest_sha256: "d".repeat(64),
      wasm_sha256: { bounded_mandate: WASM.bounded_mandate, mock_mpc: WASM.mock_mpc },
      ...source,
    },
    environment: { label: "SYNTHETIC specimen", verifier_wasm_sha256: FIXTURES["verifier/defuse-0.4.5.wasm"] },
    command: "vitest (synthetic specimen)",
    identifiers: { mpc_test_double: "mpc.sandbox", oracle_test_double: "oracle.sandbox" },
    receipts: [],
    assertions: [],
    unknowns: ["SYNTHETIC: nothing here was executed"],
    ...over,
  });

const allCases = (status: CaseResult["status"] = "passed"): CaseResult[] =>
  Object.entries(REQUIRED_CASES).flatMap(([gate, names]) =>
    names.map((name) => ({ id: `${gate}.${name}`, gate, case: name, status, reason: "SYNTHETIC", files: [`${gate}.${name}.json`], mode: "sandbox" })),
  );

const t5 = (outcome: BaselineOutcome, compareGate = "T1"): T5Data => ({
  command: "synthetic",
  hashes: {},
  environment: { label: "SYNTHETIC" },
  baseline: { name: "SYNTHETIC re-implementation", repository: "https://example.invalid/b", commit: "f".repeat(40), license: "MIT", adaptations: ["synthetic"] },
  assertions: [],
  cases: [{ id: "case", threat: "Withheld order after revocation", compare_gate: compareGate, baseline_outcome: outcome, summary: "synthetic", observed: { synthetic: true } }],
});

const acceptance = (over: Partial<Acceptance> = {}): Acceptance => ({
  schema: ACCEPTANCE_SCHEMA,
  run_id: "run-SYNTHETIC",
  revision: REV,
  dirty: false,
  certified: true,
  complete: true,
  started_at: "2026-11-04T00:00:00Z",
  evaluated_at: "2026-11-04T00:10:00Z",
  hashes: { spec_sha256: "b".repeat(64), fixture_manifest_sha256: "d".repeat(64), fixtures: FIXTURES, wasm: WASM },
  environment: { os: "SYNTHETIC" },
  commands: ["make test (SYNTHETIC)"],
  cases: allCases(),
  separate: [],
  problems: [],
  ignored: [],
  baseline: null,
  ...over,
});

const withCase = (id: string, status: CaseResult["status"]): CaseResult[] => allCases().map((c) => (c.id === id ? { ...c, status } : c));
const receipt = (label: string, detail: unknown, over: Partial<Receipt> = {}): Receipt => ({ label, outcome: "success", detail, ...over });
const check = (id: string, gate: string, description: string, observed: unknown = null): Assertion => ({ id, gate, description, passed: true, observed });

const gateStatus = (html: string, gate: string): string | undefined => {
  const label = `<code>${gate}</code>(?:<br><span class="muted">[^<]*</span>)?`;
  const m = new RegExp(`${label}<br><span class="status ([a-z-]+)">|${label}</th><td><span class="status ([a-z-]+)">`).exec(html);
  return m?.[1] ?? m?.[2];
};
const page = (acc: Acceptance | null, ev = specimen(), latest: string | null = "run-SYNTHETIC") => renderHtml(ev, { acceptance: acc, latestRunId: latest });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("evidence page: schema", () => {
  it("refuses evidence that fails schema validation", () => {
    expect(() => renderHtml({ ...specimen(), schema_version: 2 })).toThrow(/evidence failed schema validation/);
    expect(() => renderHtml({ ...specimen(), mode: "testnet" })).toThrow(/evidence failed schema validation/);
    const missing = Object.fromEntries(Object.entries(specimen()).filter(([k]) => k !== "assertions"));
    expect(() => renderHtml(missing)).toThrow(/evidence failed schema validation/);
  });

  it("refuses a malformed acceptance verdict, policy or legacy report", () => {
    expect(() => renderHtml(specimen(), { acceptance: { ...acceptance(), certified: "yes" } })).toThrow(/acceptance failed schema validation/);
    expect(() => renderHtml(specimen(), { policy: { per_order_cap_bps: "20%" } as never })).toThrow(/policy failed schema validation/);
    expect(() => renderHtml(specimen(), { legacy: { label: "x", reports: [{ gate: "T1" }] } })).toThrow(/legacy report #0 failed schema validation/);
  });
});

describe("evidence page: certification is bound to this demo", () => {
  it("passes every gate only for a certified run bound to this demo", () => {
    const html = page(acceptance());
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).toBe("passed");
    expect(html).toContain("✓ certified for this demo");
    expect(html).not.toContain("Not certified for this demo");
  });

  it("shows every gate as not run without an acceptance run", () => {
    const html = page(null);
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).toBe("not-run");
    expect(html).not.toContain('class="status passed"');
    expect(html).toContain("Not certified for this demo: no acceptance run");
  });

  it("never marks a gate from demo assertions alone", () => {
    const ev = specimen({ assertions: Object.keys(REQUIRED_CASES).map((g) => check(`demo-${g}`, g, "SYNTHETIC story check")) });
    const html = page(null, ev);
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).toBe("not-run");
    expect(html).toContain("Story checks never mark an acceptance gate");
  });

  const mismatches: [string, Evidence, Acceptance, string | null, string][] = [
    ["revision", specimen({}, { product_commit: "0".repeat(40) }), acceptance(), "run-SYNTHETIC", "revision differs"],
    ["dirty demo", specimen({}, { dirty: true }), acceptance(), "run-SYNTHETIC", "the demo ran from a dirty tree"],
    ["dirty acceptance", specimen(), acceptance({ dirty: true, certified: false }), "run-SYNTHETIC", "dirty tree"],
    ["spec", specimen({}, { spec_sha256: "9".repeat(64) }), acceptance(), "run-SYNTHETIC", "SPEC.md sha256 differs"],
    ["fixture manifest", specimen({}, { fixture_manifest_sha256: "9".repeat(64) }), acceptance(), "run-SYNTHETIC", "fixtures/manifest.json sha256 differs"],
    ["fixture file", specimen({}, { fixtures: { "verifier/defuse-0.4.5.wasm": "9".repeat(64) } }), acceptance(), "run-SYNTHETIC", "fixture verifier/defuse-0.4.5.wasm differs"],
    ["WASM", specimen({}, { wasm_sha256: { bounded_mandate: "9".repeat(64) } }), acceptance(), "run-SYNTHETIC", "WASM bounded_mandate differs"],
    ["unrecorded WASM", specimen({}, { wasm_sha256: undefined }), acceptance(), "run-SYNTHETIC", "records no hashes of the WASMs"],
    ["acceptance from another run", specimen(), acceptance(), "run-LATER", "but the latest run is run-LATER"],
  ];
  it.each(mismatches)("a mismatched %s renders as not certified for this demo, with the reason", (_what, ev, acc, latest, reason) => {
    const html = page(acc, ev, latest);
    expect(html).toContain("Not certified for this demo:");
    expect(html).toContain(escapeHtml(reason));
    expect(html).toContain("! not certified for this demo");
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).not.toBe("passed");
  });

  it("a single passing T1 case does not pass the gate", () => {
    const only = allCases().filter((c) => c.gate !== "T1" || c.case === "withheld-regrant");
    expect(gateStatus(page(acceptance({ cases: only })), "T1")).toBe("incomplete");
  });

  it.each(["failed", "mismatched", "duplicate"] as const)("a %s case fails its gate", (status) => {
    const html = page(acceptance({ certified: false, complete: false, cases: withCase("T2b.disclosed-relay", status) }));
    expect(gateStatus(html, "T2b")).toBe("failed");
    expect(html).toContain("At least one acceptance case failed");
  });

  it.each(["missing", "stale"] as const)("a %s case leaves its gate incomplete", (status) => {
    expect(gateStatus(page(acceptance({ certified: false, complete: false, cases: withCase("MODEL.recorded-proposal", status) })), "MODEL")).toBe("incomplete");
  });

  it("labels the deployment candidate gate", () => {
    expect(page(acceptance())).toContain("proposed deployment binary exercised in sandbox");
  });

  it("keeps the emergency owner-key rescue separate from ordinary recovery", () => {
    const rescue: CaseResult = { id: "RESCUE.owner-key", gate: "RESCUE", case: "owner-key", status: "passed", reason: "SYNTHETIC", files: [], mode: "sandbox" };
    const html = page(acceptance({ separate: [rescue] }));
    expect(html).toContain("Emergency owner-key rescue, reported separately");
    expect(html).toContain("This is not ordinary recovery. It never counts toward T4");
    expect(gateStatus(html, "RESCUE")).toBeUndefined();
  });
});

describe("evidence page: presentation order and step labels", () => {
  const story = specimen({
    environment: {
      verifier_wasm_sha256: FIXTURES["verifier/defuse-0.4.5.wasm"],
      steps: JSON.stringify([
        { step: "Genuine model proposal (recorded) -> propose_order", started_ms: 0, first_receipt: 0, first_assertion: 0 },
        { step: "Malicious requests", started_ms: 1, first_receipt: 1, first_assertion: 1 },
        { step: "Recovery to the owner", started_ms: 2, first_receipt: 1, first_assertion: 3 },
      ]),
    },
    receipts: [receipt("agent propose_order (order 1)", {}, { tx_hash: "TX1" })],
    assertions: [
      check("model", "MODEL", "SYNTHETIC model proposal", { mode: "recorded-model" }),
      check("a1", "BOUNDARY", "SYNTHETIC attack -> stopped by contract-role (scripted-direct)"),
      check("a2", "BOUNDARY", "SYNTHETIC attack -> stopped by adapter-schema (injected-request)"),
      check("rec", "T4", "SYNTHETIC recovered"),
    ],
  });

  it("leads with the demonstration, then gates, the baseline, limits and provenance", () => {
    const html = page(acceptance({ baseline: t5("attack_succeeded") }), story);
    const at = (id: string) => html.indexOf(`id="${id}"`);
    expect(html.indexOf("Claim: the mandate contract")).toBeLessThan(at("demo"));
    expect(at("demo")).toBeLessThan(at("gates"));
    expect(at("gates")).toBeLessThan(at("baseline"));
    expect(at("baseline")).toBeLessThan(at("limits"));
    expect(at("limits")).toBeLessThan(at("provenance"));
  });

  it("groups steps and labels model output, scripted attacks and ordinary recovery", () => {
    const html = page(null, story);
    expect(html).toContain('<span class="mode recorded-model">recorded genuine model output</span>');
    expect(html).toContain("2 of 2 scripted attacks stopped");
    expect(html).toContain('<span class="mode label">scripted attacks</span>');
    expect(html).toContain("ordinary recovery (not the owner-key rescue)");
    for (const label of ["real Intents verifier WASM", "test doubles: MPC, oracle, tokens", "no mainnet"]) expect(html).toContain(`<span class="mode label">${label}</span>`);
  });

  it("labels each WASM's role in the provenance table", () => {
    const html = page(acceptance());
    expect(html).toContain("bounded_mandate.wasm (production contract)");
    expect(html).toContain("bounded_mandate_fault.wasm (fault-injection test build, not the production contract)");
  });
});

describe("evidence page: execution modes", () => {
  it("labels recorded-model receipts and shows no mainnet label without mainnet evidence", () => {
    const html = page(null, specimen({ receipts: [receipt("Model proposal (SYNTHETIC)", { mode: "recorded-model" }), receipt("Grant (SYNTHETIC)", {}, { receipt_id: "r1" })] }));
    expect(html).toContain('<span class="mode recorded-model" title="execution mode">recorded-model</span>');
    expect(html).not.toContain('class="mode mainnet"');
    expect(html).toContain("No mainnet receipts in this evidence.");
  });

  it("refuses a mainnet label that is not backed by mainnet evidence with a transaction hash", () => {
    expect(() => renderHtml(specimen({ receipts: [receipt("fake", { mode: "mainnet" }, { tx_hash: "abc" })] }))).toThrow(/claims mainnet/);
    expect(() => renderHtml(specimen({ mode: "mainnet", receipts: [receipt("no hash", {})] }))).toThrow(/claims mainnet/);
    expect(() => renderHtml(specimen({ receipts: [receipt("odd", { mode: "testnet" })] }))).toThrow(/unknown mode/);
    expect(renderHtml(specimen({ mode: "mainnet", receipts: [receipt("trade (SYNTHETIC)", {}, { tx_hash: "HASH1" })] }))).toContain('class="mode mainnet"');
  });
});

describe("evidence page: escaping and self-containment", () => {
  it("escapes every evidence string", () => {
    const evil = `<script>alert("x")</script>&'`;
    const acc = acceptance({
      cases: allCases().map((c) => ({ ...c, reason: evil })),
      problems: [evil],
      ignored: [{ file: evil, reason: evil }],
      environment: { [evil]: evil },
      baseline: { ...t5("attack_succeeded"), command: evil },
    });
    const html = page(acc, specimen({ command: evil, identifiers: { [evil]: evil }, unknowns: [evil], receipts: [receipt(evil, { note: evil }, { tx_hash: evil })], assertions: [check(evil, evil, evil, evil)] }));
    expect(html).not.toContain("<script>");
    expect(html).toContain(escapeHtml(evil));
    expect(escapeHtml(evil)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });

  it("writes a single self-contained index.html, and renders without acceptance.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-page-"));
    dirs.push(dir);
    const path = renderPage(specimen(), dir, { acceptance: null, latestRunId: null, gateReports: ["ignored"] });
    const html = readFileSync(path, "utf8");
    expect(path).toBe(join(dir, "index.html"));
    expect(html).not.toMatch(/<(script|link|img|iframe)\b/i);
    expect(html).not.toMatch(/\b(src|href)=["']?(https?:)?\/\//i);
    expect(html).toContain("Content-Security-Policy");
    expect(gateStatus(html, "T1")).toBe("not-run");
  });
});

describe("evidence page: re-implemented baseline comparison", () => {
  it("frames the baseline as our re-implementation, not an exploit of the deployed product", () => {
    const html = page(acceptance({ baseline: t5("attack_succeeded") }));
    expect(html).toContain("our own re-implementation of the authority model of Claw Guard");
    expect(html).toContain("not evidence of an exploit against the deployed Claw Guard product");
  });

  it("claims an increment only for an executed attack joined with a passing gate certified for this demo", () => {
    expect(page(acceptance({ baseline: t5("attack_succeeded") }))).toContain("increment demonstrated");
    expect(page(acceptance({ baseline: t5("attack_succeeded") }), specimen({}, { dirty: true }))).toContain("differentiation unproven");
    expect(page(acceptance({ baseline: t5("attack_succeeded") }), specimen(), "run-LATER")).toContain("differentiation unproven");
    expect(page(acceptance({ baseline: t5("attack_succeeded"), certified: false, complete: false, cases: withCase("T1.pending-sign", "missing") }))).toContain("differentiation unproven");
    const parity = page(acceptance({ baseline: t5("blocked") }));
    expect(parity).toContain("differentiation unproven");
    expect(parity).toContain('class="status parity"');
    expect(page(acceptance({ baseline: t5("unsupported_by_design") }))).toContain("differentiation unproven");
    expect(page(acceptance({ baseline: null }))).toContain("No T5 baseline report");
  });
});

describe("evidence page: historical v1 bundle", () => {
  const bundle = join(repo, "evidence/426914d");
  const digest = (dir: string): string => {
    const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
    const h = createHash("sha256");
    for (const f of files(dir).sort()) h.update(relative(dir, f)).update(readFileSync(f));
    return h.digest("hex");
  };

  it("renders as legacy, uncertified by v2 rules, without touching the bundle", () => {
    const before = digest(bundle);
    const dir = mkdtempSync(join(tmpdir(), "bm-legacy-"));
    dirs.push(dir);
    const html = readFileSync(renderLegacyBundle(bundle, dir), "utf8");
    expect(html).toContain("Legacy reports, uncertified by v2 rules");
    expect(html).toContain("legacy pass (uncertified)");
    expect(html).not.toContain('class="status passed"');
    expect(html).toContain("Not certified for this demo: no acceptance run");
    expect(digest(bundle)).toBe(before);
  });
});
