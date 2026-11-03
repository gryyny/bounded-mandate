// SYNTHETIC specimens only: every evidence object below is built here for testing the renderer
// and is labelled as such; none is a recorded run.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_GATES } from "../src/checks/gates.js";
import { escapeHtml, gateRows, renderHtml, renderPage } from "../src/page/render.js";
import { type GateReport, loadGateReports } from "../src/page/reports.js";
import { Evidence, type Receipt } from "../src/types.js";

const COMMIT = "a".repeat(40);

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

const report = (gate: string, passed: boolean, over: Partial<GateReport> = {}): GateReport => ({
  gate,
  part: null,
  passed,
  mode: "sandbox",
  source_revision: COMMIT,
  dirty: false,
  data: { synthetic: true },
  ...over,
});

const t5Data = (outcome: string, compareGate = "T1") => ({
  command: "synthetic",
  hashes: {},
  environment: { label: "SYNTHETIC" },
  baseline: { name: "synthetic baseline", repository: "https://example.invalid/b", commit: "f".repeat(40), license: "MIT", adaptations: ["synthetic"] },
  assertions: [{ id: "T5.case", gate: "T5", description: "synthetic", passed: true, observed: null }],
  cases: [{ id: "case", threat: "Withheld order after revocation", compare_gate: compareGate, baseline_outcome: outcome, summary: "synthetic", observed: { synthetic: true } }],
});

const receipt = (label: string, detail: unknown, over: Partial<Receipt> = {}): Receipt => ({ label, outcome: "success", detail, ...over });

const gateStatus = (html: string, gate: string): string | undefined =>
  new RegExp(`<th scope="row"><code>${gate}</code></th><td><span class="status ([a-z-]+)">`).exec(html)?.[1];

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

  it("refuses malformed gate reports, T5 data and policy", () => {
    const bad = { ...report("T1", true), passed: "yes" } as unknown as GateReport;
    expect(() => renderHtml(specimen(), { gateReports: [bad] })).toThrow(/gate report #0 failed schema validation/);
    const badT5 = report("T5", true, { data: { cases: "none" } });
    expect(() => renderHtml(specimen(), { gateReports: [badT5] })).toThrow(/T5 report #0 data failed schema validation/);
    expect(() => renderHtml(specimen(), { policy: { per_order_cap_bps: "20%" } as never })).toThrow(/policy failed schema validation/);
  });

  it("loads valid report files and refuses a malformed one instead of skipping it", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-reports-"));
    dirs.push(dir);
    writeFileSync(join(dir, "T1.json"), JSON.stringify(report("T1", true)));
    expect(loadGateReports(dir).map((r) => r.gate)).toEqual(["T1"]);
    writeFileSync(join(dir, "T2.json"), JSON.stringify({ gate: "T2" }));
    expect(() => loadGateReports(dir)).toThrow(/invalid gate report T2\.json/);
  });
});

describe("evidence page: honest gate results", () => {
  it("shows every required gate as not run when nothing was executed", () => {
    const html = renderHtml(specimen());
    for (const gate of REQUIRED_GATES) expect(gateStatus(html, gate)).toBe("not-run");
    expect(html).not.toContain('class="status passed"');
    expect(html).toContain("claim not yet supported");
    expect(html).toContain("differentiation is unproven");
  });

  it("shows failed and stale reports as such, never as passed", () => {
    const html = renderHtml(specimen(), {
      gateReports: [report("T1", false), report("T4", true, { source_revision: "0".repeat(40) }), report("T2", true)],
    });
    expect(gateStatus(html, "T1")).toBe("failed");
    expect(gateStatus(html, "T4")).toBe("stale");
    expect(gateStatus(html, "T2")).toBe("passed");
    expect(html).toContain("Gate failures recorded");
  });

  it("marks a gate passed only with a passed assertion and none failed", () => {
    const ev = specimen({
      assertions: [
        { id: "m1", gate: "MODEL", description: "synthetic", passed: true, observed: null },
        { id: "b1", gate: "BOUNDARY", description: "synthetic", passed: true, observed: null },
        { id: "b2", gate: "BOUNDARY", description: "synthetic", passed: false, observed: null },
      ],
    });
    const rows = new Map(gateRows(ev, [report("T3", true), report("T3", false)]).map((r) => [r.gate, r.status]));
    expect(rows.get("MODEL")).toBe("passed");
    expect(rows.get("BOUNDARY")).toBe("failed");
    expect(rows.get("T3")).toBe("failed");
    expect(rows.get("T1")).toBe("not-run");
  });
});

describe("evidence page: execution modes", () => {
  it("labels sandbox and recorded-model steps distinctly and shows no mainnet label without mainnet evidence", () => {
    const html = renderHtml(
      specimen({
        receipts: [receipt("Model proposal (SYNTHETIC)", { mode: "recorded-model" }), receipt("Grant (SYNTHETIC)", {}, { receipt_id: "r1" })],
      }),
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
    const html = renderHtml(specimen({ mode: "mainnet", receipts: [receipt("trade (SYNTHETIC)", {}, { tx_hash: "HASH1" })] }));
    expect(html).toContain('class="mode mainnet"');
  });
});

describe("evidence page: escaping and self-containment", () => {
  it("escapes every evidence string", () => {
    const evil = `<script>alert("x")</script>&'`;
    const html = renderHtml(
      specimen({
        command: evil,
        identifiers: { [evil]: evil },
        unknowns: [evil],
        receipts: [receipt(evil, { note: evil }, { tx_hash: evil })],
      }),
      { gateReports: [report("T5", true, { mode: evil, data: t5Data("attack_succeeded") })] },
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain(escapeHtml(evil));
    expect(escapeHtml(evil)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });

  it("writes a single self-contained index.html", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-page-"));
    dirs.push(dir);
    const path = renderPage(specimen(), dir, { gateReports: [report("T5", true, { data: t5Data("blocked") })] });
    const html = readFileSync(path, "utf8");
    expect(path).toBe(join(dir, "index.html"));
    expect(html).not.toMatch(/<(script|link|img|iframe)\b/i);
    expect(html).not.toMatch(/\b(src|href)=["']?(https?:)?\/\//i);
    expect(html).toContain("Content-Security-Policy");
  });
});

describe("evidence page: baseline comparison", () => {
  it("claims an increment only for an executed baseline failure joined with a passing mandate gate", () => {
    const withGate = renderHtml(specimen(), { gateReports: [report("T5", true, { data: t5Data("attack_succeeded") }), report("T1", true)] });
    expect(withGate).toContain("increment demonstrated");

    const gateMissing = renderHtml(specimen(), { gateReports: [report("T5", true, { data: t5Data("attack_succeeded") })] });
    expect(gateMissing).toContain("differentiation unproven");

    const baselineBlocked = renderHtml(specimen(), { gateReports: [report("T5", true, { data: t5Data("blocked") }), report("T1", true)] });
    expect(baselineBlocked).toContain("differentiation unproven");
    expect(baselineBlocked).toContain('class="status parity"');

    const notExecuted = renderHtml(specimen(), { gateReports: [report("T5", true, { data: t5Data("unsupported_by_design") }), report("T1", true)] });
    expect(notExecuted).toContain("differentiation unproven");

    const t5Failed = renderHtml(specimen(), { gateReports: [report("T5", false, { data: t5Data("attack_succeeded") }), report("T1", true)] });
    expect(t5Failed).toContain("differentiation unproven");
  });
});
