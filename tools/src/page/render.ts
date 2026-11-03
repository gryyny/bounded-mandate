// Renders the static evidence page. Every status shown is computed from validated evidence:
// a gate is "passed" only when at least one passed assertion exists and none failed or is stale.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REQUIRED_GATES } from "../checks/gates.js";
import { Evidence, EvidenceMode, Policy, type Receipt } from "../types.js";
import { LIFECYCLE_SVG } from "./lifecycle.js";
import { type BaselineCase, GateReport, T5Data } from "./reports.js";
import { STYLES } from "./styles.js";

export interface RenderExtras {
  /** Per-gate test reports, e.g. from `loadGateReports("out/evidence/tests")`. */
  gateReports?: readonly GateReport[];
  /** The grant's immutable policy as read from the contract (`get_grant().policy`). */
  policy?: Policy;
}

export type GateStatus = "passed" | "failed" | "stale" | "not-run";

interface GateSource {
  label: string;
  passed: boolean;
  mode: string;
  revision: string | null;
  stale: boolean;
}

export interface GateRow {
  gate: string;
  status: GateStatus;
  sources: GateSource[];
}

const MAX_DETAIL_CHARS = 6000;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const json = (value: unknown): string => {
  const text = JSON.stringify(value === undefined ? null : value, null, 2);
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n... (truncated)` : text;
};

const fail = (what: string, error: z.ZodError): never => {
  throw new Error(`${what} failed schema validation:\n${z.prettifyError(error)}`);
};

function parseInputs(evidence: unknown, extras: RenderExtras): { ev: Evidence; reports: GateReport[]; policy: Policy | null } {
  const ev = Evidence.safeParse(evidence);
  if (!ev.success) return fail("evidence", ev.error);
  const reports = (extras.gateReports ?? []).map((r, i) => {
    const parsed = GateReport.safeParse(r);
    return parsed.success ? parsed.data : fail(`gate report #${String(i)}`, parsed.error);
  });
  let policy: Policy | null = null;
  if (extras.policy !== undefined) {
    const parsed = Policy.safeParse(extras.policy);
    policy = parsed.success ? parsed.data : fail("policy", parsed.error);
  }
  return { ev: ev.data, reports, policy };
}

/** Mode of one demo step: the run's mode unless the receipt declares a weaker, valid one. */
function stepMode(receipt: Receipt, ev: Evidence): EvidenceMode {
  const declared =
    typeof receipt.detail === "object" && receipt.detail !== null && "mode" in receipt.detail
      ? EvidenceMode.safeParse(receipt.detail.mode)
      : null;
  if (declared !== null && !declared.success) throw new Error(`receipt "${receipt.label}" declares an unknown mode`);
  const mode = declared?.data ?? ev.mode;
  if (mode === "mainnet" && (ev.mode !== "mainnet" || receipt.tx_hash === undefined)) {
    throw new Error(`receipt "${receipt.label}" claims mainnet without mainnet evidence and a transaction hash`);
  }
  return mode;
}

export function gateRows(ev: Evidence, reports: readonly GateReport[]): GateRow[] {
  const gates = [...new Set<string>([...REQUIRED_GATES, ...reports.map((r) => r.gate), ...ev.assertions.map((a) => a.gate)])];
  return gates.map((gate) => {
    const sources: GateSource[] = [
      ...reports
        .filter((r) => r.gate === gate)
        .map((r) => {
          const revision = r.source_revision ?? null;
          return {
            label: `out/evidence/tests/${gate}${r.part ? `.${r.part}` : ""}.json`,
            passed: r.passed,
            mode: r.mode,
            revision,
            stale: revision !== ev.source.product_commit,
          };
        }),
      ...ev.assertions
        .filter((a) => a.gate === gate)
        .map((a) => ({ label: `evidence assertion ${a.id}`, passed: a.passed, mode: ev.mode, revision: ev.source.product_commit, stale: false })),
    ];
    const status: GateStatus =
      sources.length === 0
        ? "not-run"
        : sources.some((s) => !s.passed)
          ? "failed"
          : sources.some((s) => s.stale)
            ? "stale"
            : "passed";
    return { gate, status, sources };
  });
}

const STATUS_TEXT: Record<GateStatus, string> = {
  passed: "✓ passed",
  failed: "✕ failed",
  stale: "! stale",
  "not-run": "– not run",
};

const statusBadge = (status: GateStatus): string => `<span class="status ${status}">${STATUS_TEXT[status]}</span>`;

const word = (cls: string, text: string): string => `<span class="status ${escapeHtml(cls)}">${escapeHtml(text)}</span>`;

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

function claimSection(ev: Evidence, rows: readonly GateRow[]): string {
  const byGate = new Map(rows.map((r) => [r.gate, r.status]));
  const items = CLAIM_PARTS.map((part) => {
    const statuses = part.gates.map((g) => byGate.get(g) ?? "not-run");
    const status: GateStatus = statuses.includes("failed")
      ? "failed"
      : statuses.every((s) => s === "passed")
        ? "passed"
        : statuses.includes("stale")
          ? "stale"
          : "not-run";
    return `<tr><td>${escapeHtml(part.text)}</td><td>${part.gates.map((g) => `<code>${escapeHtml(g)}</code>`).join(" ")}</td><td>${statusBadge(status)}</td></tr>`;
  }).join("");
  return section(
    "§1",
    "claim",
    "claim",
    "What is claimed, and what is not",
    `<p class="source">Claim text: SPEC.md sha256 <code>${escapeHtml(ev.source.spec_sha256)}</code>. Status per part: gate results in §4.</p>
<div class="claims">
<div class="card"><h3>Claim under test</h3><p>One owner delegates a bounded USDC/wNEAR trading mandate inside NEAR Intents. The mandate contract owns its Intents account, builds every policy-approved trade itself and obtains its own derived MPC signatures. The differentiator is control over the lifetime of outstanding signed authority.</p></div>
<div class="card not"><h3>Not guaranteed</h3><ul>${NON_CLAIMS.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></div>
</div>
<h3>Claim parts and blocking gates</h3>
<div class="scroll"><table><caption>A part is supported only when every listed gate passed in this source revision</caption>
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

function gatesSection(ev: Evidence, rows: readonly GateRow[]): string {
  const body = rows
    .map((row) => {
      const sources = row.sources.length === 0
        ? `<span class="muted">no executed test or assertion recorded</span>`
        : row.sources
            .map((s) => `<div><code>${escapeHtml(s.label)}</code> ${word(s.passed ? "passed" : "failed", s.passed ? "pass" : "fail")} ${modeBadge(s.mode)}${s.stale ? ` <span class="status stale">rev ${escapeHtml((s.revision ?? "unknown").slice(0, 12))}</span>` : ""}</div>`)
            .join("");
      return `<tr><th scope="row"><code>${escapeHtml(row.gate)}</code></th><td>${statusBadge(row.status)}</td><td>${sources}</td></tr>`;
    })
    .join("");
  return section(
    "§4",
    "gates",
    "gates",
    "Acceptance gates",
    `<p class="source">Source: out/evidence/tests/*.json and evidence.assertions. A report from another revision than <code>${escapeHtml(ev.source.product_commit.slice(0, 12))}</code> is shown as stale and never counts as a pass.</p>
<div class="scroll"><table><caption>T1–T5, BOUNDARY and MODEL</caption><thead><tr><th scope="col">Gate</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead><tbody>${body}</tbody></table></div>`,
  );
}

type Increment = "demonstrated" | "parity" | "unproven" | "not-comparable";

function comparisonSection(ev: Evidence, reports: readonly GateReport[], rows: readonly GateRow[]): string {
  const t5Reports = reports.filter((r) => r.gate === "T5");
  const t5Status = rows.find((r) => r.gate === "T5")?.status ?? "not-run";
  if (t5Reports.length === 0) {
    return section("§5", "baseline", "baseline", "Matched baseline comparison",
      `<div class="verdict">${word("unproven", "unproven")}<p>No T5 baseline run is recorded, so differentiation is unproven.</p></div>`);
  }
  const datas = t5Reports.map((r, i) => {
    const parsed = T5Data.safeParse(r.data);
    return parsed.success ? parsed.data : fail(`T5 report #${String(i)} data`, parsed.error);
  });
  const byGate = new Map(rows.map((r) => [r.gate, r.status]));
  const mandateStatus = (c: BaselineCase): GateStatus => {
    if (c.mandate_assertion !== undefined) {
      const a = ev.assertions.find((x) => x.id === c.mandate_assertion);
      if (a !== undefined) return a.passed ? "passed" : "failed";
    }
    return byGate.get(c.compare_gate) ?? "not-run";
  };
  const increment = (c: BaselineCase, mandate: GateStatus): Increment => {
    // Controls ("executed"/"failed") and cases without an executed attack carry no comparison.
    if (!["attack_succeeded", "blocked"].includes(c.baseline_outcome)) return "not-comparable";
    if (mandate !== "passed") return "unproven";
    if (c.baseline_outcome === "attack_succeeded") return "demonstrated";
    return "parity";
  };
  const cases = datas.flatMap((d) => d.cases);
  const tableRows = cases
    .map((c) => {
      const m = mandateStatus(c);
      const inc = increment(c, m);
      return `<tr><td><strong>${escapeHtml(c.threat)}</strong><br><span class="muted">${escapeHtml(c.summary)}</span>
<details><summary>Observed (baseline)</summary><pre>${escapeHtml(json(c.observed))}</pre></details></td>
<td>${word(c.baseline_outcome, c.baseline_outcome.replaceAll("_", " "))}</td><td>${statusBadge(m)} <code>${escapeHtml(c.mandate_assertion ?? c.compare_gate)}</code></td><td>${word(inc, inc.replace("-", " "))}</td></tr>`;
    })
    .join("");
  const demonstrated = t5Status === "passed" && cases.some((c) => increment(c, mandateStatus(c)) === "demonstrated");
  const first = datas[0];
  const baselineInfo = first === undefined
    ? ""
    : `<dl class="kv"><dt>Baseline</dt><dd>${escapeHtml(first.baseline.name)}</dd><dt>Repository</dt><dd>${escapeHtml(first.baseline.repository)}</dd><dt>Commit</dt><dd>${escapeHtml(first.baseline.commit)}</dd><dt>License</dt><dd>${escapeHtml(first.baseline.license)}</dd><dt>Command</dt><dd>${escapeHtml(first.command)}</dd></dl>
<h3>Disclosed adaptations</h3><ul>${first.baseline.adaptations.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`;
  return section(
    "§5",
    "baseline",
    "baseline",
    "Matched baseline comparison",
    `<div class="verdict">${word(demonstrated ? "demonstrated" : "unproven", demonstrated ? "increment demonstrated" : "differentiation unproven")}<p>${
      demonstrated
        ? "At least one attack executed successfully against the baseline while the matching mandate gate passed in this revision."
        : "No case has both an executed baseline failure and a passing, current mandate gate; differentiation stays unproven."
    } T5 gate: ${statusBadge(t5Status)}</p></div>
<p class="source">Source: out/evidence/tests/T5*.json (baseline outcomes classified from executed sandbox state) joined with §4 gate results. The mandate column is the matching gate's result unless a per-case assertion id is recorded.</p>
<div class="scroll"><table><caption>Same threat model, same trading authority</caption><thead><tr><th scope="col">Threat case</th><th scope="col">Baseline (executed)</th><th scope="col">Mandate</th><th scope="col">Increment</th></tr></thead><tbody>${tableRows}</tbody></table></div>
${baselineInfo}`,
  );
}

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

function policySection(policy: Policy | null): string {
  if (policy === null) {
    return section("§6", "policy", "policy", "Policy parameters", `<p class="muted">No grant policy was supplied with this evidence; parameters are not shown rather than assumed.</p>`);
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
  return section("§6", "policy", "policy", "Policy parameters",
    `<p class="source">Source: grant policy supplied with the evidence (immutable per grant).</p>
<div class="scroll"><table><caption>Immutable grant parameters</caption><thead><tr><th scope="col">Parameter</th><th scope="col">Value</th></tr></thead><tbody>${rows
      .map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
      .join("")}</tbody></table></div>`);
}

const kv = (entries: readonly [string, string][]): string =>
  entries.length === 0 ? `<p class="muted">none recorded</p>` : `<dl class="kv">${entries.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;

function provenanceSection(ev: Evidence): string {
  const s = ev.source;
  return section("§7", "sources", "sources", "Source, hashes and environment",
    `<h3>Source</h3>${kv([
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
<h3>Environment</h3>${kv(Object.entries(ev.environment))}`);
}

function unknownsSection(ev: Evidence, rows: readonly GateRow[]): string {
  const derived = [
    ...(ev.mode !== "mainnet" ? ["No mainnet receipts: encoding, key registration, the real MPC signer, settlement and recovery on mainnet are not evidenced here."] : []),
    ...(ev.source.dirty ? ["Built from a dirty working tree: results may not match the recorded commit."] : []),
    ...rows.filter((r) => r.status !== "passed").map((r) => `Gate ${r.gate} is ${STATUS_TEXT[r.status].replace(/^\S+ /, "")}: the claim parts it blocks are not supported.`),
  ];
  const items = [...ev.unknowns, ...derived];
  return section("§8", "unknowns", "unknowns", "Unknowns and open risks",
    `<p class="source">Source: evidence.unknowns plus gaps derived from this page's gate table.</p>${items.length > 0 ? `<ul class="unknowns">${items.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>` : `<p class="muted">none recorded</p>`}`);
}

/** Pure renderer; throws when the evidence, reports or policy fail schema validation. */
export function renderHtml(evidence: unknown, extras: RenderExtras = {}): string {
  const { ev, reports, policy } = parseInputs(evidence, extras);
  const rows = gateRows(ev, reports);
  const required = rows.filter((r) => (REQUIRED_GATES as readonly string[]).includes(r.gate));
  const allPassed = required.every((r) => r.status === "passed");
  const anyFailed = required.some((r) => r.status === "failed");
  const stamp = allPassed
    ? { cls: "ok", text: `All gates passed · ${ev.mode}` }
    : anyFailed
      ? { cls: "no", text: "Gate failures recorded · claim not supported" }
      : { cls: "partial", text: "Incomplete evidence · claim not yet supported" };
  const passedCount = required.filter((r) => r.status === "passed").length;
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
<div><dt>Gates passed</dt><dd>${String(passedCount)} / ${String(required.length)}</dd></div>
<div><dt>Generated</dt><dd>${escapeHtml(ev.generated_at)}</dd></div>
</dl>
${ev.source.dirty ? `<p class="banner">Generated from a working tree with uncommitted changes.</p>` : ""}
${anyFailed ? `<p class="banner fail">At least one acceptance gate failed in this run. Failed gates are listed in §4.</p>` : ""}
</header>
${claimSection(ev, rows)}
${section("§2", "lifecycle", "lifecycle", "Authority lifecycle", `<p class="source">Specified behaviour (SPEC.md “Authority lifecycle”); executed results are in §3–§5.</p><figure class="lifecycle">${LIFECYCLE_SVG}</figure>`)}
${timelineSection(ev)}
${gatesSection(ev, rows)}
${comparisonSection(ev, reports, rows)}
${policySection(policy)}
${provenanceSection(ev)}
${unknownsSection(ev, rows)}
<footer>Generated by tools/src/page/render.ts from schema-validated evidence. Self-contained: no scripts, fonts or network requests. Evidence schema version ${String(ev.schema_version)}.</footer>
</main>
</body>
</html>
`;
}

/** Writes `<outDir>/index.html` and returns its path. */
export function renderPage(evidence: Evidence, outDir: string, extras: RenderExtras = {}): string {
  const html = renderHtml(evidence, extras);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "index.html");
  writeFileSync(path, html);
  return path;
}
