// External-wallet connection for the owner console through NEAR Connect (@hot-labs/near-connect, pinned in
// package.json). The library is inlined into the page as its own script (pinned by hash in the CSP) and exposes
// window.__nearConnect. Wallets come only from the in-page list: fixtures/wallets/near-connect.json for mainnet
// (each wallet's adapter pinned to a commit, with its sha256), and, on a page served by the local sandbox test
// signer, the labelled SANDBOX TEST WALLET whose adapter that signer serves. NEAR Connect runs each adapter in a
// sandboxed iframe (scripts only, opaque origin); the console never sees a key, and verifies every returned
// transaction on chain against the exact preview.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../evidence/report.js";

export const NEAR_CONNECT_PACKAGE = "@hot-labs/near-connect";
const BUILD_DIR = join(REPO_ROOT, "tools/node_modules", NEAR_CONNECT_PACKAGE, "build");
export const WALLET_FIXTURE = join(REPO_ROOT, "fixtures/wallets/near-connect.json");

const WalletManifestEntry = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    executor: z.string().min(1),
    type: z.literal("sandbox"),
    features: z.record(z.string(), z.boolean()),
    permissions: z.record(z.string(), z.unknown()),
  })
  .loose();
export type WalletManifestEntry = z.infer<typeof WalletManifestEntry>;

const Pinned = z
  .object({
    schema: z.literal("bounded-mandate/near-connect-wallets@1"),
    library: z.object({ package: z.literal(NEAR_CONNECT_PACKAGE), version: z.string() }).loose(),
    wallets: z.array(
      z
        .object({
          manifest: WalletManifestEntry,
          pin: z.object({ repository: z.string(), commit: z.string().regex(/^[0-9a-f]{40}$/), path: z.string(), executor_sha256: z.string().regex(/^[0-9a-f]{64}$/), age_rule_met: z.boolean() }).loose(),
        })
        .strict(),
    ),
  })
  .loose();
export type PinnedWallets = z.infer<typeof Pinned>;

/** The wallet list the console offers on mainnet; every executor URL is the commit-pinned raw file. */
export function pinnedWallets(path = WALLET_FIXTURE): PinnedWallets {
  const pinned = Pinned.parse(JSON.parse(readFileSync(path, "utf8")));
  for (const w of pinned.wallets) {
    const want = `https://raw.githubusercontent.com/${w.pin.repository}/${w.pin.commit}/${w.pin.path}`;
    if (w.manifest.executor !== want) throw new Error(`wallet ${w.manifest.id}: executor ${w.manifest.executor} is not the pinned ${want}`);
  }
  return pinned;
}

/** The installed library version; the page refuses to build with any other than the fixture names. */
export function installedVersion(): string {
  const pkg = z.object({ version: z.string() }).loose().parse(JSON.parse(readFileSync(join(dirname(BUILD_DIR), "package.json"), "utf8")));
  return pkg.version;
}

function jsFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return jsFiles(p);
      return name.endsWith(".js") ? [p] : [];
    });
}

/**
 * The library's CommonJS build as one script: each file wrapped as a module, resolved by relative path only (the
 * package has no dependencies), exporting the package's index as window.__nearConnect. Source map comments are
 * dropped and `</script` is escaped inside its strings so the bundle can be inlined.
 */
export function nearConnectBundle(): string {
  const pinned = pinnedWallets();
  const version = installedVersion();
  if (version !== pinned.library.version) throw new Error(`${NEAR_CONNECT_PACKAGE} ${version} is installed; the wallet list is pinned for ${pinned.library.version}`);
  const modules = jsFiles(BUILD_DIR).map((file) => {
    const id = relative(BUILD_DIR, file).split("\\").join("/").replace(/\.js$/, "");
    const source = readFileSync(file, "utf8")
      .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
      .replace(/<\/script/gi, "<\\/script")
      .replace(/<!--/g, "<\\!--");
    return `${JSON.stringify(id)}: function (module, exports, require) {\n${source}\n}`;
  });
  const loader = `(function () {
"use strict";
var defs = {
${modules.join(",\n")}
};
var cache = {};
function resolve(from, spec) {
  if (spec.charAt(0) !== ".") throw new Error("near-connect bundle: unexpected package import " + spec);
  var base = from.indexOf("/") >= 0 ? from.slice(0, from.lastIndexOf("/")) + "/" : "";
  var parts = (base + spec).split("/");
  var out = [];
  for (var i = 0; i < parts.length; i++) { if (parts[i] === "..") out.pop(); else if (parts[i] !== "." && parts[i] !== "") out.push(parts[i]); }
  var id = out.join("/");
  if (defs[id]) return id;
  if (defs[id + "/index"]) return id + "/index";
  throw new Error("near-connect bundle: cannot resolve " + spec + " from " + from);
}
function load(id) {
  if (cache[id]) return cache[id].exports;
  var module = { exports: {} };
  cache[id] = module;
  defs[id].call(module.exports, module, module.exports, function (spec) { return load(resolve(id, spec)); });
  return module.exports;
}
window.__nearConnect = load("index");
window.__nearConnectVersion = ${JSON.stringify(version)};
})();
`;
  if (/<\/script|<!--/i.test(loader)) throw new Error("near-connect bundle cannot be inlined");
  return loader;
}

export const scriptHash = (script: string): string => `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;

export const TEST_WALLET_ID = "bounded-mandate-sandbox-test-wallet";
export const TEST_WALLET_NAME = "SANDBOX TEST WALLET (not a wallet)";
export const TEST_WALLET_EXECUTOR_PATH = "/wallet/test-executor.js";

/** The labelled test wallet's manifest entry; its adapter is served by the local sandbox test signer. */
export function testWalletManifest(): WalletManifestEntry {
  return {
    id: TEST_WALLET_ID,
    name: TEST_WALLET_NAME,
    description: "Labelled sandbox test double for NEAR Connect: its adapter runs like any wallet's, and asks the local sandbox test signer (a Node process holding a sandbox key) to sign. Not a wallet.",
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23b06a00'/%3E%3C/svg%3E",
    website: "https://example.invalid/sandbox-test-wallet",
    version: "1.0.0",
    executor: TEST_WALLET_EXECUTOR_PATH,
    type: "sandbox",
    features: { signAndSendTransaction: true, signAndSendTransactions: false, signMessage: false, signTransaction: false, signInWithoutAddKey: true, testnet: true },
    permissions: { storage: true },
  };
}

/**
 * The SANDBOX TEST WALLET's adapter, in the shape every NEAR Connect wallet adapter has: it registers with
 * window.selector.ready and runs in NEAR Connect's sandboxed iframe. It shows its own approve/reject prompt and asks
 * the local test signer at `signerOrigin` to sign, authenticated by `token` (one per signer process).
 */
export function testWalletExecutor(signerOrigin: string, accountId: string, token: string): string {
  const consts = `const SIGNER = ${JSON.stringify(signerOrigin)}; const ACCOUNT = ${JSON.stringify(accountId)}; const TOKEN = ${JSON.stringify(token)};`;
  return `${consts}
const LABEL = ${JSON.stringify(TEST_WALLET_NAME)};
const escapeText = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function prompt(params) {
  await window.selector.ui.showIframe();
  const root = document.getElementById("root");
  root.style.display = "flex";
  const a = params.actions[0] || { params: {} };
  root.innerHTML = '<div id="tw" style="padding:1rem;max-width:30rem;text-align:left">'
    + '<h1 style="font-size:1rem">' + escapeText(LABEL) + '</h1>'
    + '<p id="tw-summary" style="font:12px monospace;word-break:break-all">' + escapeText(params.signerId + " -> " + params.receiverId + " " + (a.params.methodName || a.type) + " " + JSON.stringify(a.params.args || {}) + " gas " + a.params.gas + " deposit " + a.params.deposit) + '</p>'
    + '<button id="tw-approve">Approve</button> <button id="tw-reject">Reject</button></div>';
  const choice = await new Promise((resolve) => {
    root.querySelector("#tw-approve").addEventListener("click", () => resolve(true));
    root.querySelector("#tw-reject").addEventListener("click", () => resolve(false));
  });
  root.innerHTML = "";
  root.style.display = "none";
  await window.selector.ui.hideIframe();
  return choice;
}
class SandboxTestWallet {
  async signIn() {
    window.localStorage.setItem("signedIn", "1");
    return [{ accountId: ACCOUNT, publicKey: "" }];
  }
  async signOut() {
    window.localStorage.removeItem("signedIn");
  }
  async getAccounts() {
    return window.localStorage.getItem("signedIn") === "1" ? [{ accountId: ACCOUNT, publicKey: "" }] : [];
  }
  async signAndSendTransaction(params) {
    if (!(await prompt(params))) throw new Error("User rejected the transaction in the " + LABEL);
    const res = await fetch(SIGNER + "/wallet/sign", { method: "POST", headers: { "Content-Type": "application/json", "X-Test-Wallet-Token": TOKEN }, body: JSON.stringify(params) });
    const body = await res.json();
    if (body.status === "submitted") return { status: { SuccessValue: "" }, transaction: { hash: body.tx_hash, signer_id: params.signerId, receiver_id: params.receiverId }, transaction_outcome: { id: body.tx_hash }, receipts_outcome: [] };
    if (body.status === "cancelled") throw new Error("User rejected the transaction in the local test signer");
    throw new Error(body.error || "the local test signer refused");
  }
  async signAndSendTransactions() {
    throw new Error("the sandbox test wallet signs one transaction at a time");
  }
}
window.selector.ready(new SandboxTestWallet());
`;
}
