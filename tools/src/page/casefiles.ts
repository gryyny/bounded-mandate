// Sandbox acceptance cases that show the regrant and disclosed-signature behaviour (T1.withheld-regrant,
// T2b.disclosed-relay, T2b.callback-failed-after-disclosure), read from the acceptance run's own report files.
// The page embeds each report verbatim with its sha256, so it stays inspectable when the page is hosted alone.
// Summaries only count what a report records; a report from another run or revision is not shown as evidence.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DemoBinding } from "../evidence/binding.js";
import { GateReportV2, type Acceptance } from "../evidence/schema.js";
import { caseModeBadge, escapeHtml, word } from "./html.js";

export interface ReportFile {
  file: string;
  text: string;
}

/** What each case's test does, from SPEC.md "Acceptance tests" (T1, T2b). */
export const INSPECTED_CASES: readonly { id: string; did: string }[] = [
  {
    id: "T1.withheld-regrant",
    did: "SPEC T1: withhold a signed order, revoke, relay it from another account, and repeat after regrant. The rows are the relays the test recorded, labelled by the test.",
  },
  {
    id: "T2b.disclosed-relay",
    did: "SPEC T2b: publish a signature, fail the mandate's callback, then relay the order independently. The rows are the phases the test recorded per order.",
  },
  {
    id: "T2b.callback-failed-after-disclosure",
    did: "SPEC T2b with the mandate's signing callback failing after the MPC disclosed the signature (mechanism below, as recorded). The rows are the phases the test recorded per order.",
  },
];

/** `*.json` report files in `dir`; none when the directory is absent. */
export function loadReportFiles(dir: string): ReportFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
}

const Relay = z.object({ label: z.string(), order_id: z.number(), epoch: z.number(), after_confirmed_removal: z.boolean(), executed: z.boolean() });
const T1Data = z.object({ relays: z.array(Relay), executions_after_confirmed_removal: z.number() });
const Step = z.object({ phase: z.string() }).catchall(z.unknown());
const StepsData = z.object({ steps: z.array(Step) }).catchall(z.unknown());

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

/** Counts read from the report's own fields; null when the data has another shape. */
export function recordedSummary(caseId: string, data: unknown): string[] | null {
  if (caseId === "T1.withheld-regrant") {
    const d = T1Data.safeParse(data);
    if (!d.success) return null;
    const after = d.data.relays.filter((r) => r.after_confirmed_removal);
    const before = d.data.relays.filter((r) => !r.after_confirmed_removal);
    return [
      `${plural(after.length, "relay")} after confirmed key removal (${[...new Set(after.map((r) => r.label))].join(", ")}): ${plural(after.filter((r) => r.executed).length, "execution")}.`,
      `${plural(before.length, "relay")} without confirmed removal of its own key (${[...new Set(before.map((r) => r.label))].join(", ")}): ${plural(before.filter((r) => r.executed).length, "execution")}, recorded honestly.`,
      `Recorded executions_after_confirmed_removal: ${String(d.data.executions_after_confirmed_removal)}.`,
    ];
  }
  const d = StepsData.safeParse(data);
  if (!d.success) return null;
  const relays = d.data.steps.filter((s) => typeof s.executed === "boolean");
  const afterRemoval = relays.filter((s) => /after confirmed removal/.test(s.phase));
  const accounted = d.data.steps.filter((s) => typeof s.accounted === "boolean");
  return [
    `${plural(relays.length, "independent relay")}: ${String(relays.filter((s) => s.executed === true).length)} executed (${relays
      .map((s) => `${s.phase}${s.order === undefined ? "" : ` (order ${JSON.stringify(s.order)})`}: ${s.executed === true ? "executed" : "not executed"}`)
      .join("; ")}).`,
    `${plural(afterRemoval.length, "relay")} after confirmed removal: ${plural(afterRemoval.filter((s) => s.executed === true).length, "execution")}.`,
    `${String(accounted.filter((s) => s.accounted === true).length)} of ${plural(accounted.length, "recorded accounting check")} report the order still accounted (reserved).`,
    ...(typeof d.data.outstanding_equals_both_reservations === "boolean" ? [`Recorded outstanding_equals_both_reservations: ${String(d.data.outstanding_equals_both_reservations)}.`] : []),
  ];
}

const cell = (v: unknown): string => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** The report's rows (`relays` or `steps`) as a table with every recorded field. */
function rowsTable(data: unknown): string {
  const o = z.record(z.string(), z.unknown()).safeParse(data);
  if (!o.success) return "";
  const key = Array.isArray(o.data.relays) ? "relays" : Array.isArray(o.data.steps) ? "steps" : null;
  if (key === null) return "";
  const rows = z.array(z.record(z.string(), z.unknown())).safeParse(o.data[key]);
  if (!rows.success) return "";
  if (key === "steps") {
    // Steps record different fields per phase: one row each, with the phase's own fields.
    const rest = (r: Record<string, unknown>) => Object.entries(r).filter(([k]) => k !== "order" && k !== "phase").map(([k, v]) => `${k}: ${cell(v)}`).join("; ");
    return `<div class="scroll"><table><caption>Recorded steps, in order</caption><thead><tr><th scope="col">Order</th><th scope="col">Phase</th><th scope="col">Recorded fields</th></tr></thead><tbody>${rows.data
      .map((r) => `<tr><td class="mono">${escapeHtml(cell(r.order))}</td><td>${escapeHtml(cell(r.phase))}</td><td class="mono">${escapeHtml(rest(r))}</td></tr>`)
      .join("")}</tbody></table></div>`;
  }
  const cols = [...new Set(rows.data.flatMap((r) => Object.keys(r)))];
  return `<div class="scroll"><table><caption>Recorded ${key}, in order</caption><thead><tr>${cols.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows.data
    .map((r) => `<tr>${cols.map((c) => `<td class="mono">${escapeHtml(cell(r[c]))}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

const SANDBOX_NOTE = "sandbox acceptance test - not part of the mainnet sequence";

function caseCard(c: { id: string; did: string }, acc: Acceptance, binding: DemoBinding, files: readonly ReportFile[]): string {
  const result = acc.cases.find((x) => x.id === c.id);
  const head = (status: string) => `<h3><code>${escapeHtml(c.id)}</code> ${status}</h3><p class="note-line">${escapeHtml(SANDBOX_NOTE)}</p><p>${escapeHtml(c.did)}</p>`;
  if (result === undefined) return `<article class="casefile" id="${escapeHtml(`report-${c.id}`)}">${head(word("missing", "not in this acceptance run"))}</article>`;
  const status = result.status === "passed" && !binding.certified ? word("uncertified", "passed, not certified for this demo") : word(result.status, result.status);
  const reports = result.files.map((name) => {
    const f = files.find((x) => x.file === name);
    if (f === undefined) return `<p class="muted">Report <code>${escapeHtml(name)}</code> is not available to this page.</p>`;
    const sha = createHash("sha256").update(f.text).digest("hex");
    let parsed: unknown;
    try {
      parsed = JSON.parse(f.text) as unknown;
    } catch {
      return `<p>${word("failed", "unreadable")} <code>${escapeHtml(name)}</code> is not JSON.</p>`;
    }
    const r = GateReportV2.safeParse(parsed);
    const mismatch = !r.success
      ? ["it is not a gate-report/2 envelope"]
      : [
          ...(r.data.run_id === acc.run_id ? [] : [`its run ${String(r.data.run_id)} is not the acceptance run ${String(acc.run_id)}`]),
          ...(r.data.source.revision === acc.revision ? [] : [`its revision ${r.data.source.revision.slice(0, 12)} is not the acceptance revision`]),
          ...(`${r.data.gate}.${r.data.case}` === c.id ? [] : [`it reports ${r.data.gate}.${r.data.case}`]),
        ];
    const where = `<p class="source">Report <code>${escapeHtml(name)}</code> (in a bundle: <code>evidence/&lt;revision&gt;/tests/${escapeHtml(name)}</code>) · sha256 <code>${escapeHtml(sha)}</code></p>`;
    const raw = `<details><summary>Full report, verbatim</summary><pre>${escapeHtml(f.text)}</pre></details>`;
    if (!r.success || mismatch.length > 0) return `${where}<p>${word("mismatched", "not shown as evidence")} ${escapeHtml(mismatch.join("; "))}.</p>${raw}`;
    const summary = recordedSummary(c.id, r.data.data);
    const mechanism = z.object({ mechanism: z.string() }).safeParse(r.data.data);
    return `${where}<p>${caseModeBadge(r.data.mode)} recorded result: ${word(r.data.passed ? "success" : "failure", r.data.passed ? "passed" : "failed")} · run <code>${escapeHtml(String(r.data.run_id))}</code> · revision <code>${escapeHtml(r.data.source.revision.slice(0, 12))}</code></p>
${mechanism.success ? `<p><strong>Mechanism (recorded):</strong> ${escapeHtml(mechanism.data.mechanism)}</p>` : ""}
${summary === null ? `<p class="muted">The report's data has an unexpected shape; see the verbatim report.</p>` : `<ul>${summary.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`}
${rowsTable(r.data.data)}${raw}`;
  });
  return `<article class="casefile" id="${escapeHtml(`report-${c.id}`)}">${head(status)}${reports.join("")}</article>`;
}

export function caseFilesBody(acc: Acceptance | null, binding: DemoBinding, files: readonly ReportFile[]): string {
  const intro = `<p>Regrant and disclosed-signature behaviour is tested in the sandbox acceptance suite, not in the demo above or the mainnet sequence. Each case below is read from the acceptance run's report file, embedded verbatim, so this page needs no other file.</p>`;
  if (acc === null) return `${intro}<p class="muted">No acceptance run is attached, so no case report is shown.</p>`;
  return `${intro}${INSPECTED_CASES.map((c) => caseCard(c, acc, binding, files)).join("")}`;
}
