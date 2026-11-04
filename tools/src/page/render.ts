// Renders the static evidence page. Gate status comes only from out/evidence/acceptance.json
// (src/checks/acceptance.ts): a gate shows "passed" only when every required case of a certified
// run for this revision passed. Demo assertions are story checks and never mark a gate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../evidence/report.js";
import { REQUIRED_CASES } from "../evidence/required.js";
import { Acceptance, type BaselineCase, type CaseResult } from "../evidence/schema.js";
import { Evidence, EvidenceMode, Policy, type Receipt } from "../types.js";
import { LIFECYCLE_SVG } from "./lifecycle.js";
import { LegacyGateReport, loadGateReports } from "./reports.js";
import { STYLES } from "./styles.js";

export interface RenderExtras {
  /**
   * The acceptance verdict of a `make test` run. `null`: no run (gates show "not run").
   * `renderPage` loads out/evidence/acceptance.json when this is omitted.
   */
  acceptance?: unknown;
  /** The grant's immutable policy as read from the contract (`get_grant().policy`). */
  policy?: Policy;
  /** Historical envelope-v1 reports, shown as "legacy, uncertified by v2 rules"; never mark a gate. */
  legacy?: { label: string; reports: readonly unknown[] };
  /** @deprecated Ignored: gate status comes only from acceptance.json. */
  gateReports?: unknown;
}

export type GateStatus = "passed" | "uncertified" | "failed" | "incomplete" | "stale" | "not-run";

export interface GateView {
  gate: string;
  status: GateStatus;
  cases: CaseResult[];
}

const MAX_DETAIL_CHARS = 6000;
const GATES = Object.keys(REQUIRED_CASES);

export const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

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
  policy: Policy | null;
  legacy: { label: string; reports: LegacyGateReport[] } | null;
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
  return { ev: ev.data, acc, policy, legacy };
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

/** Gate status from acceptance only. An acceptance run for another revision never counts. */
export function gateViews(ev: Evidence, acc: Acceptance | null): GateView[] {
  return GATES.map((gate) => {
    if (acc === null) return { gate, status: "not-run" as const, cases: [] };
    const cases = acc.cases.filter((c) => c.gate === gate);
    const required: readonly string[] = REQUIRED_CASES[gate as keyof typeof REQUIRED_CASES];
    const covered = required.every((name) => cases.some((c) => c.case === name));
    let status: GateStatus;
    if (acc.revision !== ev.source.product_commit) status = "stale";
    else if (cases.some((c) => c.status === "failed" || c.status === "mismatched" || c.status === "duplicate")) status = "failed";
    else if (covered && cases.every((c) => c.status === "passed")) status = acc.certified ? "passed" : "uncertified";
    else status = "incomplete";
    return { gate, status, cases };
  });
}

const STATUS_TEXT: Record<GateStatus, string> = {
  passed: "✓ passed",
  uncertified: "! uncertified",
  failed: "✕ failed",
  incomplete: "– incomplete",
  stale: "! stale",
  "not-run": "– not run",
};

const statusBadge = (status: GateStatus): string => `<span class="status ${status}">${STATUS_TEXT[status]}</span>`;

const word = (cls: string, text: string): string => `<span class="status ${escapeHtml(cls)}">${escapeHtml(text)}</span>`;

const caseBadge = (c: CaseResult, certified: boolean): string =>
  c.status === "passed" && !certified ? word("uncertified", "passed (uncertified run)") : word(c.status, c.status);

const modeBadge = (mode: string): string => {
  const known = EvidenceMode.safeParse(mode);
  const cls = known.success ? known.data : "other";
  return `<span class="mode ${cls}" title="execution mode">${escapeHtml(mode)}</span>`;
};

const section = (num: string, tag: string, id: string, title: string, body: string): string =>
  `<section class="folio" id="${id}" aria-labelledby="${id}-h"><div class="num" aria-hidden="true">${num}<small>${tag}</small></div><div class="body"><h2 id="${id}-h">${title}</h2>${body}</div></section>`;

// Spec mapping (SPEC.md "Acceptance tests"): which gates block which part of the claim.
const CLAIM_PARTS: readonly { text: string; gates: readonly string[] }[] = [
  { text: "After confirmed key removal, withheld signed orders fail, including after regrant", gates: ["T1"] },
  { text: "The owner recovers remaining assets without the agent, oracle or MPC", gates: ["T4"] },
  { text: "Signing safety: caps, reservations and published-signature relay stay accounted", gates: ["T2", "T2b"] },
  { text: "Stated policy: execution concession at most 0.5% against the declared reference", gates: ["T3"] },
  { text: "The agent cannot authorize withdrawals, transfers, raw payloads, key or policy changes", gates: ["BOUNDARY"] },
  { text: "A genuine recorded model proposal reaches the real application interface", gates: ["MODEL"] },
  { text: "Differentiation against a comparable baseline", gates: ["T5"] },
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
  for (const s of ["failed", "stale", "not-run", "incomplete", "uncertified"] as const) if (statuses.includes(s)) return s;
  return "passed";
};

function claimSection(ev: Evidence, views: readonly GateView[]): string {
  const byGate = new Map(views.map((v) => [v.gate, v.status]));
  const items = CLAIM_PARTS.map((part) => {
    const status = combine(part.gates.map((g) => byGate.get(g) ?? "not-run"));
    return `<tr><td>${escapeHtml(part.text)}</td><td>${part.gates.map((g) => `<code>${escapeHtml(g)}</code>`).join(" ")}</td><td>${statusBadge(status)}</td></tr>`;
  }).join("");
  return section(
    "§1",
    "claim",
    "claim",
    "What is claimed, and what is not",
    `<p class="source">Claim text: SPEC.md sha256 <code>${escapeHtml(ev.source.spec_sha256)}</code>. Status per part: acceptance results in §5.</p>
<div class="claims">
<div class="card"><h3>Claim under test</h3><p>One owner delegates a bounded USDC/wNEAR trading mandate inside NEAR Intents. The mandate contract owns its Intents account, builds every policy-approved trade itself and obtains its own derived MPC signatures. The differentiator is control over the lifetime of outstanding signed authority.</p></div>
<div class="card not"><h3>Not guaranteed</h3><ul>${NON_CLAIMS.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></div>
</div>
<h3>Claim parts and blocking gates</h3>
<div class="scroll"><table><caption>A part is supported only when every listed gate passed in a certified run of this revision</caption>
<thead><tr><th scope="col">Part of the claim</th><th scope="col">Gates</th><th scope="col">Status</th></tr></thead><tbody>${items}</tbody></table></div>`,
  );
}

function timelineSection(ev: Evidence): string {
  const steps = ev.receipts
    .map((r, i) => {
      const mode = stepMode(r, ev);
      const meta = [
        r.tx_hash !== undefined ? `tx ${r.tx_hash}` : null,
        r.receipt_id !== undefined ? `receipt ${r.receipt_id}` : null,
        r.block_height !== undefined ? `block ${String(r.block_height)}` : null,
      ].filter((m): m is string => m !== null);
      return `<li class="${r.outcome}" style="--i:${String(i)}"><div class="step-head"><strong>${escapeHtml(r.label)}</strong>${modeBadge(mode)}${word(r.outcome, r.outcome)}</div>
${meta.length > 0 ? `<p class="step-meta">${escapeHtml(meta.join(" · "))}</p>` : `<p class="step-meta">no transaction identifiers recorded</p>`}
<details><summary>Recorded detail</summary><pre>${escapeHtml(json(r.detail))}</pre></details></li>`;
    })
    .join("\n");
  const hasMainnet = ev.mode === "mainnet";
  return section(
    "§3",
    "story",
    "story",
    "Demonstration, step by step",
    `<p class="source">Source: evidence.receipts (${String(ev.receipts.length)}), run mode ${modeBadge(ev.mode)}, command <code>${escapeHtml(ev.command)}</code>${ev.seed !== undefined ? `, seed <code>${escapeHtml(ev.seed)}</code>` : ""}.</p>
<p>${hasMainnet ? "Steps labelled <em>mainnet</em> carry NEAR mainnet transaction hashes." : "<strong>No mainnet receipts in this evidence.</strong> Sandbox steps executed the contract and the pinned verifier WASM locally with labelled test doubles; recorded-model steps replay a genuine model response captured earlier."}</p>
${ev.receipts.length > 0 ? `<ol class="timeline">${steps}</ol>` : `<p class="muted">No steps recorded.</p>`}`,
  );
}

function demoChecksSection(ev: Evidence): string {
  const rows = ev.assertions
    .map(
      (a) =>
        `<tr><td><code>${escapeHtml(a.id)}</code></td><td>${escapeHtml(a.description)}<details><summary>Observed</summary><pre>${escapeHtml(json(a.observed))}</pre></details></td><td><code>${escapeHtml(a.gate)}</code></td><td>${word(a.passed ? "success" : "failure", a.passed ? "held" : "did not hold")}</td></tr>`,
    )
    .join("");
  return section(
    "§4",
    "demo checks",
    "demo-checks",
    "Demo story checks",
    `<p class="source">Source: evidence.assertions (${String(ev.assertions.length)}). These are checks on the demonstration story. They never mark an acceptance gate passed; gate results come only from the acceptance run in §5.</p>
${rows.length > 0 ? `<div class="scroll"><table><caption>Story checks (not acceptance results)</caption><thead><tr><th scope="col">Check</th><th scope="col">What was checked</th><th scope="col">Relates to</th><th scope="col">Outcome</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">No story checks recorded.</p>`}`,
  );
}

function gatesSection(ev: Evidence, acc: Acceptance | null, views: readonly GateView[]): string {
  if (acc === null) {
    const rows = views.map((v) => `<tr><th scope="row"><code>${escapeHtml(v.gate)}</code></th><td>${statusBadge(v.status)}</td><td class="muted">no acceptance run recorded (out/evidence/acceptance.json absent)</td></tr>`).join("");
    return section("§5", "gates", "gates", "Acceptance gates",
      `<p class="source">Source: none. Run <code>make test</code> to produce out/evidence/acceptance.json.</p><div class="scroll"><table><caption>T1–T5, BOUNDARY and MODEL</caption><thead><tr><th scope="col">Gate</th><th scope="col">Result</th><th scope="col">Cases</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }
  const rows = views
    .map((v) => {
      const cases = v.cases.length === 0 ? [null] : v.cases;
      return cases
        .map((c, i) => {
          const head = i === 0 ? `<th scope="row" rowspan="${String(cases.length)}"><code>${escapeHtml(v.gate)}</code><br>${statusBadge(v.status)}</th>` : "";
          if (c === null) return `<tr>${head}<td colspan="3" class="muted">no cases recorded</td></tr>`;
          return `<tr>${head}<td><code>${escapeHtml(c.case)}</code></td><td>${caseBadge(c, acc.certified)}${c.mode === null ? "" : ` ${modeBadge(c.mode)}`}</td><td class="reason">${escapeHtml(c.reason)}${c.files.length > 0 ? `<br><span class="muted mono">${escapeHtml(c.files.join(", "))}</span>` : ""}</td></tr>`;
        })
        .join("");
    })
    .join("");
  const runState = acc.certified
    ? "certified: clean tree, unchanged during the run, every required case present once, passed and matched"
    : acc.complete
      ? "uncertified: every required case passed, but the working tree was dirty"
      : "uncertified: the run is incomplete or has failures";
  const separate = acc.separate.length === 0
    ? ""
    : `<h3>Reported separately (never counts toward T4 or any gate)</h3><div class="scroll"><table><caption>Emergency paths</caption><thead><tr><th scope="col">Case</th><th scope="col">Status</th><th scope="col">Reason</th></tr></thead><tbody>${acc.separate
        .map((c) => `<tr><th scope="row"><code>${escapeHtml(c.id)}</code></th><td>${caseBadge(c, acc.certified)}</td><td>${escapeHtml(c.reason)}</td></tr>`)
        .join("")}</tbody></table></div>`;
  const problems = acc.problems.length === 0 ? "" : `<h3>Run problems</h3><ul class="unknowns">${acc.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`;
  const ignored = acc.ignored.length === 0
    ? ""
    : `<h3>Files not counted</h3><div class="scroll"><table><caption>Other runs, legacy reports and unknown files</caption><thead><tr><th scope="col">File</th><th scope="col">Reason</th></tr></thead><tbody>${acc.ignored
        .map((i) => `<tr><td><code>${escapeHtml(i.file)}</code></td><td>${escapeHtml(i.reason)}</td></tr>`)
        .join("")}</tbody></table></div>`;
  const staleNote = acc.revision !== ev.source.product_commit
    ? `<p class="banner">This acceptance run is for revision <code>${escapeHtml(String(acc.revision))}</code>, not the demo's <code>${escapeHtml(ev.source.product_commit)}</code>; its results are shown as stale and do not count.</p>`
    : "";
  return section(
    "§5",
    "gates",
    "gates",
    "Acceptance gates",
    `<p class="source">Source: out/evidence/acceptance.json, run <code>${escapeHtml(String(acc.run_id))}</code> at <code>${escapeHtml(String(acc.revision))}</code>, evaluated ${escapeHtml(acc.evaluated_at)}. Run state: ${escapeHtml(runState)}.</p>
${staleNote}
<div class="scroll"><table><caption>Every required case per gate</caption><thead><tr><th scope="col">Gate</th><th scope="col">Case</th><th scope="col">Status</th><th scope="col">Reason</th></tr></thead><tbody>${rows}</tbody></table></div>
${problems}${separate}${ignored}`,
  );
}

type Increment = "demonstrated" | "parity" | "unproven" | "not-comparable";

function comparisonSection(acc: Acceptance | null, views: readonly GateView[]): string {
  const title = "Matched baseline: our re-implementation of the Claw Guard design";
  const framing = `<p>The baseline is our own re-implementation of the authority model of Claw Guard at a pinned commit, adapted to the same USDC/wNEAR trading authority on the pinned Intents verifier and executed in a local sandbox. Its outcomes describe that re-implementation under our threat model. They are not evidence of an exploit against the deployed Claw Guard product.</p>`;
  const byGate = new Map(views.map((v) => [v.gate, v.status]));
  const t5Status = byGate.get("T5") ?? "not-run";
  const data = acc?.baseline ?? null;
  if (data === null) {
    return section("§6", "baseline", "baseline", title, `${framing}<div class="verdict">${word("unproven", "unproven")}<p>No T5 baseline report in this acceptance run, so differentiation is unproven.</p></div>`);
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
  return section(
    "§6",
    "baseline",
    "baseline",
    title,
    `${framing}<div class="verdict">${word(demonstrated ? "demonstrated" : "unproven", demonstrated ? "increment demonstrated" : "differentiation unproven")}<p>${
      demonstrated
        ? "At least one attack executed against the re-implemented baseline while the matching mandate gate passed in a certified run of this revision."
        : "No case has both an executed attack on the re-implemented baseline and a passing mandate gate in a certified run of this revision; differentiation stays unproven."
    } T5 gate: ${statusBadge(t5Status)}</p></div>
<p class="source">Source: acceptance.json baseline data (T5.baseline report of this run), joined with the §5 gate status of the matching gate.</p>
<div class="scroll"><table><caption>Same threat model, same trading authority</caption><thead><tr><th scope="col">Threat case</th><th scope="col">Re-implemented baseline (sandbox)</th><th scope="col">Mandate gate</th><th scope="col">Increment</th></tr></thead><tbody>${rows}</tbody></table></div>
<dl class="kv"><dt>Design source</dt><dd>${escapeHtml(data.baseline.repository)} @ ${escapeHtml(data.baseline.commit)}</dd><dt>License</dt><dd>${escapeHtml(data.baseline.license)}</dd><dt>Our implementation</dt><dd>${escapeHtml(data.baseline.name)}</dd><dt>Command</dt><dd>${escapeHtml(data.command)}</dd></dl>
<h3>Disclosed adaptations</h3><ul>${data.baseline.adaptations.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`,
  );
}

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

function policySection(policy: Policy | null): string {
  if (policy === null) {
    return section("§7", "policy", "policy", "Policy parameters", `<p class="muted">No grant policy was supplied with this evidence; parameters are not shown rather than assumed.</p>`);
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
  return section("§7", "policy", "policy", "Policy parameters",
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
          : "test build";

const kv = (entries: readonly [string, string][]): string =>
  entries.length === 0 ? `<p class="muted">none recorded</p>` : `<dl class="kv">${entries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;

function provenanceSection(ev: Evidence, acc: Acceptance | null): string {
  const s = ev.source;
  const run = acc === null
    ? `<p class="muted">no acceptance run</p>`
    : `${kv([
        ["Run id", String(acc.run_id)],
        ["Revision", String(acc.revision)],
        ["Dirty", String(acc.dirty)],
        ["Certified", String(acc.certified)],
        ["Spec sha256", String(acc.hashes.spec_sha256)],
        ["Fixture manifest sha256", String(acc.hashes.fixture_manifest_sha256)],
        ...Object.entries(acc.hashes.wasm).map(([k, v]): [string, string] => [`${k}.wasm (${wasmRole(k)})`, v]),
        ...Object.entries(acc.environment),
      ])}<h3>make test steps</h3><pre>${escapeHtml(acc.commands.join("\n"))}</pre>`;
  return section("§8", "sources", "sources", "Source, hashes and environment",
    `<h3>Demo run</h3>${kv([
      ["Product commit", s.product_commit],
      ["Working tree", s.dirty ? "dirty (uncommitted changes)" : "clean"],
      ["Spec sha256", s.spec_sha256],
      ["Spec meta commit", s.spec_commit],
      ["Contract WASM sha256", s.contract_wasm_sha256],
      ["Generated at", ev.generated_at],
      ["Command", ev.command],
    ])}
<h3>Fixtures</h3>${kv(Object.entries(s.fixtures))}
<h3>Identifiers</h3>${kv(Object.entries(ev.identifiers))}
<h3>Environment</h3>${kv(Object.entries(ev.environment))}
<h3>Acceptance run</h3>${run}`);
}

function legacySection(legacy: Inputs["legacy"]): string {
  if (legacy === null) return "";
  const rows = legacy.reports
    .map((r) => `<tr><td><code>${escapeHtml(r.gate)}${r.part ? `.${escapeHtml(r.part)}` : ""}</code></td><td>${word("stale", r.passed ? "legacy pass (uncertified)" : "legacy fail")}</td><td><code>${escapeHtml(r.source_revision ?? "unknown")}</code></td><td>${escapeHtml(r.mode)}</td></tr>`)
    .join("");
  return section("§L", "legacy", "legacy", "Legacy reports, uncertified by v2 rules",
    `<p class="source">Source: ${escapeHtml(legacy.label)}. These envelope-v1 reports predate run ids, per-case registration and hash binding. They are shown for the record and never mark a gate.</p>
<div class="scroll"><table><caption>Historical v1 reports</caption><thead><tr><th scope="col">Report</th><th scope="col">Recorded result</th><th scope="col">Revision</th><th scope="col">Mode</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function unknownsSection(ev: Evidence, acc: Acceptance | null, views: readonly GateView[]): string {
  const derived = [
    ...(ev.mode !== "mainnet" ? ["No mainnet receipts: encoding, key registration, the real MPC signer, settlement and recovery on mainnet are not evidenced here."] : []),
    ...(ev.source.dirty ? ["The demo ran from a dirty working tree: results may not match the recorded commit."] : []),
    ...(acc === null ? ["No acceptance run is attached: no gate is evidenced on this page."] : []),
    ...(acc !== null && !acc.certified ? ["The acceptance run is not certified: no gate counts as passed."] : []),
    ...views.filter((v) => v.status !== "passed").map((v) => `Gate ${v.gate} is ${STATUS_TEXT[v.status].replace(/^\S+ /, "")}: the claim parts it blocks are not supported.`),
  ];
  const items = [...ev.unknowns, ...derived];
  return section("§9", "unknowns", "unknowns", "Unknowns and open risks",
    `<p class="source">Source: evidence.unknowns plus gaps derived from the acceptance run.</p>${items.length > 0 ? `<ul class="unknowns">${items.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>` : `<p class="muted">none recorded</p>`}`);
}

/** Pure renderer; throws when the evidence, acceptance, policy or legacy reports fail schema validation. */
export function renderHtml(evidence: unknown, extras: RenderExtras = {}): string {
  const { ev, acc, policy, legacy } = parseInputs(evidence, extras);
  const views = gateViews(ev, acc);
  const passedCount = views.filter((v) => v.status === "passed").length;
  const allPassed = acc !== null && acc.certified && passedCount === views.length;
  const anyFailed = views.some((v) => v.status === "failed");
  const stamp = allPassed
    ? { cls: "ok", text: "All gates passed · certified run" }
    : acc === null
      ? { cls: "partial", text: "No acceptance run · gates not run" }
      : anyFailed
        ? { cls: "no", text: "Gate failures recorded · claim not supported" }
        : views.some((v) => v.status === "stale")
          ? { cls: "partial", text: "Acceptance run for another revision · not counted" }
          : acc.complete
            ? { cls: "partial", text: "Complete but uncertified run · dirty tree" }
            : { cls: "partial", text: "Incomplete run · claim not yet supported" };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Bounded mandate — evidence (${escapeHtml(ev.mode)})</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#claim">Skip to the claim</a>
<main class="dossier">
<header class="docket">
<p class="kicker">Evidence dossier · NEAR Intents · USDC / wNEAR</p>
<div class="stamp ${stamp.cls}" role="status">${escapeHtml(stamp.text)}</div>
<h1>A bounded trading mandate whose signed authority can be withdrawn</h1>
<p class="lede">The agent can only propose. The contract prices, caps, builds and signs every order itself, and the owner can cut off outstanding signed orders and recover assets without the agent, oracle or signer. This page shows what was executed and what was not.</p>
<dl class="facts">
<div><dt>Mode</dt><dd>${modeBadge(ev.mode)}</dd></div>
<div><dt>Commit</dt><dd>${escapeHtml(ev.source.product_commit.slice(0, 12))}${ev.source.dirty ? " (dirty)" : ""}</dd></div>
<div><dt>Gates passed</dt><dd>${String(passedCount)} / ${String(views.length)}${acc !== null && !acc.certified ? " (uncertified run)" : ""}</dd></div>
<div><dt>Generated</dt><dd>${escapeHtml(ev.generated_at)}</dd></div>
</dl>
${ev.source.dirty ? `<p class="banner">The demo was generated from a working tree with uncommitted changes.</p>` : ""}
${acc !== null && !acc.certified ? `<p class="banner">The acceptance run is not certified${acc.dirty ? " (dirty working tree)" : ""}; no gate is shown as passed.</p>` : ""}
${anyFailed ? `<p class="banner fail">At least one acceptance case failed, was mismatched or duplicated. See §5.</p>` : ""}
</header>
${claimSection(ev, views)}
${section("§2", "lifecycle", "lifecycle", "Authority lifecycle", `<p class="source">Specified behaviour (SPEC.md “Authority lifecycle”); executed results are in §3–§6.</p><figure class="lifecycle">${LIFECYCLE_SVG}</figure>`)}
${timelineSection(ev)}
${demoChecksSection(ev)}
${gatesSection(ev, acc, views)}
${comparisonSection(acc, views)}
${policySection(policy)}
${provenanceSection(ev, acc)}
${unknownsSection(ev, acc, views)}
${legacySection(legacy)}
<footer>Generated by tools/src/page/render.ts from schema-validated evidence. Self-contained: no scripts, fonts or network requests. Evidence schema version ${String(ev.schema_version)}.</footer>
</main>
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

/** Writes `<outDir>/index.html` and returns its path. Loads the repository's acceptance.json unless given. */
export function renderPage(evidence: Evidence, outDir: string, extras: RenderExtras = {}): string {
  const acceptance = extras.acceptance === undefined ? loadAcceptance(REPO_ROOT) : extras.acceptance;
  const html = renderHtml(evidence, { ...extras, acceptance });
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "index.html");
  writeFileSync(path, html);
  return path;
}

/** Renders a historical bundle (`<dir>/demo.json`, `<dir>/tests/*.json`) as legacy, uncertified by v2 rules. */
export function renderLegacyBundle(dir: string, outDir: string): string {
  const evidence = JSON.parse(readFileSync(join(dir, "demo.json"), "utf8")) as Evidence;
  return renderPage(evidence, outDir, { acceptance: null, legacy: { label: dir, reports: loadGateReports(join(dir, "tests")) } });
}
