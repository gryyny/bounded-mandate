// SYNTHETIC specimens only: every evidence and acceptance object below is built here for testing
// the renderer and is labelled as such; none is a recorded run.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_CASES } from "../src/evidence/required.js";
import { ACCEPTANCE_SCHEMA, type Acceptance, type BaselineOutcome, type CaseResult, type T5Data } from "../src/evidence/schema.js";
import { escapeHtml, gateViews, renderHtml, renderLegacyBundle, renderPage } from "../src/page/render.js";
import { Evidence, type Receipt } from "../src/types.js";

const COMMIT = "a".repeat(40);
const repo = resolve(import.meta.dirname, "../..");

const specimen = (over: Partial<Evidence> = {}): Evidence =>
  Evidence.parse({
    schema_version: 1,
    generated_at: "2026-11-03T00:00:00Z",
    mode: "sandbox",
    source: {
      product_commit: COMMIT,
      dirty: false,
      spec_sha256: "b".repeat(64),
      spec_commit: "c".repeat(40),
      contract_wasm_sha256: "d".repeat(64),
      fixtures: { "verifier/defuse-0.4.5.wasm": "e".repeat(64) },
    },
    environment: { label: "SYNTHETIC specimen" },
    command: "vitest (synthetic specimen)",
    identifiers: { specimen: "SYNTHETIC test specimen, not a run" },
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
  revision: COMMIT,
  dirty: false,
  certified: true,
  complete: true,
  started_at: "2026-11-03T00:00:00Z",
  evaluated_at: "2026-11-03T00:10:00Z",
  hashes: { spec_sha256: "b".repeat(64), fixture_manifest_sha256: "c".repeat(64), fixtures: {}, wasm: {} },
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

const gateStatus = (html: string, gate: string): string | undefined =>
  new RegExp(`<code>${gate}</code>(?:</th>|<br>)(?:<td>)?<span class="status ([a-z-]+)">`).exec(html)?.[1];

const viewStatus = (ev: Evidence, acc: Acceptance | null, gate: string) => gateViews(ev, acc).find((v) => v.gate === gate)?.status;

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

describe("evidence page: gates come only from a certified acceptance run", () => {
  it("shows every gate as not run without an acceptance run", () => {
    const html = renderHtml(specimen(), { acceptance: null });
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).toBe("not-run");
    expect(html).not.toContain('class="status passed"');
    expect(html).toContain("No acceptance run");
  });

  it("never marks a gate from demo assertions alone", () => {
    const assertions = Object.keys(REQUIRED_CASES).map((gate) => ({ id: `demo-${gate}`, gate, description: "SYNTHETIC story check", passed: true, observed: null }));
    const ev = specimen({ assertions });
    for (const gate of Object.keys(REQUIRED_CASES)) expect(viewStatus(ev, null, gate)).toBe("not-run");
    const html = renderHtml(ev, { acceptance: null });
    expect(html).not.toContain('class="status passed"');
    expect(html).toContain("Demo story checks");
    expect(html).toContain("They never mark an acceptance gate passed");
  });

  it("passes every gate only for a certified, complete run of this revision", () => {
    const html = renderHtml(specimen(), { acceptance: acceptance() });
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).toBe("passed");
    expect(html).toContain("All gates passed · certified run");
  });

  it("shows a complete run from a dirty tree as uncertified, never passed", () => {
    const acc = acceptance({ dirty: true, certified: false });
    const html = renderHtml(specimen(), { acceptance: acc });
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).toBe("uncertified");
    expect(html).not.toContain('class="status passed"');
    expect(html).not.toContain("All gates passed");
    expect(html).toContain("Complete but uncertified run");
  });

  it("shows an incomplete run as incomplete", () => {
    const acc = acceptance({ certified: false, complete: false, cases: withCase("T4.open-order-limit", "missing") });
    expect(viewStatus(specimen(), acc, "T4")).toBe("incomplete");
    expect(renderHtml(specimen(), { acceptance: acc })).toContain("Incomplete run");
  });

  it("a single passing T1 case does not pass the gate", () => {
    const only = allCases().filter((c) => c.gate !== "T1" || c.case === "withheld-regrant");
    const acc = acceptance({ cases: only });
    expect(viewStatus(specimen(), acc, "T1")).toBe("incomplete");
    expect(gateStatus(renderHtml(specimen(), { acceptance: acc }), "T1")).toBe("incomplete");
  });

  it.each(["failed", "mismatched", "duplicate"] as const)("a %s case fails its gate", (status) => {
    const acc = acceptance({ certified: false, complete: false, cases: withCase("T2b.disclosed-relay", status) });
    expect(viewStatus(specimen(), acc, "T2b")).toBe("failed");
    expect(renderHtml(specimen(), { acceptance: acc })).toContain("Gate failures recorded");
  });

  it("a stale case leaves its gate incomplete", () => {
    const acc = acceptance({ certified: false, complete: false, cases: withCase("MODEL.recorded-proposal", "stale") });
    expect(viewStatus(specimen(), acc, "MODEL")).toBe("incomplete");
  });

  it("an acceptance run for another revision never counts", () => {
    const acc = acceptance({ revision: "0".repeat(40) });
    for (const gate of Object.keys(REQUIRED_CASES)) expect(viewStatus(specimen(), acc, gate)).toBe("stale");
    expect(renderHtml(specimen(), { acceptance: acc })).toContain("another revision");
  });

  it("shows the owner-key rescue separately and lists files that were not counted", () => {
    const rescue: CaseResult = { id: "RESCUE.owner-key", gate: "RESCUE", case: "owner-key", status: "passed", reason: "SYNTHETIC", files: [], mode: "sandbox" };
    const html = renderHtml(specimen(), { acceptance: acceptance({ separate: [rescue], ignored: [{ file: "T5.json", reason: "legacy v1 report" }] }) });
    expect(html).toContain("never counts toward T4");
    expect(html).toContain("legacy v1 report");
    expect(gateViews(specimen(), acceptance({ separate: [rescue] })).some((v) => v.gate === "RESCUE")).toBe(false);
  });
});

describe("evidence page: WASM roles", () => {
  it("labels the fault-injection build and never presents it as the production contract", () => {
    const html = renderHtml(specimen(), {
      acceptance: acceptance({ hashes: { spec_sha256: null, fixture_manifest_sha256: null, fixtures: {}, wasm: { bounded_mandate: "1".repeat(64), bounded_mandate_fault: "2".repeat(64), mock_mpc: "3".repeat(64) } } }),
    });
    expect(html).toContain("bounded_mandate.wasm (production contract)");
    expect(html).toContain("bounded_mandate_fault.wasm (fault-injection test build, not the production contract)");
    expect(html).toContain("mock_mpc.wasm (labelled test double)");
  });
});

describe("evidence page: execution modes", () => {
  it("labels sandbox and recorded-model steps distinctly and shows no mainnet label without mainnet evidence", () => {
    const html = renderHtml(
      specimen({ receipts: [receipt("Model proposal (SYNTHETIC)", { mode: "recorded-model" }), receipt("Grant (SYNTHETIC)", {}, { receipt_id: "r1" })] }),
      { acceptance: null },
    );
    expect(html).toContain('<span class="mode recorded-model" title="execution mode">recorded-model</span>');
    expect(html).toContain('<span class="mode sandbox" title="execution mode">sandbox</span>');
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
    const html = renderHtml(
      specimen({ command: evil, identifiers: { [evil]: evil }, unknowns: [evil], receipts: [receipt(evil, { note: evil }, { tx_hash: evil })], assertions: [{ id: evil, gate: evil, description: evil, passed: true, observed: evil }] }),
      { acceptance: acc },
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain(escapeHtml(evil));
    expect(escapeHtml(evil)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });

  it("writes a single self-contained index.html, and renders without acceptance.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-page-"));
    dirs.push(dir);
    const path = renderPage(specimen(), dir, { acceptance: null, gateReports: ["ignored"] });
    const html = readFileSync(path, "utf8");
    expect(path).toBe(join(dir, "index.html"));
    expect(html).not.toMatch(/<(script|link|img|iframe)\b/i);
    expect(html).not.toMatch(/\b(src|href)=["']?(https?:)?\/\//i);
    expect(html).toContain("Content-Security-Policy");
    expect(gateStatus(html, "T1")).toBe("not-run");
  });
});

describe("evidence page: re-implemented baseline comparison", () => {
  const page = (acc: Acceptance) => renderHtml(specimen(), { acceptance: acc });

  it("frames the baseline as our re-implementation, not an exploit of the deployed product", () => {
    const html = page(acceptance({ baseline: t5("attack_succeeded") }));
    expect(html).toContain("our own re-implementation of the authority model of Claw Guard");
    expect(html).toContain("not evidence of an exploit against the deployed Claw Guard product");
  });

  it("claims an increment only for an executed attack joined with a passing gate of a certified run", () => {
    expect(page(acceptance({ baseline: t5("attack_succeeded") }))).toContain("increment demonstrated");
    expect(page(acceptance({ baseline: t5("attack_succeeded"), dirty: true, certified: false }))).toContain("differentiation unproven");
    expect(page(acceptance({ baseline: t5("attack_succeeded"), certified: false, complete: false, cases: withCase("T1.pending-sign", "missing") }))).toContain("differentiation unproven");
    expect(page(acceptance({ baseline: t5("attack_succeeded"), certified: false, complete: false, cases: withCase("T5.baseline", "failed") }))).toContain("differentiation unproven");
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
    expect(html).toContain("No acceptance run");
    expect(digest(bundle)).toBe(before);
  });
});
