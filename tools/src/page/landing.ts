// The landing screen: display name, lead line, the two sentences, three actions (watch, replay, verify), the size of
// the claim, the state strip, links to the source and the console, the three
// checkable facts linked to their gate reports, and the "what is real and what is a test double" section that every
// provenance label links to. The order of everything below the facts is chosen from the evidence (PAGE_LAYOUT).
import { z } from "zod";
import type { DemoBinding } from "../evidence/binding.js";
import { PLANNED_LABEL, PLANNED_SITE, REPO_URL, SITE_PATHS, bundlePaths } from "../evidence/journey.js";
import type { Evidence } from "../types.js";
import { chip, escapeHtml, modeBadge, word } from "./html.js";
import { LIVE_MAINNET_PATH, RELAY_STEP_ONLY, runVerdict, type LiveView } from "./mainnet.js";
import { reportAnchor, reportDetails, type Results } from "./results.js";
import type { Stage } from "./story.js";

/** Display name, as the submission and the post use it: the kicker above the lead line, and the page title. */
export const DISPLAY_NAME = "Bounded Mandate: AI trading on NEAR Intents without a signing key";
/** The lead line: the page's H1 (also the console's and the video's). */
export const LEAD_LINE = "Give an AI agent trading power. Keep the power to stop it.";
/** The two sentences under the lead line. */
export const POSITION =
  "An AI agent trades your treasury on NEAR Intents without holding a signing key. A contract signs each order inside your limits; one owner call voids every signed order that has not executed, and recovery returns the funds without the agent.";

export const REAL_ID = "real";
export const CERTIFIED_ID = "certified-def";
/** Shown beside the first "certified" on the page, linking to CERTIFIED_DEFINITION. */
export const CERTIFIED_SHORT = "our own acceptance gate, not an external audit";
export const CERTIFIED_DEFINITION =
  "“Certified” is this project's own acceptance gate on one clean revision: every required case passes in one run, and the demo is bound to that run by revision, spec, fixtures and WASM hashes. A committed bundle repeats it in a fresh clone and in CI. It is not an external audit.";
export const certifiedLink = (): string => `<a class="defn" href="#${CERTIFIED_ID}">${escapeHtml(CERTIFIED_SHORT)}</a>`;
export const certifiedDefinition = (): string => `<p class="defn-text" id="${CERTIFIED_ID}">${escapeHtml(CERTIFIED_DEFINITION)}</p>`;

/**
 * The size of the claim: what revoking adds over waiting for the order to expire. `ttlSec` is the grant's recorded
 * order lifetime (policy.order_ttl_sec); null when the evidence records no policy.
 */
export const claimSize = (mode: string, ttlSec: number | null): string =>
  `The advantage of revoking over waiting for expiry is bounded by the order lifetime: ${ttlSec === null ? "not recorded in this evidence" : `${String(ttlSec)} s in this ${mode} run`}.`;
export const claimSizeLine = (mode: string, ttlSec: number | null): string => `<p class="claim-size"><strong>Size of the claim.</strong> ${escapeHtml(claimSize(mode, ttlSec))}</p>`;

/**
 * Blocks below the landing screen, in page order. With mainnet receipts, the receipts and the live read-only
 * verification come before the sandbox journey; otherwise the sandbox layout keeps the replay first.
 * The open-challenge panel ("challenge") is present only with a valid challenge record: directly after "verify" in the
 * mainnet layout, at the end of the sandbox layout, so the open grant stays apart from the certified run.
 */
export type PageBlock =
  | "replay" | "story" | "paths" | "benchmark" | "attacks" | "alternatives" | "mainnet" | "verify" | "regrant" | "demo"
  | "gates" | "baseline" | "agent-api" | "limits" | "policy" | "provenance" | "legacy" | "challenge";

const SANDBOX_LAYOUT: readonly PageBlock[] = ["replay", "story", "paths", "benchmark", "attacks", "alternatives", "mainnet", "verify", "regrant", "demo", "gates", "baseline", "agent-api", "limits", "policy", "provenance", "legacy"];
const MAINNET_LAYOUT: readonly PageBlock[] = ["mainnet", "verify", ...SANDBOX_LAYOUT.filter((b) => b !== "mainnet" && b !== "verify")];

export const PAGE_LAYOUT = { sandbox: SANDBOX_LAYOUT, mainnet: MAINNET_LAYOUT } as const;
export const pageLayout = (live: LiveView, challenge = false): readonly PageBlock[] => {
  if (!challenge) return live.kind === "mainnet" ? MAINNET_LAYOUT : SANDBOX_LAYOUT;
  return live.kind === "mainnet" ? ["mainnet", "verify", "challenge", ...MAINNET_LAYOUT.slice(2)] : [...SANDBOX_LAYOUT, "challenge"];
};

/** One provenance label: a single line that names what the screen shows and links to the real-versus-double section. */
export const provenance = (text: string): string => `<p class="prov"><a href="#${REAL_ID}">${escapeHtml(text)}</a></p>`;

/** What the run itself was, from the evidence: e.g. "sandbox · real Intents verifier WASM · test doubles: MPC, oracle, tokens". */
export const runProvenance = (ev: Evidence, labels: readonly string[]): string => [`${ev.mode} replay`, ...labels.filter((l) => l !== "no mainnet")].join(" · ");

/**
 * The three actions. The same bytes are read from a clone and served on the hosted site, so nothing here says whether
 * the site is published: the links are relative to the site's base (hosting/README.md) and the text names the same
 * files in a clone. No media element: the page requests nothing until the reader follows a link or presses a button.
 */
export function actionsBlock(ev: Evidence): string {
  const clone = bundlePaths(ev.source.product_commit);
  return `<ol class="actions" aria-label="Three things to do here">
<li><p class="act"><a href="${SITE_PATHS.video}">Watch</a></p><p>The short cut of this recorded run; then the <a href="${SITE_PATHS.walkthrough}">longer walkthrough</a>.</p><p class="muted where"><span>Links play on the ${PLANNED_LABEL}.</span> <span>In a clone: <code>${escapeHtml(clone.video.slice(0, clone.video.lastIndexOf("/") + 1))}</code></span></p></li>
<li><p class="act"><a href="#replay">Replay</a></p><p>Step through the owner's eight actions with recorded balances, keys and receipts. Nothing is requested.</p></li>
<li><p class="act"><a href="#verify">Verify</a></p><p>Opt-in, read-only checks against a public RPC; no request until you press the button. Offline, from a clone: <code class="cmd">make verify</code> or <code class="cmd">node verify.mjs</code>.</p></li>
</ol>`;
}

/** Where the source and the owner console are: on the hosted site by relative link, in a clone by path. */
export function linksLine(ev: Evidence): string {
  const clone = bundlePaths(ev.source.product_commit);
  return `<p class="site-links"><span>Source: <a href="${REPO_URL}" rel="noopener noreferrer">${escapeHtml(REPO_URL.replace(/^https:\/\//, ""))}</a></span> <span><a href="${SITE_PATHS.console}">Owner console</a> on the ${PLANNED_LABEL}; in a clone <code>${escapeHtml(clone.console)}</code></span> <span>This page in a clone: <code>${escapeHtml(clone.page)}</code>; ${PLANNED_LABEL} <code>${escapeHtml(PLANNED_SITE)}</code></span></p>`;
}

const KEY_TEXT = (present: boolean | null): string => (present === null ? "no grant key" : present ? "key registered" : "key removed");

/** Mainnet cell of the strip: never the success words for a failed, inconclusive or unrun revocation step. */
export function mainnetState(live: LiveView): { cls: string; text: string } {
  if (live.kind === "absent") return { cls: "not-run", text: "pending approval: no mainnet transaction has been executed" };
  if (live.kind === "rejected") return { cls: "missing", text: `not shown: ${LIVE_MAINNET_PATH} is not mainnet evidence` };
  const v = runVerdict(live.ev);
  const r = v.revocation;
  const parts = [
    `${String(live.ev.receipts.length)} transactions`,
    // "passed" is said of the revocation test only when the whole run holds; otherwise the relay is one step that held.
    v.holds ? "revocation test passed" : r.cls === "success" ? RELAY_STEP_ONLY : r.cls === "failure" ? `revocation test failed: ${r.text}` : r.cls === "not-run" ? `revocation test not run: ${r.text}` : `revocation test ${r.text}`,
    ...(v.failedSteps > 0 ? [`${String(v.failedSteps)} of ${String(v.steps)} steps did not hold`] : []),
    ...(v.failedPreflight > 0 ? [`${String(v.failedPreflight)} preflight checks did not hold`] : []),
    ...(v.stopped ? ["run stopped"] : []),
  ];
  return { cls: v.cls, text: parts.join(" · ") };
}

export function stateStrip(ev: Evidence, binding: DemoBinding, passed: number, total: number, live: LiveView, stages: readonly Stage[]): string {
  const end = [...stages].reverse().find((s) => s.state !== null)?.state ?? null;
  const m = mainnetState(live);
  const cell = (k: string, v: string): string => `<div><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`;
  return `<dl class="state-strip" aria-label="Where the evidence stands">
${cell("Evidence", `${modeBadge(ev.mode)} revision <code>${escapeHtml(ev.source.product_commit.slice(0, 7))}</code>${ev.source.dirty ? " (dirty tree)" : ""} ${word(binding.certified ? "passed" : "uncertified", binding.certified ? "certified for this demo" : "not certified for this demo")} ${certifiedLink()}`)}
${cell("Gates", `${String(passed)} / ${String(total)} passed and certified`)}
${cell("Mainnet", word(m.cls, m.text))}
${cell(`End of the ${ev.mode} run`, end === null ? `<span class="muted">no recorded state</span>` : escapeHtml(`grant ${end.grant_status} · ${KEY_TEXT(end.key_present)} · open orders ${String(end.open_orders)}`))}
</dl>`;
}

const AgentKey = z.array(z.object({ permission: z.object({ FunctionCall: z.object({ method_names: z.array(z.string()), receiver_id: z.string() }) }) })).length(1);

const reportLink = (file: string, text: string): string => `<a href="#${escapeHtml(reportAnchor(file))}">${escapeHtml(text)}</a>`;
const none = (what: string): string => `<p class="muted">No certified ${escapeHtml(what)} is attached to this page.</p>`;
const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;

function noKeyFact(ev: Evidence, results: Results): string {
  const agent = ev.assertions.find((a) => a.id === "agent-one-restricted-key");
  const mandate = ev.assertions.find((a) => a.id === "mandate-no-keys");
  const key = AgentKey.safeParse(agent?.observed);
  const call = key.success ? key.data[0]?.permission.FunctionCall : undefined;
  const recorded =
    agent === undefined
      ? `<p class="muted">The agent's key is not recorded in this evidence.</p>`
      : `<p>${word(agent.passed ? "success" : "failure", agent.passed ? "held" : "did not hold")} <a href="#check-agent-one-restricted-key">Recorded agent key</a>: ${
          call === undefined ? "not in the expected shape" : `one function-call key for <code>${escapeHtml(call.method_names.join(", "))}</code> on <code>${escapeHtml(call.receiver_id)}</code>`
        }.</p>`;
  const account = mandate === undefined ? "" : `<p>${word(mandate.passed ? "success" : "failure", mandate.passed ? "held" : "did not hold")} <a href="#check-mandate-no-keys">The mandate account has no access key</a>; only its contract acts for it.</p>`;
  const report = results.contract === null ? none("contract boundary report (BOUNDARY.contract)") : `<p>Forbidden calls refused by the contract and the key: ${reportLink(results.contract.report.file, "BOUNDARY.contract report")}.</p>${reportDetails(results.contract.report)}`;
  return `<article class="fact" id="fact-key"><h3>1. No signing key</h3><p>The agent's only key is a function-call key limited to <code>propose_order</code>. ${ev.mode === "mainnet" ? "The order-signing key exists only as MPC shares" : `By design the order-signing key exists only as MPC shares; in this ${escapeHtml(ev.mode)} evidence the signer is a single labelled test double, not the MPC network`}, and the contract requests each signature after checking the limits.</p>${recorded}${account}${report}<p class="note-line">In this ${escapeHtml(ev.mode)} run the MPC signer is a labelled test double</p></article>`;
}

function limitsFact(results: Results): string {
  const { trades, attacks } = results;
  const t = trades === null ? none("legitimate-trade result (T3.concession)") : `<p class="fact-number">${String(trades.data.completed)} / ${String(trades.data.attempted)}</p><p>selected valid trades settled · ${reportLink(trades.report.file, "T3.concession report")}</p>`;
  const a =
    attacks === null
      ? none("hostile-request result (BOUNDARY.attacks)")
      : `<p class="fact-number">${String(attacks.data.contained)} / ${String(attacks.data.attempted)}</p><p>hostile requests refused${attacks.data.layers === null ? "" : ` at ${plural(attacks.data.layers, "layer")}`} · ${reportLink(attacks.report.file, "BOUNDARY.attacks report")} · <a href="#attacks">attack log</a></p>`;
  return `<article class="fact" id="fact-limits"><h3>2. Limits at the signature</h3><p>Selected samples, not a benchmark: scripted sandbox cases on the pinned Intents verifier.</p><div class="fact-pair"><div>${t}</div><div>${a}</div></div></article>`;
}

type OpenOrders = NonNullable<Results["openOrders"]>;

const STATE_WORDS: Record<string, string> = { signed: "signed", signing: "awaiting signature" };

function openOrderResult(o: OpenOrders["data"], report: OpenOrders["report"]): string {
  const split = Object.entries(o.states_before_revoke).map(([k, n]) => `${String(n)} ${STATE_WORDS[k] ?? k}`).join(", ");
  const retried = o.failed_removal !== undefined && o.failed_removal.grant_status !== "revoked";
  const callbacks = o.successful_removal?.callbacks.filter((c) => c.method === "on_key_removed" && c.succeeded).length;
  const removal = `One confirmed removal${retried ? " (after a forced failed removal and retry)" : ""} released ${String(o.released_key_removed)} of ${String(o.open_orders)} reservations${callbacks === 1 ? " in one callback" : ""}`;
  return `<p class="fact-number">${String(o.open_orders)}</p><p>open orders under one grant (${escapeHtml(split)})</p>
<ul class="fact-list"><li>${escapeHtml(removal)}.</li><li>The relayed withheld order ${o.withheld_relay_after_removal_executed ? "<strong>executed</strong>" : "did not execute"}.</li>${o.thirty_third_refused ? `<li>A ${escapeHtml(ordinal(o.open_orders + 1))} proposal was refused at the limit.</li>` : ""}<li>Recovery ${o.recovered_all_units ? "returned every unit" : "<strong>did not return every unit</strong>"}.</li></ul>
<p>${reportLink(report.file, "T4.open-order-limit report")}</p>${reportDetails(report)}`;
}

const ordinal = (n: number): string => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${String(n)}${suffix}`;
};

function stopFact(ev: Evidence, results: Results, ttlSec: number | null): string {
  const { openOrders, regrant } = results;
  const open = openOrders === null ? none("open-order-limit result (T4.open-order-limit)") : openOrderResult(openOrders.data, openOrders.report);
  const after = regrant?.data.relays.filter((r) => r.after_confirmed_removal) ?? [];
  const t1 = regrant === null ? none("regrant result (T1.withheld-regrant)") : `<p>${plural(after.length, "relay")} of withheld orders after confirmed key removal, including after a regrant with a fresh key: ${plural(after.filter((r) => r.executed).length, "execution")} · ${reportLink(regrant.report.file, "T1.withheld-regrant report")}</p>`;
  return `<article class="fact" id="fact-stop"><h3>3. Stop and exit</h3><p>Revocation removes the grant key at the verifier, the held order is rejected while unexpired, a regrant uses a fresh key, and recovery needs no agent, oracle or MPC. Orders may still execute until removal is confirmed. ${escapeHtml(claimSize(ev.mode, ttlSec))}</p>${open}${t1}</article>`;
}

export function factsSection(ev: Evidence, results: Results, label: string, ttlSec: number | null): string {
  return `<section class="facts-block" id="facts" aria-labelledby="facts-h"><h2 id="facts-h">Three checkable facts</h2>${provenance(label)}
<div class="fact-grid">${noKeyFact(ev, results)}${limitsFact(results)}${stopFact(ev, results, ttlSec)}</div></section>`;
}

/** The section every provenance label links to. `modes` is the existing execution-modes key, kept verbatim. */
export function realSection(ev: Evidence, live: LiveView, labels: readonly string[], modes: string): string {
  const verifier = labels.includes("real Intents verifier WASM");
  const doubles = [
    ...(ev.identifiers.mpc_test_double === undefined ? [] : [["MPC signer (Chain Signatures)", `test double ${ev.identifiers.mpc_test_double}`]]),
    ...(ev.identifiers.oracle_test_double === undefined ? [] : [["Price oracle", `test double ${ev.identifiers.oracle_test_double}`]]),
    ...(labels.includes("test doubles: MPC, oracle, tokens") ? [["USDC and wNEAR tokens", "test doubles"]] : []),
  ];
  const rows: [string, string, string][] = [
    ["Mandate contract", "real", `our production contract, sha256 ${ev.source.contract_wasm_sha256.slice(0, 12)}…, run in a local NEAR ${ev.mode}`],
    ["Intents verifier", verifier ? "real code" : "not recorded", verifier ? `the pinned verifier WASM read from mainnet, run locally in the ${ev.mode}` : "this evidence does not bind the pinned verifier WASM"],
    ...doubles.map(([k, v]): [string, string, string] => [k ?? "", "test double", v ?? ""]),
    ["Trade proposals and hostile requests in the samples", "scripted", "written by us; recorded genuine model output is labelled where it appears"],
    ["NEAR mainnet", live.kind === "mainnet" ? "real" : "none", live.kind === "mainnet" ? "the transactions in the mainnet section, each with a NEAR transaction hash" : "no mainnet transaction has been executed"],
  ];
  return `<section class="real" id="${REAL_ID}" aria-labelledby="${REAL_ID}-h"><h2 id="${REAL_ID}-h">What is real and what is a test double</h2>
<div class="scroll"><table><caption>Components of this page's evidence</caption><thead><tr><th scope="col">Component</th><th scope="col">Here</th><th scope="col">Detail</th></tr></thead><tbody>${rows
    .map(([k, kind, d]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${chip(kind === "real" || kind === "real code" ? "label" : "pending", kind)}</td><td>${escapeHtml(d)}</td></tr>`)
    .join("")}</tbody></table></div>
${modes}</section>`;
}
