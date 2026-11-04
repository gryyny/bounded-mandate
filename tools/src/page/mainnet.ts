// Mainnet receipts from `make live` (out/evidence/live-mainnet.json). Shown as mainnet only when the evidence's
// mode is "mainnet", it names no other chain, and every receipt carries a NEAR transaction hash; otherwise the
// page states that no mainnet receipt is presented. The relay of a withheld order counts as a successful
// revocation test only for classification "rejected_revoked_key" on a passing assertion.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Evidence, type Assertion, type Receipt } from "../types.js";
import { escapeHtml, modeBadge, word } from "./html.js";
import { units } from "./story.js";

export const LIVE_MAINNET_PATH = "out/evidence/live-mainnet.json";
export const EXPLORER_TX = "https://nearblocks.io/txns/";
/** Any public mainnet RPC works; this one is named in the read-only commands. */
/** Archival, so receipts stay verifiable after the run; rpc.mainnet.near.org is deprecated. */
export const PUBLIC_RPC = "https://archival-rpc.mainnet.fastnear.com";

export type LiveView = { kind: "absent" } | { kind: "rejected"; reasons: string[] } | { kind: "mainnet"; ev: Evidence };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A NEAR transaction hash: base58 of exactly 32 bytes. */
export function isTxHash(hash: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) return false;
  let n = 0n;
  for (const c of hash) n = n * 58n + BigInt(B58.indexOf(c));
  const zeros = hash.length - hash.replace(/^1+/, "").length;
  return zeros + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2)) === 32;
}

/** Parsed JSON of out/evidence/live-mainnet.json, or null when the file is absent. */
export function loadLive(root: string): unknown {
  const path = join(root, LIVE_MAINNET_PATH);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null;
}

/** Throws when present live evidence fails schema validation. */
export function liveView(live: unknown): LiveView {
  if (live === null || live === undefined) return { kind: "absent" };
  const parsed = Evidence.safeParse(live);
  if (!parsed.success) throw new Error(`live evidence failed schema validation:\n${z.prettifyError(parsed.error)}`);
  const ev = parsed.data;
  const chain = ev.environment.chain_id;
  const reasons = [
    ...(ev.mode === "mainnet" ? [] : [`its mode is "${ev.mode}", not "mainnet"`]),
    ...(chain === undefined || chain === "mainnet" ? [] : [`its chain id is "${chain}"`]),
    ...(ev.receipts.length === 0 ? ["it has no receipts"] : []),
    ...ev.receipts.filter((r) => r.tx_hash === undefined || !isTxHash(r.tx_hash)).map((r) => `receipt "${r.label}" has no NEAR transaction hash`),
  ];
  return reasons.length === 0 ? { kind: "mainnet", ev } : { kind: "rejected", reasons };
}

export interface RevocationResult {
  cls: "success" | "failure" | "inconclusive" | "not-run";
  text: string;
}

/** Result of the relayed withheld order. Only a passing "rejected_revoked_key" is a successful revocation test. */
export function revocationResult(assertions: readonly Assertion[]): RevocationResult {
  const a = assertions.find((x) => /^step-\d+-relay_withheld$/.test(x.id));
  if (a === undefined) return { cls: "not-run", text: "no withheld order was relayed in this run" };
  const parsed = z.object({ classification: z.string() }).safeParse(a.observed);
  const classification = parsed.success ? parsed.data.classification : null;
  if (classification === "rejected_revoked_key") {
    return a.passed
      ? { cls: "success", text: "withheld order rejected after confirmed revocation (rejected_revoked_key)" }
      : { cls: "failure", text: "classified rejected_revoked_key, but its verification did not hold" };
  }
  if (classification === "executed") return { cls: "failure", text: "withheld order executed after revocation" };
  if (classification === "inconclusive") return { cls: "inconclusive", text: "inconclusive: not evidence that revocation stopped the withheld order" };
  return { cls: "inconclusive", text: `unrecognized classification ${JSON.stringify(classification)}: not shown as a revocation result` };
}

const ACCOUNT = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const Detail = z.object({ step: z.union([z.number(), z.string()]).optional(), signer_id: z.string().optional(), fee_yocto: z.string().regex(/^[0-9]+$/).optional(), expected_error: z.string().optional(), withheld_relay: z.boolean().optional() });
const detailOf = (r: Receipt) => {
  const d = Detail.safeParse(r.detail);
  return d.success ? d.data : {};
};

/** The refused proposal and the withheld relay are meant to fail; their verdict is in the step verification. */
const expectedFailure = (d: { expected_error?: string | undefined; withheld_relay?: boolean | undefined }): boolean => d.expected_error !== undefined || d.withheld_relay === true;

const rpc = (method: string, params: Record<string, unknown>): string =>
  `curl -s ${PUBLIC_RPC} -H 'Content-Type: application/json' -d '${JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params })}'`;

/** Read-only commands needing no wallet, account or funds. Only validated hashes and account ids are interpolated. */
function readOnlyCommands(ev: Evidence): string[] {
  const txs = ev.receipts.flatMap((r) => {
    const signer = detailOf(r).signer_id;
    return r.tx_hash !== undefined && isTxHash(r.tx_hash) && signer !== undefined && ACCOUNT.test(signer)
      ? [`# ${r.label}\n${rpc("tx", { tx_hash: r.tx_hash, sender_account_id: signer, wait_until: "FINAL" })}`]
      : [];
  });
  const mandate = ev.identifiers.mandate;
  const view =
    mandate !== undefined && ACCOUNT.test(mandate)
      ? [`# current grant of ${mandate} (base64 of "{}")\n${rpc("query", { request_type: "call_function", finality: "final", account_id: mandate, method_name: "get_grant", args_base64: "e30=" })}`]
      : [];
  return [...txs, ...view];
}

const PENDING_TITLE = "Mainnet run: pending approval — no mainnet transaction has been executed";

export function mainnetBody(view: LiveView): string {
  if (view.kind === "absent") {
    return `<div class="pending-panel" role="status"><p class="pending-title">${PENDING_TITLE}</p><p>Mainnet execution needs separately approved accounts and budget. Nothing on this page is a mainnet receipt: the story above is sandbox execution, and the trade proposal is recorded model output. An approved run would appear here from <code>${LIVE_MAINNET_PATH}</code>, with explorer links and read-only commands.</p></div>`;
  }
  if (view.kind === "rejected") {
    return `<div class="pending-panel" role="status"><p class="pending-title">Mainnet run: not shown — <code>${LIVE_MAINNET_PATH}</code> is not mainnet evidence</p><p>Not presented as mainnet because ${escapeHtml(view.reasons.join("; "))}. No mainnet receipt is shown on this page.</p></div>`;
  }
  const ev = view.ev;
  const revocation = revocationResult(ev.assertions);
  const stopped = ev.unknowns.length > 0;
  const receipts = ev.receipts
    .map((r) => {
      const d = detailOf(r);
      const hash = r.tx_hash ?? "";
      return `<tr><td>${d.step === undefined ? "" : escapeHtml(String(d.step))}</td><td><strong>${escapeHtml(r.label)}</strong><br><a class="mono" href="${EXPLORER_TX}${escapeHtml(hash)}" rel="noopener noreferrer">${escapeHtml(hash)}</a></td><td>${modeBadge("mainnet")} ${word(r.outcome, r.outcome === "failure" && expectedFailure(d) ? "failure (expected)" : r.outcome)}</td><td class="mono">${r.block_height === undefined ? "" : String(r.block_height)}</td><td class="mono">${d.fee_yocto === undefined ? "" : `${units(d.fee_yocto, 24, 6)} NEAR`}</td></tr>`;
    })
    .join("");
  const steps = ev.assertions.filter((a) => a.id.startsWith("step-"));
  const preflight = ev.assertions.filter((a) => !a.id.startsWith("step-"));
  const row = (a: Assertion): string => {
    const relay = /-relay_withheld$/.test(a.id);
    const result = relay ? word(revocationResult([a]).cls, revocationResult([a]).text) : word(a.passed ? "success" : "failure", a.passed ? "held" : "did not hold");
    return `<tr><td><code>${escapeHtml(a.id)}</code></td><td>${result}</td><td>${escapeHtml(a.description)}<details><summary>Observed</summary><pre>${escapeHtml(JSON.stringify(a.observed, null, 2).slice(0, 4000))}</pre></details></td></tr>`;
  };
  const commands = readOnlyCommands(ev);
  return `<div class="verdict">${word(revocation.cls, revocation.cls === "success" ? "revocation test passed" : revocation.cls === "failure" ? "revocation test failed" : revocation.cls === "not-run" ? "revocation test not run" : "revocation test inconclusive")}<p>${escapeHtml(revocation.text)}. ${
    stopped ? `Run stopped: ${escapeHtml(ev.unknowns.join("; "))}` : "The run completed every manifest step."
  }</p></div>
<p class="source">Source: ${LIVE_MAINNET_PATH} · ${escapeHtml(ev.command)} · generated ${escapeHtml(ev.generated_at)} · revision ${escapeHtml(ev.source.product_commit)}${ev.source.dirty ? " (dirty)" : ""}</p>
<div class="scroll"><table><caption>Mainnet transactions (links open nearblocks.io)</caption><thead><tr><th scope="col">Step</th><th scope="col">Transaction</th><th scope="col">Result</th><th scope="col">Block</th><th scope="col">Fee</th></tr></thead><tbody>${receipts}</tbody></table></div>
<h3>Terminal verification per step</h3><div class="scroll"><table><caption>Read back from chain state and receipts after each step</caption><thead><tr><th scope="col">Assertion</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead><tbody>${steps.map(row).join("")}</tbody></table></div>
${preflight.length === 0 ? "" : `<details><summary>Preflight checks (${String(preflight.filter((a) => a.passed).length)} of ${String(preflight.length)} held)</summary><div class="scroll"><table><tbody>${preflight.map(row).join("")}</tbody></table></div></details>`}
<h3>Check it without a wallet</h3><p>Each command queries a public mainnet RPC node; none signs, spends or needs an account.</p>
<pre class="commands">${escapeHtml(commands.join("\n\n"))}</pre>
<h3>Accounts</h3><dl class="kv">${Object.entries(ev.identifiers).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;
}
