// gate: CONSOLE — the external-wallet path end to end in a real headless Chromium against a local sandbox. The console
// loads NEAR Connect (the pinned library inlined in the page) with an in-page wallet list; on a sandbox page that list
// holds only the labelled SANDBOX TEST WALLET, whose adapter runs in NEAR Connect's sandboxed frame exactly like a real
// wallet's and asks the local test signer (a Node process with a sandbox key) to sign. The live runner persists each
// external owner action; the owner signs it in the wallet, cancels once at a valid action boundary (the first
// recovery, which has no deadline), and the runner imports every hash. A reload while the wallet is asking resubmits
// nothing; a framed console and a wallet on another account get no control. This exercises the NEAR Connect
// integration only: it says nothing about any real wallet provider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NetworkProfile } from "../src/console/client.js";
import { TEST_WALLET_ID, TEST_WALLET_NAME, pinnedWallets } from "../src/console/connector.js";
import { mainnetProfile, renderConsoleHtml } from "../src/console/render.js";
import type { LocalSandboxSigner } from "../src/console/signer.js";
import { DECIMALS, DEMO_POLICY, PRICE_IDS } from "../src/demo/market.js";
import { AGENT_ALLOWANCE, balances, fillerKey, postPrices, setupWorld, type World } from "../src/demo/world.js";
import { CaseRecorder, wasmHashes } from "../src/evidence/report.js";
import { ExternalHandoff, intentSha256, type ExternalIntent } from "../src/live/external.js";
import { runLive, type LiveResult } from "../src/live/main.js";
import type { LiveManifest } from "../src/live/manifest.js";
import { NEAR } from "../src/near/client.js";
import { sandboxKey } from "../src/near/keys.js";
import { LocalNetwork } from "../src/near/sandbox.js";
import { connectWallet, consoleEvidence, consoleLog, controls, handoffText, hash58, launch, loadIntent, openConsole, readState, serveConsole, storedRecords, waitFinal, walletPrompt, worldProfile } from "./console-helpers.js";
import { offlineManifest, writeCredential, writeJson } from "./live-helpers.js";

const evidence = new CaseRecorder("CONSOLE", "wallet-sandbox", [
  "in-page-wallet-list",
  "connect-through-near-connect",
  "wallet-reject-sends-nothing",
  "wallet-signs-runner-intents",
  "runner-imports-wallet-hashes",
  "reload-while-wallet-asks",
  "framed-console-refuses-wallet",
  "wallet-on-other-account-disabled",
]);

let net: LocalNetwork | undefined;
let world: World;
let browserOrNone: Browser | undefined;
let profile: NetworkProfile;
let signerOrNone: LocalSandboxSigner | undefined;
const helpers: LocalSandboxSigner[] = [];
let dir: string | undefined;
let page: Page;
let result: LiveResult | null = null;
const handed: { kind: string; sha: string; tx_hash: string; ui_final: string }[] = [];
const rejected: { kind: string; summary: string; nonce_before: bigint | null; nonce_after: bigint | null; wallet_requests: number }[] = [];
const frames: (string | null)[] = [];
const requests: string[] = [];
const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`setup did not provide ${what}`);
  return v;
};
const browser = (): Browser => must(browserOrNone, "a browser");
const signer = (): LocalSandboxSigner => must(signerOrNone, "the test signer");
const ownerKey = () => world.owner.key ?? sandboxKey(world.owner.id);
const ownerNonce = async () => world.client.accessKeyNonce(world.owner.id, ownerKey().getPublicKey().toString());
const walletRequests = () => signer().requests.filter((r) => r.via === "wallet");

function manifest(): LiveManifest {
  const w = world;
  const key = (k: World["owner"]["key"]) => {
    if (k === null) throw new Error("missing key");
    return k;
  };
  const d = must(dir, "a directory");
  return offlineManifest(d, {
    network: { name: "sandbox", chain_id: profile.chain_id, genesis_hash: profile.genesis_hash, rpc_url: w.client.rpcUrl },
    accounts: { mandate: w.mandate.id, owner: w.owner.id, agent: w.agent.id, filler: w.filler.id, verifier: w.verifier.id, signer: w.mpcId, oracle: w.oracleId },
    code_hashes: { mandate: hash58(w.wasm.mandate.bytes), verifier: hash58(w.wasm.verifier.bytes), signer: hash58(w.wasm.mpc.bytes), oracle: hash58(w.wasm.oracle.bytes), usdc: hash58(w.wasm.ft.bytes), wnear: hash58(w.wasm.ft.bytes) },
    mandate_config: {
      owner_id: w.owner.id,
      agent_id: w.agent.id,
      verifier_id: w.verifier.id,
      signer_id: w.mpcId,
      oracle_id: w.oracleId,
      usdc: { token: w.tokens.usdc, decimals: DECIMALS.usdc, price_id: PRICE_IDS.usdc },
      wnear: { token: w.tokens.wnear, decimals: DECIMALS.wnear, price_id: PRICE_IDS.wnear },
    },
    keys: {
      mandate_full_access: [],
      agent: { public_key: key(w.agent.key).getPublicKey().toString(), max_allowance_yocto: AGENT_ALLOWANCE.toString() },
      owner: { public_key: key(w.owner.key).getPublicKey().toString() },
      filler: { public_key: key(w.filler.key).getPublicKey().toString(), intents_public_key: fillerKey(w).getPublicKey().toString() },
    },
    credentials: {
      owner: writeCredential(d, "owner.json", w.owner.id, key(w.owner.key)),
      agent: writeCredential(d, "agent.json", w.agent.id, key(w.agent.key)),
      filler: writeCredential(d, "filler.json", w.filler.id, key(w.filler.key)),
      filler_intents: writeCredential(d, "filler-intents.json", w.filler.id, fillerKey(w)),
    },
    budget: {
      max_fee_yocto: NEAR.toString(),
      max_deposit_yocto: "10",
      max_transactions: 20,
      owner_inventory_max: { usdc: (1_000n * 10n ** 6n).toString(), wnear: (300n * 10n ** 24n).toString() },
      max_order_sell: { usdc: "0", wnear: "0" },
      max_total_sell: { usdc: "0", wnear: "0" },
      filler_spend_max: { usdc: "0", wnear: "0" },
      owner_recovery_reserve_yocto: (NEAR / 2n).toString(),
    },
    steps: [
      { kind: "grant", policy: DEMO_POLICY },
      { kind: "revoke_external" },
      { kind: "recover_external", asset: "usdc" },
      { kind: "recover_external", asset: "wnear" },
      { kind: "withdraw_external", asset: "usdc" },
      { kind: "withdraw_external", asset: "wnear" },
    ],
  });
}

function actionKeyOf(intent: ExternalIntent): string {
  const args = intent.actions[0]?.args ?? {};
  if (intent.kind === "revoke_external") return "revoke";
  if (intent.kind === "recover_external") return `recover:${String(args.asset)}`;
  return `withdraw:${args.token === world.tokens.usdc ? "usdc" : "wnear"}`;
}

/** The owner signs one runner intent in the wallet; at the first recovery they first reject once in the wallet. */
async function signInWallet(intent: ExternalIntent): Promise<ExternalHandoff> {
  await readState(page);
  expect(await loadIntent(page, intent)).toMatch(/^Runner intent loaded/);
  const key = actionKeyOf(intent);
  const sha = await intentSha256(intent);
  if (intent.kind === "recover_external" && rejected.length === 0) {
    const nonceBefore = await ownerNonce();
    const before = walletRequests().length;
    await page.click(`[data-action="${key}"]`);
    await page.click("#review-confirm");
    const summary = await walletPrompt(page, "reject");
    await page.locator("#console-log", { hasText: /^Signature cancelled in the wallet/ }).waitFor();
    // Nothing is kept for this intent; the earlier actions' final records stay.
    expect((await storedRecords(page)).filter((r) => r.intent_sha256 === sha)).toEqual([]);
    expect((await controls(page)).enabled[key]).toBe(true);
    rejected.push({ kind: intent.kind, summary, nonce_before: nonceBefore, nonce_after: await ownerNonce(), wallet_requests: walletRequests().length - before });
  }
  await page.click(`[data-action="${key}"]`);
  await page.waitForSelector("#review-confirm");
  expect(await page.textContent(".review")).toContain(sha);
  expect(await page.textContent("#review-confirm")).toBe(`Sign in ${TEST_WALLET_NAME}`);
  await page.click("#review-confirm");
  await page.locator(".hot-connector-popup iframe").last().contentFrame().locator("#tw-approve").waitFor();
  frames.push(await page.locator(".hot-connector-popup iframe").last().getAttribute("sandbox"));
  const summary = await walletPrompt(page, "approve");
  expect(summary).toContain(`${world.owner.id} -> ${intent.receiver_id} ${intent.actions[0]?.method ?? "?"}`);
  await waitFinal(page, sha);
  const handoff = ExternalHandoff.parse(JSON.parse(await handoffText(page, sha)));
  handed.push({ kind: intent.kind, sha, tx_hash: handoff.tx_hash, ui_final: (await page.textContent(`li[data-record="${sha}"]`)) ?? "" });
  return handoff;
}

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  dir = mkdtempSync(join(tmpdir(), "bm-wallet-"));
  profile = await worldProfile(world);
  signerOrNone = await serveConsole({ rpcUrl: world.client.rpcUrl, accountId: world.owner.id, key: ownerKey() }, () => [profile]);
  helpers.push(signer());
  browserOrNone = await launch();
}, 300_000);

afterAll(async () => {
  const loaded = typeof world === "undefined" ? [] : Object.values(world.wasm);
  evidence.write("sandbox", wasmHashes(loaded), {
    wallet: `${TEST_WALLET_NAME} through NEAR Connect ${pinnedWallets().library.version} (a test double, not a wallet provider)`,
    browser: "chromium headless (playwright)",
    runner: result === null ? null : { exit_code: result.exitCode, message: result.message },
    handoffs: handed.map((h) => ({ kind: h.kind, sha: h.sha, tx_hash: h.tx_hash })),
    rejected_in_wallet: rejected.map((r) => ({ kind: r.kind, nonce_unchanged: r.nonce_before === r.nonce_after, wallet_requests: r.wallet_requests })),
    sign_requests: signerOrNone?.requests ?? [],
    page_requests_to_other_hosts: requests,
  });
  await browserOrNone?.close();
  for (const h of helpers) await h.stop();
  await net?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("external wallet through NEAR Connect (sandbox test wallet)", () => {
  // gate: CONSOLE
  it("offers only the in-page wallet list: the pinned wallets on mainnet, the labelled test wallet on a sandbox", () =>
    evidence.check("in-page-wallet-list", () => {
      const dataOf = (html: string) => JSON.parse((/data-console="([^"]*)"/.exec(html)?.[1] ?? "").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#39;", "'").replaceAll("&amp;", "&")) as { wallets: { nonce: string; profiles: Record<string, { network: string; manifest: { wallets: { id: string; executor: string }[] } }> } | null };
      const pinned = pinnedWallets();
      const mainnetHtml = renderConsoleHtml(consoleEvidence(), { profiles: [mainnetProfile()] });
      const mainnetData = dataOf(mainnetHtml).wallets;
      const mainnet = mainnetData?.profiles.mainnet;
      // The adapter frames' nonce survives NEAR Connect's sanitizing and is the one in the CSP.
      expect(mainnetData?.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(mainnetHtml).toContain(`'nonce-${mainnetData?.nonce ?? ""}'`);
      expect(mainnet?.network).toBe("mainnet");
      expect(mainnet?.manifest.wallets.map((w) => [w.id, w.executor])).toEqual(pinned.wallets.map((w) => [w.manifest.id, `https://raw.githubusercontent.com/${w.pin.repository}/${w.pin.commit}/${w.pin.path}`]));
      const sandbox = dataOf(renderConsoleHtml(consoleEvidence(), { profiles: [profile], localSigner: "" })).wallets?.profiles[profile.id];
      expect(sandbox?.manifest.wallets.map((w) => w.id)).toEqual([TEST_WALLET_ID]);
      // Without a local test signer, a sandbox profile offers no wallet at all.
      expect(dataOf(renderConsoleHtml(consoleEvidence(), { profiles: [profile] })).wallets).toBeNull();
    }));

  // gate: CONSOLE
  it("connects through NEAR Connect's picker; the adapter runs in a sandboxed frame; owner controls enable", () =>
    evidence.check("connect-through-near-connect", async () => {
      const s = await openConsole(browser(), signer().origin);
      page = s.page;
      page.on("request", (r) => {
        const u = new URL(r.url());
        if (u.origin !== signer().origin && u.origin !== new URL(world.client.rpcUrl).origin && u.protocol !== "data:" && u.protocol !== "about:") requests.push(r.url());
      });
      await readState(page);
      expect(await connectWallet(page, TEST_WALLET_ID)).toMatch(new RegExp(`^Connected: ${world.owner.id} via ${TEST_WALLET_NAME.replace(/[()]/g, "\\$&")} through NEAR Connect 0\\.11\\.4 \\(the labelled sandbox test wallet, a test double\\)`));
      const c = await controls(page);
      expect(c.reasons).toEqual([]);
      expect(c.enabled.revoke).toBe(false); // no grant yet
      expect(s.errors).toEqual([]);
      expect(requests).toEqual([]); // no remote wallet list or adapter was fetched
    }));

  // gate: CONSOLE
  it("every runner intent is signed in the wallet; one rejection in the wallet first sends nothing", () =>
    evidence.check("wallet-signs-runner-intents", async () => {
      await postPrices(world);
      const target = (await world.client.provider.viewBlock({ finality: "optimistic" })).header.height;
      while ((await world.client.provider.viewBlock({ finality: "final" })).header.height < target) await new Promise((r) => setTimeout(r, 200));
      result = await runLive(
        { MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(must(dir, "a directory"), "manifest.json", manifest()) },
        { outRoot: join(must(dir, "a directory"), "live"), timeoutMs: 60_000, pollMs: 300, handoff: (intent) => signInWallet(intent) },
      );
      expect(handed.map((h) => h.kind)).toEqual(["revoke_external", "recover_external", "recover_external", "withdraw_external", "withdraw_external"]);
      expect(walletRequests().map((r) => r.status)).toEqual(handed.map(() => "submitted"));
      expect(walletRequests().map((r) => r.tx_hash)).toEqual(handed.map((h) => h.tx_hash));
      for (const h of handed) expect(h.ui_final).toContain("final · success");
      // Each prompt ran in NEAR Connect's adapter frame: scripts only, no same-origin access to the console.
      expect(frames).toEqual(handed.map(() => "allow-scripts"));
    }));

  // gate: CONSOLE
  it("the rejection in the wallet sent no request and moved no nonce; the action stayed available", () =>
    evidence.check("wallet-reject-sends-nothing", () => {
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ kind: "recover_external", wallet_requests: 0 });
      expect(rejected[0]?.nonce_after).toBe(rejected[0]?.nonce_before);
      expect(rejected[0]?.summary).toContain(`${world.owner.id} -> ${world.mandate.id} recover`);
    }));

  // gate: CONSOLE
  it("the runner imported every wallet hash and completed the run", () =>
    evidence.check("runner-imports-wallet-hashes", async () => {
      expect({ exit: result?.exitCode, message: result?.exitCode === 0 ? "" : result?.message }).toEqual({ exit: 0, message: "" });
      const imported = (result?.evidence?.receipts ?? []).filter((r) => typeof r.detail === "object" && r.detail !== null && "imported" in r.detail && r.detail.imported === true);
      expect(imported.map((r) => r.tx_hash)).toEqual(handed.map((h) => h.tx_hash));
      expect(imported.every((r) => r.outcome === "success")).toBe(true);
      expect((result?.evidence?.assertions ?? []).filter((a) => !a.passed)).toEqual([]);
      expect((await world.mandate.grant())?.status).toBe("revoked");
      expect(await balances(world, world.mandate.id)).toEqual({ usdc: 0n, wnear: 0n });
    }));
});

describe("no resubmission and no control without the owner's own, unframed wallet", () => {
  // gate: CONSOLE
  it("a reload while the wallet asks resubmits nothing; the record waits for a pasted hash or is forgotten", () =>
    evidence.check("reload-while-wallet-asks", async () => {
      const s = await openConsole(browser(), signer().origin);
      await readState(s.page);
      await connectWallet(s.page, TEST_WALLET_ID);
      // The grant is revoked now; revoking again is refused by the contract but still a valid wallet prompt to test.
      const before = signer().requests.length;
      const nonce = await ownerNonce();
      await s.page.click('[data-action="revoke"]');
      await s.page.click("#review-confirm");
      await s.page.locator(".hot-connector-popup iframe").last().contentFrame().locator("#tw-approve").waitFor();
      const [pending] = await storedRecords(s.page);
      expect(pending?.phase).toBe("awaiting-signature");
      await s.page.reload();
      await s.page.locator(`li[data-record="${pending?.intent_sha256 ?? ""}"]`).waitFor();
      const after = await storedRecords(s.page);
      expect(after.map((r) => [r.intent_sha256, r.phase, r.tx_hash])).toEqual([[pending?.intent_sha256, "awaiting-signature", null]]);
      expect(await s.page.textContent(`li[data-record="${pending?.intent_sha256 ?? ""}"]`)).toContain("interrupted while the wallet was asked to sign");
      await s.page.fill(`[data-paste="${pending?.intent_sha256 ?? ""}"]`, "not-a-hash");
      await s.page.click(`[data-track="${pending?.intent_sha256 ?? ""}"]`);
      expect(await consoleLog(s.page)).toBe("That is not a NEAR transaction hash.");
      await s.page.click(`[data-dismiss="${pending?.intent_sha256 ?? ""}"]`);
      expect(await storedRecords(s.page)).toEqual([]);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(signer().requests.length).toBe(before);
      expect(await ownerNonce()).toBe(nonce);
      await s.ctx.close();
    }));

  // gate: CONSOLE
  it("a console framed by another page refuses to connect a wallet", () =>
    evidence.check("framed-console-refuses-wallet", async () => {
      const ctx = await browser().newContext();
      const p = await ctx.newPage();
      const html = renderConsoleHtml(consoleEvidence(), { profiles: [profile], localSigner: "" });
      await p.route("http://framer.test/console", (r) => r.fulfill({ contentType: "text/html", body: html }));
      await p.route("http://framer.test/", (r) => r.fulfill({ contentType: "text/html", body: '<iframe id="f" src="/console" style="width:1200px;height:900px"></iframe>' }));
      await p.goto("http://framer.test/");
      const frame = p.frameLocator("#f");
      await frame.locator("#signer-kind").selectOption("wallet");
      await frame.locator("#signer-connect").click();
      await frame.locator("#signer-status", { hasText: /^This page is framed/ }).waitFor();
      expect(await p.locator(".hot-connector-popup").count()).toBe(0);
      await ctx.close();
    }));

  // gate: CONSOLE
  it("a wallet connected on another account gets no control", () =>
    evidence.check("wallet-on-other-account-disabled", async () => {
      const attacker = await serveConsole({ rpcUrl: world.client.rpcUrl, accountId: world.attacker.id, key: world.attacker.key ?? sandboxKey(world.attacker.id) }, () => [profile]);
      helpers.push(attacker);
      const s = await openConsole(browser(), attacker.origin);
      await readState(s.page);
      expect(await connectWallet(s.page, TEST_WALLET_ID)).toMatch(new RegExp(`^Connected: ${world.attacker.id} via`));
      const c = await controls(s.page);
      expect(Object.values(c.enabled).some((v) => v)).toBe(false);
      expect(c.reasons).toEqual([`signer ${world.attacker.id} is not the contract's owner ${world.owner.id}`]);
      expect(attacker.signRequests).toBe(0);
      await s.ctx.close();
    }));
});
