// SYNTHETIC specimens only: the evidence, acceptance, gate reports and mainnet-shaped evidence below are built here to
// test the landing screen and the layout choice. None was executed; the mainnet-shaped evidence never touched a chain.
// The one exception is the block that reads the committed bundle marked certified in evidence/index.json, labelled as such.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_CASES } from "../src/evidence/required.js";
import { ACCEPTANCE_SCHEMA, type Acceptance, type CaseResult } from "../src/evidence/schema.js";
import { PLANNED_LABEL, REPO_URL, SITE_PATHS, bundlePaths } from "../src/evidence/journey.js";
import { loadReportFiles } from "../src/page/casefiles.js";
import { CERTIFIED_DEFINITION, CERTIFIED_SHORT, DISPLAY_NAME, LAB_SERVICE, LEAD_LINE, PAGE_LAYOUT, PATH_KEYS, POSITION, installLab, labLink, labScript, type LabFetch } from "../src/page/landing.js";
import { RELAY_STEP_ONLY } from "../src/page/mainnet.js";
import { HEADLINE, escapeHtml, renderHtml } from "../src/page/render.js";
import { clientScript, scriptHash } from "../src/page/verify.js";
import { type Assertion, Evidence, Policy } from "../src/types.js";
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
const live = (relay: string | null, over: { failedStep?: boolean; failedPreflight?: boolean; unknowns?: string[] } = {}): Evidence =>
  Evidence.parse({
    ...storyEvidence(),
    mode: "mainnet",
    command: "MANDATE_LIVE=1 make live (SYNTHETIC)",
    environment: { chain_id: "mainnet", label: "SYNTHETIC", manifest_steps: "check,grant,propose,fill,withhold,revoke,relay_withheld,recover,recover" },
    identifiers: { mandate: "mandate.synthetic.near", owner: "owner.synthetic.near" },
    receipts: [
      { label: "owner grant (SYNTHETIC)", tx_hash: txHash("grant"), block_height: 1, outcome: "success", detail: { step: 2, signer_id: "owner.synthetic.near" } },
      { label: "owner revoke (SYNTHETIC)", tx_hash: txHash("revoke"), block_height: 2, outcome: over.failedStep === true ? "failure" : "success", detail: { step: 6, signer_id: "owner.synthetic.near" } },
    ],
    assertions: [
      check("preflight-accounts", "preflight: accounts (SYNTHETIC)", over.failedPreflight !== true),
      check("step-1-check", "read-only state check (SYNTHETIC)", true),
      check("step-2-grant", "grant: terminal verification (SYNTHETIC)", true),
      check("step-3-propose", "propose: terminal verification (SYNTHETIC)", true),
      check("step-4-fill", "fill: terminal verification (SYNTHETIC)", true),
      check("step-5-withhold", "withhold (SYNTHETIC)", true),
      check("step-6-revoke", "revoke: terminal verification (SYNTHETIC)", over.failedStep !== true),
      ...(relay === null ? [] : [check("step-7-relay_withheld", "relay_withheld (SYNTHETIC)", true, { classification: relay })]),
      check("step-8-recover", "recover: terminal verification (SYNTHETIC)", true, { asset: "usdc" }),
      check("step-9-recover", "recover: terminal verification (SYNTHETIC)", true, { asset: "wnear" }),
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

  it("opens with the display name as the kicker, the lead line as the H1, the two sentences, three actions and the state strip, in that order", () => {
    expect(DISPLAY_NAME).toBe("Bounded Mandate: AI trading on NEAR Intents without a signing key");
    expect(LEAD_LINE).toBe("Give an AI agent trading authority without unrestricted control of your treasury.");
    expect(HEADLINE).toBe(LEAD_LINE);
    expect(first).toContain(`<p class="kicker">${DISPLAY_NAME}</p>\n<h1 class="lead-line">${LEAD_LINE}</h1>\n<p class="position lead-sub">${escapeHtml(POSITION)}</p>`);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(POSITION).toBe("The agent names a side, an amount and a price concession up to your maximum; a contract prices the order from the oracle, then builds and signs it for NEAR Intents inside your size and turnover limits. One owner call removes the signing key, so signed orders that have not executed fail once removal is confirmed, and recovery returns the remaining assets without the agent.");
    const order = ['class="kicker"', 'class="lead-line"', 'class="position lead-sub"', 'class="actions"', 'class="path-nav"', 'class="claim-size"', 'class="state-strip"'].map((n) => first.indexOf(n));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(`<title>${DISPLAY_NAME} — evidence (sandbox)</title>`);
  });

  it("states the agreed pitch: what the agent names, what the contract does, and nothing about a price or counterparty it cannot choose", () => {
    // The agent chooses a concession up to the owner's maximum and the order names no counterparty.
    for (const part of ["names a side, an amount and a price concession up to your maximum", "prices the order from the oracle", "inside your size and turnover limits", "signed orders that have not executed fail once removal is confirmed", "recovery returns the remaining assets without the agent"]) expect(POSITION).toContain(part);
    for (const h of [html, render(live("rejected_revoked_key")), renderHtml(storyEvidence(), { acceptance: null, live: null })]) {
      expect(h.replace(/<details[\s\S]*?<\/details>/g, "")).not.toMatch(/cannot choose|choose (its|the|a) (price|counterparty)|price or (its )?counterparty/i);
      // The pitch itself, down to the facts, never mentions a counterparty; the historical replay further down may.
      expect(h.slice(h.indexOf("<header"), h.indexOf('id="facts"'))).not.toMatch(/counterparty/i);
    }
    expect(`${LEAD_LINE} ${POSITION}`).not.toMatch(/\b(first|only|instant(ly)?)\b|guarantee|\bprofit/i);
    // The expiry bound is on the first screen, in the block after the sentence about revocation.
    expect(first.indexOf('class="claim-size"')).toBeGreaterThan(first.indexOf("One owner call removes the signing key"));
  });

  it("opens the README with the page's lead line and states the page's two sentences, without overclaiming", () => {
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    const opening = readme.slice(0, readme.indexOf("\n## "));
    const lines = opening.split("\n");
    expect(lines[0]).toBe(`# ${DISPLAY_NAME.split(":")[0] ?? ""}`);
    expect(lines.slice(1, 4).filter((l) => l !== "")).toEqual([LEAD_LINE]);
    expect(opening).not.toMatch(/counterparty|cannot choose|choose (its|the|a) (price|counterparty)|\b(first|only|instant(ly)?)\b|guarantee|\bprofit|\b(AI|LLM) (screener|reviewer|judge)/i);
    expect(readme).toContain(POSITION);
    // The README presents the same four paths, in the page's order.
    const paths = readme.slice(readme.indexOf("\n## Four paths"), readme.indexOf("\n## Three checkable facts"));
    expect([...paths.matchAll(/^\| \*\*([A-Za-z]+)\*\* \|/gm)].map((m) => (m[1] ?? "").toLowerCase())).toEqual([...PATH_KEYS]);
    for (const command of ["`make lab`", "`make example`", "`make verify`", "gate COMPARE", "Inspect the real mainnet trade, the confirmed key removal, the rejection of the still-unexpired withheld order and the recovery", "node verify.mjs --mainnet"]) expect(paths).toContain(command);
    // The mainnet section keeps the size of the claim next to the result.
    const mainnet = readme.slice(readme.indexOf("\n## What happened on mainnet"), readme.indexOf("\n## ", readme.indexOf("\n## What happened on mainnet") + 1));
    for (const safeguard of ["fixed proposals", "not a model proposal", "our own filler account", "integration, not reliability or profitability", "filed incomplete", "Intents account (not the owner's NEAR wallet"]) expect(mainnet).toContain(safeguard);
    expect(readme).toContain("not an external audit");
  });

  it("never calls the agent keyless: it holds a function-call key, and no signing key", () => {
    for (const h of [html, render(live("rejected_revoked_key")), renderHtml(storyEvidence(), { acceptance: null, live: null })]) expect(h).not.toMatch(/keyless|No key\b|without a key|holds no key/i);
    expect(html).toContain("<h3>1. No signing key</h3>");
  });

  it("offers watch, replay and verify as links; the cuts, the console and the source are linked, with their place in a clone", () => {
    expect([...first.matchAll(/<p class="act"><a href="([^"]+)">([A-Za-z]+)<\/a>/g)].map((m) => `${m[2] ?? ""} ${m[1] ?? ""}`)).toEqual([`Watch ${SITE_PATHS.video}`, "Replay #replay", "Verify #verify"]);
    const clone = bundlePaths(REV);
    expect(first).toContain(`<a href="${SITE_PATHS.walkthrough}">longer walkthrough</a>`);
    expect(first).toContain(`In a clone: <code>evidence/aaaaaaa/video/</code>`);
    expect(first).toContain(`<a href="${REPO_URL}" rel="noopener noreferrer">github.com/gryyny/bounded-mandate</a>`);
    expect(first).toContain(`<a href="${SITE_PATHS.console}">Owner console</a> on the ${PLANNED_LABEL}; in a clone <code>${clone.console}</code>`);
    expect(first).toContain(`This page in a clone: <code>${clone.page}</code>`);
    // Relative to the site's base, never absolute or root-absolute, and never a statement that anything is or is not published.
    expect(first).not.toMatch(/href="(\/|https:\/\/gryyny\.github\.io)/);
    expect(first).not.toMatch(/unpublished|not (yet )?published|planned|Nothing was hosted/i);
    expect(first).toContain(`<code class="cmd">make verify</code> or <code class="cmd">node verify.mjs</code>`);
    expect(at(html, "replay")).toBeGreaterThan(0);
    expect(at(html, "verify-panel")).toBeGreaterThan(0);
  });

  it("states the size of the claim on the first screen and in fact 3, with the order lifetime read from the evidence", () => {
    const base = storyEvidence();
    const policy = Policy.parse((base.assertions.find((a) => a.id === "grant-active")?.observed as { policy: unknown }).policy);
    const line = (ttl: string): string => `The advantage of revoking over waiting for expiry is bounded by the order lifetime: ${ttl}.`;
    expect(first).toContain(`<p class="claim-size"><strong>Size of the claim.</strong> ${line(`${String(policy.order_ttl_sec)} s in this sandbox run`)}</p>`);
    expect(html.slice(at(html, "fact-stop"), html.indexOf("</article>", at(html, "fact-stop")))).toContain(line(`${String(policy.order_ttl_sec)} s in this sandbox run`));
    // Not hard-coded: another recorded lifetime, a supplied policy, and evidence with no policy at all.
    const other = Evidence.parse({ ...base, assertions: base.assertions.map((a) => (a.id === "grant-active" ? { ...a, observed: { ...(a.observed as object), policy: { ...policy, order_ttl_sec: 137 } } } : a)) });
    expect(renderHtml(other, { acceptance: null, live: null })).toContain(line("137 s in this sandbox run"));
    expect(renderHtml(base, { acceptance: null, live: null, policy: { ...policy, order_ttl_sec: 91 } })).toContain(line("91 s in this sandbox run"));
    const none = Evidence.parse({ ...base, assertions: base.assertions.filter((a) => a.id !== "grant-active") });
    expect(renderHtml(none, { acceptance: null, live: null })).toContain(line("not recorded in this evidence"));
  });

  it("defines certified where it first appears: a visible phrase linked to the definition, our own gate and not an audit", () => {
    for (const h of [html, renderHtml(storyEvidence(), { acceptance: null, live: null })]) {
      const head = h.slice(h.indexOf("<header"), h.indexOf("</header>"));
      const firstUse = head.search(/certified/i);
      expect(firstUse).toBeGreaterThan(0);
      // The first use is the strip's evidence cell; the short definition follows it in the same cell.
      const cell = head.slice(head.lastIndexOf("<div>", firstUse), head.indexOf("</div>", firstUse));
      expect(cell).toContain(`<a class="defn" href="#certified-def">${CERTIFIED_SHORT}</a>`);
      expect(head).toContain(`<p class="defn-text" id="certified-def">${escapeHtml(CERTIFIED_DEFINITION)}</p>`);
    }
    expect(CERTIFIED_SHORT).toBe("our own acceptance gate, not an external audit");
    expect(CERTIFIED_DEFINITION).toMatch(/this project's own acceptance gate on one clean revision.*every required case.*one run.*fresh clone and in CI.*not an external audit/);
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

  it("No signing key: the agent's only key is a propose_order function-call key, with the recorded checks and the contract boundary report", () => {
    const f = fact("fact-key");
    expect(f).toContain("The agent's only key is a function-call key limited to <code>propose_order</code>.");
    expect(f).toContain('href="#check-agent-one-restricted-key"');
    expect(f).toContain('href="#report-BOUNDARY.contract"');
    expect(f).toContain("MPC signer is a labelled test double");
    // The design claim about MPC shares is qualified in its own sentence for evidence that ran a test double.
    expect(f).toContain("By design the order-signing key exists only as MPC shares; in this sandbox evidence the signer is a single labelled test double, not the MPC network, and the contract requests each signature after checking the limits.");
    expect(f).not.toMatch(/(?<!By design )the order-signing key exists only as MPC shares/i);
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

  it("labels the facts block certified only when a certified, bound acceptance run backs it", () => {
    const label = (h: string): string => {
      const start = h.indexOf('id="facts"');
      return /<p class="prov"><a [^>]*>([^<]*)<\/a><\/p>/.exec(h.slice(start))?.[1] ?? "";
    };
    expect(label(html)).toBe("certified sandbox acceptance reports · selected samples · test doubles as labelled");
    const uncertified = label(renderHtml(storyEvidence(), { acceptance: null, live: null, reports: REPORTS }));
    expect(uncertified).toBe("sandbox evidence, not backed by a certified acceptance run here · test doubles as labelled");
    expect(uncertified).not.toMatch(/^certified|certified sandbox acceptance reports/);
  });

  it("every in-page link resolves to an element of the page", () => {
    for (const h of [html, render(live("rejected_revoked_key")), renderHtml(storyEvidence(), { acceptance: null, live: null })]) {
      const ids = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      const missing = [...h.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((f) => !ids.has(f));
      expect(missing).toEqual([]);
    }
  });

});

// The committed bundle marked certified in evidence/index.json: recorded by make test and make demo at its revision,
// read here as files. Nothing below is synthetic, and nothing is asserted that the bundle's own files do not state.
describe("landing: the committed certified bundle renders through renderHtml", () => {
  const index = JSON.parse(readFileSync(join(repo, "evidence/index.json"), "utf8")) as { bundles: { path: string; revision: string; status: string }[] };
  const certified = index.bundles.filter((b) => b.status === "certified");
  const entry = certified[0];
  if (entry === undefined) throw new Error("evidence/index.json marks no bundle certified");
  const bundle = join(repo, entry.path);
  const acc = JSON.parse(readFileSync(join(bundle, "acceptance.json"), "utf8")) as Acceptance;
  const ev = Evidence.parse(JSON.parse(readFileSync(join(bundle, "demo.json"), "utf8")));
  const files = loadReportFiles(join(bundle, "tests"));
  const policy = Policy.parse((ev.assertions.find((a) => a.id === "grant-active")?.observed as { policy: unknown }).policy);
  const h = renderHtml(ev, { acceptance: acc, latestRunId: acc.run_id, live: null, challenge: null, reports: files, policy });
  const head = h.slice(h.indexOf("<header"), h.indexOf("</header>"));

  it("is the one certified bundle, of the revision its demo and acceptance run record", () => {
    expect(certified).toHaveLength(1);
    expect(ev.source.product_commit).toBe(entry.revision);
    expect(acc.revision).toBe(entry.revision);
    expect(entry.path).toBe(`evidence/${entry.revision.slice(0, 7)}`);
  });

  it("shows it certified, every gate passed, with the lead line, the recorded lifetime and the bundle's own paths", () => {
    expect(strip(h)).toContain('<span class="status passed">certified for this demo</span>');
    // The committed bundle may predate gates added since: it counts only the gates whose cases it recorded as passed.
    const recorded = new Set(acc.cases.filter((c) => c.status === "passed").map((c) => c.id));
    const passedGates = Object.entries(REQUIRED_CASES).filter(([gate, names]) => names.every((n) => recorded.has(`${gate}.${n}`))).length;
    expect(passedGates).toBeGreaterThan(0);
    expect(strip(h)).toContain(`${String(passedGates)} / ${String(Object.keys(REQUIRED_CASES).length)} passed and certified`);
    expect(head).toContain(`<h1 class="lead-line">${LEAD_LINE}</h1>`);
    expect(head).toContain(`bounded by the order lifetime: ${String(policy.order_ttl_sec)} s in this sandbox run.`);
    for (const path of Object.values(bundlePaths(entry.revision))) expect(h).toContain(path);
    expect(h).toContain(`evidence/${entry.revision.slice(0, 7)}/demo.json`);
    expect(h).not.toContain('<p class="banner">Not certified for this demo');
    expect(h).not.toMatch(/keyless|No key\b/);
  });

  it("reads the open-order-limit result from the bundle's report", () => {
    const data = (JSON.parse(files.find((f) => f.file === "T4.open-order-limit.json")?.text ?? "") as { data: typeof OPEN }).data;
    expect(h).toContain(`<p class="fact-number">${String(data.open_orders)}</p><p>open orders under one grant (${String(data.states_before_revoke.signed)} signed, ${String(data.states_before_revoke.signing)} awaiting signature)</p>`);
    expect(h).toContain(`released ${String(data.released_key_removed)} of ${String(data.open_orders)} reservations`);
  });

  it("resolves every in-page link and states no publication state outside the raw recorded detail", () => {
    const ids = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    expect([...h.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((f) => !ids.has(f))).toEqual([]);
    expect(h.replace(/<details[\s\S]*?<\/details>/g, "")).not.toMatch(/unpublished|Nothing was hosted/i);
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
      [live("rejected_revoked_key", { failedStep: true }), "failure", /withheld-order relay step held \(that step only\) · 1 of 8 steps did not hold/],
      [live("rejected_revoked_key", { failedPreflight: true }), "failure", /withheld-order relay step held \(that step only\) · 1 preflight checks did not hold/],
      [live("rejected_revoked_key", { unknowns: ["SYNTHETIC stop"] }), "inconclusive", /withheld-order relay step held \(that step only\) · run stopped/],
    ];
    for (const [ev, cls, text] of cases) {
      const h = render(ev);
      expect(at(h, "mainnet")).toBeLessThan(at(h, "replay"));
      expect(strip(h)).toContain(`<span class="status ${cls}">`);
      expect(strip(h)).toMatch(text);
      // No exemption: unless the whole run holds, the page carries neither the success sentence nor "passed" for the
      // revocation test, no green verdict, and no claim that every manifest step completed.
      expect(h).not.toContain(SUCCESS_SENTENCE);
      expect(h).not.toContain("revocation test passed");
      expect(h).not.toContain("The run completed every manifest step");
      const verdict = /<div class="verdict">(<span class="status ([a-z-]+)">[^<]*<\/span>)<p>([^<]*)<\/p>/.exec(h.slice(at(h, "mainnet")));
      expect(verdict?.[2]).not.toBe("success");
      expect(verdict?.[2]).toBe(cls === "inconclusive" && ev.assertions.every((x) => !/relay_withheld/.test(x.id)) ? "not-run" : cls);
    }
  });

  it("words a relay that held inside a run that does not hold as that step only, and says what did not hold", () => {
    const h = render(live("rejected_revoked_key", { failedStep: true }));
    const body = h.slice(at(h, "mainnet"), h.indexOf("</section>", at(h, "mainnet")));
    expect(RELAY_STEP_ONLY).toBe("withheld-order relay step held (that step only)");
    expect(body).toContain('<span class="status failure">run did not hold</span>');
    expect(body).toContain(`The ${RELAY_STEP_ONLY}: the relay was rejected for the removed key. The run as a whole does not hold: 1 of 8 step verifications did not hold; no revoke that held.`);
    expect(body).toContain('<td><code>step-7-relay_withheld</code></td><td><span class="status success">held (this step only): relay rejected for the removed key</span>');
    expect(body).toContain('<td><code>step-6-revoke</code></td><td><span class="status failure">did not hold</span>');
    const stopped = render(live("rejected_revoked_key", { unknowns: ["SYNTHETIC stop"] }));
    expect(stopped).toContain('<span class="status inconclusive">run incomplete</span>');
    expect(stopped).toContain("The run as a whole does not hold: run stopped: SYNTHETIC stop.");
  });

  it("does not call a relay-only record a completed run: the strip and the verdict say that step only", () => {
    // The reviewer's counterexample: the relay assertion alone, no other step verification, nothing unknown.
    const full = live("rejected_revoked_key");
    const relayOnly = Evidence.parse({ ...full, assertions: full.assertions.filter((x) => x.id.endsWith("-relay_withheld")) });
    const unrecorded = Evidence.parse({ ...full, environment: { chain_id: "mainnet", label: "SYNTHETIC" } });
    for (const ev of [relayOnly, unrecorded]) {
      const h = render(ev);
      expect(strip(h)).toContain(`<span class="status inconclusive">2 transactions · ${RELAY_STEP_ONLY}</span>`);
      expect(h).not.toContain("revocation test passed");
      expect(h).not.toContain(SUCCESS_SENTENCE);
      expect(h).not.toContain("The run completed every manifest step");
      expect(h.slice(at(h, "mainnet"))).toContain('<div class="verdict"><span class="status inconclusive">run incomplete</span>');
    }
    // Control: the same evidence, complete, is the success case.
    expect(strip(render(full))).toContain('<span class="status success">2 transactions · revocation test passed</span>');
  });

  it("uses the success wording only when the relay was rejected, every assertion held and nothing is unknown", () => {
    const h = render(live("rejected_revoked_key"));
    const body = h.slice(at(h, "mainnet"), h.indexOf("</section>", at(h, "mainnet")));
    expect(body).toContain('<div class="verdict"><span class="status success">revocation test passed</span><p>withheld order rejected after confirmed revocation (rejected_revoked_key). The run completed every manifest step and every assertion held.</p>');
    expect(strip(h)).toContain('<span class="status success">2 transactions · revocation test passed</span>');
    expect(body).not.toContain("this step only");
  });
});

// The lab is another service. Nothing below starts one: the lab URL is a SYNTHETIC address under .invalid, and the
// health answers are SYNTHETIC objects handed to the page's own click handler through a fake fetch.
describe("landing: four paths (try, compare, verify, integrate)", () => {
  const LAB = "https://lab.synthetic.invalid/";
  const plain = () => renderHtml(storyEvidence(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: null, reports: REPORTS });
  const withLab = (labUrl: string = LAB, liveEvidence: Evidence | null = null) => renderHtml(storyEvidence(), { acceptance: acceptance(), latestRunId: "run-SYNTHETIC", live: liveEvidence, reports: REPORTS, labUrl });
  const paths = (h: string): string => h.slice(h.indexOf('<section class="four-paths"'), h.indexOf("</section>", h.indexOf('<section class="four-paths"')));
  const path = (h: string, key: string): string => {
    const start = h.indexOf(`<li id="path-${key}">`);
    return h.slice(start, h.indexOf("</li>", start));
  };
  const scripts = (h: string): string[] => [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  const csp = (h: string): string => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(h)?.[1] ?? "";
  const RECORDED = '<span class="mode recorded">recorded, not interactive</span>';

  it("offers the four paths right after the first screen, in order, each under its own heading, and links them from the first screen", () => {
    for (const h of [plain(), withLab(), render(live("rejected_revoked_key"))]) {
      expect([...paths(h).matchAll(/<li id="path-([a-z]+)"><h3>([A-Za-z]+)<\/h3>/g)].map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`)).toEqual(["try Try", "compare Compare", "verify Verify", "integrate Integrate"]);
      expect(h.indexOf("</header>")).toBeLessThan(at(h, "start"));
      expect(at(h, "start")).toBeLessThan(at(h, "facts"));
      const head = h.slice(h.indexOf("<header"), h.indexOf("</header>"));
      expect(head).toContain(`<p class="path-nav"><span>Four paths:</span> ${PATH_KEYS.map((k) => `<a href="#path-${k}">${k.charAt(0).toUpperCase()}${k.slice(1)}</a>`).join(" ")}</p>`);
    }
  });

  it("with no lab configured, Try and Compare say how to run the lab locally and offer what is recorded, labelled recorded", () => {
    const h = plain();
    const tryPath = path(h, "try");
    expect(tryPath).toContain('<strong>No lab is linked from this page.</strong> Run it from a clone: <code class="cmd">make lab</code>.');
    expect(tryPath).toContain(`${RECORDED} Or step through <a href="#replay">the recorded replay</a> of one sandbox run on this page: recorded results, not a run you operate.`);
    expect(tryPath).toContain('<span class="mode sandbox" title="execution mode">sandbox</span> <span class="mode label">test doubles: MPC, oracle, tokens</span>');
    const compare = path(h, "compare");
    expect(compare).toContain('Run it from a clone: <code class="cmd">make lab</code>, then open its Compare tab.');
    for (const alternative of ["wait for expiry", "cancel a complete nonce list", "cancel an incomplete list", "cancel with the signer unavailable", "remove the key and resume with a fresh key", "re-add the same key"]) expect(compare).toContain(alternative);
    // The certified comparison is named by its gate, with the status this page's acceptance run gives it.
    expect(compare).toContain(`${RECORDED} Acceptance gate <code>COMPARE</code> (`);
    expect(compare).toContain('<span class="status passed">✓ passed</span>');
    expect(compare).toContain('<a href="#revocation-alternatives">What happens to orders after the owner acts?</a>');
    expect(compare).toContain("<code>docs/comparison.md</code> in a clone");
    // No control, no second script and nothing that could reach a lab.
    expect(paths(h)).not.toMatch(/<button|data-lab|lab-status/);
    expect(scripts(h)).toEqual([clientScript()]);
    expect(csp(h)).toContain(`script-src '${scriptHash(clientScript())}'; connect-src https:; form-action 'none'`);
    expect(h).toContain("Its one inline script makes network requests only after you press “Run read-only checks” (§V).");
  });

  it("never shows the COMPARE gate as passed without a certified run bound to this page", () => {
    const compare = path(renderHtml(storyEvidence(), { acceptance: null, live: null }), "compare");
    expect(compare).toContain('<span class="status not-run">– not run</span>');
    expect(compare).not.toContain("✓ passed");
  });

  it("Verify says that no mainnet run is recorded, and shows the run's own verdict words once one is", () => {
    const none = path(plain(), "verify");
    expect(none).toContain("<strong>No mainnet run is recorded: no mainnet transaction has been executed.</strong> There is no mainnet trade, removal, rejection or recovery to inspect yet, and nothing on this page is a mainnet result.");
    expect(none).toContain("<p>After an approved mainnet run: inspect its trade, the confirmed key removal,");
    expect(none).not.toContain("Inspect the real mainnet trade");
    expect(none).toContain('<a href="#mainnet">Mainnet status</a> · <a href="#verify">the read-only verification panel</a>');
    expect(none).toContain('<span class="mode pending">no mainnet run</span>');
    expect(none).toContain('<code class="cmd">make verify</code>');
    expect(paths(plain())).not.toMatch(/class="mode mainnet"|nearblocks/);
    const rejectedFile = path(render(Evidence.parse({ ...live("rejected_revoked_key"), mode: "sandbox" })), "verify");
    expect(rejectedFile).toContain("<strong>No mainnet run is shown: out/evidence/live-mainnet.json is not mainnet evidence.</strong>");
    expect(rejectedFile).not.toContain('class="mode mainnet"');
    const held = path(render(live("rejected_revoked_key")), "verify");
    expect(held).toContain('<span class="mode mainnet" title="execution mode">mainnet</span> <span class="status success">2 transactions · revocation test passed</span>');
    expect(held).toContain("<p>Inspect the real mainnet trade, the confirmed key removal,");
    expect(held).not.toContain("After an approved mainnet run");
    expect(held).toContain('<a href="#mainnet">The run\'s transactions and step verifications</a>');
    // A run whose relay was not rejected, or that does not hold as a whole, is never worded as a pass here either.
    for (const ev of [live("executed"), live("inconclusive"), live(null), live("rejected_revoked_key", { failedStep: true })]) {
      const v = path(render(ev), "verify");
      expect(v).not.toContain("revocation test passed");
      expect(v).not.toContain('class="status success"');
    }
    expect(path(render(live("rejected_revoked_key", { failedStep: true })), "verify")).toContain(RELAY_STEP_ONLY);
  });

  it("Integrate names the one command, the example's source and that it is an example", () => {
    const integrate = path(plain(), "integrate");
    expect(integrate).toContain('From a clone, with no funds or model credential: <code class="cmd">make example</code>. Source: <code>examples/strategy-client/</code>. It is an example, not an SDK.');
    expect(integrate).toContain("the agent's function-call key, <code>propose_order</code> and the contract's views");
  });

  it("with a lab configured, adds two opt-in buttons, a second script pinned by hash, and the lab's origin to connect-src, and nothing else", () => {
    const h = withLab();
    const lab = labLink(LAB);
    expect(lab).toEqual({ url: LAB, origin: "https://lab.synthetic.invalid", health: "https://lab.synthetic.invalid/api/health" });
    expect(paths(h)).toContain(`data-lab="${escapeHtml(JSON.stringify({ ...lab, service: LAB_SERVICE, timeout_ms: 8000 }))}"`);
    expect(path(h, "try")).toContain('<button type="button" id="lab-open-try">Open the sandbox lab</button>');
    expect(path(h, "compare")).toContain('<button type="button" id="lab-open-compare">Open the lab to compare</button>');
    for (const key of ["try", "compare"]) {
      expect(path(h, key)).toContain(`<p class="lab-status" id="lab-status-${key}" role="status" aria-live="polite"></p>`);
      expect(path(h, key)).toContain("Opt-in: nothing is requested until you press the button. It then asks <code>https://lab.synthetic.invalid</code> whether the lab is running and, only if the lab answers, opens it there.");
      // Before any click the status is empty, and what is recorded stays offered and labelled.
      expect(path(h, key)).toContain(RECORDED);
      expect(path(h, key)).toContain('<code class="cmd">make lab</code>');
    }
    expect(path(h, "compare")).toContain("In the lab, open the Compare tab.");
    // The lab is reached by script after a click: no link, form, frame or preloaded resource points at it.
    expect(h).not.toMatch(/(href|src|action)="https:\/\/lab\.synthetic\.invalid/);
    expect(scripts(h)).toEqual([clientScript(), labScript()]);
    expect(csp(h)).toContain(`script-src '${scriptHash(clientScript())}' '${scriptHash(labScript())}'; connect-src https: https://lab.synthetic.invalid; form-action 'none'`);
    expect(labScript()).not.toMatch(/https?:\/\//);
    expect(h).toContain("Its two inline scripts make network requests only after you press a button: “Run read-only checks” (§V), or a lab button, which asks https://lab.synthetic.invalid whether the lab is running.");
    // A lab on this machine is reached over http, and that one origin is all connect-src gains.
    expect(csp(withLab("http://127.0.0.1:8787"))).toContain("connect-src https: http://127.0.0.1:8787; form-action");
    // Everything outside the four paths, the policy and the footer is the page without a lab.
    const strip = (x: string): string => x.replace(paths(x), "").replace(/<meta http-equiv[^>]*>/, "").replace(/<footer>[\s\S]*?<\/footer>/, "").replace(/\n<script>[\s\S]*<\/script>\n<\/body>/, "\n</body>");
    expect(strip(h)).toBe(strip(plain()));
  });

  it("accepts an https lab or one on this machine, and refuses any other address", () => {
    expect(labLink(null)).toBeNull();
    expect(labLink(undefined)).toBeNull();
    expect(labLink("  ")).toBeNull();
    expect(labLink("https://lab.synthetic.invalid/sandbox")).toEqual({ url: "https://lab.synthetic.invalid/sandbox/", origin: "https://lab.synthetic.invalid", health: "https://lab.synthetic.invalid/sandbox/api/health" });
    expect(labLink("http://localhost:8787")?.health).toBe("http://localhost:8787/api/health");
    for (const bad of ["lab.synthetic.invalid", "http://lab.synthetic.invalid/", "ftp://127.0.0.1/", "https://user:pw@lab.synthetic.invalid/", "https://lab.synthetic.invalid/?next=1", "https://lab.synthetic.invalid/#x", "javascript:alert(1)"]) {
      expect(() => labLink(bad), bad).toThrow(/MANDATE_LAB_URL/);
      expect(() => renderHtml(storyEvidence(), { acceptance: null, live: null, labUrl: bad }), bad).toThrow(/MANDATE_LAB_URL/);
    }
  });

  // A stand-in for the two buttons, their status lines and the section; only what the handler touches.
  const dom = (h: string) => {
    const raw = /<section class="four-paths" id="start"[^>]* data-lab="([^"]*)"/.exec(h)?.[1] ?? null;
    const unescaped = raw === null ? null : raw.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    const el = () => {
      const listeners: (() => void)[] = [];
      return { textContent: "", className: "lab-status", disabled: false, getAttribute: (name: string): string | null => (name === "data-lab" ? unescaped : null), addEventListener: (_type: string, fn: () => void) => { listeners.push(fn); }, click: () => { for (const fn of listeners) fn(); } };
    };
    const els: Record<string, ReturnType<typeof el>> = { start: el(), "lab-open-try": el(), "lab-status-try": el(), "lab-open-compare": el(), "lab-status-compare": el() };
    return { els, doc: { getElementById: (id: string) => els[id] ?? null } };
  };
  const answer = (body: unknown, ok = true, status = 200) => ({ ok, status, json: () => Promise.resolve(body) });
  const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  it("asks the lab nothing before a click; after one, opens the lab only when its health record is the sandbox lab's", async () => {
    for (const key of ["try", "compare"] as const) {
      const { els, doc } = dom(withLab());
      const asked: { url: string; init: Parameters<LabFetch>[1] }[] = [];
      const opened: string[] = [];
      installLab(doc, (url, init) => { asked.push({ url, init }); return Promise.resolve(answer({ service: LAB_SERVICE, mode: "sandbox", ok: true })); }, (url) => opened.push(url));
      expect(asked).toEqual([]);
      expect(els[`lab-status-${key}`]?.textContent).toBe("");
      els[`lab-open-${key}`]?.click();
      expect(asked.map((a) => a.url)).toEqual(["https://lab.synthetic.invalid/api/health"]);
      expect(asked[0]?.init).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      expect(opened).toEqual([]);
      await settle();
      expect(opened).toEqual([LAB]);
      expect(els[`lab-status-${key}`]?.textContent).toBe("The lab answered. Opening it: a separate site running a sandbox with test doubles.");
      expect(els[`lab-status-${key}`]?.className).toBe("lab-status");
    }
  });

  it("says the lab is unreachable, opens nothing and points to the recorded replay when the lab does not answer as the sandbox lab", async () => {
    const failures: [string, () => ReturnType<LabFetch>, string][] = [
      ["network error", () => Promise.reject(new TypeError("Failed to fetch (SYNTHETIC)")), "Failed to fetch (SYNTHETIC)"],
      ["HTTP 503", () => Promise.resolve(answer({}, false, 503)), "its health check returned HTTP 503"],
      ["another service", () => Promise.resolve(answer({ service: "SYNTHETIC other", mode: "sandbox" })), "its answer is not the sandbox lab's health record"],
      ["not sandbox mode", () => Promise.resolve(answer({ service: LAB_SERVICE, mode: "mainnet" })), "its answer is not the sandbox lab's health record"],
      ["not JSON", () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("Unexpected token (SYNTHETIC)")) }), "Unexpected token (SYNTHETIC)"],
      ["an HTML page", () => Promise.resolve(answer("<html>SYNTHETIC</html>")), "its answer is not the sandbox lab's health record"],
      ["shutting down", () => Promise.resolve(answer({ service: LAB_SERVICE, mode: "sandbox", ok: false })), "it reports that it is not running"],
    ];
    for (const [name, respond, reason] of failures) {
      const { els, doc } = dom(withLab());
      const opened: string[] = [];
      installLab(doc, respond, (url) => opened.push(url));
      els["lab-open-try"]?.click();
      expect(els["lab-open-try"]?.disabled, name).toBe(true);
      await settle();
      expect(opened, name).toEqual([]);
      expect(els["lab-status-try"]?.className, name).toBe("lab-status unreachable");
      expect(els["lab-status-try"]?.textContent, name).toBe(`The lab at https://lab.synthetic.invalid is unreachable (${reason}). Nothing was run, and nothing on this page is a lab result. Use the recorded replay below, which is recorded and not interactive, or run the lab from a clone with make lab.`);
      expect(els["lab-status-try"]?.textContent, name).not.toMatch(/opening|answered|success|passed/i);
      // The other path's status is untouched, and the button can be pressed again.
      expect(els["lab-status-compare"]?.textContent, name).toBe("");
      expect(els["lab-open-try"]?.disabled, name).toBe(false);
    }
  });

  it("the inlined script is that handler: evaluated as the page inlines it, it wires the buttons and fetches nothing on load", async () => {
    const { els, doc } = dom(withLab());
    const asked: string[] = [];
    const opened: string[] = [];
    const fetchStub = (url: string) => { asked.push(url); return Promise.reject(new TypeError("SYNTHETIC offline")); };
    // Evaluating the page's own script text is the point: the tested code is byte-for-byte the inlined code.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function("document", "fetch", "location", labScript()) as (d: unknown, f: unknown, l: unknown) => void;
    run(doc, fetchStub, { assign: (url: string) => opened.push(url) });
    expect(asked).toEqual([]);
    els["lab-open-compare"]?.click();
    await settle();
    expect(asked).toEqual(["https://lab.synthetic.invalid/api/health"]);
    expect(opened).toEqual([]);
    expect(els["lab-status-compare"]?.textContent).toContain("is unreachable (SYNTHETIC offline). Nothing was run");
    // On a page without a lab there is nothing to wire.
    const bare = dom(plain());
    expect(() => { installLab(bare.doc, fetchStub, (url) => opened.push(url)); }).not.toThrow();
    bare.els["lab-open-try"]?.click();
    expect(asked).toHaveLength(1);
  });
});
