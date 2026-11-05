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
import { STORY, expiredStoryEvidence, olderStoryEvidence, storyEvidence, txHash } from "./video-story-specimen.js";

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

describe("evidence page: revocation story", () => {
  const stages = (html: string): string[] => [...html.matchAll(/<li class="stage ([a-z]+) ([a-z]+)"/g)].map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`);

  it("shows the seven stages in order with values bound to the evidence", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    expect(stages(html)).toEqual(["balances held", "limits held", "trade held", "withheld held", "revoked held", "rejected held", "recovered held"]);
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
      "1,987.66 USDC + 104.0000 wNEAR to the owner",
    ]) expect(html).toContain(escapeHtml(text));
    const at = (needle: string) => html.indexOf(needle);
    expect(at('id="stage-balances"')).toBeLessThan(at('id="stage-recovered"'));
    expect(at('id="story"')).toBeLessThan(at('id="paths"'));
    expect(at('id="paths"')).toBeLessThan(at('id="mainnet"'));
    expect(at('id="mainnet"')).toBeLessThan(at('id="demo"'));
  });

  it("labels each stage's mode and links every receipt to the transaction it shows", () => {
    const ev = storyEvidence();
    const html = renderHtml(ev, { acceptance: null, live: null });
    expect(html).toContain('<span class="mode recorded-model">recorded genuine model output</span>');
    expect(html).toContain('<span class="mode label">scripted proposal</span>');
    expect(html.match(/<p class="stage-modes"><span class="mode sandbox"/g)).toHaveLength(7);
    ev.receipts.forEach((_, i) => {
      expect(html).toContain(`href="#tx-${String(i)}"`);
      expect(html).toContain(`id="tx-${String(i)}"`);
    });
  });

  it("shows no numbers for a stage whose evidence is missing, and a failed check as not held", () => {
    const bare = renderHtml(specimen(), { acceptance: null, live: null });
    expect(stages(bare).every((s) => s.endsWith(" missing"))).toBe(true);
    expect(bare).toContain("Not in this evidence: assertion trade-executed");
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

  it("never marks a gate from the story", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    for (const gate of Object.keys(REQUIRED_CASES)) expect(gateStatus(html, gate)).toBe("not-run");
  });

  it("offers the three paths, with the video placeholder until hosted", () => {
    const html = renderHtml(storyEvidence(), { acceptance: null, live: null });
    expect(html).toContain('<a href="VIDEO_URL_PENDING">VIDEO_URL_PENDING</a>');
    expect(html).toContain("<code>make demo</code>, then <code>make test</code>");
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
    // The only external links are explorer links; nothing is loaded from the network.
    expect(html).not.toMatch(/\bsrc=["']?(https?:)?\/\//i);
    for (const m of html.matchAll(/href="(https?:[^"]*)"/g)) expect(m[1]).toMatch(/^https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("shows a stopped mainnet run as stopped", () => {
    const html = renderHtml(specimen(), { acceptance: null, live: live({ unknowns: ["run stopped: SYNTHETIC ambiguous outcome"] }) });
    expect(html).toContain("Run stopped: run stopped: SYNTHETIC ambiguous outcome");
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
    expect(stages(older).every((s) => s.endsWith(" held"))).toBe(true);
    expect(older).toContain("order nonce, deadline and bundle hash are not recorded in this evidence");
    expect(older).toContain("Block time before relay");
    expect(older).toContain(escapeHtml("rejected 38 s before its deadline"));
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

  it("heads the page with the README's plain claim", () => {
    expect(html).toContain("<h1>Let an AI agent trade within limits a contract enforces</h1>");
    expect(html).toContain('<p class="position">Once a revocation is confirmed, signed orders already issued fail too, and the owner takes the remaining assets back without the agent.</p>');
    expect(html).not.toContain("Revoke the entire grant—including outstanding signed orders");
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
