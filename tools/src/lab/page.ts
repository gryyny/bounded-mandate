// The lab's one page: generated, self-contained (inline style and one inline script pinned by hash), talking only to
// the lab that serves it. It states on every view that results are sandbox execution with test doubles.
import { createHash } from "node:crypto";
import { DECIMALS } from "../demo/market.js";
import type { Policy } from "../types.js";
import { ALTERNATIVES, type AlternativeId } from "./alternatives.js";
import { LAB_CLIENT_FUNCTIONS, type LabPageData, type Preset } from "./client.js";
import { LAB_LABEL, LAB_POLICY } from "./config.js";
import { REPLAY_COMMAND, type SourceRevision } from "./scenario.js";

const esc = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const POLICY_FIELDS: { key: keyof Policy; label: string; unit: string; help: string }[] = [
  { key: "per_order_cap_bps", label: "Largest single order", unit: "bps of starting value", help: "2000 = 20% of the treasury's value when granted." },
  { key: "outstanding_cap_bps", label: "Largest total of open orders", unit: "bps of starting value", help: "Signed orders that have not settled, expired or been revoked count here." },
  { key: "max_concession_bps", label: "Worst acceptable price", unit: "bps below the oracle price", help: "50 = the agent may give up at most 0.5% against the reference price." },
  { key: "turnover_cap_bps", label: "Total trading per grant", unit: "bps of starting value", help: "10000 = the agent may trade the treasury's value once over, in total." },
  { key: "proposal_charge_bps", label: "Minimum charge per proposal", unit: "bps of starting value", help: "Every proposal uses at least this much of the total, even when refused later." },
  { key: "breaker_drawdown_bps", label: "Loss breaker", unit: "bps drawdown", help: "200 = no new orders once the treasury is seen 2% below its starting value." },
  { key: "order_ttl_sec", label: "Order lifetime", unit: "seconds", help: "A signed order can execute until this long after it was authorized." },
  { key: "oracle_max_age_sec", label: "Oldest usable price", unit: "seconds", help: "Also bounds the order lifetime: an order cannot outlive its prices." },
  { key: "max_confidence_bps", label: "Widest price uncertainty", unit: "bps of price", help: "Prices with a wider confidence interval are refused." },
  { key: "min_remaining_sec", label: "Least time left to sign", unit: "seconds", help: "The contract will not sign an order with less lifetime left." },
  { key: "max_pricing_delay_sec", label: "Longest wait for prices", unit: "seconds", help: "A proposal not priced within this delay is never signed." },
];

/** Amounts are token units: USDC has 6 decimals. Against the starting limits the comments say what the contract answers. */
export const PRESETS: Preset[] = [
  { id: "permitted", label: "a permitted trade", explain: "Sell 50 USDC for wNEAR, giving up at most 0.20%. Inside the starting limits.", sell: "usdc", sell_amount: "50000000", max_concession_bps: 20 },
  { id: "unsafe-size", label: "an unsafe trade (too large)", explain: "Sell 600 USDC in one order: about 31% of the treasury, above the 20% starting limit per order.", sell: "usdc", sell_amount: "600000000", max_concession_bps: 20 },
  { id: "unsafe-price", label: "an unsafe trade (price too poor)", explain: "Sell 50 USDC while giving up as much as 5%: above the 0.5% starting limit.", sell: "usdc", sell_amount: "50000000", max_concession_bps: 500 },
  { id: "poor", label: "a poor but permitted trade", explain: "Sell 50 USDC at the worst price the current grant allows. Bad for the owner, and still inside the limits: the contract signs it.", sell: "usdc", sell_amount: "50000000", max_concession_bps: "grant_max" },
];

const ALTERNATIVE_LABELS: Record<AlternativeId, string> = {
  wait: "Stop issuing and wait for expiry",
  cancel_complete: "Cancel a complete nonce list",
  cancel_incomplete: "Cancel an incomplete nonce list",
  cancel_signer_unavailable: "Cancel with the signer unavailable",
  remove_fresh_key: "Remove the key, resume with a fresh key",
  remove_same_key: "Remove the key, re-add the same key",
};

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1c1b19;--muted:#5f5b53;--line:#d9d5cc;--card:#fff;--ok:#1d6b3a;--bad:#a3271b;--work:#7a5a00;--accent:#1f4f8f}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a9a59b;--line:#3a3833;--card:#1f1f1c;--ok:#6fcf8f;--bad:#ff8a7a;--work:#e6c35c;--accent:#8ab4f0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:0 20px 64px}
.top{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line)}
.banner{background:var(--work);color:#fff;padding:8px 20px;font-size:14px;font-weight:600}
@media (prefers-color-scheme:dark){.banner{color:#161614}}
h1{font-size:28px;line-height:1.2;margin:28px 0 8px}
h2{font-size:20px;margin:0 0 8px}
h3{font-size:16px;margin:0 0 6px}
p{margin:0 0 10px}
.muted{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:16px 0}
.step{display:inline-block;min-width:26px;height:26px;border-radius:13px;background:var(--accent);color:var(--bg);text-align:center;font-weight:700;margin-right:8px;font-size:14px;line-height:26px}
button{font:inherit;padding:7px 12px;border-radius:6px;border:1px solid var(--accent);background:var(--card);color:var(--accent);cursor:pointer;margin:0 6px 6px 0}
button.primary{background:var(--accent);color:var(--bg)}
button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
input,select,textarea{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input[type=text]{width:110px}
.limits{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px 18px}
.limits label{display:block;font-weight:600;font-size:14px}
.limits small,.preset small{display:block;color:var(--muted);font-size:13px}
.preset{margin:0 0 10px}
.tabs{display:flex;gap:4px;margin:20px 0 0;border-bottom:1px solid var(--line)}
.tabs button{border-radius:6px 6px 0 0;margin:0;border-bottom:none}
.tabs button[aria-selected=true]{background:var(--accent);color:var(--bg)}
.status{max-width:1040px;padding:8px 14px;border-radius:6px;border:1px solid var(--line);margin:8px auto;font-weight:600}
.status.ok{border-color:var(--ok);color:var(--ok)}
.status.refused{border-color:var(--bad);color:var(--bad)}
.status.work{border-color:var(--work);color:var(--work)}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:1px 7px;border-radius:9px;border:1px solid currentColor}
.pill.ok{color:var(--ok)}.pill.refused{color:var(--bad)}.pill.info{color:var(--muted)}.pill.exec{color:var(--fg)}
.kv{display:grid;grid-template-columns:minmax(180px,max-content) 1fr;gap:4px 16px;margin:0}
.kv dt{color:var(--muted);font-size:14px}.kv dd{margin:0;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;font-size:14px;margin:0 0 10px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.scroll{overflow-x:auto}
td.acts button{padding:3px 8px;font-size:13px}
.rec{border-top:1px solid var(--line);padding:12px 0}
.seq{color:var(--muted)}
.err{color:var(--bad);overflow-wrap:anywhere}
details.tx{margin:4px 0;font-size:14px}
details.tx summary{cursor:pointer}
code,pre{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:240px;overflow:auto}
.receipts{margin:6px 0 6px 18px;padding:0}
textarea{width:100%;height:160px;font:12px/1.4 ui-monospace,monospace}
`;

/** The page's only script: the client functions, then the wiring. */
export function labScript(): string {
  const body = LAB_CLIENT_FUNCTIONS.map((f) => f.toString()).join("\n");
  // Transpilers may wrap names with a `__name` helper (esbuild keepNames); the script has no module scope for it.
  const script = `"use strict";\nconst __name = (f) => f;\n${body}\nlet store = null;\ntry { store = window.sessionStorage; } catch { store = null; }\ninstall(document, (url, init) => fetch(url, init), store);\n`;
  if (/<\/script|<!--/i.test(script)) throw new Error("lab script cannot be inlined: it contains a closing script tag or comment opener");
  return script;
}

const scriptHash = (script: string): string => `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;

/** No external source of any kind: styles and the one script are inline, requests go to the serving lab only. */
export const labCsp = (script: string): string =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src '${scriptHash(script)}'; connect-src 'self'; form-action 'none'; base-uri 'none'`;

export interface LabPageInfo {
  source: SourceRevision;
  wasm: Record<string, { path: string; sha256: string }>;
  testDoubles: readonly { role: string; contract: string; path: string; sha256: string; note: string }[];
  policy?: Policy;
}

export function renderLabPage(info: LabPageInfo): { html: string; csp: string } {
  const script = labScript();
  const csp = labCsp(script);
  const policy = info.policy ?? LAB_POLICY;
  const data: LabPageData = {
    policy_fields: POLICY_FIELDS.map((f) => f.key),
    presets: PRESETS,
    alternatives: ALTERNATIVES.map((id) => ({ id, label: ALTERNATIVE_LABELS[id] })),
    decimals: DECIMALS,
  };
  const limits = POLICY_FIELDS.map(
    (f) => `<div><label for="policy-${f.key}">${esc(f.label)}</label><input id="policy-${f.key}" type="text" inputmode="numeric" value="${String(policy[f.key])}" autocomplete="off"> <span class="muted">${esc(f.unit)}</span><small>${esc(f.help)}</small></div>`,
  ).join("\n");
  const presets = PRESETS.map((p) => `<div class="preset"><button type="button" id="preset-${esc(p.id)}" data-needs="session">Propose ${esc(p.label)}</button><small>${esc(p.explain)}</small></div>`).join("\n");
  const alternatives = ALTERNATIVES.map((id) => `<button type="button" id="alt-${id}" data-needs="session">${esc(ALTERNATIVE_LABELS[id])}</button>`).join("\n");
  const binaries = Object.entries(info.wasm)
    .map(([role, w]) => `<tr><td>${esc(role)}</td><td><code>${esc(w.path)}</code></td><td><code>${esc(w.sha256)}</code></td></tr>`)
    .join("");
  const doubles = info.testDoubles.map((d) => `<li><strong>${esc(d.role)}</strong>: ${esc(d.contract)}. ${esc(d.note)}.</li>`).join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>Bounded mandate — sandbox lab</title>
<style>${STYLE}</style>
</head>
<body>
<div class="top">
<div class="banner" role="note" id="lab-label">${esc(LAB_LABEL)}</div>
<p id="lab-status" class="status" role="status" aria-live="polite">Start a session to get your own sandbox treasury.</p>
</div>
<main id="lab-root" data-lab="${esc(JSON.stringify(data))}">
<h1>Sandbox lab: give an agent trading authority inside your limits, then remove it</h1>
<p>An owner lets an AI agent trade USDC and wNEAR from a treasury. The agent can only <em>propose</em> a trade. A contract checks every proposal against the owner's limits and signs only what passes. When the owner revokes, the contract removes its signing key, and from then on even orders that were already signed stop working.</p>
<p>Here you play every role on a private sandbox chain. Each button sends real transactions to the real contracts in that sandbox, and every answer below is what their receipts say. Nothing here is computed by this page.</p>
<section class="card" aria-label="Session">
<button type="button" class="primary" id="session-start" data-needs="no-session">Start a session</button>
<button type="button" id="session-refresh" data-needs="session">Read the state again</button>
<button type="button" id="session-reset" data-needs="session">Reset</button>
<button type="button" id="session-export" data-needs="session">Export scenario</button>
<button type="button" id="session-end" data-needs="session">End session</button>
<p class="muted" id="session-info"></p>
<div id="export-box" hidden>
<p class="muted">The scenario names the source revision, the WASM hashes, the test doubles and every action with its outcome. Replay it on a fresh local sandbox with <code>${esc(REPLAY_COMMAND)}</code>. <a id="export-link" download="lab-scenario.json" href="#">Download the file</a></p>
<textarea id="export-text" readonly aria-label="Exported scenario"></textarea>
</div>
</section>
<div class="tabs" role="tablist">
<button type="button" role="tab" id="tab-operate" aria-selected="true" aria-controls="panel-operate">Operate the treasury</button>
<button type="button" role="tab" id="tab-compare" aria-selected="false" aria-controls="panel-compare">Compare the owner's alternatives</button>
</div>
<div id="panel-operate" role="tabpanel" aria-labelledby="tab-operate">
<section class="card">
<h2><span class="step">1</span>Owner: set the limits and grant</h2>
<p class="muted">These are the limits the contract will enforce on the agent. They cannot be changed while the grant is active: to change them, revoke and grant again. Try a second session with other limits and the same trades. The starting values are the project's demonstration thresholds, except the two lifetimes (120 s instead of 60 s) so that you have time to act: this sandbox never skips time.</p>
<div class="limits">
${limits}
</div>
<p><button type="button" class="primary" id="act-grant" data-needs="session">Grant with these limits</button></p>
</section>
<section class="card">
<h2><span class="step">2</span>Agent: propose a trade</h2>
<p class="muted">The agent's key can call one method, <code>propose_order</code>. It cannot choose a recipient, sign anything itself or change the limits.</p>
${presets}
<p><label for="prop-sell">Custom: sell</label> <input id="prop-amount" type="text" inputmode="decimal" value="25" aria-label="Amount to sell"> <select id="prop-sell"><option value="usdc">USDC</option><option value="wnear">wNEAR</option></select> <label for="prop-concession">giving up at most</label> <input id="prop-concession" type="text" inputmode="numeric" value="20"> <span class="muted">bps</span> <button type="button" id="act-propose" data-needs="session">Propose</button></p>
</section>
<section class="card">
<h2><span class="step">3</span>Signed orders: fill one, withhold another</h2>
<p class="muted">A signed order is a promise anyone can execute until its deadline. <strong>Fill</strong> executes it now against the filler. <strong>Withhold</strong> makes the counterparty keep the complete signed bundle instead, to use later. After you revoke in step 4, <strong>Relay withheld</strong> sends that same bundle from another account.</p>
<div class="scroll"><table><thead><tr><th>Order</th><th>Sells</th><th>Buys at least</th><th>Gives up at most</th><th>State</th><th>Deadline</th><th>Do</th></tr></thead><tbody id="orders"></tbody></table></div>
</section>
<section class="card">
<h2><span class="step">4</span>Owner: revoke, then recover</h2>
<p class="muted">Revoke stops new orders at once and removes the grant's key from the verifier. Once that removal is confirmed, relay the withheld order in step 3: the verifier refuses it. Recover moves both assets to the owner's own Intents account; it needs no agent, no price and no signature, so it works with both test doubles switched off.</p>
<p><button type="button" class="primary" id="act-revoke" data-needs="session">Revoke the grant</button> <button type="button" id="act-recover" data-needs="session">Recover the assets</button></p>
<details id="doubles"><summary>Test doubles of this session (price oracle and MPC signer)</summary>
<p class="muted">These switches act on this session's own test doubles only.</p>
<p><button type="button" id="act-oracle-off" data-needs="session">Make the price oracle fail</button> <label for="oracle-wnear">wNEAR price in USD</label> <input id="oracle-wnear" type="text" inputmode="decimal" value="3.00"> <button type="button" id="act-oracle-on" data-needs="session">Oracle answers with this price</button></p>
<p><button type="button" id="act-signer-off" data-needs="session">Make the MPC signer fail</button> <button type="button" id="act-signer-on" data-needs="session">Signer signs again</button></p>
</details>
</section>
<section class="card" aria-label="Live state">
<h2>Live state of your sandbox</h2>
<p class="muted">Read from the contracts after your last action.</p>
<div id="state"></div>
</section>
</div>
<div id="panel-compare" role="tabpanel" aria-labelledby="tab-compare" hidden>
<section class="card">
<h2>What else could the owner do?</h2>
<p class="muted">Each run starts from the same conditions on its own fresh accounts in your session's sandbox: a treasury account on the pinned verifier, with three signed orders already in a counterparty's hands, two that the owner has on record and one that it does not. The owner then takes one of the actions below, and another account relays every withheld order. The table shows which orders still executed. A run takes 10 to 40 seconds; waiting for expiry waits in real time.</p>
${alternatives}
<div id="compare-results"></div>
</section>
</div>
<section class="card" aria-label="Receipts">
<h2>Receipt log</h2>
<p class="muted">Newest first. Every transaction with its hash, each receipt's executor and result, and the contracts' own logs.</p>
<div id="log"></div>
</section>
<section class="card" aria-label="What runs here">
<h2>What runs here</h2>
<p>${esc(LAB_LABEL)}</p>
<ul>${doubles}</ul>
<div class="scroll"><table><thead><tr><th>Role</th><th>File</th><th>sha256</th></tr></thead><tbody>${binaries}</tbody></table></div>
<p class="muted">Lab source revision <code>${esc(info.source.revision)}</code>${info.source.dirty ? " with uncommitted changes" : ""}. The lab holds only keys created for this sandbox and sends nothing to a public network. Results here say nothing about mainnet.</p>
</section>
</main>
<script>${script}</script>
</body>
</html>
`;
  return { html, csp };
}
