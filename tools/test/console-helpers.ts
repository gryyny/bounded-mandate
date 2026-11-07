// Shared setup for the console's real-browser tests: a local sandbox world, the console served by the LOCAL SANDBOX
// TEST SIGNER, and Playwright steps that drive the page the way an owner would. Sandbox keys only.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseEncode } from "near-api-js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { NetworkProfile } from "../src/console/client.js";
import { renderConsoleHtml, sandboxProfile } from "../src/console/render.js";
import { LocalSandboxSigner, type SignerOptions } from "../src/console/signer.js";
import type { World } from "../src/demo/world.js";
import { REPO_ROOT } from "../src/near/sandbox.js";
import { Evidence } from "../src/types.js";
import { storyEvidence } from "./video-story-specimen.js";

export const POLL_MS = 250;
export const hash58 = (bytes: Uint8Array): string => baseEncode(createHash("sha256").update(bytes).digest());

/** The recorded section's input: this checkout's demo evidence when present, else the labelled SYNTHETIC specimen. */
export function consoleEvidence(): Evidence {
  const path = join(REPO_ROOT, "out/evidence/demo.json");
  if (existsSync(path)) {
    const parsed = Evidence.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) return parsed.data;
  }
  return storyEvidence();
}

/** The expected deployment, derived from the local build artifacts and the sandbox's own status. */
export async function worldProfile(world: World): Promise<NetworkProfile> {
  const status = await world.client.nodeStatus();
  return sandboxProfile({
    rpc_url: world.client.rpcUrl,
    chain_id: status.chain_id,
    genesis_hash: status.genesis_hash,
    mandate_id: world.mandate.id,
    code_hash: hash58(world.wasm.mandate.bytes),
    verifier_id: world.verifier.id,
    source: "local build target/near/bounded_mandate",
  });
}

/**
 * A test signer serving the console; `profiles` is read on every page load so a test can swap expectations. The
 * signer is bound to the first profile's deployment at start unless `deployment` is given.
 */
export async function serveConsole(opts: Omit<SignerOptions, "page" | "deployment"> & Partial<Pick<SignerOptions, "deployment">>, profiles: () => NetworkProfile[], evidence: Evidence = consoleEvidence()): Promise<LocalSandboxSigner> {
  const deployment = opts.deployment ?? profiles()[0]?.deployment;
  if (deployment === undefined || deployment === null) throw new Error("the test signer needs a deployment to bind its receivers to");
  return LocalSandboxSigner.start({ ...opts, deployment, page: () => renderConsoleHtml(evidence, { profiles: profiles(), localSigner: "", pollMs: POLL_MS, timeoutMs: 15_000 }) });
}

export const launch = (): Promise<Browser> => chromium.launch();

/** A fresh browser context (empty localStorage) on the console, collecting page errors. */
export async function openConsole(browser: Browser, origin: string, viewport = { width: 1280, height: 900 }): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${origin}/`);
  return { ctx, page, errors };
}

export async function readState(page: Page): Promise<string> {
  await page.click("#live-read");
  await page.locator("#live-status", { hasText: /^(Read from|Not verified|Read failed)/ }).waitFor();
  return (await page.textContent("#live-status")) ?? "";
}

export async function connectLocal(page: Page): Promise<string> {
  await page.selectOption("#signer-kind", "local");
  await page.click("#signer-connect");
  await page.locator("#signer-status", { hasText: /^(Connected|Local test signer unavailable)/ }).waitFor();
  return (await page.textContent("#signer-status")) ?? "";
}

export async function loadIntent(page: Page, intent: unknown): Promise<string> {
  await page.fill("#intent-text", JSON.stringify(intent, null, 2));
  await page.click("#intent-load");
  await page.locator("#intent-status", { hasText: /^(Runner intent loaded|Not loaded)/ }).waitFor();
  return (await page.textContent("#intent-status")) ?? "";
}

/** State of every action button: enabled, and the gate reasons shown. */
export async function controls(page: Page): Promise<{ enabled: Record<string, boolean>; reasons: string[] }> {
  return page.evaluate<{ enabled: Record<string, boolean>; reasons: string[] }>(
    `({ enabled: Object.fromEntries([...document.querySelectorAll("[data-action]")].map((e) => [e.getAttribute("data-action"), !e.disabled])), reasons: [...document.querySelectorAll(".gate-reasons li")].map((e) => e.textContent) })`,
  );
}

/** Pending records in the page's localStorage. */
export interface StoredRecord {
  intent_sha256: string;
  phase: string;
  tx_hash: string | null;
}
export const storedRecords = (page: Page): Promise<StoredRecord[]> =>
  page.evaluate<StoredRecord[]>(`Object.keys(localStorage).filter((k) => k.startsWith("bounded-mandate/console/pending/")).map((k) => JSON.parse(localStorage.getItem(k)))`);

export const consoleLog = async (page: Page): Promise<string> => (await page.textContent("#console-log")) ?? "";

export async function waitFinal(page: Page, sha: string, timeout = 60_000): Promise<void> {
  await page.waitForSelector(`li[data-record="${sha}"][data-phase="final"]`, { timeout });
}

export async function handoffText(page: Page, sha: string): Promise<string> {
  return (await page.textContent(`pre[data-handoff="${sha}"]`)) ?? "";
}

/** Connects the owner's "external wallet": NEAR Connect's picker, then the wallet `walletId` in it. */
export async function connectWallet(page: Page, walletId: string): Promise<string> {
  await page.selectOption("#signer-kind", "wallet");
  await page.click("#signer-connect");
  await page.locator(`.hot-connector-popup .connect-item[data-type="${walletId}"]`).click();
  await page.locator("#signer-status", { hasText: /^(Connected|Not connected|No external wallet|This page is framed)/ }).waitFor();
  return (await page.textContent("#signer-status")) ?? "";
}

/** Answers the SANDBOX TEST WALLET's own prompt, shown by NEAR Connect in the adapter's sandboxed frame. */
export async function walletPrompt(page: Page, choice: "approve" | "reject"): Promise<string> {
  const frame = page.locator(".hot-connector-popup iframe").last().contentFrame();
  const summary = (await frame.locator("#tw-summary").textContent()) ?? "";
  await frame.locator(choice === "approve" ? "#tw-approve" : "#tw-reject").click();
  return summary;
}
