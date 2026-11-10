// Drives the owner console in headless Chromium during `make demo`. The page is served by the LOCAL SANDBOX TEST
// SIGNER (src/console/signer.ts), which holds the sandbox owner key in this Node process; the browser holds no key.
// The review reads what the rendered page shows; the revocation is the console's own Revoke control, signed after its
// preview. Owner controls via the local sandbox test signer are not a wallet and prove nothing about any wallet.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import type { NetworkProfile } from "../console/client.js";
import { renderConsoleHtml, sandboxProfile } from "../console/render.js";
import { LocalSandboxSigner, type SignRequestLog } from "../console/signer.js";
import type { ConsoleRendered, Screenshot } from "../evidence/journey.js";
import { codeHashOf } from "../live/network.js";
import { sandboxKey } from "../near/keys.js";
import { REPO_ROOT } from "../near/sandbox.js";
import type { Evidence } from "../types.js";
import type { World } from "./world.js";

const POLL_MS = 250;
const Rows = z.array(z.tuple([z.string(), z.string()]));

/** Waits until the final block has caught up with the optimistic head: the console reads final state only. */
async function untilFinal(world: World): Promise<void> {
  const target = (await world.client.provider.viewBlock({ finality: "optimistic" })).header.height;
  while ((await world.client.provider.viewBlock({ finality: "final" })).header.height < target) await new Promise((r) => setTimeout(r, 100));
}

const LiveDom = z.object({
  status: z.string(),
  badge: z.string(),
  checks: z.array(z.string()),
  controls: z.string(),
  cards: z.record(z.string(), z.object({ rows: Rows, pill: z.string().nullable(), line: z.string().nullable(), table: z.array(z.array(z.string())) })),
});

// Evaluated in the page; a string so this module needs no DOM types.
const READ_LIVE = `(() => {
  const t = (e) => (e === null || e === undefined ? "" : (e.textContent ?? "").trim());
  const cards = {};
  for (const c of document.querySelectorAll("#live-body .ccard")) {
    const dts = [...c.querySelectorAll("dl.kv > dt")].map(t);
    const dds = [...c.querySelectorAll("dl.kv > dd")].map(t);
    cards[t(c.querySelector("h3"))] = {
      rows: dts.map((k, i) => [k, dds[i] ?? ""]),
      pill: c.querySelector(".grant-line .status") === null ? null : t(c.querySelector(".grant-line .status")),
      line: c.querySelector(".grant-line") === null ? null : t(c.querySelector(".grant-line")),
      table: [...c.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map(t)),
    };
  }
  return { status: t(document.querySelector("#live-status")), badge: t(document.querySelector("#live-body .chips")), checks: [...document.querySelectorAll("#live-body p.check")].map(t), controls: t(document.querySelector("#actions p.check")), cards };
})()`;

const READ_REVIEW = `[...document.querySelectorAll("#review .review dl.kv > dt")].map((dt) => [(dt.textContent ?? "").trim(), ((dt.nextElementSibling && dt.nextElementSibling.textContent) ?? "").trim()])`;

export interface RevokeResult {
  preview: [string, string][];
  /** null when the preview was refused before signing. */
  intent_sha256: string | null;
  tx_hash: string | null;
  ui_final: string | null;
  requests: SignRequestLog[];
  screenshot: Screenshot | null;
}

export interface ConsoleSessionOptions {
  /** Where screenshots are written; default out/console/screens. */
  screensDir?: string;
  /** Where the deployed mandate WASM came from, as the console profile names it. */
  wasmSource?: string;
}

export class ConsoleSession {
  private constructor(
    private readonly world: World,
    private readonly screens: string,
    readonly signer: LocalSandboxSigner,
    private readonly browser: Browser,
    private readonly page: Page,
    readonly profile: NetworkProfile,
    readonly browserVersion: string,
    readonly errors: string[],
  ) {}

  /** Serves the console for this sandbox through the test signer and opens it in headless Chromium. */
  static async start(world: World, evidence: () => Evidence, opts: ConsoleSessionOptions = {}): Promise<ConsoleSession> {
    const status = await world.client.nodeStatus();
    const profile = sandboxProfile({
      rpc_url: world.client.rpcUrl,
      chain_id: status.chain_id,
      genesis_hash: status.genesis_hash,
      mandate_id: world.mandate.id,
      code_hash: codeHashOf(world.wasm.mandate.bytes),
      verifier_id: world.verifier.id,
      source: opts.wasmSource ?? "local build target/near/bounded_mandate",
    });
    const signer = await LocalSandboxSigner.start({
      rpcUrl: world.client.rpcUrl,
      accountId: world.owner.id,
      key: world.owner.key ?? sandboxKey(world.owner.id),
      deployment: { mandate_id: world.mandate.id, verifier_id: world.verifier.id },
      page: () => renderConsoleHtml(evidence(), { profiles: [profile], localSigner: "", pollMs: POLL_MS, timeoutMs: 15_000 }),
    });
    const browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`${signer.origin}/`);
    return new ConsoleSession(world, opts.screensDir ?? join(REPO_ROOT, "out/console/screens"), signer, browser, page, profile, `chromium ${browser.version()} headless (playwright)`, errors);
  }

  async stop(): Promise<void> {
    await this.browser.close();
    await this.signer.stop();
  }

  private async readState(): Promise<void> {
    await untilFinal(this.world);
    await this.page.click("#live-read");
    await this.page.locator("#live-status", { hasText: /^(Read from|Not verified|Read failed)/ }).waitFor();
  }

  private async shot(selector: string, name: string): Promise<Screenshot> {
    mkdirSync(this.screens, { recursive: true });
    const path = join(this.screens, `${name}.png`);
    await this.page.locator(selector).screenshot({ path });
    return { path: relative(REPO_ROOT, path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  }

  /** Reads the live view at a final block and connects the test signer; returns what the page shows. */
  async review(): Promise<ConsoleRendered> {
    await this.readState();
    await this.page.selectOption("#signer-kind", "local");
    await this.page.click("#signer-connect");
    await this.page.locator("#signer-status", { hasText: /^(Connected|Local test signer unavailable)/ }).waitFor();
    const dom = LiveDom.parse(await this.page.evaluate(READ_LIVE));
    const card = (title: string) => dom.cards[title] ?? { rows: [], pill: null, line: null, table: [] };
    const row = (title: string, key: string): string => card(title).rows.find(([k]) => k === key)?.[1] ?? "not shown";
    const grant = card("Grant");
    return {
      browser: this.browserVersion,
      origin: this.signer.origin,
      live_status: dom.status,
      badge: dom.badge,
      chain_verified: dom.checks.some((c) => c.startsWith("chain verified")),
      deployment_matches: dom.checks.some((c) => c.startsWith("deployment matches")),
      owner_controls: dom.controls,
      grant_status: grant.pill ?? "not shown",
      grant_line: grant.line ?? "not shown",
      grant_key: row("Grant", "Grant key"),
      key_on_verifier: row("Grant", "Key on the verifier now"),
      limits: card("Limits of this grant").rows,
      mandate: card("Mandate").rows,
      mandate_balances: Object.fromEntries(card("Balances").table.map((cells) => [cells[0] ?? "", cells[1] ?? ""])),
      screenshot: await this.shot("#live", "demo-console-review"),
    };
  }

  /**
   * Opens the Revoke control's review and, only when `accept` finds the shown preview exact, confirms it and waits for
   * the console to show the transaction final.
   */
  async revoke(accept: (preview: [string, string][]) => string[]): Promise<RevokeResult> {
    await this.readState();
    await this.page.click('[data-action="revoke"]');
    await this.page.waitForSelector("#review-confirm");
    const preview = Rows.parse(await this.page.evaluate(READ_REVIEW));
    const screenshot = await this.shot("#review", "demo-revoke-preview");
    const shown = preview.find(([k]) => k === "Intent sha256")?.[1] ?? null;
    if (accept(preview).length > 0 || shown === null) {
      await this.page.click("#review-cancel");
      return { preview, intent_sha256: null, tx_hash: null, ui_final: null, requests: [...this.signer.requests], screenshot };
    }
    await this.page.click("#review-confirm");
    const record = `li[data-record="${shown}"]`;
    await this.page.waitForSelector(`${record}[data-phase="final"]`, { timeout: 60_000 });
    const requests = [...this.signer.requests];
    const head = (await this.page.textContent(`${record} > p`))?.trim() ?? "";
    const rows = Rows.parse(await this.page.evaluate(`[...document.querySelectorAll('${record} > dl.kv > dt')].map((dt) => [(dt.textContent ?? "").trim(), ((dt.nextElementSibling && dt.nextElementSibling.textContent) ?? "").trim()])`));
    const state = rows.find(([k]) => k === "Contract state")?.[1];
    return { preview, intent_sha256: shown, tx_hash: requests[0]?.tx_hash ?? null, ui_final: state === undefined ? head : `${head} · ${state}`, requests, screenshot };
  }
}
