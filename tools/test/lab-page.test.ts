// gate: LAB — the lab's page: self-contained under a strict CSP, and operated in a real headless Chromium through the
// whole visitor workflow against a served lab (deployment candidate, pinned verifier, prebuilt TEST DOUBLES). What the
// page shows is compared with what the lab's API reports for the same session; the page makes no request to any other
// origin.
import { createHash } from "node:crypto";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseRecorder } from "../src/evidence/report.js";
import type { ActionRecord } from "../src/lab/actions.js";
import { ALTERNATIVES } from "../src/lab/alternatives.js";
import { fmtUnits, panicText, toUnits } from "../src/lab/client.js";
import { LAB_LABEL, LAB_POLICY } from "../src/lab/config.js";
import { PRESETS, renderLabPage } from "../src/lab/page.js";
import { Scenario } from "../src/lab/scenario.js";
import { launch } from "./console-helpers.js";
import { labWasm, serve, view, type Served } from "./lab-helpers.js";

const evidence = new CaseRecorder("LAB", "page", ["self-contained-strict-csp", "units-and-errors", "browser-workflow", "comparison-export-reset-reload", "same-origin-no-errors"]);

let lab: Served;
let browser: Browser;
let page: Page;
const errors: string[] = [];
const requests: string[] = [];

beforeAll(async () => {
  lab = await serve();
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (r) => requests.push(r.url()));
}, 60_000);

afterAll(async () => {
  const bound = labWasm(lab.lab);
  evidence.write("sandbox", bound.wasm, { ...bound.data, browser: "chromium headless (playwright)" });
  await browser.close();
  await lab.close();
});

/** Waits until the page's status line says `text`; the status is rewritten by every action. */
const status = (text: string, timeout = 60_000): Promise<void> => page.locator("#lab-status").filter({ hasText: text }).waitFor({ timeout });
const sessionId = (): Promise<string> => page.evaluate<string>("window.sessionStorage.getItem('lab-session')");
const log = async (): Promise<ActionRecord[]> => (await lab.api("GET", `/api/sessions/${await sessionId()}/log`)).body.log as ActionRecord[];
const stateText = (): Promise<string> => page.locator("#state").innerText();

describe("the lab page", () => {
  // gate: LAB
  it("is one self-contained document whose only script is pinned by the CSP", () => evidence.check("self-contained-strict-csp", async () => {
    const { html, csp } = renderLabPage({ source: lab.lab.source, wasm: lab.lab.prebuilt.wasm, testDoubles: lab.lab.testDoubles() });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts).toHaveLength(1);
    expect(html).not.toMatch(/<script[^>]+src=|<link|<iframe|<img|<form|@import|url\(/i);
    expect(csp).toBe(`default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'sha256-${createHash("sha256").update(scripts[0] ?? "", "utf8").digest("base64")}'; connect-src 'self'; form-action 'none'; base-uri 'none'`);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    // No address of any other host, in markup or script.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain(LAB_LABEL);
    for (const d of lab.lab.testDoubles()) expect(html).toContain(d.sha256);
    for (const p of PRESETS) expect(html).toContain(`id="preset-${p.id}"`);
    for (const id of ALTERNATIVES) expect(html).toContain(`id="alt-${id}"`);
    const served = await fetch(`${lab.server.origin}/`);
    expect(await served.text()).toBe(html);
    expect(served.headers.get("content-security-policy")).toBe(`${csp}; frame-ancestors 'none'`);
    expect(served.headers.get("x-frame-options")).toBe("DENY");
  }));

  // gate: LAB
  it("converts amounts exactly and shows the contracts' own error text", () => evidence.check("units-and-errors", () => {
    expect(toUnits("50", 6)).toBe("50000000");
    expect(toUnits("0.000001", 6)).toBe("1");
    expect(toUnits("20.5", 24)).toBe((205n * 10n ** 23n).toString());
    expect(toUnits("0", 6)).toBe("0");
    for (const bad of ["", "-1", "1e3", "1.0000001", "1,5", "abc"]) expect(toUnits(bad, 6)).toBeNull();
    expect(fmtUnits("1000000000", 6)).toBe("1,000");
    expect(fmtUnits("16630006666666666666666667", 24)).toBe("16.630006");
    expect(fmtUnits("1", 6)).toBe("0.000001");
    expect(fmtUnits("0", 24)).toBe("0");
    for (const [text, shown] of [["12.5", "12.5"], ["0.000001", "0.000001"], ["999999", "999,999"], ["1234567.25", "1,234,567.25"]] as const) expect(fmtUnits(toUnits(text, 6) ?? "", 6)).toBe(shown);
    expect(panicText('{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: per-order cap exceeded"}}}}')).toBe("per-order cap exceeded");
    expect(panicText("Transaction expired")).toBe("Transaction expired");
  }));

  // gate: LAB
  it("runs the whole workflow from the page, and shows what the lab's API reports", () => evidence.check("browser-workflow", async () => {
    await page.goto(`${lab.server.origin}/`);
    expect(await page.locator("#lab-label").innerText()).toBe(LAB_LABEL);
    expect(await page.locator("#act-grant").isDisabled()).toBe(true);
    await page.click("#session-start");
    await status("Your sandbox treasury is ready");
    expect(await stateText()).toContain("1,000 USDC · 300 wNEAR");

    await page.click("#act-grant");
    await status("Grant active; its key is registered on the verifier.");
    expect((await view(lab, await sessionId())).state.grant?.policy).toEqual(LAB_POLICY);

    await page.click("#preset-permitted");
    await status("Order 0 signed by the contract");
    await page.locator("#orders tr", { hasText: "signed" }).getByRole("button", { name: "Fill" }).click();
    await status("Filler: filled. Order 0 is released (settled).");

    await page.click("#preset-unsafe-size");
    await status("per-order cap exceeded");
    expect(await page.locator("#lab-status").innerText()).toMatch(/^Refused by mandate\.\S+: per-order cap exceeded$/);
    await page.click("#preset-unsafe-price");
    await status("concession above policy maximum");

    await page.click("#preset-poor");
    await status("Order 1 signed by the contract");
    await page.locator("#orders tr", { hasText: "signed" }).getByRole("button", { name: "Fill" }).click();
    await status("Filler: filled. Order 1 is released (settled).");

    // A custom trade, withheld across the revocation.
    await page.fill("#prop-amount", "20");
    await page.selectOption("#prop-sell", "wnear");
    await page.fill("#prop-concession", "30");
    await page.click("#act-propose");
    await status("Order 2 signed by the contract: sells 20 wNEAR");
    await page.locator("#orders tr", { hasText: "signed" }).getByRole("button", { name: "Withhold" }).click();
    await status("Order withheld. The verifier's dry run accepts the bundle");
    await page.click("#act-revoke");
    await status("Grant revoked; its key is no longer registered on the verifier.");
    await page.locator("#orders tr", { hasText: "withheld" }).getByRole("button", { name: "Relay withheld" }).click();
    await status("Rejected by the verifier before the order's deadline: public key");

    await page.click("#doubles summary");
    await page.click("#act-oracle-off");
    await status("Done.");
    await page.click("#act-signer-off");
    await page.locator("#state", { hasText: "failing (immediate_error)" }).waitFor({ timeout: 60_000 });
    await page.click("#act-recover");
    await status("Recovered to the owner's Intents account:");

    const recorded = await log();
    expect(recorded.map((r) => r.action)).toEqual(["grant", "propose", "fill", "propose", "propose", "propose", "fill", "propose", "withhold", "revoke", "relay", "set_oracle", "set_signer", "recover"]);
    expect(recorded.map((r) => r.input).filter((_, i) => [1, 3, 4, 5].includes(i))).toEqual([
      { sell: "usdc", sell_amount: "50000000", max_concession_bps: 20 },
      { sell: "usdc", sell_amount: "600000000", max_concession_bps: 20 },
      { sell: "usdc", sell_amount: "50000000", max_concession_bps: 500 },
      { sell: "usdc", sell_amount: "50000000", max_concession_bps: LAB_POLICY.max_concession_bps },
    ]);
    expect(recorded[7]?.input).toEqual({ sell: "wnear", sell_amount: (20n * 10n ** 24n).toString(), max_concession_bps: 30 });
    // The page shows the chain state the API reports, and every transaction hash of the log.
    const final = (await view(lab, await sessionId())).state;
    const shown = await stateText();
    expect(final.balances.mandate).toEqual({ usdc: "0", wnear: "0" });
    expect(shown).toContain("0 USDC · 0 wNEAR");
    expect(shown).toContain(`${fmtUnits(final.balances.owner_intents.usdc, 6)} USDC · ${fmtUnits(final.balances.owner_intents.wnear, 24)} wNEAR`);
    expect(shown).toContain("revoked · epoch 1");
    expect(shown).toContain(final.accounts.mandate);
    expect(await page.locator("#log article.rec").count()).toBe(recorded.length);
    const logText = await page.locator("#log").innerText();
    const hashes = recorded.flatMap((r) => r.transactions.map((t) => t.tx_hash ?? ""));
    expect(hashes.length).toBeGreaterThan(recorded.length);
    for (const hash of hashes) expect(logText).toContain(hash);
  }), 300_000);

  // gate: LAB
  it("runs a comparison, exports the scenario, resets and survives a reload", () => evidence.check("comparison-export-reset-reload", async () => {
    await page.click("#tab-compare");
    expect(await page.locator("#panel-operate").isHidden()).toBe(true);
    await page.click("#alt-remove_fresh_key");
    await status("Remove the key, resume with a fresh key: 0 of 3 withheld orders still executed", 120_000);
    const comparison = (await log()).at(-1)?.result.comparison as { orders: { label: string; executed_after_action: boolean }[]; other_relays: { executed_after_action: boolean }[] };
    expect(comparison.orders.map((o) => o.executed_after_action)).toEqual([false, false, false]);
    const rows = page.locator("#compare-results table").first().locator("tbody tr");
    expect(await rows.count()).toBe(3);
    for (const [i, o] of comparison.orders.entries()) {
      const row = await rows.nth(i).innerText();
      expect(row).toContain(o.label);
      expect(row).toContain("did not execute");
    }
    // The order signed with the fresh key executed; the page shows that too.
    expect(comparison.other_relays.some((o) => o.executed_after_action)).toBe(true);
    expect(await page.locator("#compare-results").innerText()).toContain("EXECUTED");

    await page.click("#session-export");
    await status("Scenario exported below");
    const scenario = Scenario.parse(JSON.parse(await page.inputValue("#export-text")));
    expect(scenario.actions.map((a) => a.action)).toEqual((await log()).map((r) => r.action));
    expect(scenario.source).toEqual(lab.lab.source);
    expect(await page.locator("#export-link").getAttribute("href")).toMatch(/^data:application\/json;charset=utf-8,%7B/);

    await page.click("#tab-operate");
    const id = await sessionId();
    await page.reload();
    await status("Reconnected to your session.");
    expect(await sessionId()).toBe(id);
    expect(await page.locator("#log article.rec").count()).toBe((await log()).length);
    expect(await stateText()).toContain("revoked · epoch 1");

    await page.click("#session-reset");
    await status("Reset: a new treasury with the starting balances and no grant.", 120_000);
    expect(await page.locator("#log article.rec").count()).toBe(0);
    expect(await stateText()).toContain("none yet");
    expect(await stateText()).toContain("1,000 USDC · 300 wNEAR");
    await page.click("#session-end");
    await status("Session ended; its sandbox world is gone.");
    expect(lab.lab.stats().sessions).toBe(0);
    expect(await page.locator("#act-grant").isDisabled()).toBe(true);
  }), 300_000);

  // gate: LAB
  it("made requests to the serving lab only, with no page or CSP error", () => evidence.check("same-origin-no-errors", () => {
    expect(requests.length).toBeGreaterThan(20);
    for (const url of requests) expect(url.startsWith(`${lab.server.origin}/`), url).toBe(true);
    expect(errors).toEqual([]);
  }));
});
