// SYNTHETIC specimens only: the evidence, acceptance, gate reports and mainnet-shaped evidence below are built here to
// test the landing screen and the layout choice. None was executed; the mainnet-shaped evidence never touched a chain.
// The one exception is the test that reads the committed certified bundle evidence/51d2532, labelled as such.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_CASES } from "../src/evidence/required.js";
import { ACCEPTANCE_SCHEMA, type Acceptance, type CaseResult } from "../src/evidence/schema.js";
import { PLANNED_LABEL, PLANNED_URLS } from "../src/evidence/journey.js";
import { loadReportFiles } from "../src/page/casefiles.js";
import { LEAD_LINE, PAGE_LAYOUT, POSITION } from "../src/page/landing.js";
import { escapeHtml, renderHtml } from "../src/page/render.js";
import { type Assertion, Evidence } from "../src/types.js";
import { storyEvidence, txHash } from "./video-story-specimen.js";

const REV = "a".repeat(40);
const FIXTURES = { "verifier/defuse-0.4.5.wasm": "e".repeat(64) };
const WASM = { bounded_mandate: "1".repeat(64) };
const repo = resolve(import.meta.dirname, "../..");

const allCases = (): CaseResult[] =>
  Object.entries(REQUIRED_CASES).flatMap(([gate, names]) =>
    names.map((name) => ({ id: `${gate}.${name}`, gate, case: name, status: "passed" as const, reason: "SYNTHETIC", files: [`${gate}.${name}.json`], mode: "sandbox" })),
  );

const acceptance = (): Acceptance => ({
  schema: ACCEPTANCE_SCHEMA,
  run_id: "run-SYNTHETIC",
  revision: REV,
  dirty: false,
  certified: true,
  complete: true,
  started_at: "2026-11-09T00:00:00Z",
  evaluated_at: "2026-11-09T00:10:00Z",
  hashes: { spec_sha256: "b".repeat(64), fixture_manifest_sha256: "d".repeat(64), fixtures: FIXTURES, wasm: WASM },
  environment: { os: "SYNTHETIC" },
  commands: ["make test (SYNTHETIC)"],
  cases: allCases(),
  separate: [],
  problems: [],
  ignored: [],
  baseline: null,
});

const report = (id: string, data: unknown): { file: string; text: string } => {
  const [gate, kase] = id.split(".") as [string, string];
  return {
    file: `${id}.json`,
    text: `${JSON.stringify({ schema: "bounded-mandate/gate-report/2", gate, case: kase, passed: true, mode: "sandbox", run_id: "run-SYNTHETIC", source: { revision: REV, dirty: false }, spec_sha256: "b".repeat(64), fixture_manifest_sha256: "d".repeat(64), wasm_sha256: WASM, command: "SYNTHETIC", generated_at_unix: 1, data }, null, 2)}\n`,
  };
};

// Deliberately not the certified run's numbers, so the page must read them from the report.
const OPEN = { open_orders: 7, states_before_revoke: { signed: 4, signing: 3 }, thirty_third_refused: true, released_key_removed: 7, withheld_relay_after_removal_executed: false, recovered_all_units: true, failed_removal: { grant_status: "revoking" }, successful_removal: { grant_status: "revoked", callbacks: [{ method: "on_key_removed", succeeded: true }] } };
const TRADES = { legitimate: { origin: "scripted", attempted: 3, completed: 3, authorization_refused: 0, execution_failed: 0, settlement_failed: 0, setup_failed: 0 } };
const ATTACKS = { suite: { results: [
  { passed: true, contained: true, origin: "injected-request", observed: "adapter-schema" },
  { passed: true, contained: true, origin: "scripted-direct", observed: "near-access-key" },
  { passed: true, contained: true, origin: "scripted-direct", observed: "contract-policy" },
] } };
const T1 = { relays: [{ label: "SYNTHETIC-after", order_id: 1, epoch: 1, after_confirmed_removal: true, executed: false }, { label: "SYNTHETIC-regrant", order_id: 1, epoch: 2, after_confirmed_removal: true, executed: false }], executions_after_confirmed_removal: 0 };
const REPORTS = [
  report("T3.concession", TRADES),
  report("BOUNDARY.attacks", ATTACKS),
  report("BOUNDARY.contract", { cases: [{ case: "SYNTHETIC recipient field", boundary: "json-schema", rejected_at_boundary: true }] }),
  report("T4.open-order-limit", OPEN),
  report("T1.withheld-regrant", T1),
];

const check = (id: string, description: string, passed: boolean, observed: unknown = null): Assertion => ({ id, gate: "LIVE", description, passed, observed });
/** SYNTHETIC mainnet-shaped evidence: valid-looking hashes, never executed. */
const live = (relay: string | null, over: { failedStep?: boolean; unknowns?: string[] } = {}): Evidence =>
  Evidence.parse({
    ...storyEvidence(),
    mode: "mainnet",
    command: "MANDATE_LIVE=1 make live (SYNTHETIC)",
    environment: { chain_id: "mainnet", label: "SYNTHETIC" },
    identifiers: { mandate: "mandate.synthetic.near", owner: "owner.synthetic.near" },
    receipts: [
      { label: "owner grant (SYNTHETIC)", tx_hash: txHash("grant"), block_height: 1, outcome: "success", detail: { step: 2, signer_id: "owner.synthetic.near" } },
      { label: "owner revoke (SYNTHETIC)", tx_hash: txHash("revoke"), block_height: 2, outcome: over.failedStep === true ? "failure" : "success", detail: { step: 6, signer_id: "owner.synthetic.near" } },
    ],
    assertions: [
      check("step-2-grant", "grant: terminal verification (SYNTHETIC)", true),
      check("step-6-revoke", "revoke: terminal verification (SYNTHETIC)", over.failedStep !== true),
      ...(relay === null ? [] : [check("step-7-relay_withheld", "relay_withheld (SYNTHETIC)", true, { classification: relay })]),
    ],
    unknowns: over.unknowns ?? [],
  });

const render = (liveEvidence: Evidence | null = null) => renderHtml(storyEvidence(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: liveEvidence, reports: REPORTS });
const at = (html: string, id: string): number => html.indexOf(`id="${id}"`);
const strip = (html: string): string => {
  const start = html.indexOf('<dl class="state-strip"');
  return html.slice(start, html.indexOf("</dl>", start));
};
const SUCCESS_SENTENCE = "withheld order rejected after confirmed revocation";

describe("landing: the first screen", () => {
  const html = render();
  const first = html.slice(html.indexOf("<header"), html.indexOf("</header>"));

  it("opens with the lead line, the two sentences, three actions and the state strip, in that order", () => {
    expect(LEAD_LINE).toBe("Bounded Mandate: keyless AI trading on NEAR Intents");
    expect(first).toContain(`<h1 class="lead-line">${LEAD_LINE}</h1>`);
    expect(first).toContain(`<p class="position lead-sub">${escapeHtml(POSITION)}</p>`);
    expect(POSITION).toBe("An AI agent trades your treasury on NEAR Intents without holding a signing key. A contract signs each order inside your limits; one owner call voids every signed order that has not executed, and recovery returns the funds without the agent.");
    const order = ['class="lead-line"', 'class="position lead-sub"', 'class="actions"', 'class="state-strip"'].map((n) => first.indexOf(n));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(`<title>${LEAD_LINE} — evidence (sandbox)</title>`);
  });

  it("offers watch, replay and verify; the unpublished cut is labelled text, never a link", () => {
    expect([...first.matchAll(/<p class="act">(?:<a href="#([a-z]+)">)?([A-Za-z]+)/g)].map((m) => `${m[2] ?? ""}${m[1] === undefined ? "" : ` #${m[1]}`}`)).toEqual(["Watch", "Replay #replay", "Verify #verify"]);
    expect(first).toContain(`${PLANNED_LABEL}</span> <code>${PLANNED_URLS.video}</code>`);
    expect(html).not.toContain(`href="${PLANNED_URLS.video}`);
    expect(first).toContain(`<code class="cmd">make verify</code> or <code class="cmd">node verify.mjs</code>`);
    expect(at(html, "replay")).toBeGreaterThan(0);
    expect(at(html, "verify-panel")).toBeGreaterThan(0);
  });

  it("states certification, gates, mainnet status and the recorded end state in the strip", () => {
    const s = strip(html);
    expect(s).toContain("certified for this demo");
    expect(s).toContain(`${String(Object.keys(REQUIRED_CASES).length)} / ${String(Object.keys(REQUIRED_CASES).length)} passed and certified`);
    expect(s).toContain("pending approval: no mainnet transaction has been executed");
    expect(s).toContain("grant revoked · key removed · open orders 0");
  });

  it("makes no first, only, instant, profit or guarantee claim and addresses no screener", () => {
    const facts = html.slice(html.indexOf("<header"), html.indexOf('id="replay"'));
    const text = facts.replace(/<details[\s\S]*?<\/details>/g, "").replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\binstant(ly)?\b|\bthe (first|only)\b|\bprofit|guarantee|\b(AI|LLM) (screener|reviewer|judge)|\bClaude\b|\bCodex\b/i);
  });
});

describe("landing: three checkable facts, each linked to its gate report", () => {
  const html = render();
  const fact = (id: string): string => {
    const start = html.indexOf(`id="${id}"`);
    return html.slice(start, html.indexOf("</article>", start)).replace(/<details[\s\S]*?<\/details>/g, "");
  };

  it("No key: the agent's only key is a propose_order function-call key, with the recorded checks and the contract boundary report", () => {
    const f = fact("fact-key");
    expect(f).toContain("The agent's only key is a function-call key limited to <code>propose_order</code>.");
    expect(f).toContain('href="#check-agent-one-restricted-key"');
    expect(f).toContain('href="#report-BOUNDARY.contract"');
    expect(f).toContain("MPC signer is a labelled test double");
  });

  it("Limits at the signature: counts and layers come from the certified reports, labelled selected samples", () => {
    const f = fact("fact-limits");
    expect(f).toContain("Selected samples");
    expect(f).toContain(`<p class="fact-number">${String(TRADES.legitimate.completed)} / ${String(TRADES.legitimate.attempted)}</p>`);
    expect(f).toContain(`<p class="fact-number">${String(ATTACKS.suite.results.length)} / ${String(ATTACKS.suite.results.length)}</p>`);
    expect(f).toContain(`at ${String(new Set(ATTACKS.suite.results.map((r) => r.observed)).size)} layers`);
    expect(f).toContain('href="#report-T3.concession"');
    expect(f).toContain('href="#report-BOUNDARY.attacks"');
  });

  it("Stop and exit: the open-order-limit result is read from its report, not hard-coded", () => {
    const f = fact("fact-stop");
    expect(f).toContain(`<p class="fact-number">${String(OPEN.open_orders)}</p><p>open orders under one grant (${String(OPEN.states_before_revoke.signed)} signed, ${String(OPEN.states_before_revoke.signing)} awaiting signature)</p>`);
    expect(f).toContain(`One confirmed removal (after a forced failed removal and retry) released ${String(OPEN.released_key_removed)} of ${String(OPEN.open_orders)} reservations in one callback.`);
    expect(f).toContain("The relayed withheld order did not execute.");
    expect(f).toContain(`A ${String(OPEN.open_orders + 1)}th proposal was refused at the limit.`);
    expect(f).toContain("Recovery returned every unit.");
    expect(f).toContain("2 relays of withheld orders after confirmed key removal, including after a regrant with a fresh key: 0 executions");
    expect(f).toContain('href="#report-T4.open-order-limit"');
    expect(f).toContain('href="#report-T1.withheld-regrant"');
  });

  it("narrates an executed relay or incomplete recovery in the open-order result as such", () => {
    const bad = { ...OPEN, released_key_removed: 6, withheld_relay_after_removal_executed: true, recovered_all_units: false };
    const h = renderHtml(storyEvidence(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: null, reports: [...REPORTS.filter((r) => r.file !== "T4.open-order-limit.json"), report("T4.open-order-limit", bad)] });
    expect(h).toContain("released 6 of 7 reservations");
    expect(h).toContain("The relayed withheld order <strong>executed</strong>.");
    expect(h).toContain("Recovery <strong>did not return every unit</strong>.");
  });

  it("shows no fact number and no report link without a certified, bound acceptance run", () => {
    const h = renderHtml(storyEvidence(), { acceptance: null, live: null, reports: REPORTS });
    expect(h).not.toContain('class="fact-number"');
    expect(h).toContain("No certified open-order-limit result (T4.open-order-limit) is attached to this page.");
    expect(h).not.toContain('href="#report-');
  });

  it("every in-page link resolves to an element of the page", () => {
    for (const h of [html, render(live("rejected_revoked_key")), renderHtml(storyEvidence(), { acceptance: null, live: null })]) {
      const ids = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      const missing = [...h.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((f) => !ids.has(f));
      expect(missing).toEqual([]);
    }
  });

  it("reads the certified bundle's open-order-limit report (committed evidence/51d2532)", () => {
    const bundle = join(repo, "evidence/51d2532");
    const acc = JSON.parse(readFileSync(join(bundle, "acceptance.json"), "utf8")) as Acceptance;
    const ev = Evidence.parse(JSON.parse(readFileSync(join(bundle, "demo.json"), "utf8")));
    const files = loadReportFiles(join(bundle, "tests"));
    const data = (JSON.parse(files.find((f) => f.file === "T4.open-order-limit.json")?.text ?? "") as { data: typeof OPEN }).data;
    const h = renderHtml(ev, { acceptance: acc, latestRunId: acc.run_id, live: null, reports: files });
    expect(h).toContain(`<p class="fact-number">${String(data.open_orders)}</p><p>open orders under one grant (${String(data.states_before_revoke.signed)} signed, ${String(data.states_before_revoke.signing)} awaiting signature)</p>`);
    expect(h).toContain(`released ${String(data.released_key_removed)} of ${String(data.open_orders)} reservations`);
  });
});

describe("landing: provenance and disclosures", () => {
  it("gives each screen one provenance label linking to what is real and what is a test double", () => {
    for (const h of [render(), render(live("rejected_revoked_key"))]) {
      const labels = [...h.matchAll(/<p class="prov"><a href="#([a-z]+)">/g)].map((m) => m[1]);
      expect(labels).toHaveLength(5);
      expect(new Set(labels)).toEqual(new Set(["real"]));
      expect(h).toContain('<h2 id="real-h">What is real and what is a test double</h2>');
      for (const region of [["<header", "</header>"], ['id="facts"', "</section>"], ['class="replay-block"', 'id="replay"'], ['id="mainnet"', "</section>"], ['id="verify"', "</section>"]] as const) {
        const start = h.indexOf(region[0]);
        expect(h.slice(start, h.indexOf(region[1], start + region[0].length)).match(/class="prov"/g) ?? [], region[0]).toHaveLength(1);
      }
    }
  });

  it("keeps every existing disclosure: modes key, run chips, journey note, uncertified banner, test-double rows", () => {
    const base = storyEvidence();
    const doubles = Evidence.parse({ ...base, identifiers: { ...base.identifiers, mpc_test_double: "mpc.synthetic", oracle_test_double: "oracle.synthetic" } });
    const h = renderHtml(doubles, { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: null, reports: REPORTS });
    expect(h).toContain('aria-label="Execution modes on this page"');
    expect(h).toContain('<span class="mode label">test doubles: MPC, oracle, tokens</span>');
    expect(h).toContain('<span class="mode label">no mainnet</span>');
    expect(h).toContain("Revocation is not instant: orders may execute while it is pending");
    expect(h).toContain("Claim: the mandate contract builds and signs every trade itself");
    expect(h).toMatch(/<th scope="row">MPC signer \(Chain Signatures\)<\/th><td><span class="mode pending">test double<\/span>/);
    expect(h).toMatch(/<th scope="row">NEAR mainnet<\/th><td><span class="mode pending">none<\/span><\/td><td>no mainnet transaction has been executed/);
    const uncertified = renderHtml(storyEvidence(), { acceptance: null, live: null });
    expect(uncertified).toContain('<p class="banner">Not certified for this demo:');
  });
});

describe("landing: layout chosen from the evidence", () => {
  it("lists every block once in both layouts, differing only in where receipts and verification go", () => {
    expect(new Set(PAGE_LAYOUT.sandbox).size).toBe(PAGE_LAYOUT.sandbox.length);
    expect([...PAGE_LAYOUT.mainnet].sort()).toEqual([...PAGE_LAYOUT.sandbox].sort());
    expect(PAGE_LAYOUT.mainnet.slice(0, 2)).toEqual(["mainnet", "verify"]);
  });

  it("sandbox layout: the replay comes first, the pending mainnet panel later", () => {
    const h = render();
    expect(at(h, "facts")).toBeLessThan(at(h, "replay"));
    expect(at(h, "replay")).toBeLessThan(at(h, "story"));
    expect(at(h, "story")).toBeLessThan(at(h, "mainnet"));
    expect(at(h, "mainnet")).toBeLessThan(at(h, "verify"));
    expect(h).toContain("Mainnet run: pending approval — no mainnet transaction has been executed");
  });

  it("mainnet layout (SYNTHETIC receipts): receipts and live verification come before the sandbox journey", () => {
    const h = render(live("rejected_revoked_key"));
    expect(at(h, "facts")).toBeLessThan(at(h, "mainnet"));
    expect(at(h, "mainnet")).toBeLessThan(at(h, "verify"));
    expect(at(h, "verify")).toBeLessThan(at(h, "replay"));
    expect(at(h, "replay")).toBeLessThan(at(h, "regrant"));
    expect(strip(h)).toContain('<span class="status success">2 transactions · revocation test passed</span>');
    expect(h).toContain(SUCCESS_SENTENCE);
    expect(h).toContain("NEAR mainnet receipts first, then the sandbox replay");
  });

  it("a rejected live file (wrong mode) keeps the sandbox layout and shows no mainnet receipt", () => {
    const h = render(Evidence.parse({ ...live("rejected_revoked_key"), mode: "sandbox" }));
    expect(at(h, "replay")).toBeLessThan(at(h, "mainnet"));
    expect(strip(h)).toContain("not shown: out/evidence/live-mainnet.json is not mainnet evidence");
    expect(h).not.toContain(SUCCESS_SENTENCE);
  });

  it("narrates a failed or inconclusive mainnet step as such, never with the success sentence", () => {
    const cases: [Evidence, string, RegExp][] = [
      [live("executed"), "failure", /revocation test failed: withheld order executed after revocation/],
      [live("inconclusive"), "inconclusive", /revocation test inconclusive: not evidence that revocation stopped the withheld order/],
      [live(null), "inconclusive", /revocation test not run: no withheld order was relayed in this run/],
      [live("rejected_revoked_key", { failedStep: true }), "failure", /revocation test passed · 1 of 2 steps did not hold/],
      [live("rejected_revoked_key", { unknowns: ["SYNTHETIC stop"] }), "inconclusive", /revocation test passed · run stopped/],
    ];
    for (const [ev, cls, text] of cases) {
      const h = render(ev);
      expect(at(h, "mainnet")).toBeLessThan(at(h, "replay"));
      expect(strip(h)).toContain(`<span class="status ${cls}">`);
      expect(strip(h)).toMatch(text);
      if (cls !== "success" && !/revocation test passed/.test(text.source)) {
        expect(h).not.toContain(SUCCESS_SENTENCE);
        expect(h).not.toContain("revocation test passed");
      }
    }
  });
});
