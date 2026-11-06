// The console's recorded view: what one `make demo` run observed, rendered statically from its evidence and labelled
// with the run's mode (sandbox). It never reads the network and is never mixed with the live view: every value here
// comes from demo.json's assertions, receipts and recorded step states, and an absent value says "not in this evidence".
import { z } from "zod";
import { OwnerWithdrawal, demoSteps } from "../evidence/journey.js";
import { escapeHtml, modeBadge, word } from "../page/html.js";
import { isoNs, modelReason } from "../page/story.js";
import { GrantView, type Evidence, type Receipt } from "../types.js";
import { fmtShort, fmtUnits, grantStatusText, policyLines } from "./client.js";

const DECIMALS: Record<string, number> = { usdc: 6, wnear: 24 };
const NAME: Record<string, string> = { usdc: "USDC", wnear: "wNEAR" };
const Pair = z.object({ usdc: z.string(), wnear: z.string() });
const Detail = z.object({ signer_id: z.string(), receiver_id: z.string(), method: z.string(), final: z.boolean(), mode: z.string() }).partial().loose();

const absent = (what: string): string => `<p class="absent">${escapeHtml(what)}: not in this evidence.</p>`;
const kv = (rows: [string, string][]): string => `<dl class="kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;
const card = (title: string, body: string, wide = false): string => `<section class="ccard${wide ? " wide" : ""}"><h3>${escapeHtml(title)}</h3>${body}</section>`;
const amount = (asset: string, raw: string): string => `${fmtUnits(raw, DECIMALS[asset] ?? 0)} ${NAME[asset] ?? asset}`;
const short = (asset: string, raw: string): string => `${fmtShort(raw, DECIMALS[asset] ?? 0, 6)} ${NAME[asset] ?? asset}`;
const observed = (ev: Evidence, id: string): unknown => ev.assertions.find((a) => a.id === id)?.observed;

function grantCard(ev: Evidence): string {
  const g = GrantView.safeParse(observed(ev, "grant-active"));
  if (!g.success) return card("Grant and its limits", absent("the grant as read after activation"));
  const v = g.data;
  return card(
    "Grant and its limits",
    `<p class="grant-line">${word(`grant-${v.status}`, v.status)} epoch ${String(v.epoch)} at activation · ${escapeHtml(grantStatusText(v.status))}</p>${kv([
      ["Grant key", v.public_key ?? "none"],
      ["Derivation path", v.path],
      ["Initial reference value", v.initial_value ?? "not recorded"],
    ])}<h4>Limits</h4>${kv(policyLines(v.policy))}`,
  );
}

const pair = (p: { usdc: string; wnear: string }): string => `${escapeHtml(short("usdc", p.usdc))}<br>${escapeHtml(short("wnear", p.wnear))}`;

function lifecycleCard(ev: Evidence): string {
  const steps = demoSteps(ev.environment);
  if (steps === null) {
    const revoked = z.object({ status: z.string(), key_registered: z.boolean() }).safeParse(observed(ev, "revoked"));
    return card(
      "Grant status through the run",
      revoked.success ? `<p>After the owner's revocation: grant ${escapeHtml(revoked.data.status)}, key ${revoked.data.key_registered ? "still registered" : "absent"} on the verifier.</p>` : absent("per-step chain state"),
    );
  }
  const rows = steps
    .map((s) => {
      const st = s.state;
      if (st === undefined) return `<tr><td>${escapeHtml(s.step)}</td><td colspan="6" class="absent">state not recorded</td></tr>`;
      const key = st.key_present === null ? "no grant key" : st.key_present ? "registered" : "absent";
      return `<tr><td>${escapeHtml(s.step)}</td><td>${word(`grant-${st.grant_status}`, st.grant_status)}</td><td>${escapeHtml(key)}</td><td class="num">${String(st.open_orders)}</td><td class="num">${pair(st.mandate)}</td><td class="num">${pair(st.owner_intents)}</td><td class="num">${pair(st.owner_near)}</td></tr>`;
    })
    .join("");
  return card(
    "Grant status through the run",
    `<div class="scroll"><table><thead><tr><th scope="col">After step</th><th scope="col">Grant</th><th scope="col">Key on verifier</th><th scope="col">Open orders</th><th scope="col">Mandate on Intents</th><th scope="col">Owner on Intents</th><th scope="col">Owner's NEAR account</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    true,
  );
}

function balancesCard(ev: Evidence): string {
  const last = demoSteps(ev.environment)?.findLast((s) => s.state !== undefined)?.state;
  if (last !== undefined) {
    const row = (label: string, p: { usdc: string; wnear: string }) => `<tr><th scope="row">${escapeHtml(label)}</th><td class="num">${escapeHtml(short("usdc", p.usdc))}</td><td class="num">${escapeHtml(short("wnear", p.wnear))}</td></tr>`;
    return card(
      "Balances at the end of the run",
      `<div class="scroll"><table><thead><tr><th scope="col">Holder</th><th scope="col">USDC</th><th scope="col">wNEAR</th></tr></thead><tbody>${row("Mandate on Intents", last.mandate)}${row("Owner on Intents", last.owner_intents)}${row("Owner's NEAR account", last.owner_near)}</tbody></table></div><p class="source">At block time ${escapeHtml(isoNs(last.block_time_ns))}.</p>`,
    );
  }
  const f = z.object({ mandate: Pair, owner: Pair }).safeParse(observed(ev, "final-balances"));
  if (!f.success) return card("Balances at the end of the run", absent("final balances"));
  return card(
    "Balances at the end of the run",
    kv([
      ["Mandate on Intents", `${amount("usdc", f.data.mandate.usdc)} · ${amount("wnear", f.data.mandate.wnear)}`],
      ["Owner on Intents", `${amount("usdc", f.data.owner.usdc)} · ${amount("wnear", f.data.owner.wnear)}`],
    ]),
  );
}

const ORDER_CHECKS: [string, string][] = [
  ["trade-executed", "Order traded"],
  ["settled-release", "Its reservation released on settlement"],
  ["withheld-executable", "Second order signed and withheld (executable before revocation)"],
  ["withheld-released", "Withheld order's reservation released by confirmed key removal"],
  ["withheld-rejected", "Withheld order relayed after revocation"],
];

function ordersCard(ev: Evidence): string {
  const items = ORDER_CHECKS.map(([id, label]) => {
    const a = ev.assertions.find((x) => x.id === id);
    if (a === undefined) return `<li>${word("missing", "not recorded")} ${escapeHtml(label)}</li>`;
    return `<li>${word(a.passed ? "success" : "failure", a.passed ? "held" : "did not hold")} ${escapeHtml(label)}: ${escapeHtml(a.description)}</li>`;
  }).join("");
  return card("Orders", `<ul class="checks">${items}</ul>`);
}

function recoveryCard(ev: Evidence): string {
  const r = z.object({ recovered: Pair }).safeParse(observed(ev, "recovered"));
  const w = ev.assertions.map((a) => OwnerWithdrawal.safeParse(a.observed)).find((p) => p.success)?.data;
  const rec = r.success
    ? kv((["usdc", "wnear"] as const).map((k) => [`Recovered ${NAME[k] ?? k}`, `${amount(k, r.data.recovered[k])} to the owner's Intents account`]))
    : absent("recovered amounts");
  const wd =
    w === undefined
      ? `<h4>Owner withdrawal</h4>${absent("the owner's withdrawal to its NEAR account")}`
      : `<h4>Owner withdrawal (outside recovery)</h4>${kv(w.assets.map((x) => [NAME[x.asset] ?? x.asset, `${x.outcome}: ${amount(x.asset, x.amount)} · owner ${x.registration.registered_before ? "was registered" : "registered first"} · ${String(x.attempts.length)} attempt(s)`]))}`;
  return card("Recovery and withdrawal", `${rec}${wd}`);
}

function agentCard(ev: Evidence): string {
  const reason = modelReason(ev);
  const d = z.object({ mode: z.string(), decision: z.object({ model: z.string(), proposal: z.unknown().optional() }).loose().nullable() }).safeParse(observed(ev, "model-proposal-on-chain"));
  if (!d.success || d.data.decision === null) return card("The agent's last decision", absent("a recorded model decision"));
  return card(
    "The agent's last decision",
    `<p>${modeBadge(d.data.mode)} Replayed genuine output of <code>${escapeHtml(d.data.decision.model)}</code>; no model was called in this run.</p>${reason === null ? absent("the model's stated reason") : `<blockquote>${escapeHtml(reason)}</blockquote>`}`,
  );
}

function receiptRow(r: Receipt, i: number, mode: string): string {
  const d = Detail.safeParse(r.detail);
  const det = d.success ? d.data : {};
  const where = det.receiver_id === undefined ? "" : `${det.signer_id ?? "?"} → ${det.receiver_id}.${det.method ?? "?"}`;
  const finality = det.final === true ? "final" : "executed, not awaited to final";
  return `<tr><td class="num">${String(i + 1)}</td><td>${escapeHtml(r.label)}${where === "" ? "" : `<span class="sub">${escapeHtml(where)}</span>`}</td><td>${word(r.outcome, r.outcome)}<span class="sub">${escapeHtml(finality)}</span></td><td><code>${escapeHtml(r.tx_hash ?? "none")}</code></td><td>${modeBadge(det.mode ?? mode)}</td></tr>`;
}

/** The recorded view, static. `ev` is schema-validated demo evidence. */
export function recordedSection(ev: Evidence): string {
  const ids = ev.identifiers;
  const config = kv([
    ["Mandate", ids.mandate ?? "not recorded"],
    ["Owner", ids.owner ?? "not recorded"],
    ["Agent", ids.agent ?? "not recorded"],
    ["Intents verifier", ids.verifier ?? "not recorded"],
    ["USDC token", ids.usdc_token ?? "not recorded"],
    ["wNEAR token", ids.wnear_token ?? "not recorded"],
    ["Test doubles", [ids.mpc_test_double, ids.oracle_test_double].filter((x) => x !== undefined).join(", ") || "none recorded"],
  ]);
  const rows = ev.receipts.map((r, i) => receiptRow(r, i, ev.mode)).join("");
  return `<div class="recorded-view">
<p class="chips">${modeBadge(ev.mode)} <span class="mode recorded">recorded evidence · not live</span></p>
<p>Recorded by <code>${escapeHtml(ev.command)}</code> at revision <code>${escapeHtml(ev.source.product_commit.slice(0, 12))}</code>${ev.source.dirty ? " (uncommitted changes)" : ""}, ${escapeHtml(ev.generated_at)}. A local sandbox ran our contract and the pinned Intents verifier WASM with labelled test doubles for the MPC signer, the oracle and the tokens. These values come from <code>out/evidence/demo.json</code>; they say nothing about any live network and are never combined with the live view above.</p>
<div class="cgrid">
${card("Mandate", config)}
${grantCard(ev)}
${lifecycleCard(ev)}
${ordersCard(ev)}
${balancesCard(ev)}
${recoveryCard(ev)}
${agentCard(ev)}
</div>
<h3>Receipts</h3>
<div class="scroll"><table class="receipts-table"><thead><tr><th scope="col">#</th><th scope="col">Step</th><th scope="col">Outcome</th><th scope="col">Transaction</th><th scope="col">Provenance</th></tr></thead><tbody>${rows}</tbody></table></div>
${ev.unknowns.length === 0 ? "" : `<ul class="unknowns">${ev.unknowns.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul>`}
</div>`;
}
