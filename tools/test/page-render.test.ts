// SYNTHETIC specimens only: every evidence and acceptance object below is built here for testing
// the renderer and is labelled as such; none is a recorded run.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_CASES } from "../src/evidence/required.js";
import { ACCEPTANCE_SCHEMA, type Acceptance, type BaselineOutcome, type CaseResult, type T5Data } from "../src/evidence/schema.js";
import { LIVE_MAINNET_PATH, isTxHash, loadLive } from "../src/page/mainnet.js";
import { escapeHtml, renderHtml, renderLegacyBundle, renderPage } from "../src/page/render.js";
import { clientScript, scriptHash } from "../src/page/verify.js";
import { type Assertion, Evidence, type Receipt } from "../src/types.js";
import { ATTACKS, CONSOLE_RENDERED, CONSOLE_REVOKE, STORY, expiredStoryEvidence, olderStoryEvidence, storyEvidence, txHash } from "./video-story-specimen.js";
import { CONSOLE_BROWSER_LABEL, ConsoleReview, OWNER_CONTROLS_LABEL, PLANNED_LABEL, PLANNED_URLS, REPO_URL, SITE_PATHS, bundlePaths } from "../src/evidence/journey.js";
import { revocationStory } from "../src/page/story.js";
import { AGENT_API_EXAMPLES, AGENT_API_EXAMPLES_URL, AGENT_API_QUOTE } from "../src/page/related.js";

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
      check("model-proposal-on-chain", "MODEL", "SYNTHETIC model proposal", { mode: "recorded-model", decision: { adapter_verdict: { kind: "proposal" } } }),
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
    expect(html).not.toContain(evil);
    expect(html).not.toContain("<script>alert");
    // The page's own client script is the only script element.
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    expect(html).toContain(escapeHtml(evil));
    expect(escapeHtml(evil)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });

  it("writes a single self-contained index.html, and renders without acceptance.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-page-"));
    dirs.push(dir);
    const path = renderPage(specimen(), dir, { acceptance: null, latestRunId: null, live: null, gateReports: ["ignored"] });
    const html = readFileSync(path, "utf8");
    expect(path).toBe(join(dir, "index.html"));
    // One inline script, allowed by its hash; no other script, stylesheet, image or frame, and nothing loaded from elsewhere.
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toBe("");
    const script = scripts[0]?.[2] ?? "";
    expect(script).toBe(clientScript());
    expect(script).not.toMatch(/https?:\/\//);
    expect(html).toContain(`script-src '${scriptHash(script)}'`);
    const rest = html.replace(scripts[0]?.[0] ?? "", "");
    expect(rest).not.toMatch(/<(script|link|img|iframe)\b/i);
    expect(html).not.toMatch(/\bsrc=["']?(https?:)?\/\//i);
    // The one external reference is a link the reader may follow to the source repository; nothing is loaded.
    expect([...new Set([...html.matchAll(/<([a-z0-9]+)\b[^>]*\bhref=["']?((?:https?:)?\/\/[^"'\s>]*)/gi)].map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`))]).toEqual([`a ${REPO_URL}`]);
    expect(html).not.toMatch(/<(video|audio|source|track|embed|object)\b|\bposter=|\bautoplay\b/i);
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

describe("evidence page: revocation story", () => {
  const stages = (html: string): string[] => [...html.matchAll(/<li class="stage ([a-z]+) ([a-z]+)"/g)].map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`);

  it("shows the nine detailed stages in journey order with values bound to the evidence", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    // Journey order: hostile requests (step 3) before the withheld order (step 4).
    expect(stages(html)).toEqual(["limits held", "console held", "trade held", "attacks held", "withheld held", "revoked held", "rejected held", "recovered held", "withdrawn held"]);
    expect([...html.matchAll(/<span class="stage-n" aria-hidden="true">([0-9a-z]+)<\/span>/g)].map((m) => m[1])).toEqual(["1a", "1b", "2", "3", "4", "5", "6", "7", "8"]);
    // Expected text derived from the SYNTHETIC raw inputs (6 USDC decimals, 24 wNEAR decimals, 12 value decimals).
    const s = STORY;
    expect(s.before.usdc).toBe(2_000n * 10n ** 6n);
    for (const text of [
      "2,000.00 USDC + 100.0000 wNEAR",
      "$2,300.00",
      "20% of initial value ($460.00)",
      "sold 12.34 USDC → bought 4.0000 wNEAR",
      `recorded output of ${s.model}`,
      "order id 7: 5.0000 wNEAR → 14.99 USDC",
      "grant revoked · key registered: no",
      "rejected 37 s before its deadline",
      "1,987.66 USDC + 104.0000 wNEAR to the owner's Intents account",
      `${String(ATTACKS.length)} of ${String(ATTACKS.length)} refused · state unchanged`,
      "1,987.66 USDC + 104.0000 wNEAR to owner.synthetic's NEAR account",
    ]) expect(html).toContain(escapeHtml(text));
    const at = (needle: string) => html.indexOf(needle);
    expect(at('id="stage-console"')).toBeLessThan(at('id="stage-recovered"'));
    expect(at('id="stage-recovered"')).toBeLessThan(at('id="stage-withdrawn"'));
    expect(at('id="story"')).toBeLessThan(at('id="paths"'));
    expect(at('id="paths"')).toBeLessThan(at('id="mainnet"'));
    expect(at('id="mainnet"')).toBeLessThan(at('id="demo"'));
  });

  it("labels each stage's mode and links every receipt to the transaction it shows", () => {
    const ev = storyEvidence();
    const html = renderHtml(ev, { acceptance: null, live: null });
    expect(html).toContain('<span class="mode recorded-model">recorded genuine model output</span>');
    expect(html).toContain('<span class="mode label">scripted proposal</span>');
    expect(html.match(/<p class="stage-modes"><span class="mode sandbox"/g)).toHaveLength(9);
    ev.receipts.forEach((_, i) => {
      expect(html).toContain(`href="#tx-${String(i)}"`);
      expect(html).toContain(`id="tx-${String(i)}"`);
    });
  });

  it("shows no numbers for a stage whose evidence is missing, and a failed check as not held", () => {
    const bare = renderHtml(specimen(), { acceptance: null, live: null });
    expect(stages(bare).every((s) => s.endsWith(" missing"))).toBe(true);
    expect(bare).toContain("Not in this evidence: assertion console-review");
    expect(bare).toContain("Not in this evidence: receipt matching /^owner grant$/; assertion grant-active");
    const ev = storyEvidence();
    const failed = { ...ev, assertions: ev.assertions.map((a) => (a.id === "withheld-rejected" ? { ...a, passed: false } : a)) };
    const html = renderHtml(failed, { acceptance: null, live: null });
    expect(stages(html)).toContain("rejected failure");
    expect(html).toContain("withheld-rejected</a> <strong>did not hold</strong>");
  });

  it("narrates a failed check as not held, and an expired relay as inconclusive, never as rejection by revocation", () => {
    const ev = storyEvidence();
    const failed = { ...ev, assertions: ev.assertions.map((a) => (a.id === "withheld-executable" ? { ...a, passed: false } : a)) };
    const notHeld = renderHtml(failed, { acceptance: null, live: null });
    expect(stages(notHeld)).toContain("withheld failure");
    expect(notHeld).toContain(escapeHtml("did not hold: withheld-executable"));
    expect(notHeld).not.toContain(escapeHtml("the verifier's simulation accepts it"));

    const html = renderHtml(expiredStoryEvidence(), { acceptance: null, live: null });
    expect(stages(html)).toContain("rejected inconclusive");
    expect(html).toContain(escapeHtml("inconclusive: the withheld order was relayed 4.5 s after its deadline"));
    expect(html).not.toMatch(/rejected -?\d+ s before its deadline/);
    expect(html).toContain("withheld-rejected</a> <strong>did not hold</strong>");
  });

  it("never states the console revocation's route or preview when its check did not hold", () => {
    const ev = storyEvidence();
    const failedConsole = (observed: unknown) => ({
      ...ev,
      assertions: ev.assertions.map((a) => (a.id === "revoke-through-console" ? { ...a, passed: false, observed } : a)),
    });
    const held = revocationStory(ev).find((s) => s.key === "revoked");
    expect(held?.facts.map(([k]) => k)).toEqual(expect.arrayContaining(["Through", "Preview", "Sign requests", "Transaction"]));
    expect(renderHtml(ev, { acceptance: null, live: null })).toContain("<dt>Preview</dt>");

    const html = renderHtml(failedConsole({ ...CONSOLE_REVOKE, preview_problems: ["Method shows revoke_all, derived revoke"] }), { acceptance: null, live: null });
    expect(stages(html)).toContain("revoked failure");
    expect(html).toContain("revoke-through-console</a> <strong>did not hold</strong>");
    expect(html).not.toContain("<dt>Through</dt>");
    expect(html).not.toContain(escapeHtml("the console's Revoke control"));
    expect(html).not.toContain("<dt>Preview</dt>");
    expect(html).not.toContain(escapeHtml("exact: receiver, method, arguments, gas and deposit as derived"));
    expect(html).toContain(escapeHtml("console revocation did not hold: preview differs: Method shows revoke_all, derived revoke"));

    // Values that look exact still do not make a failed check read as the console route.
    const stage = revocationStory(failedConsole(CONSOLE_REVOKE)).find((s) => s.key === "revoked");
    expect(stage?.outcome).toBe("not-held");
    expect(stage?.facts.map(([k]) => k)).not.toEqual(expect.arrayContaining(["Through"]));
    expect(stage?.facts.find(([k]) => k === "Revocation")).toEqual(["Revocation", "console revocation did not hold: the revoke-through-console check failed"]);
    expect(stage?.facts.some(([k]) => ["Preview", "Sign requests", "Transaction"].includes(k))).toBe(false);
  });

  it("never marks a gate from the story", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).toBe("not-run");
  });

  it("offers the three paths: the cuts as links relative to the site, and both local demos named for what they are", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    const paths = html.slice(html.indexOf('id="paths"'), html.indexOf("</section>", html.indexOf('id="paths"')));
    expect(html).not.toContain("VIDEO_URL_PENDING");
    const clone = bundlePaths(storyEvidence().source.product_commit);
    expect(paths).toContain(`<a href="${SITE_PATHS.video}">Short cut</a> · <a href="${SITE_PATHS.walkthrough}">longer walkthrough</a> (in a clone: <code>${clone.video}</code>, <code>${clone.walkthrough}</code>)`);
    // The site is a project site: an absolute or root-absolute link to it would not survive the base path.
    expect(html).not.toContain(`href="${PLANNED_URLS.video}`);
    expect(html).not.toMatch(/href="\/[^"]/);
    // make quick is the prebuilt, uncertified path without Rust; make test && make demo is the certified one.
    expect(paths).toContain("<strong>Quick demo: prebuilt, uncertified, no Rust.</strong> <code>make quick</code>");
    expect(paths).toContain("writes only <code>out/quick/</code>");
    expect(paths).toContain("<strong>Certified path (needs Rust).</strong> On a clean revision run <code>make test &amp;&amp; make demo</code>");
    expect(paths).toContain("<code>make demo</code> alone runs the story from source but certifies nothing");
    expect(paths).not.toContain("Quick sandbox demo");
    expect(paths).toContain("<code>make verify</code> (Node only, offline)");
    expect(html).toContain("<code>make test &amp;&amp; make page</code>");
  });
});

describe("evidence page: mainnet section", () => {
  const PENDING = "Mainnet run: pending approval — no mainnet transaction has been executed";
  const live = (over: Partial<Evidence> = {}): Evidence =>
    Evidence.parse({
      ...specimen(),
      mode: "mainnet",
      command: "MANDATE_LIVE=1 make live (SYNTHETIC)",
      environment: { chain_id: "mainnet", label: "SYNTHETIC" },
      identifiers: { mandate: "mandate.synthetic.near", owner: "owner.synthetic.near" },
      receipts: [
        { label: "owner grant (SYNTHETIC)", tx_hash: txHash("grant"), block_height: 1, outcome: "success", detail: { step: 2, signer_id: "owner.synthetic.near", fee_yocto: "1000000000000000000000" } },
        { label: "owner revoke (SYNTHETIC)", tx_hash: txHash("revoke"), block_height: 2, outcome: "success", detail: { step: 6, signer_id: "owner.synthetic.near" } },
      ],
      assertions: [check("step-2-grant", "LIVE", "grant: terminal verification"), check("step-6-revoke", "LIVE", "revoke: terminal verification")],
      unknowns: [],
      ...over,
    });
  const relay = (classification: string, passed: boolean): Assertion => ({ id: "step-7-relay_withheld", gate: "LIVE", description: "relay_withheld (SYNTHETIC)", passed, observed: { classification } });
  const withRelay = (classification: string, passed: boolean): Evidence => live({ assertions: [...live().assertions, relay(classification, passed)] });
  const noMainnet = (html: string) => {
    expect(html).not.toContain('class="mode mainnet"');
    expect(html).not.toContain("nearblocks.io");
  };

  it("renders the pending panel when no live evidence exists", () => {
    const html = renderHtml(specimen(), { acceptance: null, live: null });
    expect(html).toContain(PENDING);
    expect(html).toContain('<span class="mode pending">mainnet: none</span>');
    noMainnet(html);
  });

  it("loads out/evidence/live-mainnet.json only when present", () => {
    const root = mkdtempSync(join(tmpdir(), "bm-live-"));
    dirs.push(root);
    expect(loadLive(root)).toBeNull();
    mkdirSync(join(root, "out/evidence"), { recursive: true });
    writeFileSync(join(root, LIVE_MAINNET_PATH), JSON.stringify(live()));
    expect(Evidence.parse(loadLive(root))).toEqual(live());
  });

  it("never shows sandbox-mode or unhashed live evidence as mainnet", () => {
    const cases: [string, unknown, string][] = [
      ["sandbox mode", live({ mode: "sandbox" }), 'its mode is &quot;sandbox&quot;, not &quot;mainnet&quot;'],
      ["testnet chain", live({ environment: { chain_id: "testnet" } }), "its chain id is &quot;testnet&quot;"],
      ["fake hash", live({ receipts: [{ label: "trade (SYNTHETIC)", tx_hash: "HASH1", outcome: "success", detail: {} }] }), "has no NEAR transaction hash"],
      ["no hash", live({ receipts: [{ label: "trade (SYNTHETIC)", outcome: "success", detail: {} }] }), "has no NEAR transaction hash"],
      ["no receipts", live({ receipts: [] }), "it has no receipts"],
    ];
    for (const [, ev, reason] of cases) {
      const html = renderHtml(specimen(), { acceptance: null, live: ev });
      expect(html).toContain("is not mainnet evidence");
      expect(html).toContain(reason);
      noMainnet(html);
    }
    expect(() => renderHtml(specimen(), { live: { mode: "mainnet" } })).toThrow(/live evidence failed schema validation/);
  });

  it("never shows an inconclusive or executed relay as a successful revocation test", () => {
    for (const passed of [true, false]) {
      const html = renderHtml(specimen(), { acceptance: null, live: withRelay("inconclusive", passed) });
      expect(html).toContain('<span class="status inconclusive">revocation test inconclusive</span>');
      expect(html).toContain('<span class="status inconclusive">inconclusive: not evidence that revocation stopped the withheld order</span>');
      expect(html).not.toContain("revocation test passed");
      expect(html).not.toContain("withheld order rejected after confirmed revocation");
    }
    const executed = renderHtml(specimen(), { acceptance: null, live: withRelay("executed", true) });
    expect(executed).toContain("revocation test failed");
    expect(executed).not.toContain("revocation test passed");
    const unverified = renderHtml(specimen(), { acceptance: null, live: withRelay("rejected_revoked_key", false) });
    expect(unverified).toContain("revocation test failed");
    expect(unverified).not.toContain("revocation test passed");
    const unknown = renderHtml(specimen(), { acceptance: null, live: withRelay("rejected", true) });
    expect(unknown).toContain("revocation test inconclusive");
    expect(renderHtml(specimen(), { acceptance: null, live: live() })).toContain("revocation test not run");
  });

  it("renders mainnet receipts with explorer links and read-only commands", () => {
    const ev = withRelay("rejected_revoked_key", true);
    const html = renderHtml(specimen(), { acceptance: null, live: ev });
    expect(html).toContain('<span class="status success">revocation test passed</span>');
    expect(html).toContain("withheld order rejected after confirmed revocation (rejected_revoked_key)");
    expect(html).toContain('class="mode mainnet"');
    expect(html).not.toContain(PENDING);
    for (const r of ev.receipts) {
      expect(isTxHash(r.tx_hash ?? "")).toBe(true);
      expect(html).toContain(`href="https://nearblocks.io/txns/${r.tx_hash ?? ""}"`);
      expect(html).toContain(escapeHtml(`"tx_hash":"${r.tx_hash ?? ""}","sender_account_id":"owner.synthetic.near"`));
    }
    expect(html).toContain("0.001000 NEAR");
    expect(html).toContain(escapeHtml('"method_name":"get_grant"'));
    // The only external links are explorer links and the source repository; nothing is loaded from the network.
    expect(html).not.toMatch(/\bsrc=["']?(https?:)?\/\//i);
    for (const m of html.matchAll(/href="(https?:[^"]*)"/g)) if (m[1] !== REPO_URL) expect(m[1]).toMatch(/^https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("shows a stopped mainnet run as stopped", () => {
    const html = renderHtml(specimen(), { acceptance: null, live: live({ unknowns: ["run stopped: SYNTHETIC ambiguous outcome"] }) });
    expect(html).toContain("run stopped: run stopped: SYNTHETIC ambiguous outcome");
    expect(html).not.toContain("The run completed every manifest step");
    expect(html).not.toContain("revocation test passed");
  });
});

describe("evidence page: outcome, withheld identity and sandbox cases", () => {
  const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
  const stages = (h: string): string[] => [...h.matchAll(/<li class="stage ([a-z]+) ([a-z-]+)"/g)].map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`);
  const withObserved = (ev: Evidence, id: string, edit: (o: Record<string, unknown>) => Record<string, unknown>): Evidence => ({
    ...ev,
    assertions: ev.assertions.map((a) => (a.id === id ? { ...a, observed: edit(a.observed as Record<string, unknown>) } : a)),
  });

  it("states the agent's objective as its instruction, not a contract rule, and shows the allocation from recorded balances", () => {
    expect(html).toContain(escapeHtml("“keep the portfolio near 50% USDC / 50% wNEAR by USD value”"));
    expect(html).toContain("not a rule the contract enforces");
    expect(html).toContain("Nothing here claims a profit.");
    // Independent derivation in micro-dollars from the SYNTHETIC raw inputs and reference ($1.00, $3.00).
    const s = STORY;
    const micro = (u: bigint, w: bigint) => ({ u: u * 1n, w: (w * 3n * 10n ** 6n) / 10n ** 24n });
    const pctOf = (v: { u: bigint; w: bigint }) => {
      const h = (v.u * 20_000n / (v.u + v.w) + 1n) / 2n;
      return `${String(h / 100n)}.${String(h % 100n).padStart(2, "0")}%`;
    };
    const before = micro(s.before.usdc, s.before.wnear);
    const after = micro(s.before.usdc - s.sell, s.before.wnear + s.buy);
    expect(pctOf(before)).toBe("86.96%");
    for (const text of [pctOf(before), pctOf(after), "$2,300.00", "$2,299.66", "USDC $1, wNEAR $3", "not a measure of profit or loss", `${pctOf(before)} → ${pctOf(after)} (target 50%`]) {
      expect(html).toContain(escapeHtml(text));
    }
    const older = renderHtml(olderStoryEvidence(), { acceptance: null, live: null });
    expect(older).toContain("Allocation not shown: this evidence lacks the grant&#39;s initial reference prices (grant-active).");
  });

  it("shows the withheld order's identity, simulation, removal, rejection and recovery", () => {
    for (const text of [
      "SYNTHETICnonce",
      "9".repeat(64),
      "8".repeat(64),
      new Date(Number(STORY.deadlineNs / 1_000_000n)).toISOString(),
      "the verifier&#39;s simulation (simulate_intents) accepts this exact bundle",
      "ed25519:SYNTHETICkeySYNTHETICkey",
      "SYNTHETICblock at ",
      "yes (bundle sha256 matches)",
      "rejected 37 s before its deadline",
    ]) expect(html).toContain(text);
    expect(stages(html).every((s) => s.endsWith(" held"))).toBe(true);
  });

  it("keeps older evidence without the identity held, and says what is not recorded", () => {
    const older = renderHtml(olderStoryEvidence(), { acceptance: null, live: null });
    // An older demo never opened the console: its review is inconclusive and its revocation is a direct owner call.
    expect(stages(older).filter((s) => !s.endsWith(" held"))).toEqual(["console inconclusive"]);
    expect(older).toContain(escapeHtml("inconclusive: this evidence records no values read from the rendered console"));
    expect(older).toContain(escapeHtml("a direct owner call (not through the console)"));
    expect(older).not.toContain(escapeHtml(OWNER_CONTROLS_LABEL));
    expect(older).toContain("order nonce, deadline and bundle hash are not recorded in this evidence");
    expect(older).toContain("Block time before relay");
    expect(older).toContain(escapeHtml("rejected 38 s before its deadline"));
  });

  it("narrates a malformed signature or an order expired at its rejection block as inconclusive, never as rejection by revocation", () => {
    // SYNTHETIC: the demo marks both as not held (relayRejectionProblems); the page must not narrate them as evidence.
    const malformed = withObserved(storyEvidence(), "withheld-rejected", (o) => ({ ...o, error: "SYNTHETIC Smart contract panicked: invalid signature" }));
    const expiredAtBlock = withObserved(storyEvidence(), "withheld-rejected", (o) => ({
      ...o,
      relay_block_time_ns: (STORY.deadlineNs - 1_000_000_000n).toString(),
      verifier_receipt: { id: "SYNTHETICreceipt", block_hash: "SYNTHETICblock", block_time_ns: (STORY.deadlineNs + 500_000_000n).toString() },
    }));
    const atDeadline = withObserved(storyEvidence(), "withheld-rejected", (o) => ({
      ...o,
      relay_block_time_ns: (STORY.deadlineNs - 1_000_000_000n).toString(),
      verifier_receipt: { id: "SYNTHETICreceipt", block_hash: "SYNTHETICblock", block_time_ns: STORY.deadlineNs.toString() },
    }));
    const cases: [Evidence, string][] = [
      [malformed, "the verifier error does not name the removed grant key"],
      [expiredAtBlock, "the withheld order was relayed 0.5 s after its deadline"],
      [atDeadline, "the recorded relay time equals the order deadline. This demonstration requires a positive margin before the deadline"],
    ];
    for (const [ev, reason] of cases) {
      const failed = { ...ev, assertions: ev.assertions.map((a) => (a.id === "withheld-rejected" ? { ...a, passed: false } : a)) };
      const h = renderHtml(failed, { acceptance: null, live: null });
      expect(stages(h)).toContain("rejected inconclusive");
      expect(h).toContain(escapeHtml(reason));
      expect(h).toContain("withheld-rejected</a> <strong>did not hold</strong>");
      expect(h).not.toMatch(/rejected -?\d+ s before its deadline/);
      expect(h).not.toContain(escapeHtml("The verifier rejects it: the signing key no longer exists."));
    }
  });

  it("narrates a console review that differs from the chain as inconclusive, and a failed console revocation as not held", () => {
    const differs = withObserved(storyEvidence(), "console-review", (o) => ({ ...o, mismatches: ["grant status: console shows \"active\", chain \"revoked\""] }));
    const h = renderHtml(differs, { acceptance: null, live: null });
    expect(stages(h)).toContain("console inconclusive");
    expect(h).toContain(escapeHtml("the console showed values that differ from the chain"));
    const ev = storyEvidence();
    const twice = { ...ev, assertions: ev.assertions.map((a) => (a.id === "revoke-through-console" ? { ...a, passed: false } : a)) };
    const t = renderHtml(twice, { acceptance: null, live: null });
    expect(stages(t)).toContain("revoked failure");
    expect(t).toContain("revoke-through-console</a> <strong>did not hold</strong>");
  });

  it("narrates as inconclusive a rejection that does not name the key, a different bundle, or a different simulated order", () => {
    const cases: [Evidence, string, string][] = [
      [withObserved(storyEvidence(), "withheld-rejected", (o) => ({ ...o, error: "SYNTHETIC invalid signature" })), "rejected inconclusive", "the verifier error does not name the removed grant key"],
      [withObserved(storyEvidence(), "withheld-rejected", (o) => ({ ...o, bundle_sha256: "7".repeat(64) })), "rejected inconclusive", "the relayed bundle is not the simulated bundle"],
      [withObserved(storyEvidence(), "withheld-executable", (o) => ({ ...o, order_id: "8" })), "withheld inconclusive", "the simulated order 8 is not the signed order 7"],
      [withObserved(storyEvidence(), "withheld-executable", (o) => ({ ...o, signing_public_key: "ed25519:OTHER" })), "withheld inconclusive", "the withheld order was not signed by the grant key"],
    ];
    for (const [ev, stage, reason] of cases) {
      const h = renderHtml(ev, { acceptance: null, live: null });
      expect(stages(h)).toContain(stage);
      expect(h).toContain(escapeHtml(reason));
    }
  });

  it("heads the page with the lead line and the two sentences", () => {
    expect(html).toContain('<p class="kicker">Bounded Mandate: AI trading on NEAR Intents without a signing key</p>\n<h1 class="lead-line">Give an AI agent trading power. Keep the power to stop it.</h1>');
    expect(html).not.toMatch(/keyless|No key\b|without a key|holds no key/i);
    expect(html).toContain(
      `<p class="position lead-sub">${escapeHtml("An AI agent trades your treasury on NEAR Intents without holding a signing key. A contract signs each order inside your limits; one owner call voids every signed order that has not executed, and recovery returns the funds without the agent.")}</p>`,
    );
    expect(html).not.toContain("Revoke the entire grant—including outstanding signed orders");
    // No instant-revocation, first/only, profit or guaranteed-loss wording in the first screen.
    const first = html.slice(html.indexOf("<h1 "), html.indexOf("</p>", html.indexOf('class="journey-note"')));
    expect(first).not.toMatch(/\binstant(ly)? revo|revokes? instantly|\bthe (first|only)\b|\bprofit|guarantee/i);
  });

  it("places the verification panel and the sandbox cases between the mainnet section and the demonstration", () => {
    const at = (id: string) => html.indexOf(`id="${id}"`);
    expect(at("mainnet")).toBeLessThan(at("verify"));
    expect(at("verify")).toBeLessThan(at("regrant"));
    expect(at("regrant")).toBeLessThan(at("demo"));
    expect(html).toContain("No acceptance run is attached, so no case report is shown.");
  });

  const report = (id: string, data: unknown, over: Record<string, unknown> = {}): { file: string; text: string } => {
    const [gate, kase] = id.split(".") as [string, string];
    return {
      file: `${id}.json`,
      text: `${JSON.stringify({ schema: "bounded-mandate/gate-report/2", gate, case: kase, passed: true, mode: "sandbox", run_id: "run-SYNTHETIC", source: { revision: REV, dirty: false }, spec_sha256: "b".repeat(64), fixture_manifest_sha256: "d".repeat(64), wasm_sha256: {}, command: "SYNTHETIC", generated_at_unix: 1, data, ...over }, null, 2)}\n`,
    };
  };
  const t1 = { relays: [{ label: "SYNTHETIC-before", order_id: 0, epoch: 1, after_confirmed_removal: false, executed: true }, { label: "SYNTHETIC-after", order_id: 1, epoch: 1, after_confirmed_removal: true, executed: false }, { label: "SYNTHETIC-regrant", order_id: 1, epoch: 1, after_confirmed_removal: true, executed: false }], executions_after_confirmed_removal: 0 };
  const t2b = { mechanism: "SYNTHETIC mechanism text", steps: [{ order: 0, phase: "SYNTHETIC disclosed", accounted: true }, { order: 0, phase: "independent relay", executed: true }, { order: 1, phase: "relay after confirmed removal", executed: false, state: "released:key_removed" }] };
  const reports = [report("T1.withheld-regrant", t1), report("T2b.disclosed-relay", t2b), report("T2b.callback-failed-after-disclosure", t2b)];

  it("separates legitimate completions, hostile requests and the revocation comparison, using only bound reports", () => {
    const legitimate = { origin: "scripted", attempted: 2, completed: 2, authorization_refused: 0, execution_failed: 0, settlement_failed: 0, setup_failed: 0 };
    const results = [{ passed: true, contained: true, origin: "injected-request" }, { passed: true, contained: true, origin: "scripted-direct" }];
    const stopped = [{ executed: false }, { executed: false }, { executed: false }];
    const executed = stopped.map(() => ({ executed: true }));
    const scenario = (strategy: string, signatures: number, relays: typeof stopped, resume: object) => ({ strategy, account_key_signatures_for_the_action: signatures, withheld_relays_after_action: relays, unrecorded_order_stopped_before_its_deadline: !relays[2]?.executed, resume });
    const alternatives = { withheld_orders: "SYNTHETIC three orders", strategies: [
      scenario("cancel complete nonce list", 3, stopped, { same_key_new_order: { executed: true } }),
      scenario("remove key, same key re-added", 0, executed, { while_removed: stopped }),
    ] };
    const hashes = { wasm_sha256: { bounded_mandate: WASM.bounded_mandate } };
    const gateReports = [report("T3.concession", { legitimate }, hashes), report("BOUNDARY.attacks", { suite: { results } }, hashes), report("COMPARE.revocation-alternatives", alternatives, hashes)];
    const html = renderHtml(storyEvidence(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", reports: gateReports });
    expect(html.match(/<p class="result-number">2 \/ 2<\/p>/g)).toHaveLength(2);
    expect(html).toContain("0 authorization refusals");
    expect(html).toContain("<th scope=\"row\">cancel complete nonce list</th><td>3</td><td>0 / 3</td>");
    expect(html).toContain("0 / 3 executed while the key was absent.");
    expect(html).toContain("3 / 3 after re-add");
    expect(html).toContain("A complete nonce list and an available signer can cancel every listed order.");
    const invalidReports = [
      report("T3.concession", { legitimate }, { ...hashes, run_id: "run-STALE" }),
      report("BOUNDARY.attacks", { suite: { results } }, { wasm_sha256: { bounded_mandate: "8".repeat(64) } }),
      ...gateReports.slice(2), ...gateReports.slice(2),
    ];
    const unavailable = renderHtml(storyEvidence(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", reports: invalidReports });
    expect(unavailable).not.toContain('class="result-number"');
    expect(unavailable).toContain("No certified revocation comparison is attached to this replay.");
    const stale = renderHtml(storyEvidence(), { acceptance: acceptance(), latestRunId: "run-STALE", reports: gateReports });
    expect(stale).not.toContain('class="result-number"');
    expect(stale).toContain("No certified revocation comparison is attached to this replay.");
  });

  it("summarizes each regrant and disclosure case from its own report, embedded verbatim with its sha256", () => {
    const h = renderHtml(specimen(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: null, reports });
    expect(h.match(/sandbox acceptance test - not part of the mainnet sequence/g)).toHaveLength(3);
    expect(h).toContain("2 relays after confirmed key removal (SYNTHETIC-after, SYNTHETIC-regrant): 0 executions.");
    expect(h).toContain("1 relay without confirmed removal of its own key (SYNTHETIC-before): 1 execution, recorded honestly.");
    expect(h).toContain("2 independent relays: 1 executed");
    expect(h).toContain("1 relay after confirmed removal: 0 executions.");
    expect(h).toContain("<strong>Mechanism (recorded):</strong> SYNTHETIC mechanism text");
    for (const r of reports) {
      expect(h).toContain(createHash("sha256").update(r.text).digest("hex"));
      expect(h).toContain(escapeHtml(r.text));
    }
    expect(h).toContain("released:key_removed");
  });

  it("does not show a report from another run, a missing report or an uncertified pass as evidence", () => {
    const other = [report("T1.withheld-regrant", t1, { run_id: "run-OTHER" }), ...reports.slice(1)];
    const h = renderHtml(specimen(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: null, reports: other });
    expect(h).toContain("its run run-OTHER is not the acceptance run run-SYNTHETIC");
    expect(h).not.toContain("SYNTHETIC-after, SYNTHETIC-regrant");
    const missing = renderHtml(specimen(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: null, reports: [] });
    expect(missing).toContain("Report <code>T1.withheld-regrant.json</code> is not available to this page.");
    const uncertified = renderHtml(specimen({}, { dirty: true }), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: null, reports });
    expect(uncertified).toContain("passed, not certified for this demo</span></h3>");
  });

  it("reads the certified bundle's actual regrant and disclosure reports", () => {
    const bundle = join(repo, "evidence/7fc3f90");
    const acc = JSON.parse(readFileSync(join(bundle, "acceptance.json"), "utf8")) as Acceptance;
    const files = ["T1.withheld-regrant.json", "T2b.disclosed-relay.json", "T2b.callback-failed-after-disclosure.json"].map((file) => ({ file, text: readFileSync(join(bundle, "tests", file), "utf8") }));
    const ev = Evidence.parse(JSON.parse(readFileSync(join(bundle, "demo.json"), "utf8")));
    const h = renderHtml(ev, { acceptance: acc, latestRunId: acc.run_id, live: null, reports: files });
    const relays = (JSON.parse(files[0]?.text ?? "") as { data: { relays: { after_confirmed_removal: boolean; executed: boolean }[] } }).data.relays;
    const after = relays.filter((r) => r.after_confirmed_removal);
    expect(h).toContain(`${String(after.length)} relays after confirmed key removal`);
    expect(h).toContain(`: ${String(after.filter((r) => r.executed).length)} executions.`);
    expect(h).not.toContain("not shown as evidence");
    expect(h.match(/recorded result: <span class="status success">passed<\/span>/g)).toHaveLength(3);
  });
});

describe("evidence page: journey, attack log, withdrawal and planned URLs", () => {
  const stages = (h: string): string[] => [...h.matchAll(/<li class="stage ([a-z]+) ([a-z-]+)"/g)].map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`);
  const stageHtml = (html: string, key: string): string => {
    const start = html.indexOf(`id="stage-${key}"`);
    return html.slice(start, html.indexOf("</li>", start));
  };
  const section = (html: string, id: string): string => {
    const start = html.indexOf(`id="${id}"`);
    return html.slice(start, html.indexOf("</section>", start));
  };

  it("follows the grant with the console review read from the rendered console, and labels the console revocation", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    const card = stageHtml(html, "console");
    const shown = CONSOLE_RENDERED;
    for (const text of [
      `grant ${shown.grant_status} · key registered · ${shown.mandate_balances.USDC} USDC + ${shown.mandate_balances.wNEAR} wNEAR`,
      "final block #42 of the sandbox",
      "owner.synthetic",
      "propose_order on mandate.synthetic",
      shown.screenshot.path,
      OWNER_CONTROLS_LABEL,
      "not rendered by this run",
      `Console (${PLANNED_LABEL})`,
      PLANNED_URLS.console,
      bundlePaths(storyEvidence().source.product_commit).console,
      CONSOLE_BROWSER_LABEL,
    ]) {
      expect(card).toContain(escapeHtml(text));
    }
    expect(card).toContain("grant active · key registered · open orders 0");
    const revoked = stageHtml(html, "revoked");
    for (const text of [`the console's Revoke control, ${OWNER_CONTROLS_LABEL}`, "Sign requests</dt><dd>1", CONSOLE_REVOKE.tx_hash]) expect(revoked).toContain(text.includes("<") ? text : escapeHtml(text));
  });

  it("separates the owner's withdrawal from recovery, with registration only where it was needed", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    const recovered = stageHtml(html, "recovered");
    const withdrawn = stageHtml(html, "withdrawn");
    expect(recovered).toContain("ordinary recovery (not the owner-key rescue)");
    expect(recovered).not.toContain("ft_withdraw");
    expect(recovered).toContain(escapeHtml("owner.synthetic (owner's Intents account, not an external wallet)"));
    expect(withdrawn).toContain("owner action, outside recovery claims");
    expect(withdrawn).toContain(escapeHtml("outside the mandate contract and every recovery claim"));
    expect(withdrawn).toContain("1,987.66 USDC withdrawn; already registered");
    expect(withdrawn).toContain(`104.0000 wNEAR withdrawn; registered first (tx ${escapeHtml(txHash("owner storage_deposit on wnear token").slice(0, 6))}`);
    // The withdrawal receipts bind to the withdrawal stage, never to recovery.
    const ev = storyEvidence();
    const ft = ev.receipts.findIndex((r) => r.label.startsWith("owner ft_withdraw"));
    expect(withdrawn).toContain(`href="#tx-${String(ft)}"`);
    expect(recovered).not.toContain(`href="#tx-${String(ft)}"`);
  });

  it("narrates a failed withdrawal as failed, with the balance it left in the owner's Intents account", () => {
    const ev = storyEvidence();
    const failed: Evidence = {
      ...ev,
      assertions: ev.assertions.map((a) => {
        if (a.id !== "owner-withdrawal") return a;
        const o = a.observed as { assets: Record<string, unknown>[] };
        const wnearFailed = { ...o.assets[1], attempts: [1, 2].map((n) => ({ tx_hash: `SYNTHETICfail${String(n)}`, success: false, returned: "0", intents_after: (STORY.before.wnear + STORY.buy).toString(), near_after: "0", error: "SYNTHETIC refunded" })), outcome: "failed" };
        return { ...a, passed: false, observed: { ...o, assets: [o.assets[0], wnearFailed] } };
      }),
    };
    const html = renderHtml(failed, { acceptance: null, live: null });
    expect(stages(html)).toContain("withdrawn failure");
    const card = stageHtml(html, "withdrawn");
    expect(card).toContain("did not hold: owner-withdrawal");
    expect(card).toContain("failed: SYNTHETIC refunded");
    expect(card).not.toContain(escapeHtml("to owner.synthetic's NEAR account"));
    const caption = revocationStory(failed).find((st) => st.key === "withdrawn")?.caption ?? "";
    expect(caption).toContain("wNEAR withdrawal failed after 2 attempts (SYNTHETIC refunded); 104.0000 wNEAR stays in the owner's Intents account");
    expect(caption).not.toContain("the owner withdraws");
  });

  it("lists each hostile request under the enforcement layer it actually reached, with its returned text and source", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    const log = section(html, "attacks");
    for (const [layer, n] of [["Local validation", 1], ["Agent key permission", 1], ["Contract method check", 1], ["Policy validation", 1], ["Verifier", 1]] as const) {
      expect(log).toContain(`<h3>${layer}: ${String(n)} of ${String(n)} refused`);
    }
    expect(log).toContain("contract/src/lib.rs:905");
    expect(log).toContain("per-order cap exceeded");
    expect(log).toContain("sandbox tx <code class=\"mono\">SYNTHETICattacktx3</code>");
    expect(log).toContain("no transaction: refused before inclusion");
    expect(log).toContain("synthetic injected request");
    expect(log).toContain("recorded genuine model output");
    // The layer comes from the observed boundary, not from the expectation in the description.
    const ev = storyEvidence();
    const moved = { ...ev, assertions: ev.assertions.map((a) => (a.id === "attack-direct-over-cap" ? { ...a, passed: false, observed: { ...(a.observed as object), observed: "not-stopped", contained: false } } : a)) };
    const movedLog = section(renderHtml(moved, { acceptance: null, live: null }), "attacks");
    expect(movedLog).toContain("<h3>Not stopped: 0 of 1 refused");
    expect(movedLog).toContain("state changed");
    expect(movedLog).not.toContain("<h3>Policy validation");
    expect(stages(renderHtml(moved, { acceptance: null, live: null }))).toContain("attacks failure");
  });

  it("derives the attack log from older evidence without the new fields, and says what is not recorded", () => {
    const ev = storyEvidence();
    const older = { ...ev, assertions: ev.assertions.map((a) => (a.id.startsWith("attack-") ? { ...a, observed: { observed: (a.observed as { observed: string }).observed, contained: true } } : a)) };
    const log = section(renderHtml(older, { acceptance: null, live: null }), "attacks");
    expect(log).toContain("<h3>Policy validation: 1 of 1 refused");
    expect(log).toContain("not recorded");
  });

  it("uses no verified or live wording for sandbox data in the journey and the attack log", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    for (const part of [section(html, "story"), section(html, "attacks")]) expect(part).not.toMatch(/\bverified\b|\blive\b|\bmainnet receipt/i);
  });

  it("says where the page, console and cuts are served and where they are in a clone, never whether they are published", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    const clone = bundlePaths(storyEvidence().source.product_commit);
    expect(PLANNED_LABEL).toBe("hosted site");
    expect(PLANNED_URLS.video).toBe(`${PLANNED_URLS.page}video/bounded-mandate-short.mp4`);
    expect(PLANNED_URLS.walkthrough).toBe(`${PLANNED_URLS.page}video/bounded-mandate-demo.mp4`);
    expect(clone).toEqual({ page: "evidence/aaaaaaa/page/index.html", console: "evidence/aaaaaaa/console/index.html", video: "evidence/aaaaaaa/video/bounded-mandate-short.mp4", walkthrough: "evidence/aaaaaaa/video/bounded-mandate-demo.mp4" });
    for (const path of Object.values(clone)) expect(html).toContain(`<code>${path}</code>`);
    // Links to the site's own routes are relative, so the same bytes work under the project path.
    expect(html).not.toMatch(/href="https:\/\/gryyny\.github\.io/);
    for (const route of Object.values(SITE_PATHS)) expect(html).toContain(`<a href="${route}">`);
    expect(html).toContain(`<a href="${REPO_URL}" rel="noopener noreferrer">`);
    // Outside the raw recorded detail (which shows what the run recorded), nothing states a publication state.
    const prose = html.replace(/<details[\s\S]*?<\/details>/g, "");
    expect(prose).not.toMatch(/unpublished|not (yet )?published|planned, |Nothing was hosted|not hosted|is published|is live\b/i);
    for (const m of prose.matchAll(/gryyny\.github\.io[^<"]*/g)) expect(prose.slice(Math.max(0, m.index - 200), m.index + 200)).toContain(PLANNED_LABEL);
    // Evidence up to 0bcb3f4 recorded the earlier label; both parse, and a new run records the state-independent one.
    const view = (label: string): boolean => ConsoleReview.shape.view.safeParse({ local_path: null, planned_url: PLANNED_URLS.console, planned_label: label }).success;
    expect(view("planned, unpublished") && view(PLANNED_LABEL)).toBe(true);
  });

  it("compares the Agent API's routes from pinned, dated documentation, as text and without a tested-weakness claim", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    const part = section(html, "agent-api");
    expect(part).toContain("Related design: the NEAR Intents Agent API");
    expect(part).toContain(`commit <code>${AGENT_API_EXAMPLES.commit}</code>`);
    // The commit read on 2026-11-06 (README source 9), pinned independently of the constant.
    expect(part).toContain("commit <code>25528957276e18ec933eb7d6e8e5c59a5fe033c4</code>");
    expect(part).toContain(escapeHtml(AGENT_API_EXAMPLES_URL));
    expect(AGENT_API_EXAMPLES_URL).toContain(`/blob/${AGENT_API_EXAMPLES.commit}/07-native-accounts/README.md#L`);
    expect(part).toContain(`read ${AGENT_API_EXAMPLES.read}`);
    for (const route of ["evm/sign-intent", "solana/sign-intent", "POST /v1/agents/{agent_id}/swap"]) expect(part).toContain(`<code>${escapeHtml(route)}</code>`);
    expect(part).toContain(escapeHtml(AGENT_API_QUOTE));
    expect(AGENT_API_QUOTE.split(" ").length).toBeLessThan(15);
    expect(part).toContain("Documentation evidence, not a tested weakness.");
    expect(part).toContain("ordinary hosted execution is not described this way");
    expect(part).toContain("Any integration of the two is proposed, not built");
    // Sources are text: the page links to no documentation or repository.
    expect(part).not.toMatch(/href="https?:/);
    // It sits after the matched baseline and before the claim and limits.
    expect(html.indexOf('id="baseline"')).toBeLessThan(html.indexOf('id="agent-api"'));
    expect(html.indexOf('id="agent-api"')).toBeLessThan(html.indexOf('id="limits"'));
  });

  it("labels TypeScript unit-test case reports honestly", () => {
    const cases = allCases().map((c) => (c.gate === "AGENT" ? { ...c, mode: "unit" } : c));
    const html = page(acceptance({ cases }));
    expect(html).toContain("TypeScript unit test (no VM, chain or model)");
  });
});

describe("evidence page: the owner's journey on the first screen", () => {
  const journey = (h: string): string[] => [...h.matchAll(/<li class="jstep ([a-z]+) ([a-z-]+)"/g)].map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`);
  const card = (h: string, key: string): string => {
    const start = h.indexOf(`id="journey-${key}"`);
    return h.slice(start, h.indexOf("</li>", start));
  };
  const KEYS = ["mandate", "trade", "attacks", "withheld", "revoked", "rejected", "recovered", "withdrawn"];

  it("puts the eight steps right after the lead line, before the claim, the allocation and every section", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    expect(journey(html)).toEqual(KEYS.map((k) => `${k} held`));
    const at = (needle: string) => html.indexOf(needle);
    expect(at("<h1 ")).toBeLessThan(at('class="journey"'));
    expect(at('class="journey"')).toBeLessThan(at("Claim: the mandate contract"));
    expect(at('class="journey"')).toBeLessThan(at('class="outcome"'));
    expect(at('id="journey-withdrawn"')).toBeLessThan(at('id="story"'));
    expect([...html.matchAll(/<span class="jn" aria-hidden="true">([0-9])<\/span>/g)].map((m) => m[1])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect([...html.matchAll(/aria-label="(Step [0-9] detail)">detail<\/a>/g)].map((m) => m[1])).toEqual(KEYS.map((_, i) => `Step ${String(i + 1)} detail`));
  });

  it("opens recorded state and evidence from the eight replay steps without adding a script", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    expect(html.match(/<details class="replay" name="owner-replay">/g)).toHaveLength(8);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(card(html, "withheld")).toContain('href="#stage-withheld">evidence and receipts</a>');
    expect(card(html, "withheld")).toContain("<dt>Deadline</dt>");
    expect(card(html, "revoked")).toContain("<span>Recorded state after</span> grant revoked · key removed");
    expect(card(html, "recovered")).toContain("owner Intents 1,987.66 USDC + 104.0000 wNEAR");
  });

  it("labels the trade a scripted proposal when the replayed model declined", () => {
    const ev = storyEvidence();
    const declined = Evidence.parse({
      ...ev,
      receipts: ev.receipts.map((r) => (r.label === "agent propose_order (first order)" ? { ...r, detail: { proposal_source: "scripted" } } : r)),
      assertions: ev.assertions.map((a) =>
        a.id === "model-proposal-on-chain" ? { ...a, passed: false, observed: { ...(a.observed as object), decision: { model: STORY.model, decision_text: JSON.stringify({ action: "decline", reason: "SYNTHETIC decline" }), adapter_verdict: { kind: "decline", reason: "SYNTHETIC decline" } } } } : a,
      ),
    });
    const html = renderHtml(declined, { acceptance: null, live: null });
    const trade = card(html, "trade");
    expect(trade).toContain("scripted proposal");
    expect(trade).toContain("did not hold");
    expect(trade).not.toContain("recorded genuine model output");
    expect(trade).not.toContain(STORY.model);
    const proposal = html.match(/<li class="failure"[^>]*><div class="step-head"><strong>Bounded agent proposal[^<]+<\/strong>.*?<\/div>/)?.[0];
    expect(proposal).toContain("scripted proposal");
    expect(proposal).not.toContain("recorded genuine model output");
    expect(html).not.toContain('<span class="mode recorded-model">recorded model output</span>');
    expect(html).not.toMatch(/the trade proposal is recorded model output|the model step replays a recorded genuine model response/i);
    expect(html).toContain("recorded prompt-injection response");
  });

  it("states each step's recorded outcome with readable amounts and its labels", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    // Expected amounts derived from the SYNTHETIC raw inputs: 12.34 USDC sold for 4 wNEAR; 5 wNEAR withheld for 14.99 USDC.
    const want: [string, string[]][] = [
      ["mandate", ["reviewed", "$2,300.00 under mandate at the sandbox's reference prices; each order at most 20% ($460.00), price concession at most 0.5%", "read in the owner console: grant active, key registered", CONSOLE_BROWSER_LABEL]],
      ["trade", ["executed", "sold 12.34 USDC for 4 wNEAR, as signed; proposed by recorded synthetic-model-1 output (replayed)", "recorded genuine model output"]],
      ["attacks", ["refused", `${String(ATTACKS.length)} of ${String(ATTACKS.length)} scripted hostile requests refused, no state changed`, "scripted attacks"]],
      ["withheld", ["signed, held back", "order id 7: 5 wNEAR for 14.99 USDC, signed by the grant key ed25519:SYNTHE…Ckey and held back; the verifier's simulation accepts it (bundle sha256 99999999…)", "scripted proposal"]],
      ["revoked", ["removal confirmed", "revoked in the owner console, signed by the local sandbox test signer (not a wallet); key removal confirmed", OWNER_CONTROLS_LABEL]],
      ["rejected", ["rejected", "the same bundle (sha256 99999999…), relayed by another account 37 s before its deadline; the verifier rejects it because the signing key no longer exists"]],
      ["recovered", ["recovered", "1,987.66 USDC and 104 wNEAR to the owner's Intents account, with the oracle failing and the MPC test double on hold", "ordinary recovery (not the owner-key rescue)"]],
      ["withdrawn", ["withdrawn", "1,987.66 USDC and 104 wNEAR from the owner's Intents account to its NEAR account", "owner action, outside recovery claims"]],
    ];
    for (const [key, texts] of want) for (const t of texts) expect(card(html, key)).toContain(escapeHtml(t));
    // Raw base units stay in the detail sections, not in the journey.
    for (const key of KEYS) expect(card(html, key)).not.toMatch(/[0-9]{9,}/);
    expect(html).toContain("Revocation is not instant: orders may execute while it is pending");
    // Sandbox execution, recorded model output, provider calls and mainnet receipts are labelled apart.
    const replayed = renderHtml(Evidence.parse({ ...storyEvidence(), environment: { ...storyEvidence().environment, model_mode: "recorded-model" } }), { acceptance: null, live: null });
    for (const label of ['<span class="mode sandbox" title="execution mode">sandbox</span>', '<span class="mode recorded-model">recorded model output</span>', '<span class="mode pending">provider calls: none</span>', '<span class="mode pending">mainnet: none</span>']) {
      expect(replayed).toContain(label);
    }
    const withoutMode = Object.fromEntries(Object.entries(storyEvidence().environment).filter(([k]) => k !== "model_mode"));
    expect(renderHtml(Evidence.parse({ ...storyEvidence(), environment: withoutMode }), { acceptance: null, live: null })).not.toContain("provider calls: none");
    expect(html.indexOf("Revocation is not instant")).toBeLessThan(html.indexOf('id="story"'));
  });

  it("never shows a success word for a step that did not hold, was inconclusive or is missing", () => {
    const ev = storyEvidence();
    const failed = { ...ev, assertions: ev.assertions.map((a) => (a.id === "revoke-through-console" ? { ...a, passed: false } : a)) };
    const f = renderHtml(failed, { acceptance: null, live: null });
    expect(journey(f)).toContain("revoked failure");
    expect(card(f, "revoked")).toContain("did not hold");
    expect(card(f, "revoked")).not.toContain("removal confirmed");

    const expired = renderHtml(expiredStoryEvidence(), { acceptance: null, live: null });
    expect(journey(expired)).toContain("rejected inconclusive");
    expect(card(expired, "rejected")).toContain('<span class="status inconclusive">inconclusive</span>');
    expect(card(expired, "rejected")).toContain(escapeHtml("inconclusive: the withheld order was relayed 4.5 s after its deadline"));
    expect(card(expired, "rejected")).not.toContain(">rejected</span>");
    expect(card(expired, "rejected")).not.toMatch(/before its deadline/);
    // The step's title does not claim the outcome either.
    expect(card(expired, "rejected")).toContain('<span class="jtitle">The withheld order relayed</span>');
    expect(card(expired, "rejected")).not.toContain("The same order is rejected");
    expect(card(f, "revoked")).toContain('<span class="jtitle">Owner revocation</span>');

    // A two-stage step takes the worst outcome: an inconclusive console review leaves step 1 inconclusive.
    const older = renderHtml(olderStoryEvidence(), { acceptance: null, live: null });
    expect(journey(older)[0]).toBe("mandate inconclusive");
    expect(card(older, "mandate")).not.toContain(">reviewed</span>");

    // A stage whose checks held but whose outcome values are absent shows no success status either.
    const unbuilt = { ...ev, assertions: ev.assertions.map((a) => (a.id === "trade-executed" ? { ...a, observed: { ...(a.observed as object), signed: { ...(a.observed as { signed: object }).signed, buy_amount: null } } } : a)) };
    const u = renderHtml(unbuilt, { acceptance: null, live: null });
    expect(journey(u)).toContain("trade missing");
    expect(card(u, "trade")).toContain('<span class="status missing">not in this evidence</span>');
    expect(card(u, "trade")).toContain("Bounded proposal and trade: its outcome values are not recorded in this evidence");
    expect(card(u, "trade")).not.toContain('class="status success"');

    // A failed stage outranks absent evidence in a two-stage step.
    const both = { ...ev, assertions: ev.assertions.filter((a) => a.id !== "console-review").map((a) => (a.id === "grant-active" ? { ...a, passed: false } : a)) };
    expect(journey(renderHtml(both, { acceptance: null, live: null }))[0]).toBe("mandate failure");

    const bare = renderHtml(specimen(), { acceptance: null, live: null });
    expect(journey(bare).every((j) => j.endsWith(" missing"))).toBe(true);
    expect(card(bare, "trade")).toContain("not in this evidence");
    expect(card(bare, "trade")).not.toContain(">executed</span>");
  });

  it("shows the withdrawal's failure on its step, and keeps it outside recovery", () => {
    const ev = storyEvidence();
    const failed: Evidence = {
      ...ev,
      assertions: ev.assertions.map((a) => {
        if (a.id !== "owner-withdrawal") return a;
        const o = a.observed as { assets: Record<string, unknown>[] };
        const wnearFailed = { ...o.assets[1], attempts: [{ tx_hash: "SYNTHETICfail", success: false, returned: "0", intents_after: (STORY.before.wnear + STORY.buy).toString(), near_after: "0", error: "SYNTHETIC refunded" }], outcome: "failed" };
        return { ...a, passed: false, observed: { ...o, assets: [o.assets[0], wnearFailed] } };
      }),
    };
    const h = renderHtml(failed, { acceptance: null, live: null });
    expect(card(h, "withdrawn")).toContain("did not hold");
    expect(card(h, "withdrawn")).toContain(escapeHtml("104.0000 wNEAR stays in the owner's Intents account"));
    expect(card(h, "withdrawn")).not.toContain(">withdrawn</span>");
    expect(card(h, "recovered")).not.toContain("ft_withdraw");
  });
});
