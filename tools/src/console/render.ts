// Renders the static owner console: one self-contained HTML file with no backend. Read-only for every visitor; the
// owner's revoke, recover and withdraw controls enable only for the contract's owner on the expected network and
// deployment, and are signed outside the page. Its inline scripts are client.ts and, when the page offers external
// wallets, the pinned NEAR Connect library (connector.ts); both are pinned by hash in the CSP.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../evidence/report.js";
import { escapeHtml } from "../page/html.js";
import { STYLES } from "../page/styles.js";
import { MAINNET_GENESIS_HASH } from "../page/verify.js";
import { asObject, asString, canonicalJson, chainOutcome, receiptViews, rpcCall, rpcErrorText, sha256Hex, statusKind } from "../page/verify-client.js";
import { Evidence } from "../types.js";
import { CONSOLE_FUNCTIONS, type ActionKind, type ConsoleData, type NetworkProfile, type WalletProfile } from "./client.js";
import { nearConnectBundle, pinnedWallets, scriptHash, testWalletManifest } from "./connector.js";
import { recordedSection } from "./recorded.js";

/** Gas per owner action (TGas). revoke/recover match the live manifest template; withdraw/register are provisional. */
export const DEFAULT_GAS_TGAS: Record<ActionKind, number> = { revoke: 150, recover: 80, withdraw: 100, register: 30 };
/** A non-archival public mainnet RPC (README: rpc.mainnet.near.org is deprecated). */
export const MAINNET_RPC = "https://free.rpc.fastnear.com";

export function mainnetProfile(deployment: NetworkProfile["deployment"] = null): NetworkProfile {
  return {
    id: "mainnet",
    label: "NEAR mainnet",
    kind: "mainnet",
    rpc_url: MAINNET_RPC,
    chain_id: "mainnet",
    genesis_hash: MAINNET_GENESIS_HASH,
    deployment,
    cli_network: "mainnet",
    gas_tgas: DEFAULT_GAS_TGAS,
  };
}

export interface SandboxIdentity {
  rpc_url: string;
  chain_id: string;
  genesis_hash: string;
  mandate_id: string;
  code_hash: string;
  verifier_id: string;
  source: string;
}

/** A local sandbox. Its genesis differs on every start, so the expectation is pinned when the sandbox is known. */
export function sandboxProfile(s: SandboxIdentity, label = "Local sandbox"): NetworkProfile {
  return {
    id: `sandbox-${s.genesis_hash.slice(0, 8)}`,
    label,
    kind: "sandbox",
    rpc_url: s.rpc_url,
    chain_id: s.chain_id,
    genesis_hash: s.genesis_hash,
    deployment: { mandate_id: s.mandate_id, code_hash: s.code_hash, verifier_id: s.verifier_id, source: s.source },
    cli_network: "sandbox",
    gas_tgas: DEFAULT_GAS_TGAS,
  };
}

export interface ConsoleOptions {
  /** Networks offered by the chooser, first selected. Default: mainnet only, with no expected deployment. */
  profiles?: NetworkProfile[];
  /** Base URL of the local sandbox test signer ("" = this page's own origin), or null for none. */
  localSigner?: string | null;
  /**
   * External wallets through NEAR Connect (default true): the pinned list on mainnet profiles and, on a page served
   * by the local test signer, the labelled sandbox test wallet on sandbox profiles.
   */
  wallets?: boolean;
  /** sha256 of the sandbox test wallet's adapter as the local test signer serves it; null leaves it unchecked. */
  testWalletSha256?: string | null;
  pollMs?: number;
  timeoutMs?: number;
}

const ESC_JSON = (v: unknown): string => escapeHtml(JSON.stringify(v));

/** The page's only script: client functions, then the bootstrap. */
export function consoleScript(): string {
  const shared = [asObject, asString, rpcErrorText, rpcCall, statusKind, receiptViews, chainOutcome, canonicalJson, sha256Hex];
  const body = [...shared, ...CONSOLE_FUNCTIONS].map((f) => f.toString()).join("\n");
  const boot = `const __store = (() => { try { const s = window.localStorage; s.getItem("bounded-mandate/console/probe"); return s; } catch { return null; } })();
install({
  doc: document,
  rpcFetch: (u, i) => fetch(u, i),
  localFetch: (u, i) => fetch(u, i),
  connector: window.__nearConnect ? (o, pins) => {
    const NC = window.__nearConnect;
    window.__nearConnectPins(pins);
    const c = new NC.NearConnector(o);
    return { connect: () => c.connect(), disconnect: (w) => c.disconnect(w), kindOf: (w) => (w instanceof NC.SandboxWallet ? "sandbox" : w instanceof NC.InjectedWallet ? "injected" : "other") };
  } : null,
  framed: (() => { try { return window.top !== window.self; } catch { return true; } })(),
  store: __store,
  now: () => new Date().toISOString(),
  later: (f, ms) => { setTimeout(f, ms); },
  download: (name, text) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); },
});`;
  const script = `"use strict";\nconst __name = (f) => f;\n${body}\n${boot}\n`;
  if (/<\/script|<!--/i.test(script)) throw new Error("console script cannot be inlined: it contains a closing script tag or comment opener");
  return script;
}

export const consoleScriptHash = (script: string): string => `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;

/** Wallet lists by profile id: pinned wallets on mainnet, the sandbox test wallet only where a test signer serves it. */
export function walletProfiles(profiles: NetworkProfile[], localSigner: string | null, testWalletSha256: string | null = null): Record<string, WalletProfile> {
  const pinned = pinnedWallets();
  const out: Record<string, WalletProfile> = {};
  for (const p of profiles) {
    if (p.kind === "mainnet") {
      out[p.id] = {
        network: "mainnet",
        manifest: { version: pinned.library.version, wallets: pinned.wallets.map((w) => w.manifest) },
        pins: Object.fromEntries(pinned.wallets.map((w) => [w.manifest.id, { commit: w.pin.commit, age_rule_met: w.pin.age_rule_met }])),
        hashes: Object.fromEntries(pinned.wallets.map((w) => [w.manifest.executor, w.pin.executor_sha256])),
      };
    } else if (localSigner !== null) {
      const test = testWalletManifest();
      out[p.id] = { network: "testnet", manifest: { version: "sandbox", wallets: [test] }, pins: { [test.id]: null }, hashes: { [test.executor]: testWalletSha256 } };
    }
  }
  return out;
}

const CONSOLE_STYLES = `
.mode.live { color: var(--pass); border: 1px solid currentColor; }
.mode.wrong-chain { color: var(--fail); border: 1px dashed currentColor; }
.mode.recorded { color: var(--m-sandbox); border: 1px dotted currentColor; }
.mode.test-signer { color: var(--stale); border: 1px solid currentColor; }
.hot-connector-popup .settings-button { display: none !important; }
.sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .8rem; margin: 0 0 1.2rem; }
.sources > div { background: color-mix(in srgb, var(--rule) 18%, var(--sheet)); border: 1px solid var(--rule); padding: .7rem .9rem; font-size: .92rem; }
.sources p { margin: .35rem 0 0; }
.cgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1rem; margin-top: 1rem; }
.ccard { background: var(--sheet); border: 1px solid var(--rule); padding: .9rem 1.1rem; min-width: 0; overflow-wrap: anywhere; }
.ccard h3 { margin-top: 0; }
.ccard.wide { grid-column: 1 / -1; }
.ccard.span2 { grid-column: span 2; }
.sub { display: block; font: .74rem/1.45 var(--mono); color: var(--muted); margin-top: .2rem; overflow-wrap: anywhere; }
table.receipts-table td code { white-space: normal; overflow-wrap: anywhere; }
.ccard h4 { font: 600 .74rem/1.4 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 1rem 0 .4rem; }
.ccard dl.kv { border: 0; padding: 0; background: none; grid-template-columns: minmax(0, 1fr); gap: 0; }
.ccard dl.kv dt { margin-top: .5rem; }
.ccard dl.kv dt:first-child { margin-top: 0; }
.ccard dl.kv dd { word-break: normal; overflow-wrap: anywhere; }
.review dl.kv, .vitem dl.kv { grid-template-columns: minmax(7rem, 12rem) minmax(0, 1fr); }
.ccard table { font-size: .86rem; }
.ccard table th, .ccard table td { overflow-wrap: normal; word-break: normal; }
.ccard table th { white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.grant-line { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; margin: 0 0 .6rem; }
.status.grant-active { color: var(--pass); background: var(--pass-bg); }
.status.grant-activating, .status.grant-revoking { color: var(--stale); background: var(--stale-bg); }
.status.grant-revoked { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--sheet)); }
.status.grant-none, .status.grant-unknown { color: var(--none); background: var(--none-bg); }
p.check { display: flex; flex-wrap: wrap; align-items: baseline; gap: .3rem .5rem; margin: .4rem 0; overflow-wrap: anywhere; }
ul.reasons { margin: .2rem 0 .8rem; padding-left: 1.2rem; font-size: .9rem; color: var(--fail); }
ul.reasons li { margin: .15rem 0; overflow-wrap: anywhere; }
.absent { font: .82rem/1.5 var(--mono); color: var(--muted); }
blockquote { margin: .6rem 0 0; padding: .4rem .9rem; border-left: 3px solid var(--m-model); font-style: italic; }
.panel { background: var(--sheet); border: 1px solid var(--rule-strong); padding: 1rem 1.2rem; margin: 0 0 1rem; }
.panel h3 { margin-top: 0; }
.controls-row { display: flex; flex-wrap: wrap; gap: .5rem .8rem; align-items: center; }
.controls-row label { font: 600 .72rem/1.3 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.controls-row input, .controls-row select, textarea, #manual-hash {
  font: .86rem var(--mono); padding: .45rem .6rem; border: 1px solid var(--rule-strong); background: var(--sheet); color: var(--ink); min-width: 0;
}
.controls-row input { flex: 1 1 14rem; }
textarea { width: 100%; min-height: 6.5rem; resize: vertical; }
button { font: 700 .76rem/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: .62rem .9rem; border: 2px solid var(--accent); background: var(--sheet); color: var(--accent); cursor: pointer; }
button.primary { background: var(--accent); color: var(--sheet); }
button:disabled { opacity: .45; cursor: not-allowed; border-style: dashed; }
.actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: .9rem; }
.actions > p.check, .actions > ul { grid-column: 1 / -1; }
article.action { background: var(--sheet); border: 1px solid var(--rule-strong); border-top: 4px solid var(--accent); padding: .9rem 1rem; display: flex; flex-direction: column; gap: .4rem; min-width: 0; }
article.action.off { border-top-color: var(--rule-strong); }
article.action h3 { margin: 0; font-size: 1.02rem; }
article.action p { margin: 0; font-size: .9rem; }
article.action button { align-self: flex-start; margin-top: auto; }
p.why { color: var(--fail); font-size: .86rem; }
p.note { color: var(--stale); font-size: .86rem; }
.review { margin-top: 1rem; background: var(--sheet); border: 2px solid var(--accent); padding: 1rem 1.2rem; overflow-wrap: anywhere; }
.review h3 { margin-top: 0; }
.refused { margin-top: 1rem; padding: .8rem 1rem; border-left: 4px solid var(--fail); background: var(--fail-bg); }
.buttons { display: flex; flex-wrap: wrap; gap: .6rem; }
#console-log { min-height: 1.4rem; font: .84rem/1.5 var(--mono); color: var(--ink); background: color-mix(in srgb, var(--stale-bg) 50%, var(--sheet)); padding: .4rem .7rem; border-left: 3px solid var(--stale); }
#console-log:empty { display: none; }
pre.handoff { max-height: 18rem; }
.about li { margin: .35rem 0; }
.live-view .chips { margin-bottom: .6rem; }
@media (max-width: 760px) {
  .controls-row { flex-direction: column; align-items: stretch; }
  .controls-row input, .controls-row select, .controls-row button { width: 100%; flex: 0 0 auto; }
  .cgrid, .actions { grid-template-columns: minmax(0, 1fr); }
  .ccard.span2 { grid-column: auto; }
  dl.kv { grid-template-columns: minmax(0, 1fr); gap: .1rem; }
  dl.kv dd { margin-bottom: .45rem; }
}
`;

const section = (num: string, tag: string, id: string, title: string, body: string): string =>
  `<section class="folio" id="${id}" aria-labelledby="${id}-h"><div class="num" aria-hidden="true">${num}<small>${tag}</small></div><div class="body"><h2 id="${id}-h">${title}</h2>${body}</div></section>`;

function liveSection(data: ConsoleData): string {
  const options = data.profiles.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join("");
  const expected = data.profiles
    .map((p) => `<li><strong>${escapeHtml(p.label)}</strong>: chain id <code>${escapeHtml(p.chain_id)}</code>, genesis <code>${escapeHtml(p.genesis_hash)}</code>; ${p.deployment === null ? "no expected deployment recorded, so owner controls stay disabled" : `mandate <code>${escapeHtml(p.deployment.mandate_id)}</code>, code hash <code>${escapeHtml(p.deployment.code_hash)}</code> (${escapeHtml(p.deployment.source)})`}.</li>`)
    .join("");
  return `<p>Read the mandate's current state straight from an RPC of your choice. Nothing is requested until you press the button. The RPC must first report the network's chain id <em>and</em> genesis hash; on a wrong chain, an error or a timeout nothing is shown as verified. The RPC you choose is trusted for every answer it returns.</p>
<div class="panel">
<p class="controls-row"><label for="net-profile">Network</label><select id="net-profile">${options}</select><label for="net-rpc">RPC</label><input id="net-rpc" type="url" spellcheck="false" autocomplete="off"><label for="net-mandate">Mandate</label><input id="net-mandate" spellcheck="false" autocomplete="off"><button id="live-read" type="button">Read chain state</button></p>
<p id="live-status" class="source" role="status" aria-live="polite"></p>
<details><summary>Expected networks and deployments</summary><ul>${expected}</ul></details>
</div>
<div id="live-body"><p class="muted">The live view needs JavaScript; the recorded evidence below does not.</p></div>`;
}

function ownerSection(data: ConsoleData): string {
  const local = data.local_signer !== null;
  const wallets = data.wallets;
  const walletNote =
    wallets === null
      ? ""
      : `<p><span class="mode label">NEAR Connect ${escapeHtml(wallets.library_version)}</span> External wallets connect through NEAR Connect, from the wallet list in this page (no remote list, no saved or manually added wallets). On mainnet each wallet's adapter is pinned to a commit, checked against its sha256 before it runs, and runs in a sandboxed frame. A browser-extension wallet that announces itself to the page may also appear; it is labelled as not pinned. The wallet signs and broadcasts; the page holds no key and checks every returned transaction on chain against the exact preview. A wallet that ends a request without a hash leaves the action pending until you paste the hash or forget it. ${local ? "On a local sandbox the only wallet offered is the labelled SANDBOX TEST WALLET, a test double that asks the local test signer to sign." : "Compatibility with a specific wallet is established only when its owner connects it (see About)."}</p>`;
  return `<p>Revoke, recover and withdraw are enabled only when all three hold: the connected signer is the contract's <code>owner_id</code>, the RPC's chain is the chosen network (genesis check), and the mandate account runs the expected code. Each action is shown exactly before anything is signed, and is signed outside this page.</p>
<div class="panel">
<h3>1 · Signer</h3>
<p class="controls-row"><label for="signer-kind">Signing adapter</label><select id="signer-kind">${wallets === null ? "" : `<option value="wallet">External wallet (NEAR Connect)</option>`}${local ? `<option value="local">Local sandbox test signer</option>` : ""}<option value="manual">Manual near CLI handoff</option></select><input id="signer-account" placeholder="owner account id" spellcheck="false" autocomplete="off"><button id="signer-connect" type="button">Connect</button></p>
${walletNote}
${local ? `<p><span class="mode test-signer">test signer</span> The local sandbox test signer is a Node process on this machine that holds a sandbox owner key and refuses any chain but its own sandbox. It stands in for a wallet in tests; it is not a wallet and proves no wallet compatibility.</p>` : ""}
<p id="signer-status" class="source" role="status">Not connected.</p>
</div>
<div class="panel">
<h3>2 · Runner intent (optional)</h3>
<p>Paste the runner's persisted <code>bounded-mandate/external-intent@1</code> record. Then only that action can be signed, and only if the console's own preview, built from live state, equals it field by field.</p>
<textarea id="intent-text" spellcheck="false" aria-label="Runner intent JSON"></textarea>
<p class="buttons"><button id="intent-load" type="button">Load intent</button><button id="intent-clear" type="button">Clear</button></p>
<p id="intent-status" class="source" role="status">No runner intent loaded: the console signs its own preview.</p>
</div>
<h3>3 · Actions</h3>
<div id="actions"><p class="muted">Controls need JavaScript and live state.</p></div>
<div id="review"></div>
<p id="console-log" role="status" aria-live="polite"></p>
<h3>Actions in this browser</h3>
<p class="muted">Pending actions are kept in this browser's storage, keyed by the intent's sha256. After a reload the console only resumes polling; it never signs or sends anything again by itself.</p>
<div id="activity"></div>`;
}

const ABOUT = `<ul class="about">
<li><strong>No backend, no keys.</strong> This page is one static file. It holds no private key and no model credential; it reads public RPC state and hands transactions to a signer outside the page.</li>
<li><strong>Two sources, never mixed.</strong> “Live” values come from the RPC you chose, after its genesis check, at one final block. “Recorded” values come from a sandbox run's evidence file. Neither is ever substituted for the other.</li>
<li><strong>Signing adapters.</strong> External wallets connect through NEAR Connect (pinned library, in-page wallet list, adapters pinned by commit; see <code>fixtures/wallets/near-connect.json</code>). The local sandbox test signer is a local sandbox adapter, not a wallet. It is offered only when this page is served by <code>tools/src/console/serve.ts</code>, signs with a sandbox key in a Node process on this machine, refuses other chains and signs only the owner calls this console offers on the served deployment. The manual handoff shows the exact <code>near</code> CLI command and tracks the hash you paste.</li>
<li><strong>Which wallets are verified.</strong> The NEAR Connect path (wallet list, sandboxed adapter, signature request, cancel, hash import) is tested end to end in a local sandbox with the labelled SANDBOX TEST WALLET only. No real wallet provider has signed through this console yet: compatibility with the owner's actual wallet is an owner-assisted check, and nothing here claims it.</li>
<li><strong>Wallet adapters' own storage.</strong> An adapter granted storage keeps its session data in this site's browser storage under its wallet id. That is the wallet's data, not a key held by this page's code.</li>
<li><strong>The runner verifies.</strong> The handoff record (intent sha256, transaction hash, signer) is imported by the runner, which checks the chain, signer, key, receiver, every action and argument, the receipt tree and the end state. The console's own final-state display is a convenience, not that verification.</li>
<li><strong>Never resubmitted.</strong> With the local test signer, a cancelled signature or a rejected transaction leaves nothing pending. A wallet's rejection or closed window stays pending until you forget it, because a wallet's error cannot prove that nothing was sent. A reload during a pending action resumes polling only.</li>
</ul>`;

/** Pure renderer; throws when the evidence fails schema validation. */
export function renderConsoleHtml(evidence: unknown, opts: ConsoleOptions = {}): string {
  const parsed = Evidence.safeParse(evidence);
  if (!parsed.success) throw new Error(`evidence failed schema validation:\n${z.prettifyError(parsed.error)}`);
  const ev = parsed.data;
  const profiles = opts.profiles ?? [mainnetProfile()];
  if (profiles.length === 0) throw new Error("the console needs at least one network profile");
  const localSigner = opts.localSigner ?? null;
  const script = consoleScript();
  const walletsByProfile = opts.wallets === false ? {} : walletProfiles(profiles, localSigner, opts.testWalletSha256 ?? null);
  const bundle = Object.keys(walletsByProfile).length === 0 ? null : nearConnectBundle();
  // NEAR Connect runs each wallet adapter in a sandboxed srcdoc iframe, which inherits this page's CSP; its inline
  // scripts carry this nonce. It is fixed per build (the page is static), derived from the two pinned scripts, and
  // hex because NEAR Connect drops every nonce character outside [A-Za-z0-9+/=].
  const nonce = bundle === null ? null : createHash("sha256").update(`${script}\n${bundle}`).digest("hex").slice(0, 32);
  const data: ConsoleData = {
    profiles,
    local_signer: localSigner,
    timeout_ms: opts.timeoutMs ?? 15_000,
    poll_ms: opts.pollMs ?? 1_000,
    wallets: bundle === null || nonce === null ? null : { library_version: pinnedWallets().library.version, nonce, profiles: walletsByProfile },
  };
  const scriptSrc = [`'${consoleScriptHash(script)}'`, ...(bundle === null || nonce === null ? [] : [`'${scriptHash(bundle)}'`, `'nonce-${nonce}'`])].join(" ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:${bundle === null ? "" : " https:"}; script-src ${scriptSrc}; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Bounded mandate — owner console</title>
<style>${STYLES}${CONSOLE_STYLES}</style>
</head>
<body>
<a class="skip" href="#live">Skip to the live state</a>
<main class="dossier" id="console-root" data-console="${ESC_JSON(data)}">
<header class="docket">
<p class="kicker">Bounded mandate · owner console · NEAR Intents · USDC / wNEAR</p>
<p class="chips"><span class="mode label">static page</span> <span class="mode label">no backend</span> <span class="mode label">holds no keys</span></p>
<h1>Review the mandate. Revoke, recover and withdraw as its owner.</h1>
<p class="position">Anyone can read the grant, its limits, the key on the verifier, open orders and balances. Only the contract's owner can act, and only by signing outside this page.</p>
<div class="sources">
<div><span class="mode live">live</span><p>Current chain state from an RPC you choose, after a chain-id and genesis check, at one final block (§1).</p></div>
<div><span class="mode sandbox">sandbox</span> <span class="mode recorded">recorded</span><p>What one <code>make demo</code> run observed in a local sandbox with labelled test doubles (§3). Not live.</p></div>
</div>
</header>
${section("§1", "live", "live", "Live chain state", liveSection(data))}
${section("§2", "owner", "owner", "Owner controls", ownerSection(data))}
${section("§3", "recorded", "recorded", "Recorded evidence (sandbox)", recordedSection(ev))}
${section("§4", "about", "about", "About this console", ABOUT)}
<footer>Generated by tools/src/console/render.ts from schema-validated evidence (revision ${escapeHtml(ev.source.product_commit.slice(0, 12))}). Self-contained: no external files. Its inline scripts make network requests only when you press a button, or to resume polling an action already pending in this browser; a wallet's pinned adapter is fetched only when you choose that wallet.</footer>
</main>
${bundle === null ? "" : `<script>${bundle}</script>\n`}<script>${script}</script>
</body>
</html>
`;
}

/** Writes `<outDir>/index.html` (default out/console) and returns its path. The build entry `make demo` calls. */
export function renderConsole(evidence: Evidence, outDir = join(REPO_ROOT, "out/console"), opts: ConsoleOptions = {}): string {
  const html = renderConsoleHtml(evidence, opts);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "index.html");
  writeFileSync(path, html);
  return path;
}
