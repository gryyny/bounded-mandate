// gate: CONSOLE — the owner flow end to end in a real headless Chromium against a local sandbox. The live runner
// (src/live/main.ts) grants, then persists each external owner action as an intent; the console loads that intent,
// checks that its own preview from live state equals it, signs it through the LOCAL SANDBOX TEST SIGNER (not a wallet)
// and exports the handoff; the runner imports the hash and verifies the transaction and end state. Revoke, recovery
// of both assets and the owner's withdrawal of both assets all go through the console. The final contract, verifier
// and token state is asserted through RPC. Screenshots of the read-only and owner views go to out/console/screens/.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NetworkProfile } from "../src/console/client.js";
import type { LocalSandboxSigner } from "../src/console/signer.js";
import { DECIMALS, DEMO_POLICY, PRICE_IDS } from "../src/demo/market.js";
import { AGENT_ALLOWANCE, balances, fillerKey, postPrices, setupWorld, type World } from "../src/demo/world.js";
import { ftBalance } from "../src/demo/withdraw.js";
import { CaseRecorder, REPO_ROOT, wasmHashes } from "../src/evidence/report.js";
import { ExternalHandoff, intentSha256, type ExternalIntent } from "../src/live/external.js";
import { runLive, type LiveResult } from "../src/live/main.js";
import type { LiveManifest } from "../src/live/manifest.js";
import { NEAR } from "../src/near/client.js";
import { sandboxKey } from "../src/near/keys.js";
import { LocalNetwork } from "../src/near/sandbox.js";
import { connectLocal, controls, hash58, handoffText, launch, loadIntent, openConsole, readState, serveConsole, waitFinal, worldProfile } from "./console-helpers.js";
import { offlineManifest, writeCredential, writeJson } from "./live-helpers.js";

const evidence = new CaseRecorder("CONSOLE", "browser-sandbox", [
  "read-only-view",
  "owner-controls-enabled",
  "console-signs-runner-intents",
  "runner-imports-and-verifies",
  "final-state-by-rpc",
]);

const SCREENS = join(REPO_ROOT, "out/console/screens");
let net: LocalNetwork | undefined;
let world: World;
let browserOrNone: Browser | undefined;
let profile: NetworkProfile;
let signerOrNone: LocalSandboxSigner | undefined;
let dir: string | undefined;
const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`setup did not provide ${what}`);
  return v;
};
const browser = (): Browser => must(browserOrNone, "a browser");
const signer = (): LocalSandboxSigner => must(signerOrNone, "the test signer");
let page: Page;
let result: LiveResult | null = null;
const handed: { kind: string; sha: string; tx_hash: string; ui_final: string }[] = [];
let recovered: { usdc: bigint; wnear: bigint } = { usdc: 0n, wnear: 0n };
let walletBefore: { usdc: bigint; wnear: bigint } = { usdc: 0n, wnear: 0n };

const ownerKey = () => world.owner.key ?? sandboxKey(world.owner.id);

function manifest(): LiveManifest {
  const w = world;
  const key = (k: World["owner"]["key"]) => {
    if (k === null) throw new Error("missing key");
    return k;
  };
  return offlineManifest(must(dir, "a directory"), {
    network: { name: "sandbox", chain_id: profile.chain_id, genesis_hash: profile.genesis_hash, rpc_url: w.client.rpcUrl },
    accounts: { mandate: w.mandate.id, owner: w.owner.id, agent: w.agent.id, filler: w.filler.id, verifier: w.verifier.id, signer: w.mpcId, oracle: w.oracleId },
    // Independently derived from the local build artifacts, not read back from the chain.
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
      owner: writeCredential(must(dir, "a directory"), "owner.json", w.owner.id, key(w.owner.key)),
      agent: writeCredential(must(dir, "a directory"), "agent.json", w.agent.id, key(w.agent.key)),
      filler: writeCredential(must(dir, "a directory"), "filler.json", w.filler.id, key(w.filler.key)),
      filler_intents: writeCredential(must(dir, "a directory"), "filler-intents.json", w.filler.id, fillerKey(w)),
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

/** The console button that corresponds to a runner intent. */
function actionKeyOf(intent: ExternalIntent): string {
  const args = intent.actions[0]?.args ?? {};
  if (intent.kind === "revoke_external") return "revoke";
  if (intent.kind === "recover_external") return `recover:${String(args.asset)}`;
  return `withdraw:${args.token === world.tokens.usdc ? "usdc" : "wnear"}`;
}

/** What the owner does in the console for one runner intent; returns the handoff the console exported. */
async function signInConsole(intent: ExternalIntent): Promise<ExternalHandoff> {
  await readState(page);
  expect(await loadIntent(page, intent)).toMatch(/^Runner intent loaded/);
  const key = actionKeyOf(intent);
  const sha = await intentSha256(intent);
  if (intent.kind === "revoke_external") {
    await shot(page, "owner-review-desktop", async () => {
      await page.click(`[data-action="${key}"]`);
      await page.waitForSelector("#review-confirm");
    });
  } else {
    await page.click(`[data-action="${key}"]`);
    await page.waitForSelector("#review-confirm");
  }
  expect(await page.textContent(".review")).toContain(sha);
  await page.click("#review-confirm");
  await waitFinal(page, sha);
  const text = await handoffText(page, sha);
  const handoff = ExternalHandoff.parse(JSON.parse(text));
  handed.push({ kind: intent.kind, sha, tx_hash: handoff.tx_hash, ui_final: (await page.textContent(`li[data-record="${sha}"]`)) ?? "" });
  return handoff;
}

async function shot(p: Page, name: string, before?: () => Promise<void>): Promise<void> {
  await before?.();
  mkdirSync(SCREENS, { recursive: true });
  await p.screenshot({ path: join(SCREENS, `${name}.png`), fullPage: true });
}

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  dir = mkdtempSync(join(tmpdir(), "bm-console-"));
  profile = await worldProfile(world);
  signerOrNone = await serveConsole({ rpcUrl: world.client.rpcUrl, accountId: world.owner.id, key: ownerKey() }, () => [profile]);
  browserOrNone = await launch();
}, 300_000);

afterAll(async () => {
  const loaded = typeof world === "undefined" ? [] : Object.values(world.wasm);
  evidence.write("sandbox", wasmHashes(loaded), {
    signer: "local sandbox test signer (not a wallet)",
    browser: "chromium headless (playwright)",
    runner: result === null ? null : { exit_code: result.exitCode, message: result.message },
    handoffs: handed.map((h) => ({ kind: h.kind, sha: h.sha, tx_hash: h.tx_hash })),
    sign_requests: signerOrNone?.requests ?? [],
  });
  await browserOrNone?.close();
  await signerOrNone?.stop();
  await net?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("owner flow through the console, imported by the runner", () => {
  // gate: CONSOLE
  it("shows a read-only view to any visitor, labelled live and separate from recorded evidence", () =>
    evidence.check("read-only-view", async () => {
      const s = await openConsole(browser(), signer().origin);
      page = s.page;
      expect(await readState(page)).toMatch(/^Read from .*Live chain state, not recorded evidence\.$/);
      const live = (await page.textContent("#live-body")) ?? "";
      expect(live).toContain(`live · ${profile.label} · final block #`);
      expect(live).toContain("chain verified");
      expect(live).toContain("deployment matches");
      expect(live).toContain("No grant: the agent has no authority.");
      const c = await controls(page);
      expect(Object.values(c.enabled).some((v) => v)).toBe(false);
      expect(c.reasons).toEqual(["connect a signer (an external wallet, the local sandbox test signer or the manual CLI handoff)"]);
      await shot(page, "read-only-desktop");
      const m = await openConsole(browser(), signer().origin, { width: 390, height: 844 });
      await readState(m.page);
      await shot(m.page, "read-only-390");
      await m.ctx.close();
      expect(s.errors).toEqual([]);
    }));

  // gate: CONSOLE
  it("enables the owner's controls for the owner's signer on the expected deployment", () =>
    evidence.check("owner-controls-enabled", async () => {
      expect(await connectLocal(page)).toMatch(new RegExp(`^Connected: ${world.owner.id} via the LOCAL SANDBOX TEST SIGNER`));
      const c = await controls(page);
      expect(c.reasons).toEqual([]);
      expect(c.enabled.revoke).toBe(false); // no grant yet: nothing to revoke
    }));

  // gate: CONSOLE
  it("signs every runner intent in the console; the runner imports each hash and verifies it", () =>
    evidence.check("console-signs-runner-intents", async () => {
      await postPrices(world);
      // The runner reads final state; setup writes are optimistic.
      const target = (await world.client.provider.viewBlock({ finality: "optimistic" })).header.height;
      while ((await world.client.provider.viewBlock({ finality: "final" })).header.height < target) await new Promise((r) => setTimeout(r, 200));
      walletBefore = { usdc: await ftBalance(world, "usdc", world.owner.id), wnear: await ftBalance(world, "wnear", world.owner.id) };
      const mandateBefore = await balances(world, world.mandate.id);
      result = await runLive(
        { MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(must(dir, "a directory"), "manifest.json", manifest()) },
        { outRoot: join(must(dir, "a directory"), "live"), timeoutMs: 60_000, pollMs: 300, handoff: (intent) => signInConsole(intent) },
      );
      recovered = mandateBefore;
      expect(handed.map((h) => h.kind)).toEqual(["revoke_external", "recover_external", "recover_external", "withdraw_external", "withdraw_external"]);
      // One sign request per intent, all submitted: nothing was signed or sent twice.
      expect(signer().requests.map((r) => [r.intent_sha256, r.status])).toEqual(handed.map((h) => [h.sha, "submitted"]));
      expect(signer().requests.map((r) => r.tx_hash)).toEqual(handed.map((h) => h.tx_hash));
      for (const h of handed) expect(h.ui_final).toContain("final · success");
      await shot(page, "owner-final-desktop");
      const m = await openConsole(browser(), signer().origin, { width: 390, height: 844 });
      await readState(m.page);
      await connectLocal(m.page);
      await shot(m.page, "owner-390");
      await m.ctx.close();
    }));

  // gate: CONSOLE
  it("the runner accepted every handed-off transaction and completed the run", () =>
    evidence.check("runner-imports-and-verifies", () => {
      expect(result?.message).toBeDefined();
      expect({ exit: result?.exitCode, message: result?.exitCode === 0 ? "" : result?.message }).toEqual({ exit: 0, message: "" });
      const imported = (result?.evidence?.receipts ?? []).filter((r) => typeof r.detail === "object" && r.detail !== null && "imported" in r.detail && r.detail.imported === true);
      expect(imported.map((r) => r.tx_hash)).toEqual(handed.map((h) => h.tx_hash));
      expect(imported.every((r) => r.outcome === "success")).toBe(true);
      const failed = (result?.evidence?.assertions ?? []).filter((a) => !a.passed);
      expect(failed).toEqual([]);
    }));

  // gate: CONSOLE
  it("the chain shows the revoked grant, recovered and withdrawn assets", () =>
    evidence.check("final-state-by-rpc", async () => {
      const grant = await world.mandate.grant();
      expect(grant?.status).toBe("revoked");
      expect(grant?.key_op_in_flight).toBe(false);
      expect(await world.verifier.hasPublicKey(world.mandate.id, grant?.public_key ?? "")).toBe(false);
      expect(await balances(world, world.mandate.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(await balances(world, world.owner.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(recovered.usdc > 0n && recovered.wnear > 0n).toBe(true);
      expect({ usdc: await ftBalance(world, "usdc", world.owner.id), wnear: await ftBalance(world, "wnear", world.owner.id) }).toEqual({
        usdc: walletBefore.usdc + recovered.usdc,
        wnear: walletBefore.wnear + recovered.wnear,
      });
      const views = await world.mandate.recoveryViews();
      expect(views.map((v) => [v.asset, v.in_flight, v.recovered])).toEqual([
        ["usdc", false, recovered.usdc.toString()],
        ["wnear", false, recovered.wnear.toString()],
      ]);
    }));
});
