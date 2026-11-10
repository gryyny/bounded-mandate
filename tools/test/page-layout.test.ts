// Site, CSP and layout check of the rendered evidence page in headless Chromium at 1440 and 390 px, in both layouts.
// SYNTHETIC specimens only: the sandbox story and the mainnet-shaped evidence are built for testing; nothing ran on a
// chain. Served from 127.0.0.1 under the planned project path; no other host is requested.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderHtml } from "../src/page/render.js";
import { assembleSite, checkSite, PLANNED_BASE, serveSite } from "../src/release/site.js";
import { Evidence } from "../src/types.js";
import { record } from "./page-challenge-specimen.js";
import { storyEvidence, txHash } from "./video-story-specimen.js";

const mainnet = (): Evidence =>
  Evidence.parse({
    ...storyEvidence(),
    mode: "mainnet",
    command: "MANDATE_LIVE=1 make live (SYNTHETIC)",
    environment: { chain_id: "mainnet", label: "SYNTHETIC" },
    identifiers: { mandate: "mandate.synthetic.near", owner: "owner.synthetic.near" },
    receipts: [{ label: "owner revoke (SYNTHETIC)", tx_hash: txHash("revoke"), block_height: 2, outcome: "success", detail: { step: 6, signer_id: "owner.synthetic.near" } }],
    assertions: [{ id: "step-7-relay_withheld", gate: "LIVE", description: "relay_withheld (SYNTHETIC)", passed: true, observed: { classification: "inconclusive" } }],
    unknowns: [],
  });

let browser: Browser;
const dirs: string[] = [];
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.each([
  ["sandbox", null, null],
  ["mainnet (SYNTHETIC)", mainnet(), null],
  ["sandbox with a SYNTHETIC closed challenge", null, record("closed", { agent_key: { ...record("closed").agent_key, publication_url: "https://example.invalid/SYNTHETIC-key-post" } })],
  ["mainnet (SYNTHETIC) with a SYNTHETIC open challenge", mainnet(), record("open", { mode: "mainnet" })],
] as const)("evidence page in Chromium: %s layout", (_name, live, challenge) => {
  it("passes the site and CSP check, makes no request before interaction and fits 1440 and 390 px", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-page-layout-"));
    dirs.push(dir);
    const page = join(dir, "index.html");
    writeFileSync(page, renderHtml(storyEvidence(), { acceptance: null, live, challenge }));
    const root = assembleSite({ page, out: join(dir, "site") });
    const report = await checkSite(root, [""]);
    expect(report.problems).toEqual([]);
    expect(report.passed).toBe(true);

    const { server, origin } = await serveSite(root);
    try {
      for (const width of [1440, 390]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const p = await ctx.newPage();
        const requests: string[] = [];
        const errors: string[] = [];
        p.on("request", (r) => requests.push(r.url()));
        p.on("pageerror", (e) => errors.push(e.message));
        p.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        await p.goto(`${origin}${PLANNED_BASE}`, { waitUntil: "load" });
        // A string expression, as the console tests do: the test's TypeScript lib has no DOM types.
        const layout = await p.evaluate<{ overflow: number; order: number[]; actions: number }>(
          `(() => { const top = (s) => document.querySelector(s)?.getBoundingClientRect().top ?? -1; return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, order: ["h1.lead-line", "p.lead-sub", "ol.actions", "dl.state-strip"].map(top), actions: document.querySelectorAll("ol.actions > li").length }; })()`,
        );
        expect(errors, `${String(width)} px`).toEqual([]);
        expect(requests, `${String(width)} px`).toEqual([`${origin}${PLANNED_BASE}`]);
        expect(layout.overflow, `${String(width)} px horizontal overflow`).toBeLessThanOrEqual(0);
        expect(layout.order.every((t) => t >= 0)).toBe(true);
        expect([...layout.order].sort((a, b) => a - b)).toEqual(layout.order);
        expect(layout.actions).toBe(3);
        await ctx.close();
      }
    } finally {
      await new Promise<void>((ok) => server.close(() => { ok(); }));
    }
  });
});
