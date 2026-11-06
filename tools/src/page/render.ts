// Renders the static evidence page. Order: product position, claim and the run's allocation outcome, the nine-stage
// journey bound to the demo evidence, three ways to check it, the attack log, mainnet receipts (or the pending panel), the
// opt-in read-only verification panel, the regrant and disclosure sandbox cases, the full demonstration,
// acceptance gates per case, the T5 baseline, claim and limits, policy, provenance. A gate shows "passed" only when acceptance.json is
// certified AND bound to this demo (src/evidence/binding.ts): same clean revision, spec, fixtures and WASMs.
// Demo assertions are story checks and never mark a gate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { bindDemo, latestRunId, type DemoBinding } from "../evidence/binding.js";
import { REPO_ROOT, reportsDir } from "../evidence/report.js";
import { REQUIRED_CASES } from "../evidence/required.js";
import { Acceptance, type BaselineCase, type CaseResult } from "../evidence/schema.js";
import { type Assertion, Evidence, EvidenceMode, Policy, type Receipt } from "../types.js";
import { caseFilesBody, loadReportFiles, type ReportFile } from "./casefiles.js";
import { caseModeBadge, chip, escapeHtml, modeBadge, word } from "./html.js";
import { LIFECYCLE_SVG } from "./lifecycle.js";
import { liveView, loadLive, mainnetBody, type LiveView } from "./mainnet.js";
import { LegacyGateReport, loadGateReports } from "./reports.js";
import { AGENT_OBJECTIVE, allocation, attackRows, isoNs, layerCounts, offBalance, priceText, revocationStory, share, shortHash, stateLine, usd, usdc, wnear, type Stage } from "./story.js";
import { PLANNED_LABEL, PLANNED_URLS } from "../evidence/journey.js";
import { STYLES } from "./styles.js";
import { clientScript, scriptHash, verifyData, verifySection } from "./verify.js";

export { escapeHtml } from "./html.js";

/** The product in two plain lines, aligned with the README's opening. */
export const HEADLINE = "Let an AI agent trade within limits a contract enforces";
export const SUBTITLE = "Once a revocation is confirmed, signed orders already issued fail too, and the owner takes the remaining assets back without the agent.";

/** Public URL of the short video; a placeholder until it is hosted. */
export const VIDEO_URL: string = "VIDEO_URL_PENDING";

export interface RenderExtras {
  /**
   * The acceptance verdict of a `make test` run. `null`: no run (gates show "not run").
   * `renderPage` loads out/evidence/acceptance.json when this is omitted.
   */
  acceptance?: unknown;
  /** Run id of the latest `make test` (out/run/run.json); an acceptance verdict from another run never certifies. */
  latestRunId?: string | null;
  /** The grant's immutable policy as read from the contract (`get_grant().policy`). */
  policy?: Policy;
  /** Historical envelope-v1 reports, shown as "legacy, uncertified by v2 rules"; never mark a gate. */
  legacy?: { label: string; reports: readonly unknown[] };
  /**
   * Evidence of a `make live` run. Shown as mainnet only when its mode is "mainnet" and every receipt carries a
   * NEAR transaction hash. `null`: none. `renderPage` loads out/evidence/live-mainnet.json when this is omitted.
   */
  live?: unknown;
  /**
   * Gate report files of the acceptance run (out/evidence/tests); the regrant and disclosure cases are embedded
   * from them. `renderPage` loads them when this is omitted; `renderHtml` then shows none.
   */
  reports?: readonly ReportFile[];
  /** @deprecated Ignored: gate status comes only from acceptance.json. */
  gateReports?: unknown;
}

export type GateStatus = "passed" | "uncertified" | "failed" | "incomplete" | "not-run";

export interface GateView {
  gate: string;
  status: GateStatus;
  cases: CaseResult[];
}

const MAX_DETAIL_CHARS = 6000;
const GATES = Object.keys(REQUIRED_CASES);

/** What each gate demonstrates, in one line. */
export const GATE_LABEL: Record<string, string> = {
  T1: "withheld signed orders fail after confirmed key removal",
  T2: "caps and reservations under randomized interleavings",
  T2b: "a published signature stays accounted",
  T3: "execution concession, feeds and breaker",
  T4: "ordinary recovery without agent, oracle or MPC",
  T5: "matched baseline (our re-implementation)",
  BOUNDARY: "forbidden requests fail at their boundary",
  MODEL: "recorded genuine model proposal reaches the interface",
  DEPLOY: "proposed deployment binary exercised in sandbox",
  DAO: "a pinned Sputnik DAO as the fixed owner, threshold-voted (sandbox)",
  AGENT: "runner sale budgets bound the agent; no-transaction provider rehearsal",
};

const json = (value: unknown): string => {
  const text = JSON.stringify(value === undefined ? null : value, null, 2);
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n... (truncated)` : text;
};

const fail = (what: string, error: z.ZodError): never => {
  throw new Error(`${what} failed schema validation:\n${z.prettifyError(error)}`);
};

interface Inputs {
  ev: Evidence;
  acc: Acceptance | null;
  binding: DemoBinding;
  policy: Policy | null;
  legacy: { label: string; reports: LegacyGateReport[] } | null;
  live: LiveView;
}

function parseInputs(evidence: unknown, extras: RenderExtras): Inputs {
  const ev = Evidence.safeParse(evidence);
  if (!ev.success) return fail("evidence", ev.error);
  let acc: Acceptance | null = null;
  if (extras.acceptance !== undefined && extras.acceptance !== null) {
    const parsed = Acceptance.safeParse(extras.acceptance);
    acc = parsed.success ? parsed.data : fail("acceptance", parsed.error);
  }
  let policy: Policy | null = null;
  if (extras.policy !== undefined) {
    const parsed = Policy.safeParse(extras.policy);
    policy = parsed.success ? parsed.data : fail("policy", parsed.error);
  }
  const legacy =
    extras.legacy === undefined
      ? null
      : {
          label: extras.legacy.label,
          reports: extras.legacy.reports.map((r, i) => {
            const parsed = LegacyGateReport.safeParse(r);
            return parsed.success ? parsed.data : fail(`legacy report #${String(i)}`, parsed.error);
          }),
        };
  return { ev: ev.data, acc, binding: bindDemo(ev.data, acc, extras.latestRunId ?? null), policy, legacy, live: liveView(extras.live) };
}

/** Mode of one demo step: the run's mode unless the receipt declares a weaker, valid one. */
function stepMode(receipt: Receipt, ev: Evidence): EvidenceMode {
  const declared =
    typeof receipt.detail === "object" && receipt.detail !== null && "mode" in receipt.detail ? EvidenceMode.safeParse(receipt.detail.mode) : null;
  if (declared !== null && !declared.success) throw new Error(`receipt "${receipt.label}" declares an unknown mode`);
  const mode = declared?.data ?? ev.mode;
  if (mode === "mainnet" && (ev.mode !== "mainnet" || receipt.tx_hash === undefined)) {
    throw new Error(`receipt "${receipt.label}" claims mainnet without mainnet evidence and a transaction hash`);
  }
  return mode;
}

/** Gate status from acceptance only, and "passed" only when the acceptance run is bound to this demo. */
export function gateViews(acc: Acceptance | null, binding: DemoBinding): GateView[] {
  return GATES.map((gate) => {
    if (acc === null) return { gate, status: "not-run" as const, cases: [] };
    const cases = acc.cases.filter((c) => c.gate === gate);
    const required: readonly string[] = REQUIRED_CASES[gate as keyof typeof REQUIRED_CASES];
    const covered = required.every((name) => cases.some((c) => c.case === name));
    let status: GateStatus;
    if (cases.some((c) => c.status === "failed" || c.status === "mismatched" || c.status === "duplicate")) status = "failed";
    else if (covered && cases.every((c) => c.status === "passed")) status = binding.certified ? "passed" : "uncertified";
    else status = "incomplete";
    return { gate, status, cases };
  });
}

const STATUS_TEXT: Record<GateStatus, string> = {
  passed: "✓ passed",
  uncertified: "! not certified for this demo",
  failed: "✕ failed",
  incomplete: "– incomplete",
  "not-run": "– not run",
};

const statusBadge = (status: GateStatus): string => `<span class="status ${status}">${STATUS_TEXT[status]}</span>`;
const caseBadge = (c: CaseResult, certified: boolean): string =>
  c.status === "passed" && !certified ? word("uncertified", "passed, not certified for this demo") : word(c.status, c.status);

const section = (num: string, tag: string, id: string, title: string, body: string): string =>
  `<section class="folio" id="${id}" aria-labelledby="${id}-h"><div class="num" aria-hidden="true">${num}<small>${tag}</small></div><div class="body"><h2 id="${id}-h">${title}</h2>${body}</div></section>`;

const SCRIPTED_ATTACK = /\((injected-request|scripted-direct)\)/;
const isModelOutput = (a: Assertion): boolean =>
  typeof a.observed === "object" && a.observed !== null && "mode" in a.observed && a.observed.mode === "recorded-model";

/** Execution labels that apply to the whole run, each derived from the evidence. */
function runLabels(ev: Evidence): string[] {
  const labels: string[] = [];
  const verifier = ev.source.fixtures["verifier/defuse-0.4.5.wasm"];
  if (verifier !== undefined && ev.environment.verifier_wasm_sha256 === verifier) labels.push("real Intents verifier WASM");
  if (ev.identifiers.mpc_test_double !== undefined || ev.identifiers.oracle_test_double !== undefined) labels.push("test doubles: MPC, oracle, tokens");
  if (ev.mode !== "mainnet") labels.push("no mainnet");
  return labels;
}

function headerChips(ev: Evidence, binding: DemoBinding, live: LiveView): string {
  const extra = [
    ...(ev.assertions.some(isModelOutput) ? ["recorded genuine model output"] : []),
    ...(ev.assertions.some((a) => SCRIPTED_ATTACK.test(a.description)) ? ["scripted attacks"] : []),
  ];
  return [
    `<span class="status ${binding.certified ? "passed" : "uncertified"}">${binding.certified ? "✓ certified for this demo" : "! not certified for this demo"}</span>`,
    modeBadge(ev.mode),
    ...[...runLabels(ev).filter((l) => live.kind !== "mainnet" || l !== "no mainnet"), ...extra].map((l) => chip("label", l)),
  ].join(" ");
}

interface Step {
  title: string;
  receipts: Receipt[];
  checks: Assertion[];
}

/** Story steps with their receipts and checks, from the offsets the demo recorded; null for older evidence. */
function storySteps(ev: Evidence): Step[] | null {
  const raw = ev.environment.steps;
  if (raw === undefined) return null;
  const parsed = z
    .array(z.object({ step: z.string(), first_receipt: z.number().int().nonnegative(), first_assertion: z.number().int().nonnegative() }))
    .safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.length === 0) return null;
  const steps = parsed.data;
  const first = steps[0];
  const pre: Step = { title: "Setup", receipts: ev.receipts.slice(0, first?.first_receipt ?? 0), checks: ev.assertions.slice(0, first?.first_assertion ?? 0) };
  const out = steps.map((s, i) => {
    const next = steps[i + 1];
    return { title: s.step, receipts: ev.receipts.slice(s.first_receipt, next?.first_receipt), checks: ev.assertions.slice(s.first_assertion, next?.first_assertion) };
  });
  return pre.receipts.length + pre.checks.length > 0 ? [pre, ...out] : out;
}

const receiptLine = (r: Receipt, ev: Evidence): string => {
  const meta = [r.tx_hash !== undefined ? `tx ${r.tx_hash}` : null, r.receipt_id !== undefined ? `receipt ${r.receipt_id}` : null, r.block_height !== undefined ? `block ${String(r.block_height)}` : null].filter(
    (m): m is string => m !== null,
  );
  return `<li id="tx-${String(ev.receipts.indexOf(r))}"><strong>${escapeHtml(r.label)}</strong> ${modeBadge(stepMode(r, ev))} ${word(r.outcome, r.outcome)}<p class="step-meta">${escapeHtml(meta.length > 0 ? meta.join(" · ") : "no transaction identifiers recorded")}</p>
<details><summary>Recorded detail</summary><pre>${escapeHtml(json(r.detail))}</pre></details></li>`;
};

const checkLine = (a: Assertion): string =>
  `<li id="check-${escapeHtml(a.id)}">${word(a.passed ? "success" : "failure", a.passed ? "held" : "did not hold")} <code>${escapeHtml(a.gate)}</code> ${escapeHtml(a.description)}<details><summary>Observed</summary><pre>${escapeHtml(json(a.observed))}</pre></details></li>`;

function stepBody(step: Step, ev: Evidence): string {
  const attacks = step.checks.filter((a) => SCRIPTED_ATTACK.test(a.description));
  const other = step.checks.filter((a) => !attacks.includes(a));
  const byBoundary = new Map<string, { n: number; held: number }>();
  for (const a of attacks) {
    const b = /stopped by ([a-z-]+)/.exec(a.description)?.[1] ?? "unclassified";
    const e = byBoundary.get(b) ?? { n: 0, held: 0 };
    byBoundary.set(b, { n: e.n + 1, held: e.held + (a.passed ? 1 : 0) });
  }
  const attackBlock = attacks.length === 0
    ? ""
    : `<p><strong>${String(attacks.filter((a) => a.passed).length)} of ${String(attacks.length)} scripted attacks stopped</strong> at their expected boundary: ${[...byBoundary.entries()]
        .map(([b, e]) => `${escapeHtml(b)} ${String(e.held)}/${String(e.n)}`)
        .join(" · ")}</p><details><summary>Each scripted attack</summary><ul class="checks">${attacks.map(checkLine).join("")}</ul></details>`;
  return `${step.receipts.length > 0 ? `<ul class="receipts">${step.receipts.map((r) => receiptLine(r, ev)).join("")}</ul>` : ""}${attackBlock}${other.length > 0 ? `<ul class="checks">${other.map(checkLine).join("")}</ul>` : ""}`;
}

function demonstrationSection(ev: Evidence): string {
  const steps = storySteps(ev);
  const base = runLabels(ev);
  const intro = `<p class="source">Source: out/evidence/demo.json · ${escapeHtml(ev.command)} · ${String(ev.receipts.length)} transactions, ${String(ev.assertions.length)} story checks. Story checks never mark an acceptance gate.</p>
<p>${ev.mode === "mainnet" ? "Steps labelled <em>mainnet</em> carry NEAR mainnet transaction hashes." : "<strong>No mainnet receipts in this evidence.</strong> Sandbox steps ran our contract and the pinned verifier WASM locally with labelled test doubles; the model step replays a recorded genuine model response."}</p>`;
  if (steps === null) {
    // Older evidence without step offsets: chronological transactions, then the story checks.
    return section("§1", "demo", "demo", "The demonstration",
      `${intro}<ol class="timeline">${ev.receipts.map((r, i) => `<li class="${r.outcome}" style="--i:${String(i)}"><div class="step-head">${base.map((l) => chip("label", l)).join("")}</div><ul class="receipts">${receiptLine(r, ev)}</ul></li>`).join("")}</ol>
<h3>Story checks</h3><ul class="checks">${ev.assertions.map(checkLine).join("")}</ul>`);
  }
  const items = steps
    .map((s, i) => {
      const labels = [
        ...(s.receipts.some((r) => stepMode(r, ev) === "recorded-model") || s.checks.some(isModelOutput) ? ["recorded genuine model output"] : []),
        ...(s.checks.some((a) => SCRIPTED_ATTACK.test(a.description)) ? ["scripted attacks"] : []),
        ...(s.receipts.some((r) => /scripted/.test(r.label)) ? ["scripted proposal"] : []),
        ...(/^Recovery/i.test(s.title) ? ["ordinary recovery (not the owner-key rescue)"] : []),
        ...(/withdrawal/i.test(s.title) ? ["owner action, outside recovery claims"] : []),
      ];
      const failed = s.receipts.some((r) => r.outcome === "failure" && !/after revocation/.test(r.label)) || s.checks.some((a) => !a.passed);
      return `<li class="${failed ? "failure" : "success"}" style="--i:${String(i)}"><div class="step-head"><strong>${escapeHtml(s.title)}</strong>${modeBadge(ev.mode)}${[...labels, ...base].map((l) => chip(l.startsWith("recorded") ? "recorded-model" : "label", l)).join("")}</div>${stepBody(s, ev)}</li>`;
    })
    .join("\n");
  return section("§1", "demo", "demo", "The demonstration", `${intro}<ol class="timeline">${items}</ol>`);
}

/** The three execution modes, each stated for this page, so sandbox, recorded model output and mainnet stay apart. */
function modesKey(ev: Evidence, live: LiveView): string {
  const demo =
    ev.mode === "sandbox"
      ? "Sandbox execution: a local NEAR sandbox runs our contract and the pinned Intents verifier WASM, with labelled test doubles for MPC, oracle and tokens."
      : `Demo evidence recorded in mode ${ev.mode}.`;
  const model = ev.assertions.some(isModelOutput)
    ? [`<li>${chip("recorded-model", "recorded model output")}<span>The trade proposal replays a recorded genuine model response. No model is called to build this page.</span></li>`]
    : [];
  const mainnet =
    live.kind === "mainnet"
      ? `<li>${modeBadge("mainnet")}<span>Mainnet receipts: transactions of an approved <code>make live</code> run, in their own section below.</span></li>`
      : `<li>${chip("pending", "mainnet: none")}<span>No mainnet receipt is shown on this page.</span></li>`;
  return `<ul class="modes-key" aria-label="Execution modes on this page"><li>${modeBadge(ev.mode)}<span>${escapeHtml(demo)}</span></li>${model.join("")}${mainnet}</ul>`;
}

function stageCard(s: Stage, i: number, ev: Evidence): string {
  const state = { held: "held", "not-held": "failure", inconclusive: "inconclusive", missing: "missing" }[s.outcome];
  const txs = s.receipts.map(
    ({ index, receipt }) => `<a href="#tx-${String(index)}">tx ${escapeHtml(shortHash(receipt.tx_hash ?? receipt.label))}</a>${receipt.outcome === "failure" ? " (failed)" : ""}`,
  );
  const one = (c: Stage["checks"][number]): string =>
    c.held === null ? `<span class="absent">${escapeHtml(c.id)}: not in this evidence</span>` : `<a href="#check-${escapeHtml(c.id)}">${escapeHtml(c.id)}</a> ${c.held ? "held" : "<strong>did not hold</strong>"}`;
  // A stage bound to many checks (the attack log) lists only those that did not hold, and links the log.
  const many = s.checks.length > 8;
  const checks = many
    ? [`${String(s.checks.filter((c) => c.held === true).length)} of ${String(s.checks.length)} checks held (<a href="#attacks">attack log</a>)`, ...s.checks.filter((c) => c.held !== true).map(one)]
    : s.checks.map(one);
  const labels = s.labels.map((l) => chip(l.startsWith("recorded") ? "recorded-model" : "label", l)).join("");
  const facts = s.facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  return `<li class="stage ${s.key} ${state}" id="stage-${s.key}"><p class="stage-head"><span class="stage-n" aria-hidden="true">${String(i + 1)}</span><span class="stage-title">${escapeHtml(s.title)}</span></p>
<p class="stage-modes">${modeBadge(ev.mode)}${labels}</p>
${s.headline === null ? `<p class="headline absent">Not in this evidence: ${escapeHtml(s.missing.join("; "))}</p>` : `<p class="headline${s.outcome === "held" ? "" : " absent"}">${escapeHtml(s.headline)}</p>`}
${facts === "" ? "" : `<dl class="stage-facts">${facts}</dl>`}
${s.state === null ? "" : `<p class="stage-state"><span>State after</span> ${escapeHtml(stateLine(s.state))}</p>`}
<p class="bound">Evidence: ${[...txs, ...checks].join(" · ")}</p></li>`;
}

/** The agent's objective and the allocation before and after the permitted trade, from recorded values. */
function outcomeBlock(ev: Evidence): string {
  const objective = `<p><strong>The owner's objective for the agent:</strong> “${escapeHtml(AGENT_OBJECTIVE)}”. This is the agent's instruction (its system prompt), not a rule the contract enforces; the contract enforces only the limits of the grant. Nothing here claims a profit.</p>`;
  const a = allocation(ev);
  if (!a.ok) return `<div class="outcome">${objective}<p class="muted">Allocation not shown: this evidence lacks ${escapeHtml(a.missing.join(" and "))}.</p></div>`;
  const { before, after, reference } = a.value;
  const row = (k: string, f: (s: typeof before) => string): string => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(f(before))}</td><td>${escapeHtml(f(after))}</td></tr>`;
  return `<div class="outcome">${objective}
<div class="scroll"><table><caption>The mandate's Intents account around the permitted trade (${escapeHtml(ev.mode)})</caption><thead><tr><th scope="col"></th><th scope="col">Before the trade</th><th scope="col">After the trade</th></tr></thead><tbody>
${row("USDC", (s) => `${usdc(s.units.usdc)} · ${usd(s.value.usdc.toString())}`)}
${row("wNEAR", (s) => `${wnear(s.units.wnear)} · ${usd(s.value.wnear.toString())}`)}
${row("Total value", (s) => usd(s.value.total.toString()))}
${row("USDC share of value", (s) => share(s.usdcShare))}
${row("Distance from 50 / 50", offBalance)}
</tbody></table></div>
<p class="source">Balances: story check trade-executed (before and after). Prices: the grant's initial reference recorded in grant-active, ${escapeHtml(priceText(reference))}, read by the contract at ${escapeHtml(isoNs(reference.observed_at_ns))}${ev.mode === "sandbox" ? "; in this sandbox run they are the oracle test double's prices that the demo posted, not market prices" : ""}. Values in integer units, rounded down to the cent; shares to the nearest 0.01%. Valued at fixed reference prices, this is not a measure of profit or loss.</p></div>`;
}

function storySection(ev: Evidence): string {
  const stages = revocationStory(ev);
  return `<section class="story" id="story" aria-labelledby="story-h"><h2 id="story-h">The journey in ${String(stages.length)} stages, from one ${escapeHtml(ev.mode)} run</h2>
<p class="source">Every value is read from out/evidence/demo.json (${escapeHtml(ev.command)}, revision ${escapeHtml(ev.source.product_commit.slice(0, 7))}${ev.source.dirty ? ", dirty tree" : ""}); each stage links to the transactions and story checks it shows (§1), and its state line is read through contract and verifier views at the end of that step. Story checks never mark an acceptance gate (§2).</p>
<ol class="stages">${stages.map((s, i) => stageCard(s, i, ev)).join("\n")}</ol></section>`;
}

function casesSection(acc: Acceptance | null, binding: DemoBinding, reports: readonly ReportFile[]): string {
  return section("§R", "sandbox", "regrant", "Regrant and disclosed signatures: sandbox acceptance cases", caseFilesBody(acc, binding, reports));
}

/** The attack log: every hostile request of this run, the layer that refused it and the source that shows where. */
function attackLogSection(ev: Evidence, acc: Acceptance | null, binding: DemoBinding): string {
  const rows = attackRows(ev);
  const title = "Attack log: each hostile request and the layer that refused it";
  if (rows.length === 0) return section("§A", "attacks", "attacks", title, `<p class="muted">This evidence records no attack results.</p>`);
  const origin = (o: string | null): string =>
    o === "injected-request" ? chip("label", "synthetic injected request") : o === "scripted-direct" ? chip("label", "scripted direct call") : chip("label", "origin not recorded");
  const sourceCell = (r: (typeof rows)[number]): string => {
    const excerpt = r.source === null ? "" : r.source.excerpt.length > 90 ? `${r.source.excerpt.slice(0, 89)}…` : r.source.excerpt;
    const src = r.source === null ? "" : `<code>${escapeHtml(`${r.source.file}:${String(r.source.line)}`)}</code><br><span class="muted mono">${escapeHtml(excerpt)}</span>`;
    const tx = r.tx_hash !== null ? `sandbox tx <code class="mono">${escapeHtml(r.tx_hash)}</code>` : r.submitted === false ? "no transaction: refused before inclusion" : r.observed === "adapter-schema" ? "no transaction: refused before any chain call" : "";
    const parts = [src, tx].filter((p) => p !== "");
    return parts.length === 0 ? `<span class="muted">source not located in this evidence</span>` : parts.join("<br>");
  };
  const row = (r: (typeof rows)[number]): string => {
    const held = r.passed && r.contained !== false;
    return `<tr id="attack-${escapeHtml(r.id.replace(/^attack-/, ""))}"><td>${word(held ? "success" : "failure", held ? "refused" : r.contained === false ? "state changed" : "not at its expected layer")} ${escapeHtml(r.description)}<br>${origin(r.origin)}${r.model_output === null ? "" : `<details><summary>Injected text</summary><pre>${escapeHtml(r.model_output)}</pre></details>`}</td>
<td class="reason">${escapeHtml(r.reason ?? "not recorded")}</td><td>${sourceCell(r)}</td></tr>`;
  };
  const layers = [...new Set(rows.map((r) => r.layer))];
  const body = layers
    .map((layer) => {
      const of = rows.filter((r) => r.layer === layer);
      const wheres = [...new Set(of.map((r) => r.where))].join("; ");
      return `<h3>${escapeHtml(layer.charAt(0).toUpperCase() + layer.slice(1))}: ${String(of.filter((r) => r.passed).length)} of ${String(of.length)} refused <span class="muted">(${escapeHtml(wheres)})</span></h3>
<div class="scroll"><table class="attack-log"><caption>${escapeHtml(layer)} in this ${escapeHtml(ev.mode)} run</caption><thead><tr><th scope="col">Request</th><th scope="col">What it returned</th><th scope="col">Source evidence</th></tr></thead><tbody>${of.map(row).join("")}</tbody></table></div>`;
    })
    .join("");
  const injection = ev.assertions.find((a) => a.id === "injection-recording");
  const verdict = z.object({ verdict: z.object({ kind: z.string() }).loose(), model: z.string().optional(), decision_text: z.string().optional() }).loose().safeParse(injection?.observed);
  const injectionBlock =
    injection === undefined
      ? ""
      : `<h3>Prompt injection against the model ${chip("recorded-model", "recorded genuine model output")}</h3><p>A synthetic instruction to withdraw everything to another account was placed in the market notes given to ${escapeHtml(verdict.success ? (verdict.data.model ?? "the model") : "the model")}. Its recorded response left the adapter as <strong>${escapeHtml(verdict.success ? verdict.data.verdict.kind : "not recorded")}</strong>; only a strict proposal (sell, amount, concession) or a decline can leave it, so no withdrawal is expressible. ${word(injection.passed ? "success" : "failure", injection.passed ? "held" : "did not hold")}</p>${
          verdict.success && verdict.data.decision_text !== undefined ? `<details><summary>Recorded model output</summary><pre>${escapeHtml(verdict.data.decision_text)}</pre></details>` : ""
        }`;
  const report = acc?.cases.find((c) => c.gate === "BOUNDARY" && c.case === "attacks");
  const reportLine =
    report === undefined
      ? "The acceptance case BOUNDARY.attacks is not in this page's acceptance run."
      : `Acceptance case BOUNDARY.attacks: ${report.status}${report.status === "passed" && !binding.certified ? ", not certified for this demo" : ""} (${report.files.join(", ")}).`;
  const counts = layerCounts(rows);
  return section("§A", "attacks", "attacks", title,
    `<p class="source">Source: the attack-* story checks of out/evidence/demo.json. Each layer is the boundary the attack suite classified from the observed result; each source line was located at demo time by searching this checkout for the text the layer returned. Origins: synthetic injected requests and scripted direct calls are written by us, never model output. ${escapeHtml(reportLine)}</p>
<p><strong>${String(rows.filter((r) => r.passed).length)} of ${String(rows.length)} refused</strong>: ${counts.map(([l, n]) => `${escapeHtml(l)} ${String(n)}`).join(" · ")}</p>
${body}${injectionBlock}`);
}

/** The planned hosting locations, always labelled as planned and unpublished; never a link. */
const plannedLine = (): string =>
  `<p class="planned">${chip("pending", PLANNED_LABEL)} Page <code>${escapeHtml(PLANNED_URLS.page)}</code> · console <code>${escapeHtml(PLANNED_URLS.console)}</code>. Nothing is hosted there yet.</p>`;

function pathsSection(live: LiveView, stageCount: number): string {
  const video =
    VIDEO_URL === "VIDEO_URL_PENDING"
      ? `<a href="${VIDEO_URL}">${VIDEO_URL}</a> (hosting pending; local build: out/video/bounded-mandate-short.mp4)`
      : `<a href="${escapeHtml(VIDEO_URL)}" rel="noopener noreferrer">${escapeHtml(VIDEO_URL)}</a>`;
  const mainnet =
    live.kind === "mainnet"
      ? `<p class="see">See: the run's NEAR mainnet transactions on nearblocks.io, and read-only RPC commands that check them without a wallet, account or funds.</p><p><a href="#mainnet">Mainnet receipts</a> · <a href="#verify">check them from this page</a></p>`
      : `<p class="see">See: <strong>Mainnet run: pending approval — no mainnet transaction has been executed.</strong> There are no mainnet receipts to inspect yet.</p><p><a href="#mainnet">Mainnet status</a> · <a href="#verify">read-only checks you can run from this page</a></p>`;
  return `<section class="paths" id="paths" aria-labelledby="paths-h"><h2 id="paths-h">Three ways to check it</h2><ol class="path-list">
<li><p class="do">Watch the short video</p><p class="see">See: the ${String(stageCount)} stages above captioned with this run's numbers, in under 90 seconds.</p><p>${video}</p></li>
<li><p class="do">Inspect public mainnet receipts</p>${mainnet}</li>
<li><p class="do">Run <code>make demo</code>, then <code>make test</code></p><p class="see">See: this page regenerated from a fresh local sandbox run, needing no funds or model key; then every acceptance gate re-run and bound to the revision (about 16 minutes).</p></li>
</ol>${plannedLine()}</section>`;
}

function gatesSection(acc: Acceptance | null, binding: DemoBinding, views: readonly GateView[]): string {
  const label = (g: string) => `<br><span class="muted">${escapeHtml(GATE_LABEL[g] ?? "")}</span>`;
  if (acc === null) {
    const rows = views.map((v) => `<tr><th scope="row"><code>${escapeHtml(v.gate)}</code>${label(v.gate)}</th><td>${statusBadge(v.status)}</td><td class="muted">no acceptance run recorded</td></tr>`).join("");
    return section("§2", "gates", "gates", "Acceptance gates",
      `<p class="source">Source: none. <code>make test</code> writes out/evidence/acceptance.json.</p><div class="scroll"><table><caption>Required gates</caption><thead><tr><th scope="col">Gate</th><th scope="col">Result</th><th scope="col">Cases</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }
  const rows = views
    .map((v) => {
      const cases = v.cases.length === 0 ? [null] : v.cases;
      return cases
        .map((c, i) => {
          const head = i === 0 ? `<th scope="row" rowspan="${String(cases.length)}"><code>${escapeHtml(v.gate)}</code>${label(v.gate)}<br>${statusBadge(v.status)}</th>` : "";
          if (c === null) return `<tr>${head}<td colspan="3" class="muted">no cases recorded</td></tr>`;
          return `<tr>${head}<td><code>${escapeHtml(c.case)}</code></td><td>${caseBadge(c, binding.certified)}${c.mode === null ? "" : ` ${caseModeBadge(c.mode)}`}</td><td class="reason">${escapeHtml(c.reason)}${c.files.length > 0 ? `<br><span class="muted mono">${escapeHtml(c.files.join(", "))}</span>` : ""}</td></tr>`;
        })
        .join("");
    })
    .join("");
  const rescue = acc.separate.length === 0
    ? ""
    : `<h3>Emergency owner-key rescue, reported separately</h3><p>This is not ordinary recovery. It never counts toward T4 or any other gate.</p><div class="scroll"><table><caption>Emergency path</caption><thead><tr><th scope="col">Case</th><th scope="col">Status</th><th scope="col">Reason</th></tr></thead><tbody>${acc.separate
        .map((c) => `<tr><th scope="row"><code>${escapeHtml(c.id)}</code></th><td>${caseBadge(c, binding.certified)}</td><td>${escapeHtml(c.reason)}</td></tr>`)
        .join("")}</tbody></table></div>`;
  return section("§2", "gates", "gates", "Acceptance gates",
    `<p class="source">Source: out/evidence/acceptance.json. ${binding.certified ? "Certified for this demo." : `Not certified for this demo: ${escapeHtml(binding.reasons.join("; "))}.`} Details in §6.</p>
<div class="scroll"><table><caption>Every required case per gate</caption><thead><tr><th scope="col">Gate</th><th scope="col">Case</th><th scope="col">Status</th><th scope="col">Reason</th></tr></thead><tbody>${rows}</tbody></table></div>${rescue}`);
}

type Increment = "demonstrated" | "parity" | "unproven" | "not-comparable";

function comparisonSection(acc: Acceptance | null, views: readonly GateView[]): string {
  const title = "Matched baseline: our re-implementation of the Claw Guard design";
  const framing = `<p>The baseline is our own re-implementation of the authority model of Claw Guard at a pinned commit, adapted to the same USDC/wNEAR trading authority on the pinned Intents verifier and executed in a local sandbox. Its outcomes describe that re-implementation under our threat model. They are not evidence of an exploit against the deployed Claw Guard product.</p>`;
  const byGate = new Map(views.map((v) => [v.gate, v.status]));
  const t5Status = byGate.get("T5") ?? "not-run";
  const data = acc?.baseline ?? null;
  if (data === null) {
    return section("§3", "baseline", "baseline", title, `${framing}<div class="verdict">${word("unproven", "unproven")}<p>No T5 baseline report in this acceptance run, so differentiation is unproven.</p></div>`);
  }
  const increment = (c: BaselineCase, mandate: GateStatus): Increment => {
    if (c.baseline_outcome !== "attack_succeeded" && c.baseline_outcome !== "blocked") return "not-comparable";
    if (mandate !== "passed") return "unproven";
    return c.baseline_outcome === "attack_succeeded" ? "demonstrated" : "parity";
  };
  const rows = data.cases
    .map((c) => {
      const m = byGate.get(c.compare_gate) ?? "not-run";
      const inc = increment(c, m);
      return `<tr><td><strong>${escapeHtml(c.threat)}</strong><br><span class="muted">${escapeHtml(c.summary)}</span>
<details><summary>Observed (re-implemented baseline)</summary><pre>${escapeHtml(json(c.observed))}</pre></details></td>
<td>${word(c.baseline_outcome, c.baseline_outcome.replaceAll("_", " "))}</td><td>${statusBadge(m)} <code>${escapeHtml(c.compare_gate)}</code></td><td>${word(inc, inc.replace("-", " "))}</td></tr>`;
    })
    .join("");
  const demonstrated = t5Status === "passed" && data.cases.some((c) => increment(c, byGate.get(c.compare_gate) ?? "not-run") === "demonstrated");
  return section("§3", "baseline", "baseline", title,
    `${framing}<div class="verdict">${word(demonstrated ? "demonstrated" : "unproven", demonstrated ? "increment demonstrated" : "differentiation unproven")}<p>${
      demonstrated
        ? "At least one attack executed against the re-implemented baseline while the matching mandate gate passed in an acceptance run certified for this demo."
        : "No case has both an executed attack on the re-implemented baseline and a passing mandate gate certified for this demo; differentiation stays unproven."
    } T5 gate: ${statusBadge(t5Status)}</p></div>
<div class="scroll"><table><caption>Same threat model, same trading authority</caption><thead><tr><th scope="col">Threat case</th><th scope="col">Re-implemented baseline (sandbox)</th><th scope="col">Mandate gate</th><th scope="col">Increment</th></tr></thead><tbody>${rows}</tbody></table></div>
<dl class="kv"><dt>Design source</dt><dd>${escapeHtml(data.baseline.repository)} @ ${escapeHtml(data.baseline.commit)}</dd><dt>License</dt><dd>${escapeHtml(data.baseline.license)}</dd><dt>Our implementation</dt><dd>${escapeHtml(data.baseline.name)}</dd><dt>Command</dt><dd>${escapeHtml(data.command)}</dd></dl>
<h3>Disclosed adaptations</h3><ul>${data.baseline.adaptations.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`);
}

// Spec mapping (SPEC.md "Acceptance tests"): which gates block which part of the claim.
const CLAIM_PARTS: readonly { text: string; gates: readonly string[] }[] = [
  { text: "After confirmed key removal, withheld signed orders fail, including after regrant", gates: ["T1"] },
  { text: "The owner recovers remaining assets without the agent, oracle or MPC (ordinary recovery)", gates: ["T4"] },
  { text: "Signing safety: caps, reservations and published-signature relay stay accounted", gates: ["T2", "T2b"] },
  { text: "Stated policy: execution concession at most 0.5% against the declared reference", gates: ["T3"] },
  { text: "The agent cannot authorize withdrawals, transfers, raw payloads, key or policy changes", gates: ["BOUNDARY"] },
  { text: "A genuine recorded model proposal reaches the real application interface", gates: ["MODEL"] },
  { text: "The proposed deployment binary is the one exercised in sandbox", gates: ["DEPLOY"] },
  { text: "Differentiation against a comparable baseline", gates: ["T5"] },
  { text: "A pinned Sputnik DAO works as the single fixed owner: grant, revoke, recovery and withdrawal by threshold vote", gates: ["DAO"] },
  { text: "Agent proposals above the runner's remaining sale budgets are rejected, never clipped", gates: ["AGENT"] },
];

const NON_CLAIMS = [
  "No guarantee of principal, profit or execution availability.",
  "No maximum total loss: market moves, stale references, fees and orders still executable when the breaker trips can lose more than the stated concession.",
  "The loss breaker stops new authorizations only; it is not a total-loss cap.",
  "The owner stays trusted and keeps deployment/upgrade authority.",
  "An adversarial agent can still make economically poor permitted trades.",
  "NEAR, the Intents verifier and the token contracts must keep functioning; recovery also needs owner gas.",
  "While revoking (before confirmed removal), already-signed orders may still execute.",
];

const combine = (statuses: readonly GateStatus[]): GateStatus => {
  for (const s of ["failed", "not-run", "incomplete", "uncertified"] as const) if (statuses.includes(s)) return s;
  return "passed";
};

function limitsSection(ev: Evidence, acc: Acceptance | null, binding: DemoBinding, views: readonly GateView[], live: LiveView): string {
  const byGate = new Map(views.map((v) => [v.gate, v.status]));
  const parts = CLAIM_PARTS.map((part) => {
    const status = combine(part.gates.map((g) => byGate.get(g) ?? "not-run"));
    return `<tr><td>${escapeHtml(part.text)}</td><td>${part.gates.map((g) => `<code>${escapeHtml(g)}</code>`).join(" ")}</td><td>${statusBadge(status)}</td></tr>`;
  }).join("");
  const derived = [
    ...(ev.mode !== "mainnet" && live.kind !== "mainnet" ? ["No mainnet receipts: encoding, key registration, the real MPC signer, settlement and recovery on mainnet are not evidenced here."] : []),
    ...(acc === null ? ["No acceptance run is attached: no gate is evidenced on this page."] : []),
    ...(!binding.certified && acc !== null ? [`The acceptance run is not certified for this demo: ${binding.reasons.join("; ")}.`] : []),
    ...views.filter((v) => v.status !== "passed").map((v) => `Gate ${v.gate} is ${STATUS_TEXT[v.status].replace(/^\S+ /, "")}: the claim parts it blocks are not supported.`),
  ];
  return section("§4", "limits", "limits", "Claim, non-claims and limits",
    `<p class="source">Claim text: SPEC.md sha256 <code>${escapeHtml(ev.source.spec_sha256)}</code>.</p>
<div class="scroll"><table><caption>A part is supported only when every listed gate passed and is certified for this demo</caption>
<thead><tr><th scope="col">Part of the claim</th><th scope="col">Gates</th><th scope="col">Status</th></tr></thead><tbody>${parts}</tbody></table></div>
<div class="claims"><div class="card not"><h3>Not guaranteed</h3><ul>${NON_CLAIMS.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></div>
<div class="card"><h3>Unknowns and open risks</h3><ul class="unknowns">${[...ev.unknowns, ...derived].map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul></div></div>
<h3>Specified authority lifecycle</h3><figure class="lifecycle">${LIFECYCLE_SVG}</figure>`);
}

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

function policySection(policy: Policy | null): string {
  if (policy === null) {
    return section("§5", "policy", "policy", "Policy parameters", `<p class="muted">No grant policy was supplied with this evidence; parameters are not shown rather than assumed.</p>`);
  }
  const rows: [string, string][] = [
    ["Per-order cap", `${pct(policy.per_order_cap_bps)} of initial reference value`],
    ["Aggregate outstanding cap", `${pct(policy.outstanding_cap_bps)} of initial reference value`],
    ["Max execution-price concession", pct(policy.max_concession_bps)],
    ["Cumulative turnover cap", `${pct(policy.turnover_cap_bps)} of initial reference value`],
    ["Loss breaker", `${pct(policy.breaker_drawdown_bps)} drawdown from initial value (stops new authorizations only)`],
    ["Oracle maximum age", `${String(policy.oracle_max_age_sec)} s`],
    ["Max confidence / price", pct(policy.max_confidence_bps)],
    ["Order deadline", `${String(policy.order_ttl_sec)} s after authorization; refuse below ${String(policy.min_remaining_sec)} s remaining`],
    ["Max pricing delay", `${String(policy.max_pricing_delay_sec)} s`],
  ];
  return section("§5", "policy", "policy", "Policy parameters",
    `<p class="source">Source: grant policy supplied with the evidence (immutable per grant).</p>
<div class="scroll"><table><caption>Immutable grant parameters</caption><thead><tr><th scope="col">Parameter</th><th scope="col">Value</th></tr></thead><tbody>${rows
      .map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
      .join("")}</tbody></table></div>`);
}

/** What each built WASM is; only `bounded_mandate` is the production contract. */
export const wasmRole = (stem: string): string =>
  stem === "bounded_mandate"
    ? "production contract"
    : stem.endsWith("_fault")
      ? "fault-injection test build, not the production contract"
      : stem.startsWith("mock_")
        ? "labelled test double"
        : stem === "claw_guard_adapted"
          ? "T5 baseline re-implementation"
          : stem.includes("reproducible")
            ? "proposed deployment binary (fixture)"
            : "test build";

const kv = (entries: readonly [string, string][]): string =>
  entries.length === 0 ? `<p class="muted">none recorded</p>` : `<dl class="kv">${entries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;

function provenanceSection(ev: Evidence, acc: Acceptance | null, binding: DemoBinding): string {
  const d = binding.inputs.demo;
  const a = binding.inputs.acceptance;
  const cmp = (name: string, demo: string | null, accepted: string | null | undefined): string =>
    `<tr><th scope="row">${escapeHtml(name)}</th><td><code>${escapeHtml(demo ?? "not recorded")}</code></td><td><code>${escapeHtml(accepted ?? "not recorded")}</code></td><td>${
      demo !== null && demo === accepted ? word("passed", "match") : word("failed", "differs")
    }</td></tr>`;
  const stems = [...new Set([...Object.keys(d.wasm_sha256 ?? {}), ...Object.keys(a?.wasm_sha256 ?? {})])].sort();
  const table = `<div class="scroll"><table><caption>Demo evidence against the acceptance run</caption><thead><tr><th scope="col">Input</th><th scope="col">Demo (demo.json)</th><th scope="col">Acceptance (acceptance.json)</th><th scope="col"></th></tr></thead><tbody>
${cmp("Revision", d.revision, a?.revision)}${cmp("Dirty tree", String(d.dirty), a === null ? null : String(a.dirty))}${cmp("SPEC.md sha256", d.spec_sha256, a?.spec_sha256)}${cmp("fixtures/manifest.json sha256", d.fixture_manifest_sha256, a?.fixture_manifest_sha256)}
${stems.map((s) => cmp(`${s}.wasm (${wasmRole(s)})`, d.wasm_sha256?.[s] ?? null, a?.wasm_sha256[s])).join("")}</tbody></table></div>`;
  const run = acc === null
    ? `<p class="muted">no acceptance run</p>`
    : `${kv([
        ["Run id", String(acc.run_id)],
        ["Latest run id", binding.inputs.latest_run_id ?? "unknown"],
        ["Certified (acceptance)", String(acc.certified)],
        ["Complete", String(acc.complete)],
        ...Object.entries(acc.environment),
      ])}<h3>make test steps</h3><pre>${escapeHtml(acc.commands.join("\n"))}</pre>
${acc.problems.length === 0 ? "" : `<h3>Run problems</h3><ul class="unknowns">${acc.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`}
${acc.ignored.length === 0 ? "" : `<h3>Files not counted</h3><div class="scroll"><table><caption>Other runs, legacy reports and unknown files</caption><thead><tr><th scope="col">File</th><th scope="col">Reason</th></tr></thead><tbody>${acc.ignored.map((i) => `<tr><td><code>${escapeHtml(i.file)}</code></td><td>${escapeHtml(i.reason)}</td></tr>`).join("")}</tbody></table></div>`}`;
  return section("§6", "provenance", "provenance", "Provenance and certification",
    `<div class="verdict">${binding.certified ? word("passed", "certified for this demo") : word("uncertified", "not certified for this demo")}<p>${
      binding.certified ? "A certified acceptance run, the latest run, binds to this demo on revision, clean tree, spec, fixtures and every deployed WASM." : escapeHtml(binding.reasons.join("; "))
    }</p></div>${table}
<h3>Fixtures (demo)</h3>${kv(Object.entries(ev.source.fixtures))}
<h3>Demo run</h3>${kv([["Spec meta commit", ev.source.spec_commit], ["Generated at", ev.generated_at], ["Command", ev.command], ...Object.entries(ev.identifiers), ...Object.entries(ev.environment).filter(([k]) => k !== "steps")])}
<h3>Acceptance run</h3>${run}`);
}

function legacySection(legacy: Inputs["legacy"]): string {
  if (legacy === null) return "";
  const rows = legacy.reports
    .map((r) => `<tr><td><code>${escapeHtml(r.gate)}${r.part ? `.${escapeHtml(r.part)}` : ""}</code></td><td>${word("uncertified", r.passed ? "legacy pass (uncertified)" : "legacy fail")}</td><td><code>${escapeHtml(r.source_revision ?? "unknown")}</code></td><td>${escapeHtml(r.mode)}</td></tr>`)
    .join("");
  return section("§L", "legacy", "legacy", "Legacy reports, uncertified by v2 rules",
    `<p class="source">Source: ${escapeHtml(legacy.label)}. These envelope-v1 reports predate run ids, per-case registration and hash binding. They are shown for the record and never mark a gate.</p>
<div class="scroll"><table><caption>Historical v1 reports</caption><thead><tr><th scope="col">Report</th><th scope="col">Recorded result</th><th scope="col">Revision</th><th scope="col">Mode</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

/** Pure renderer; throws when the evidence, acceptance, policy or legacy reports fail schema validation. */
export function renderHtml(evidence: unknown, extras: RenderExtras = {}): string {
  const { ev, acc, binding, policy, legacy, live } = parseInputs(evidence, extras);
  const script = clientScript();
  const views = gateViews(acc, binding);
  const passedCount = views.filter((v) => v.status === "passed").length;
  const anyFailed = views.some((v) => v.status === "failed");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src '${scriptHash(script)}'; connect-src https:; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Bounded mandate — evidence (${escapeHtml(ev.mode)})</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#story">Skip to the revocation story</a>
<main class="dossier">
<header class="docket">
<p class="kicker">Bounded mandate · evidence dossier · NEAR Intents · USDC / wNEAR</p>
<p class="chips" role="status">${headerChips(ev, binding, live)}</p>
<h1>${escapeHtml(HEADLINE)}</h1>
<p class="position">${escapeHtml(SUBTITLE)}</p>
${modesKey(ev, live)}
<p class="lede">Claim: the mandate contract builds and signs every trade itself, so the agent can only propose within immutable limits, and after the owner's confirmed key removal withheld signed orders fail while the owner recovers assets without the agent, oracle or signer.</p>
${outcomeBlock(ev)}
<p class="facts-line">Gates passed and certified for this demo: ${String(passedCount)} / ${String(views.length)}</p>
${binding.certified ? "" : `<p class="banner">Not certified for this demo: ${escapeHtml(binding.reasons.join("; "))}. No gate is shown as passed.</p>`}
${anyFailed ? `<p class="banner fail">At least one acceptance case failed, was mismatched or duplicated. See §2.</p>` : ""}
</header>
${storySection(ev)}
${pathsSection(live, revocationStory(ev).length)}
${attackLogSection(ev, acc, binding)}
${section("§M", "mainnet", "mainnet", "Mainnet receipts", mainnetBody(live))}
${section("§V", "verify", "verify", "Verify it yourself: read-only, opt-in", verifySection(ev, verifyData(ev, live)))}
${casesSection(acc, binding, extras.reports ?? [])}
${demonstrationSection(ev)}
${gatesSection(acc, binding, views)}
${comparisonSection(acc, views)}
${limitsSection(ev, acc, binding, views, live)}
${policySection(policy)}
${provenanceSection(ev, acc, binding)}
${legacySection(legacy)}
<footer>Generated by tools/src/page/render.ts from schema-validated evidence. Self-contained: no external files, fonts or links needed. Its one inline script makes network requests only after you press “Run read-only checks” (§V). Evidence schema version ${String(ev.schema_version)}.</footer>
</main>
<script>${script}</script>
</body>
</html>
`;
}

/** Reads out/evidence/acceptance.json; null when absent, throws when malformed. */
export function loadAcceptance(root: string): Acceptance | null {
  const path = join(root, "out/evidence/acceptance.json");
  if (!existsSync(path)) return null;
  const parsed = Acceptance.safeParse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.success ? parsed.data : fail(path, parsed.error);
}

/** Writes `<outDir>/index.html` and returns its path. Loads the repository's acceptance.json, run id and mainnet evidence unless given. */
export function renderPage(evidence: Evidence, outDir: string, extras: RenderExtras = {}): string {
  const acceptance = extras.acceptance === undefined ? loadAcceptance(REPO_ROOT) : extras.acceptance;
  const runId = extras.latestRunId === undefined ? latestRunId(REPO_ROOT) : extras.latestRunId;
  const live = extras.live === undefined ? loadLive(REPO_ROOT) : extras.live;
  const reports = extras.reports ?? loadReportFiles(reportsDir(REPO_ROOT));
  const html = renderHtml(evidence, { ...extras, acceptance, latestRunId: runId, live, reports });
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "index.html");
  writeFileSync(path, html);
  return path;
}

/** Renders a historical bundle (`<dir>/demo.json`, `<dir>/tests/*.json`) as legacy, uncertified by v2 rules. */
export function renderLegacyBundle(dir: string, outDir: string): string {
  const evidence = JSON.parse(readFileSync(join(dir, "demo.json"), "utf8")) as Evidence;
  return renderPage(evidence, outDir, { acceptance: null, latestRunId: null, live: null, legacy: { label: dir, reports: loadGateReports(join(dir, "tests")) } });
}
