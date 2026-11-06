// gate: AGENT — the runner's remaining per-order and cumulative sale budgets reach the snapshot, the prompt bytes
// and the objective guard. A proposal above either is rejected, never clipped; a partial rebalance within the tighter
// cap is valid. Every provider answer here is SYNTHETIC (written by the test), never model output.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRecording as loadLiveRecording, replayRecording, toRecording, writeRecording } from "../src/agent/live-recording.js";
import { allocation, assess, decideRebalance, inputsFrom, objectiveProblems, type FreshObservations, type RebalanceInputs } from "../src/agent/objective.js";
import { BUDGETED_PROMPT_VERSION, BUDGETED_SYSTEM_PROMPT, PROMPT_VERSION, SYSTEM_PROMPT, buildPrompt } from "../src/agent/prompt.js";
import { demoSnapshot, recordingPath } from "../src/agent/record.js";
import { loadRecording } from "../src/agent/recording.js";
import { remainingSaleBudget, type SaleBudget } from "../src/agent/snapshot.js";
import { CaseRecorder, REPO_ROOT } from "../src/evidence/report.js";
import type { Asset } from "../src/types.js";
import { DECIMALS, DECLINE_JSON, ONE_USD_PRICE, SyntheticProvider, USDC, WNEAR, grantFor, priceObs, proposeJson, saleBudget } from "./agent-live-helpers.js";

// AGENT.budget-bounds passes only if every check below ran and passed (src/evidence/report.ts).
const evidence = new CaseRecorder("AGENT", "budget-bounds", [
  "per-order-boundary",
  "cumulative-boundary",
  "partial-within-tighter-cap",
  "rejected-not-clipped",
  "integer-units",
  "budgets-in-prompt-bytes",
  "remaining-from-caps",
  "replay-and-pre-signing-recheck",
  "recorded-fixtures-unchanged",
]);

afterAll(() => {
  evidence.write("unit", {}, { note: "TypeScript unit test of the agent objective guard and prompt; no VM, chain or model" });
});

const NOTES = ["synthetic market note"];
const prices = { usdc: priceObs("usdc", ONE_USD_PRICE), wnear: priceObs("wnear", 3n * ONE_USD_PRICE) };
const inputsWith = (balances: Record<Asset, bigint>, budget: SaleBudget | null): RebalanceInputs => ({
  grant: grantFor(balances, prices),
  prices,
  decimals: DECIMALS,
  balances,
  sale_budget: budget,
});
// $1000 USDC vs $600 wNEAR: 50/50 needs 200 USDC sold; the grant's per-order cap is 20% of $1600 = $320.
const USDC_HEAVY = { usdc: 1_000n * USDC, wnear: 200n * WNEAR };
// $200 USDC vs $1200 wNEAR: 50/50 needs 166.66.. wNEAR; the grant's per-order cap is 20% of $1400 = $280 (93.33 wNEAR).
const WNEAR_HEAVY = { usdc: 200n * USDC, wnear: 400n * WNEAR };
const NONE: [bigint, bigint] = [0n, 0n];

const run = (budget: SaleBudget | null, answer: string, balances = USDC_HEAVY) => decideRebalance(new SyntheticProvider(answer), inputsWith(balances, budget), NOTES);
const perOrderMsg = (asset: Asset, units: bigint, cap: bigint) => `sells ${units} units of ${asset}, above the runner's per-order sale budget ${cap}`;
const cumulativeMsg = (asset: Asset, units: bigint, cap: bigint) => `sells ${units} units of ${asset}, above the runner's remaining cumulative sale budget ${cap}`;

describe("runner sale budgets in the objective guard (synthetic answers)", () => {
  // gate: AGENT
  it("per-order budget: exactly at it is accepted, one unit over is rejected", () =>
    evidence.check("per-order-boundary", async () => {
      const budget = saleBudget([50n * USDC, 120n * USDC], NONE);
      const at = await run(budget, proposeJson("usdc", 50n * USDC));
      expect(at.verdict).toEqual({ kind: "proposal", proposal: { sell: "usdc", sell_amount: (50n * USDC).toString(), max_concession_bps: 30 }, reason: "synthetic rebalance" });
      const over = await run(budget, proposeJson("usdc", 50n * USDC + 1n));
      expect(over.verdict).toEqual({ kind: "rejected", boundary: "objective", problems: [perOrderMsg("usdc", 50n * USDC + 1n, 50n * USDC)] });
    }));

  // gate: AGENT
  it("cumulative budget: exactly at it is accepted, one unit over is rejected", () =>
    evidence.check("cumulative-boundary", async () => {
      const budget = saleBudget([150n * USDC, 80n * USDC], NONE);
      expect((await run(budget, proposeJson("usdc", 80n * USDC))).verdict.kind).toBe("proposal");
      const over = await run(budget, proposeJson("usdc", 80n * USDC + 1n));
      expect(over.verdict).toEqual({ kind: "rejected", boundary: "objective", problems: [cumulativeMsg("usdc", 80n * USDC + 1n, 80n * USDC)] });
      // Both exceeded: both reported.
      const both = await run(saleBudget([50n * USDC, 40n * USDC], NONE), proposeJson("usdc", 60n * USDC));
      expect(both.verdict).toEqual({ kind: "rejected", boundary: "objective", problems: [perOrderMsg("usdc", 60n * USDC, 50n * USDC), cumulativeMsg("usdc", 60n * USDC, 40n * USDC)] });
      // Nothing left to sell: any sale is rejected; a decline stays a legitimate no-action.
      const empty = saleBudget([100n * USDC, 0n], NONE);
      expect((await run(empty, proposeJson("usdc", 1n))).verdict).toMatchObject({ kind: "rejected", boundary: "objective" });
      expect((await run(empty, DECLINE_JSON)).verdict).toEqual({ kind: "no-action", reason: "model-declined", detail: "synthetic decline" });
    }));

  // gate: AGENT
  it("a partial rebalance within the tighter cap is valid; a looser budget leaves the objective's own bound", () =>
    evidence.check("partial-within-tighter-cap", async () => {
      const alloc = allocation(inputsWith(USDC_HEAVY, null));
      expect(alloc.needed_units).toBe((200n * USDC).toString());
      // Tighter cap 50 USDC, a quarter of the 200 USDC needed: still a useful sale toward 50/50.
      const partial = await run(saleBudget([50n * USDC, 120n * USDC], NONE), proposeJson("usdc", 50n * USDC));
      expect(partial.verdict.kind).toBe("proposal");
      // The other asset's budget does not constrain this sale.
      expect((await run(saleBudget([50n * USDC, 120n * USDC], [0n, 0n]), proposeJson("usdc", 30n * USDC))).verdict.kind).toBe("proposal");
      // With a budget looser than the need, the needed + 1% + 1 unit bound still applies, unchanged.
      const loose = saleBudget([1_000n * USDC, 1_000n * USDC], NONE);
      expect((await run(loose, proposeJson("usdc", 202n * USDC + 1n))).verdict.kind).toBe("proposal");
      const tooMuch = await run(loose, proposeJson("usdc", 202n * USDC + 2n));
      expect(tooMuch.verdict).toMatchObject({ kind: "rejected", boundary: "objective" });
      expect(JSON.stringify(tooMuch.verdict)).toMatch(/more than the 200000000 needed/);
      // Within the band nothing is asked, budget or not.
      const p = new SyntheticProvider(proposeJson("usdc", USDC));
      const balanced = await decideRebalance(p, inputsWith({ usdc: 520n * USDC, wnear: 160n * WNEAR }, loose), NOTES);
      expect(balanced.verdict).toMatchObject({ kind: "no-action", reason: "balanced" });
      expect(p.calls).toBe(0);
    }));

  // gate: AGENT
  it("an over-budget proposal is rejected with its amount intact, never reduced to fit", () =>
    evidence.check("rejected-not-clipped", async () => {
      const over = 50n * USDC + 1n;
      const d = await run(saleBudget([50n * USDC, 120n * USDC], NONE), proposeJson("usdc", over));
      expect(d.verdict.kind).toBe("rejected");
      expect("proposal" in d.verdict).toBe(false);
      expect(d.adapter).toEqual({ kind: "proposal", proposal: { sell: "usdc", sell_amount: over.toString(), max_concession_bps: 30 }, reason: "synthetic rebalance" });
      expect(JSON.stringify(d.verdict)).not.toContain(`"sell_amount":"${(50n * USDC).toString()}"`);
    }));

  // gate: AGENT
  it("compares 24-decimal wNEAR budgets exactly (beyond 2^53)", () =>
    evidence.check("integer-units", async () => {
      const cap = 50n * WNEAR + 1n;
      const budget = saleBudget(NONE, [cap, 10n ** 30n]);
      expect((await run(budget, proposeJson("wnear", cap), WNEAR_HEAVY)).verdict.kind).toBe("proposal");
      const over = await run(budget, proposeJson("wnear", cap + 1n), WNEAR_HEAVY);
      expect(over.verdict).toEqual({ kind: "rejected", boundary: "objective", problems: [perOrderMsg("wnear", cap + 1n, cap)] });
    }));
});

describe("budgets in the snapshot and prompt", () => {
  // gate: AGENT
  it("the prompt bytes carry both budgets and the tighter cap; the hash binds them", () =>
    evidence.check("budgets-in-prompt-bytes", () => {
      const budget = saleBudget([50n * USDC, 120n * USDC], [10n * WNEAR, 5n * WNEAR]);
      const a = assess(inputsWith(USDC_HEAVY, budget), NOTES);
      if (a.kind !== "ask") throw new Error("expected a model call");
      expect(a.prompt.version).toBe(BUDGETED_PROMPT_VERSION);
      expect(a.prompt.system).toBe(BUDGETED_SYSTEM_PROMPT);
      expect(a.prompt.system).toMatch(/per_order_units/);
      expect(a.prompt.system).toMatch(/cumulative_remaining_units/);
      expect(a.prompt.system).toMatch(/rejected, never reduced/);
      const prefix = "Current mandate snapshot (JSON):\n";
      const suffix = "\n\nDecide now.";
      expect(a.prompt.user.startsWith(prefix) && a.prompt.user.endsWith(suffix)).toBe(true);
      const shown = (JSON.parse(a.prompt.user.slice(prefix.length, -suffix.length)) as { runner_sale_budget: unknown }).runner_sale_budget;
      expect(shown).toEqual({
        usdc: { per_order_units: "50000000", cumulative_remaining_units: "120000000", max_sale_units: "50000000" },
        wnear: { per_order_units: (10n * WNEAR).toString(), cumulative_remaining_units: (5n * WNEAR).toString(), max_sale_units: (5n * WNEAR).toString() },
      });
      // One unit of cumulative budget changes the prompt hash.
      const b = assess(inputsWith(USDC_HEAVY, saleBudget([50n * USDC, 120n * USDC - 1n], [10n * WNEAR, 5n * WNEAR])), NOTES);
      if (b.kind !== "ask") throw new Error("expected a model call");
      expect(b.prompt.sha256).not.toBe(a.prompt.sha256);
      // Without a runner budget the v1 prompt is built, byte for byte as before.
      const plain = assess(inputsWith(USDC_HEAVY, null), NOTES);
      if (plain.kind !== "ask") throw new Error("expected a model call");
      expect(plain.prompt.version).toBe(PROMPT_VERSION);
      expect(plain.prompt.system).toBe(SYSTEM_PROMPT);
      expect(plain.prompt.user).not.toContain("runner_sale_budget");
    }));

  // gate: AGENT
  it("derives the remaining budget from the runner's caps and units already charged", () =>
    evidence.check("remaining-from-caps", () => {
      const caps = { max_order_sell: { usdc: "1000000", wnear: "250000000000000000000000" }, max_total_sell: { usdc: "2000000", wnear: "1000000000000000000000000" } };
      expect(remainingSaleBudget(caps, { usdc: 1_500_000n, wnear: 0n })).toEqual({
        usdc: { per_order_units: "1000000", cumulative_remaining_units: "500000" },
        wnear: { per_order_units: "250000000000000000000000", cumulative_remaining_units: "1000000000000000000000000" },
      });
      // Charged beyond the cap (conservative counting) leaves zero, never a negative budget.
      expect(remainingSaleBudget(caps, { usdc: 2_000_001n, wnear: 10n ** 24n }).usdc.cumulative_remaining_units).toBe("0");
      expect(remainingSaleBudget(caps, { usdc: 2_000_001n, wnear: 10n ** 24n }).wnear.cumulative_remaining_units).toBe("0");
    }));
});

describe("budgets survive recording, replay and the pre-signing recheck", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const reading = (asset: Asset, mantissa: bigint) => ({ price_id: prices[asset].price_id, max_age_sec: 60, price: mantissa.toString(), conf: "1000", expo: -8, publish_time: 1_000, age_sec: 10 });
  const observations: FreshObservations = {
    block: { height: 42, hash: "synthetic-block", timestamp_ns: "1010000000000" },
    grant: grantFor(USDC_HEAVY, prices),
    balances: { usdc: USDC_HEAVY.usdc.toString(), wnear: USDC_HEAVY.wnear.toString() },
    prices: { usdc: reading("usdc", ONE_USD_PRICE), wnear: reading("wnear", 3n * ONE_USD_PRICE) },
    read_errors: [],
  };

  // gate: AGENT
  it("a recorded budgeted decision replays to the same verdict; a budget spent since the decision fails the recheck", () =>
    evidence.check("replay-and-pre-signing-recheck", async () => {
      const budget = saleBudget([50n * USDC, 120n * USDC], NONE);
      const usable = inputsFrom(observations, DECIMALS, budget);
      if (!usable.ok) throw new Error(usable.problems.join());
      expect(usable.inputs.sale_budget).toEqual(budget);
      for (const units of [50n * USDC, 50n * USDC + 1n]) {
        const d = await decideRebalance(new SyntheticProvider(proposeJson("usdc", units)), usable.inputs, NOTES);
        const dir = mkdtempSync(join(tmpdir(), "bm-budget-rec-"));
        dirs.push(dir);
        const written = writeRecording(dir, toRecording({ step: 0, requestSeq: 1, provider: "synthetic", requestedModel: null, observations, decimals: DECIMALS, notes: NOTES, requestBody: null }, d));
        const rec = loadLiveRecording(dir, written.file, written.sha256);
        expect(rec.prompt.version).toBe(BUDGETED_PROMPT_VERSION);
        const replayed = await replayRecording(rec);
        expect(replayed.verdict).toEqual(d.verdict);
        expect(d.verdict.kind).toBe(units === 50n * USDC ? "proposal" : "rejected");
      }
      // The live pre-signing recheck runs objectiveProblems on fresh inputs; 100 USDC charged since leaves 20 USDC.
      const later = inputsFrom(observations, DECIMALS, saleBudget([50n * USDC, 20n * USDC], NONE));
      if (!later.ok) throw new Error(later.problems.join());
      const proposal = { sell: "usdc" as const, sell_amount: (50n * USDC).toString(), max_concession_bps: 30 };
      expect(objectiveProblems(later.inputs, allocation(later.inputs), proposal)).toEqual([cumulativeMsg("usdc", 50n * USDC, 20n * USDC)]);
    }));

  // gate: AGENT
  it("the recorded genuine fixtures still load and still match the v1 prompt built from their snapshots", () =>
    evidence.check("recorded-fixtures-unchanged", () => {
      for (const variant of ["normal", "injection"] as const) {
        // loadRecording checks the file hash against fixtures/manifest.json and rebuilds the prompt.
        const rec = loadRecording(REPO_ROOT, recordingPath(variant));
        expect(rec.interaction.prompt.version).toBe(PROMPT_VERSION);
        expect(buildPrompt(demoSnapshot(variant)).sha256).toBe(rec.interaction.prompt.sha256);
      }
    }));
});
