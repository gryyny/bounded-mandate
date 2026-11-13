// The landing screen: display name, lead line, the two sentences, three actions (watch, replay, verify), the links to
// the four paths, the size of the claim, the state strip, links to the source and the console, the four paths (try,
// compare, verify, integrate), the three checkable facts linked to their gate reports, and the "what is real and what
// is a test double" section that every provenance label links to. The order of everything below the facts is chosen
// from the evidence (PAGE_LAYOUT).
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
export const LEAD_LINE = "Give an AI agent trading authority without unrestricted control of your treasury.";
/**
 * The two sentences under the lead line (also the video's). The agent does choose a concession, up to the owner's
 * maximum, and the order names no counterparty, so neither sentence says the agent cannot choose a price or a
 * counterparty. Revocation is confirmed key removal, and recovery is a separate owner call.
 */
export const POSITION =
  "The agent names a side, an amount and a price concession up to your maximum; a contract prices the order from the oracle, then builds and signs it for NEAR Intents inside your size and turnover limits. One owner call removes the signing key, so signed orders that have not executed fail once removal is confirmed, and recovery returns the remaining assets without the agent.";

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
  | "gates" | "baseline" | "agent-api" | "limits" | "policy" | "provenance" | "legacy" | "challenge" | "dao";

const SANDBOX_LAYOUT: readonly PageBlock[] = ["replay", "story", "paths", "benchmark", "attacks", "alternatives", "dao", "mainnet", "verify", "regrant", "demo", "gates", "baseline", "agent-api", "limits", "policy", "provenance", "legacy"];
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

export const PATHS_ID = "start";
/** The four paths, in page order; each is `id="path-<key>"`. */
export const PATH_KEYS = ["try", "compare", "verify", "integrate"] as const;
export type PathKey = (typeof PATH_KEYS)[number];
const PATH_TITLE: Record<PathKey, string> = { try: "Try", compare: "Compare", verify: "Verify", integrate: "Integrate" };

/** The first screen's one-line way into the four paths. */
export const pathNav = (): string =>
  `<p class="path-nav"><span>Four paths:</span> ${PATH_KEYS.map((k) => `<a href="#path-${k}">${PATH_TITLE[k]}</a>`).join(" ")}</p>`;

/** Build-time setting naming a running sandbox lab; unset (the default) links none. */
export const LAB_URL_ENV = "MANDATE_LAB_URL";
export const LAB_SERVICE = "bounded-mandate-lab";
const LAB_TIMEOUT_MS = 8_000;

/** A sandbox lab the Try and Compare paths may open, after an explicit click and a health check. */
export interface LabLink {
  /** Where the visitor is sent once the lab answered. */
  url: string;
  /** The one origin the page's connect-src is widened for. */
  origin: string;
  /** `api/health` under the lab's URL. */
  health: string;
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/** Null for no lab. Throws on anything but an https URL, or an http URL on this machine, without credentials, query or fragment. */
export function labLink(url: string | null | undefined): LabLink | null {
  const text = url?.trim() ?? "";
  if (text === "") return null;
  if (!URL.canParse(text)) throw new Error(`${LAB_URL_ENV} is not a URL: ${text}`);
  const u = new URL(text);
  const local = LOOPBACK.includes(u.hostname) || u.hostname.endsWith(".localhost");
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
    throw new Error(`${LAB_URL_ENV} must be an https URL (http only for a lab on this machine) without credentials, query or fragment: ${text}`);
  }
  const base = u.href.endsWith("/") ? u.href : `${u.href}/`;
  return { url: base, origin: u.origin, health: new URL("api/health", base).href };
}

/** The DOM the lab control touches; tools/ has no DOM types. */
interface LabEl {
  textContent: string | null;
  className: string;
  disabled: boolean;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: () => void): void;
}
export interface LabDoc {
  getElementById(id: string): unknown;
}
export type LabFetch = (url: string, init: { method: "GET"; signal: AbortSignal; credentials: "omit"; referrerPolicy: "no-referrer"; cache: "no-store" }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Wires the lab buttons. Nothing is fetched before a click. A click asks the lab's health endpoint; the visitor is sent
 * to the lab only when it answers as the sandbox lab, and any other answer, error or timeout is shown as unreachable,
 * with no lab result. Self-contained: its source text is the page's second inline script.
 */
export function installLab(doc: LabDoc, fetchFn: LabFetch, go: (url: string) => void): void {
  const root = doc.getElementById("start") as LabEl | null;
  const raw = root?.getAttribute("data-lab") ?? null;
  if (raw === null) return;
  const lab = JSON.parse(raw) as { url: string; origin: string; health: string; service: string; timeout_ms: number };
  for (const key of ["try", "compare"]) {
    const button = doc.getElementById(`lab-open-${key}`) as LabEl | null;
    const status = doc.getElementById(`lab-status-${key}`) as LabEl | null;
    if (button === null || status === null) continue;
    button.addEventListener("click", () => {
      button.disabled = true;
      status.className = "lab-status";
      status.textContent = `Asking ${lab.origin} whether the lab is running …`;
      void fetchFn(lab.health, { method: "GET", signal: AbortSignal.timeout(lab.timeout_ms), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(`its health check returned HTTP ${String(r.status)}`);
          return r.json();
        })
        .then((body) => {
          const b = (typeof body === "object" && body !== null ? body : {}) as { service?: unknown; mode?: unknown; ok?: unknown };
          if (b.service !== lab.service || b.mode !== "sandbox") throw new Error("its answer is not the sandbox lab's health record");
          if (b.ok === false) throw new Error("it reports that it is not running");
          status.textContent = "The lab answered. Opening it: a separate site running a sandbox with test doubles.";
          go(lab.url);
        })
        .catch((e: unknown) => {
          status.className = "lab-status unreachable";
          status.textContent = `The lab at ${lab.origin} is unreachable (${e instanceof Error ? e.message : String(e)}). Nothing was run, and nothing on this page is a lab result. Use the recorded replay below, which is recorded and not interactive, or run the lab from a clone with make lab.`;
          button.disabled = false;
        });
    });
  }
}

/** The page's second inline script, present only when a lab is configured. Identical bytes are hashed for the CSP and tested. */
export function labScript(): string {
  // Transpilers may wrap names with a `__name` helper (esbuild keepNames); the script has no module scope for it. In a
  // function of its own, because the verification script declares the same helper in the scope classic scripts share.
  const script = `(() => {\n"use strict";\nconst __name = (f) => f;\n${installLab.toString()}\ninstallLab(document, (url, init) => fetch(url, init), (url) => { location.assign(url); });\n})();\n`;
  if (/<\/script|<!--/i.test(script)) throw new Error("lab script cannot be inlined: it contains a closing script tag or comment opener");
  return script;
}

const RECORDED_CHIP = chip("recorded", "recorded, not interactive");
const SANDBOX_CHIPS = `${modeBadge("sandbox")} ${chip("label", "test doubles: MPC, oracle, tokens")}`;

/** Try and Compare: the opt-in button when a lab is configured, otherwise how to run the lab from a clone. `tab` names where to go inside the lab. */
function labAccess(key: "try" | "compare", lab: LabLink | null, button: string, tab: string | null): string {
  if (lab === null) return `<p class="lab-local"><strong>No lab is linked from this page.</strong> Run it from a clone: <code class="cmd">make lab</code>${tab === null ? "" : `, then open its ${tab} tab`}.</p>`;
  return `<p class="lab-controls"><button type="button" id="lab-open-${key}">${escapeHtml(button)}</button></p>
<p class="lab-note">Opt-in: nothing is requested until you press the button. It then asks <code>${escapeHtml(lab.origin)}</code> whether the lab is running and, only if the lab answers, opens it there.${tab === null ? "" : ` In the lab, open the ${tab} tab.`} The lab is a separate site.</p>
<p class="lab-status" id="lab-status-${key}" role="status" aria-live="polite"></p>
<p class="lab-local">Without it, run the lab from a clone: <code class="cmd">make lab</code>.</p>`;
}

/** What the Verify path can inspect today, in the same words as the state strip. */
function verifyPath(live: LiveView): string {
  const panel = `<a href="#verify">the read-only verification panel</a>`;
  if (live.kind === "mainnet") {
    const m = mainnetState(live);
    return `<p>${modeBadge("mainnet")} ${word(m.cls, m.text)}</p><p><a href="#mainnet">The run's transactions and step verifications</a> · check them from your browser in ${panel}, which also replays the withheld order against archival chain state.</p>`;
  }
  const none =
    live.kind === "absent"
      ? "No mainnet run is recorded: no mainnet transaction has been executed."
      : `No mainnet run is shown: ${LIVE_MAINNET_PATH} is not mainnet evidence.`;
  return `<p><strong>${escapeHtml(none)}</strong> There is no mainnet trade, removal, rejection or recovery to inspect yet, and nothing on this page is a mainnet result.</p><p><a href="#mainnet">Mainnet status</a> · ${panel}, which until then checks the verifier's code hash and current chain state. Offline, from a clone: <code class="cmd">make verify</code>.</p>`;
}

/**
 * The four paths: try (operate the sandbox lab), compare (reproduce the owner's alternatives), verify (the mainnet run)
 * and integrate (the independent client example). `compareGate` is the COMPARE gate's label and status as HTML. No
 * path shows a result of its own: the lab runs elsewhere, and what this page holds is labelled recorded.
 */
export function fourPaths(ev: Evidence, live: LiveView, lab: LabLink | null, compareGate: string): string {
  const data = lab === null ? "" : ` data-lab="${escapeHtml(JSON.stringify({ ...lab, service: LAB_SERVICE, timeout_ms: LAB_TIMEOUT_MS }))}"`;
  const item = (key: PathKey, chips: string, body: string): string => `<li id="path-${key}"><h3>${PATH_TITLE[key]}</h3><p class="path-modes">${chips}</p>${body}</li>`;
  return `<section class="four-paths" id="${PATHS_ID}" aria-labelledby="${PATHS_ID}-h"${data}><h2 id="${PATHS_ID}-h">Four paths: try, compare, verify, integrate</h2>
<ol class="four">
${item("try", SANDBOX_CHIPS, `<p>Operate a sandbox treasury in the lab: set limits and grant, make a permitted trade, attempt an unsafe trade, make a poor but permitted trade, withhold a signed order, revoke, retry the withheld order, and recover. Each result is executed by the contracts on a sandbox chain; nothing is sent to a public network.</p>
${labAccess("try", lab, "Open the sandbox lab", null)}
<p class="lab-recorded">${RECORDED_CHIP} Or step through <a href="#replay">the recorded replay</a> of one ${escapeHtml(ev.mode)} run on this page: recorded results, not a run you operate.</p><p class="dao-link">For shared treasury decisions, inspect the <a href="#dao">recorded DAO treasury preset</a>: proposal, approval threshold, revoke, recovery and withdrawal.</p>`)}
${item("compare", SANDBOX_CHIPS, `<p>Reproduce what each of the owner's alternatives does to signed orders that are still outstanding, from equal starting conditions: wait for expiry, cancel a complete nonce list, cancel an incomplete list, cancel with the signer unavailable, remove the key and resume with a fresh key, and re-add the same key.</p>
${labAccess("compare", lab, "Open the lab to compare", "Compare")}
<p class="lab-recorded">${RECORDED_CHIP} Acceptance gate ${compareGate}. Its results, when a certified run backs this page, are under <a href="#revocation-alternatives">What happens to orders after the owner acts?</a>; the write-up is <code>docs/comparison.md</code> in a clone.</p>`)}
${item("verify", live.kind === "mainnet" ? chip("label", "read-only") : `${chip("pending", "no mainnet run")} ${chip("label", "read-only")}`, `<p>${live.kind === "mainnet" ? "Inspect the real mainnet trade" : "After an approved mainnet run: inspect its trade"}, the confirmed key removal, the rejection of the still-unexpired withheld order and the recovery, each by its transaction, with a historical replay of the withheld order against archival chain state.</p>
${verifyPath(live)}`)}
${item("integrate", `${modeBadge("sandbox")} ${chip("label", "runs from a clone")}`, `<p>Run a small strategy client that is separate from the demo harness and uses the documented interface alone: the agent's function-call key, <code>propose_order</code> and the contract's views. Against a local sandbox it proposes an allowed trade, meets a refusal and observes revocation.</p>
<p>From a clone, with no funds or model credential: <code class="cmd">make example</code>. Source: <code>examples/strategy-client/</code>. It is an example, not an SDK.</p>`)}
</ol></section>`;
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
