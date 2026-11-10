// Site, CSP and layout check of the rendered evidence page in headless Chromium at 1440x900 and 390x844, in both layouts.
// SYNTHETIC specimens only: the sandbox story and the mainnet-shaped evidence are built for testing; nothing ran on a
// chain. The console page and the two cuts the page links to are SYNTHETIC stand-ins (a stub page and placeholder
// bytes), there only so the page's links resolve. Served from 127.0.0.1 under the project path; no other host is requested.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { SITE_PATHS } from "../src/evidence/journey.js";
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

/** SYNTHETIC console directory and cuts, so the site is assembled as a release assembles it. */
const standIns = (dir: string): { console: string; video: string } => {
  const consoleDir = join(dir, "console");
  const video = join(dir, "video");
  mkdirSync(consoleDir, { recursive: true });
  mkdirSync(video, { recursive: true });
  writeFileSync(join(consoleDir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; form-action 'none'; base-uri 'none'"><title>SYNTHETIC console</title></head><body><p>SYNTHETIC stand-in for the owner console</p></body></html>`);
  for (const path of [SITE_PATHS.video, SITE_PATHS.walkthrough]) writeFileSync(join(dir, path), "SYNTHETIC placeholder, not a video");
  return { console: consoleDir, video };
};

/** What must be on the first screen without scrolling, per viewport: [width, height, selectors]. */
const FIRST_SCREEN = [
  [1440, 900, ["h1.lead-line", "p.lead-sub", "ol.actions > li:nth-child(1)", "ol.actions > li:nth-child(2)", "ol.actions > li:nth-child(3)", "dl.state-strip"]],
  [390, 844, ["h1.lead-line", "p.lead-sub", "ol.actions > li:nth-child(1) .act", "ol.actions > li:nth-child(2) .act", "ol.actions > li:nth-child(3) .act"]],
] as const;

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
  it("passes the site and CSP check, makes no request before interaction and shows the first screen at 1440x900 and 390x844", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-page-layout-"));
    dirs.push(dir);
    const page = join(dir, "index.html");
    writeFileSync(page, renderHtml(storyEvidence(), { acceptance: null, live, challenge }));
    const root = assembleSite({ page, ...standIns(join(dir, "src")), out: join(dir, "site") });
    const report = await checkSite(root, ["", SITE_PATHS.console]);
    expect(report.problems).toEqual([]);
    expect(report.passed).toBe(true);
    // Assembled without the cuts, the page's own video links are reported.
    const bare = await checkSite(assembleSite({ page, console: join(dir, "src/console"), out: join(dir, "bare") }), [""]);
    expect(bare.problems.map((p) => p.replace(/;.*$/, ""))).toEqual([SITE_PATHS.video, SITE_PATHS.walkthrough].map((v) => `${PLANNED_BASE}: <a href="${v}"> is HTTP 404`));

    const { server, origin } = await serveSite(root);
    try {
      for (const [width, height, visible] of FIRST_SCREEN) {
        const ctx = await browser.newContext({ viewport: { width, height } });
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
        const layout = await p.evaluate<{ overflow: number; scrollY: number; viewport: [number, number]; order: number[]; actions: number; boxes: ([number, number, number, number] | null)[]; media: number }>(
          `(() => { const top = (s) => document.querySelector(s)?.getBoundingClientRect().top ?? -1; const box = (s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r === undefined || r.width === 0 || r.height === 0 ? null : [r.left, r.top, r.right, r.bottom]; }; return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, scrollY: window.scrollY, viewport: [document.documentElement.clientWidth, window.innerHeight], order: ["h1.lead-line", "p.lead-sub", "ol.actions", "dl.state-strip"].map(top), actions: document.querySelectorAll("ol.actions > li").length, boxes: ${JSON.stringify(visible)}.map(box), media: document.querySelectorAll("video, audio, img, iframe, source").length }; })()`,
        );
        const at = `${String(width)}x${String(height)}`;
        expect(errors, at).toEqual([]);
        // No request before the reader interacts: only the document itself, and no media element that could fetch.
        expect(requests, at).toEqual([`${origin}${PLANNED_BASE}`]);
        expect(layout.media, at).toBe(0);
        expect(layout.overflow, `${at} horizontal overflow`).toBeLessThanOrEqual(0);
        expect(layout.order.every((t) => t >= 0)).toBe(true);
        expect([...layout.order].sort((a, b) => a - b)).toEqual(layout.order);
        expect(layout.actions).toBe(3);
        // Each of these is wholly inside the viewport before any scroll.
        expect(layout.scrollY, at).toBe(0);
        expect(layout.viewport[1], at).toBe(height);
        for (const [i, b] of layout.boxes.entries()) {
          const name = `${at} ${visible[i] ?? ""}`;
          expect(b, name).not.toBeNull();
          if (b === null) continue;
          expect(b[0], `${name} left`).toBeGreaterThanOrEqual(0);
          expect(b[1], `${name} top`).toBeGreaterThanOrEqual(0);
          expect(b[2], `${name} right`).toBeLessThanOrEqual(layout.viewport[0]);
          expect(b[3], `${name} bottom`).toBeLessThanOrEqual(height);
        }
        // The Watch card does not wrap a long URL: its text is at most four lines high at the wide viewport.
        if (width === 1440) {
          const cards = await p.evaluate<number[]>(`[...document.querySelectorAll("ol.actions > li")].map((li) => li.getBoundingClientRect().height)`);
          expect(Math.max(...cards), `${at} action card height`).toBeLessThanOrEqual(170);
          expect(await p.evaluate<number>(`document.querySelectorAll("ol.actions a[href^='http'], ol.actions code").length === 0 ? 0 : Math.max(...[...document.querySelectorAll("ol.actions code")].map((c) => c.getClientRects().length))`), `${at} a path in an action card stays on one line`).toBeLessThanOrEqual(1);
        }
        // Following Watch requests exactly the cut it links, relative to the site's base.
        if (width === 1440) {
          const href = await p.evaluate<string>(`document.querySelector("ol.actions .act a").href`);
          expect(href).toBe(`${origin}${PLANNED_BASE}${SITE_PATHS.video}`);
          expect((await fetch(href)).headers.get("content-type")).toBe("video/mp4");
        }
        await ctx.close();
      }
    } finally {
      await new Promise<void>((ok) => server.close(() => { ok(); }));
    }
  });
});
