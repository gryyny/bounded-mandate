// Read-only check of the pinned NEAR Connect wallet list (fixtures/wallets/near-connect.json). Needs network access;
// it is not part of `make test`.
//   npx tsx src/console/wallets-check.ts [--browser [--console <index.html>]] [--out <report.json>]
// 1. Fetches every pinned adapter URL and compares its sha256 with the fixture.
// 2. With --browser: opens the built console page (default out/console/index.html, from `make demo`) in headless
//    Chromium and asks NEAR Connect, inside that
//    page and under its CSP, for each wallet's accounts. That loads the wallet's pinned adapter in NEAR Connect's
//    sandboxed frame and calls it; no wallet is connected, nothing is signed, no key or account is involved. A wallet
//    "loads" when its adapter registered and answered. It does not show that the wallet can sign for the owner.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { REPO_ROOT } from "../evidence/report.js";
import { pinnedWallets } from "./connector.js";

export interface AdapterResult {
  id: string;
  url: string;
  sha256_expected: string;
  sha256_fetched: string | null;
  matches: boolean;
  fetch_error: string | null;
  load: { answered: boolean; result: string; csp_violations: string[]; ms: number } | null;
}

async function fetchCheck(): Promise<AdapterResult[]> {
  const out: AdapterResult[] = [];
  for (const w of pinnedWallets().wallets) {
    const r: AdapterResult = { id: w.manifest.id, url: w.manifest.executor, sha256_expected: w.pin.executor_sha256, sha256_fetched: null, matches: false, fetch_error: null, load: null };
    try {
      const res = await fetch(w.manifest.executor);
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      r.sha256_fetched = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
      r.matches = r.sha256_fetched === r.sha256_expected;
    } catch (e) {
      r.fetch_error = e instanceof Error ? e.message : String(e);
    }
    out.push(r);
  }
  return out;
}

async function browserCheck(results: AdapterResult[], html: string): Promise<void> {
  if (!html.includes("&quot;mainnet&quot;:{&quot;network&quot;:&quot;mainnet&quot;")) throw new Error("the console page offers no mainnet wallet list");
  const browser = await chromium.launch();
  try {
    for (const r of results) {
      if (!r.matches) continue;
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const violations: string[] = [];
      page.on("console", (m) => {
        if (/Content Security Policy/i.test(m.text())) violations.push(m.text().slice(0, 300));
      });
      await page.route("https://console.invalid/", (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto("https://console.invalid/");
      const started = Date.now();
      const result = await page.evaluate(
        `(async () => {
          const d = JSON.parse(document.getElementById("console-root").getAttribute("data-console"));
          const p = d.wallets.profiles.mainnet;
          const c = new window.__nearConnect.NearConnector({ network: "mainnet", manifest: p.manifest, features: { signAndSendTransaction: true }, autoConnect: false, cspNonce: d.wallets.nonce, footerBranding: null, providers: { mainnet: [], testnet: [] } });
          const timeout = new Promise((resolve) => setTimeout(() => resolve({ answered: false, result: "no answer within 45 s" }), 45000));
          const ask = c.wallet(${JSON.stringify(r.id)}).then((w) => w.getAccounts()).then(
            (a) => ({ answered: true, result: "accounts: " + JSON.stringify(a) }),
            (e) => ({ answered: !/not found|iframe not loaded/i.test(String(e && e.message || e)), result: "error: " + String(e && e.message || e).slice(0, 200) }),
          );
          return Promise.race([ask, timeout]);
        })()`,
      );
      r.load = { ...(result as { answered: boolean; result: string }), csp_violations: violations, ms: Date.now() - started };
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { browser: { type: "boolean" }, console: { type: "string" }, out: { type: "string" } } });
  const results = await fetchCheck();
  const page = resolve(values.console ?? join(REPO_ROOT, "out/console/index.html"));
  const html = values.browser === true ? readFileSync(page, "utf8") : null;
  if (html !== null) await browserCheck(results, html);
  const report = {
    schema: "bounded-mandate/wallet-adapter-check@1",
    checked_at: new Date().toISOString(),
    library: pinnedWallets().library,
    console_page_sha256: html === null ? null : createHash("sha256").update(html).digest("hex"),
    note: "Adapter load only: no wallet connected, no account, nothing signed. It does not show that a wallet can sign for the owner.",
    results,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out !== undefined) writeFileSync(resolve(values.out), text);
  console.log(text);
  if (results.some((r) => !r.matches)) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
