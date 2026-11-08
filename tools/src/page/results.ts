import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { DemoBinding } from "../evidence/binding.js";
import { GateReportV2, type Acceptance } from "../evidence/schema.js";
import type { ReportFile } from "./casefiles.js";
import { escapeHtml } from "./html.js";

const count = z.number().int().nonnegative();
const Legitimate = z.object({
  origin: z.literal("scripted"),
  attempted: count.positive(),
  completed: count,
  authorization_refused: count,
  execution_failed: count,
  settlement_failed: count,
  setup_failed: count,
}).refine((v) => v.attempted === v.completed + v.authorization_refused + v.execution_failed + v.settlement_failed + v.setup_failed);
const TradeData = z.object({ legitimate: Legitimate });
const AttackData = z.object({
  suite: z.object({ results: z.array(z.object({
    passed: z.boolean(),
    contained: z.boolean().nullable(),
    origin: z.enum(["injected-request", "scripted-direct"]),
  })).nonempty() }),
});
const Relay = z.object({ executed: z.boolean() });
const Alternatives = z.object({
  withheld_orders: z.string(),
  strategies: z.array(z.object({
    strategy: z.string(),
    account_key_signatures_for_the_action: count,
    withheld_relays_after_action: z.array(Relay).nonempty(),
    unrecorded_order_stopped_before_its_deadline: z.boolean(),
    resume: z.object({
      while_removed: z.array(Relay).nonempty().optional(),
      same_key_new_order: Relay.optional(),
      fresh_key_new_order: Relay.optional(),
      old_order_after_fresh_key: Relay.optional(),
      unrecorded_order_after_its_deadline: Relay.optional(),
    }),
  })).nonempty(),
});

/** These summaries represent certified sandbox cases, with the same identity and input hashes as the acceptance run. */
export function sandboxResults(acc: Acceptance | null, binding: DemoBinding, files: readonly ReportFile[]) {
  const from = <T>(id: string, shape: z.ZodType<T>): { data: T; report: ReportFile } | null => {
    if (!binding.certified || acc === null) return null;
    const name = `${id}.json`;
    const entry = acc.cases.find((c) => c.id === id);
    if (entry?.status !== "passed" || entry.mode !== "sandbox" || entry.files.length !== 1 || entry.files[0] !== name) return null;
    const matching = files.filter((f) => f.file === name);
    const report = matching[0];
    if (report === undefined || matching.length !== 1) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(report.text) as unknown;
    } catch {
      return null;
    }
    const parsed = GateReportV2.safeParse(raw);
    if (!parsed.success) return null;
    const r = parsed.data;
    if (`${r.gate}.${r.case}` !== id || r.run_id !== acc.run_id || r.source.revision !== acc.revision || r.source.dirty || !r.passed || r.mode !== "sandbox" || r.spec_sha256 !== acc.hashes.spec_sha256 || r.fixture_manifest_sha256 !== acc.hashes.fixture_manifest_sha256) return null;
    const wasm = Object.entries(r.wasm_sha256);
    const fixtureWasm = Object.fromEntries(Object.entries(acc.hashes.fixtures).map(([path, hash]) => [basename(path, ".wasm"), hash]));
    if (wasm.length === 0 || wasm.some(([stem, hash]) => (acc.hashes.wasm[stem] ?? fixtureWasm[stem]) !== hash)) return null;
    const data = shape.safeParse(r.data);
    return data.success ? { data: data.data, report } : null;
  };
  const trades = from("T3.concession", TradeData);
  const attacks = from("BOUNDARY.attacks", AttackData);
  return {
    trades: trades === null ? null : { data: trades.data.legitimate, report: trades.report },
    attacks: attacks === null ? null : {
      data: {
        contained: attacks.data.suite.results.filter((r) => r.passed && r.contained === true).length,
        attempted: attacks.data.suite.results.length,
      },
      report: attacks.report,
    },
    alternatives: from("COMPARE.revocation-alternatives", Alternatives),
  };
}

type Results = ReturnType<typeof sandboxResults>;

function reportDetails(report: ReportFile): string {
  const sha = createHash("sha256").update(report.text).digest("hex");
  return `<details><summary>Read <code>${escapeHtml(report.file)}</code></summary><p class="source">Report SHA-256 <code>${sha}</code></p><pre>${escapeHtml(report.text)}</pre></details>`;
}

export function benchmarkBody({ trades, attacks }: Results): string {
  const legitimate = trades === null ? `<p class="muted">No certified legitimate-trade result is attached to this replay.</p>` : `<p class="result-number">${String(trades.data.completed)} / ${String(trades.data.attempted)}</p><p>Selected scripted trades executed and settled.</p><p><strong>${String(trades.data.authorization_refused)} authorization refusals</strong> on trades expected to pass. Setup failures ${String(trades.data.setup_failed)} · execution failures ${String(trades.data.execution_failed)} · settlement failures ${String(trades.data.settlement_failed)}.</p>${reportDetails(trades.report)}`;
  const hostile = attacks === null ? `<p class="muted">No certified hostile-request result is attached to this replay.</p>` : `<p class="result-number">${String(attacks.data.contained)} / ${String(attacks.data.attempted)}</p><p>Selected hostile requests refused at the expected boundary with containment confirmed.</p><p><a href="#attacks">See requests, refusal reasons and enforcing layers from the demo.</a></p>${reportDetails(attacks.report)}`;
  return `<p>Two separate groups of hand-picked sandbox cases using the pinned Intents verifier. Requests and proposals in these groups are scripted. The counts describe these cases only.</p><div class="result-grid"><article><h3>Legitimate trade controls</h3>${legitimate}</article><article><h3>Hostile request cases</h3>${hostile}</article></div>`;
}

const executionCount = (relays: readonly { executed: boolean }[]): string => `${String(relays.filter((r) => r.executed).length)} / ${String(relays.length)}`;

export function revocationAlternativesBody({ alternatives }: Results): string {
  const common = `<p>Expiry stops each order once its deadline passes. A complete nonce list and an available signer can cancel every listed order. Removing a key on NEAR Intents is a verifier capability that other systems can use. It protects once removal is confirmed, without a list or a signature from the removed key. The mandate combines that with contract-enforced limits, a fresh key on regrant and independent recovery.</p>`;
  if (alternatives === null) return `${common}<p class="muted">No certified revocation comparison is attached to this replay.</p>`;
  const rows = alternatives.data.strategies.map((s) => {
    const { resume } = s;
    const resumed = [
      s.unrecorded_order_stopped_before_its_deadline ? "Third order stopped before its deadline." : "Third order still executed before its deadline.",
      ...(resume.same_key_new_order === undefined ? [] : [`New order using the same key ${resume.same_key_new_order.executed ? "executed" : "failed"}.`]),
      ...(resume.fresh_key_new_order === undefined ? [] : [`New order using a fresh key ${resume.fresh_key_new_order.executed ? "executed" : "failed"}.`]),
      ...(resume.old_order_after_fresh_key === undefined ? [] : [`Old order ${resume.old_order_after_fresh_key.executed ? "executed after rotation" : "still failed after rotation"}.`]),
      ...(resume.unrecorded_order_after_its_deadline === undefined ? [] : [`Order relayed after its deadline ${resume.unrecorded_order_after_its_deadline.executed ? "executed" : "failed"}.`]),
      ...(resume.while_removed === undefined ? [] : [`${executionCount(resume.while_removed)} executed while the key was absent.`]),
    ];
    const after = `${executionCount(s.withheld_relays_after_action)}${resume.while_removed === undefined ? "" : " after re-add"}`;
    return `<tr><th scope="row">${escapeHtml(s.strategy)}</th><td>${String(s.account_key_signatures_for_the_action)}</td><td>${after}</td><td>${escapeHtml(resumed.join(" "))}</td></tr>`;
  });
  const complete = alternatives.data.strategies.some((s) => s.strategy === "cancel complete nonce list");
  return `${common}<p class="source">${escapeHtml(alternatives.data.withheld_orders)}.${complete ? " The complete-list control supplies the third nonce separately from the ledger." : ""}</p>
<div class="scroll"><table class="revocation-results"><caption>Matched verifier comparison · sandbox acceptance</caption><thead><tr><th scope="col">Owner response</th><th scope="col">Signatures from the order key</th><th scope="col">Unexpired withheld orders executed</th><th scope="col">Other recorded result</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
<p>The comparison isolates the verifier. In the mandate the owner authorizes revoke and the contract removes the key. A relay can still win the race before confirmation. Mainnet timing requires a separate run.</p>${reportDetails(alternatives.report)}`;
}
