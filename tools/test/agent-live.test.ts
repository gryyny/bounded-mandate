// Live agent decision without chain, funds or credentials: the 50/50 objective guard at current prices, input
// freshness, the NEAR AI Cloud provider against a mocked fetch, and recording replay. Every provider answer here
// is SYNTHETIC (written by the test), never model output.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DECISION_JSON_SCHEMA } from "../src/agent/decision.js";
import { loadRecording, replayRecording, toRecording, writeRecording } from "../src/agent/live-recording.js";
import { NEAR_AI_API_KEY_ENV, NearAiProvider, parseNearAiResponse } from "../src/agent/providers.js";
import { allocation, assess, decideRebalance, inputsFrom, priceMarginProblems, type FreshObservations, type RebalanceInputs } from "../src/agent/rebalance.js";
import { valueUnits } from "../src/agent/snapshot.js";
import { DEMO_POLICY, PRICE_IDS } from "../src/demo/market.js";
import { ModelSource } from "../src/live/manifest.js";
import type { Asset, GrantView, PriceObservation } from "../src/types.js";
import { DECLINE_JSON, SyntheticProvider, proposeJson } from "./agent-live-helpers.js";

const USDC = 10n ** 6n;
const WNEAR = 10n ** 24n;
const DECIMALS = { usdc: 6, wnear: 24 };
const usd = (dollars: bigint): bigint => dollars * 10n ** 12n;

const price = (asset: Asset, mantissa: bigint, conf = 0n): PriceObservation => ({ price_id: PRICE_IDS[asset], price: mantissa.toString(), conf: conf.toString(), expo: -8, publish_time_sec: "1000" });
const ONE = 100_000_000n;
const prices = (usdc: bigint, wnear: bigint) => ({ usdc: price("usdc", usdc), wnear: price("wnear", wnear) });

/** A grant whose initial value is the balances at the `initial` prices (setup arithmetic, not an expectation). */
function inputs(balances: Record<Asset, bigint>, current: Record<Asset, PriceObservation>, initial = current, over: Partial<GrantView> = {}): RebalanceInputs {
  const initialValue = valueUnits(balances.usdc, 6, initial.usdc) + valueUnits(balances.wnear, 24, initial.wnear);
  const grant: GrantView = {
    epoch: 1,
    path: "mandate/v1/1",
    public_key: "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct",
    status: "active",
    policy: DEMO_POLICY,
    initial_reference: { ...initial, observed_at_ns: "0" },
    initial_value: initialValue.toString(),
    turnover_used: "0",
    outstanding: "0",
    breaker: null,
    key_op_in_flight: false,
    ...over,
  };
  return { grant, prices: current, decimals: DECIMALS, balances };
}

const NOTES = ["synthetic market note"];
const decide = (provider: SyntheticProvider, i: RebalanceInputs) => decideRebalance(provider, i, NOTES);

describe("objective guard at current prices (synthetic provider answers)", () => {
  // 1000 USDC + 200 wNEAR at $1 / $3: $1000 vs $600, 62.5% USDC; selling $200 = 200 USDC reaches 50/50.
  const usdcHeavy = () => inputs({ usdc: 1_000n * USDC, wnear: 200n * WNEAR }, prices(ONE, 3n * ONE));
  // 200 USDC + 400 wNEAR: $200 vs $1200; 50/50 needs $500 of wNEAR = 166.66.. wNEAR; per-order cap 20% of $1400 = $280.
  const wnearHeavy = () => inputs({ usdc: 200n * USDC, wnear: 400n * WNEAR }, prices(ONE, 3n * ONE));

  it("a balanced portfolio is a no-action without a model call; the band is 2 percentage points inclusive", async () => {
    const p = new SyntheticProvider(proposeJson("usdc", USDC));
    // 520 USDC vs 160 wNEAR x $3 = $480: exactly 52.00% USDC.
    const edge = await decide(p, inputs({ usdc: 520n * USDC, wnear: 160n * WNEAR }, prices(ONE, 3n * ONE)));
    expect(edge.verdict).toMatchObject({ kind: "no-action", reason: "balanced" });
    expect(edge.result).toBeNull();
    expect(p.calls).toBe(0);
    // $521 vs $479: 52.1% USDC, outside the band; the model is asked once.
    const outside = await decide(p, inputs({ usdc: 521n * USDC, wnear: 479n * WNEAR / 3n }, prices(ONE, 3n * ONE)));
    expect(outside.assessment.kind).toBe("ask");
    expect(p.calls).toBe(1);
  });

  it("USDC-heavy: accepts a USDC sale up to the needed amount plus 1% and one unit", async () => {
    const a = allocation(usdcHeavy());
    expect(a).toMatchObject({ balanced: false, overweight: "usdc", usdc_share_bps: "6250", needed_units: (200n * USDC).toString(), max_units: (202n * USDC + 1n).toString() });
    for (const units of [200n * USDC, 202n * USDC + 1n]) {
      const d = await decide(new SyntheticProvider(proposeJson("usdc", units)), usdcHeavy());
      expect(d.verdict).toEqual({ kind: "proposal", proposal: { sell: "usdc", sell_amount: units.toString(), max_concession_bps: 30 }, reason: "synthetic rebalance" });
    }
  });

  it("wNEAR-heavy: accepts a wNEAR sale within the per-order cap; refuses one above it", async () => {
    expect(allocation(wnearHeavy())).toMatchObject({ overweight: "wnear", needed_units: "166666666666666666666666666" });
    expect((await decide(new SyntheticProvider(proposeJson("wnear", 90n * WNEAR)), wnearHeavy())).verdict.kind).toBe("proposal");
    const over = await decide(new SyntheticProvider(proposeJson("wnear", 100n * WNEAR)), wnearHeavy());
    expect(over.verdict).toMatchObject({ kind: "rejected", boundary: "objective" });
    expect(JSON.stringify(over.verdict)).toMatch(/above the per-order cap 280 USD/);
  });

  it.each([
    ["wrong direction (USDC-heavy, sells wNEAR)", () => usdcHeavy(), proposeJson("wnear", 10n * WNEAR), /sells wnear, but usdc is overweight/],
    ["wrong direction (wNEAR-heavy, sells USDC)", () => wnearHeavy(), proposeJson("usdc", 10n * USDC), /sells usdc, but wnear is overweight/],
    ["more than needed to reach 50/50", () => usdcHeavy(), proposeJson("usdc", 202n * USDC + 2n), /more than the 200000000 needed/],
    ["a zero amount", () => usdcHeavy(), proposeJson("usdc", 0n), /sell_amount is zero/],
    ["a concession above the grant's", () => usdcHeavy(), proposeJson("usdc", 100n * USDC, 51), /concession 51 bps above the grant's 50/],
    ["more than the remaining outstanding capacity", () => ({ ...usdcHeavy(), grant: { ...usdcHeavy().grant, outstanding: usd(250n).toString() } }), proposeJson("usdc", 100n * USDC), /remaining outstanding capacity 70 USD/],
    // Turnover cap 100% of $1600; $1590 used + 50 USDC = $1640.
    ["more than the remaining turnover", () => ({ ...usdcHeavy(), grant: { ...usdcHeavy().grant, turnover_used: usd(1_590n).toString() } }), proposeJson("usdc", 50n * USDC), /turnover would reach 1640 USD, above the cap 1600 USD/],
    // A 1 USDC order is still charged the proposal floor, 0.5% of $1600 = $8: $1595 + $8 > $1600.
    ["a tiny order charged the proposal floor beyond the turnover cap", () => ({ ...usdcHeavy(), grant: { ...usdcHeavy().grant, turnover_used: usd(1_595n).toString() } }), proposeJson("usdc", USDC), /turnover would reach 1603 USD/],
    // Breaker at 2% drawdown of $1600: $1568. Holdings now 1000 USDC + 200 wNEAR at $2.84 = $1568.
    ["holdings at the loss-breaker threshold", () => inputs({ usdc: 1_000n * USDC, wnear: 200n * WNEAR }, prices(ONE, 284_000_000n), prices(ONE, 3n * ONE)), proposeJson("usdc", 100n * USDC), /holdings 1568 USD at or below the loss-breaker threshold 1568 USD/],
  ])("sends nothing for %s", async (_name, make, answer, re) => {
    const d = await decide(new SyntheticProvider(answer), make());
    expect(d.verdict.kind).toBe("rejected");
    expect(d.verdict).toMatchObject({ boundary: "objective" });
    expect(JSON.stringify(d.verdict)).toMatch(re);
  });

  it("uses current oracle prices, not the grant's initial reference", async () => {
    // Initial wNEAR $3, current $4. 1000 USDC + 250 wNEAR: $1000 vs $750 at the initial price (57%), $1000 vs $1000 now.
    const p = new SyntheticProvider(proposeJson("usdc", USDC));
    const now = await decide(p, inputs({ usdc: 1_000n * USDC, wnear: 250n * WNEAR }, prices(ONE, 4n * ONE), prices(ONE, 3n * ONE)));
    expect(now.verdict).toMatchObject({ kind: "no-action", reason: "balanced" });
    expect(p.calls).toBe(0);
    // 1000 USDC + 200 wNEAR: $800 of wNEAR now; the model sees $4 and needs 100 USDC.
    const a = assess(inputs({ usdc: 1_000n * USDC, wnear: 200n * WNEAR }, prices(ONE, 4n * ONE), prices(ONE, 3n * ONE)), NOTES);
    if (a.kind !== "ask") throw new Error("expected a model call");
    expect(a.snapshot.assets.wnear.price_usd).toBe("4");
    expect(a.prompt.user).toContain('"price_usd": "4"');
    expect(a.allocation.needed_units).toBe((100n * USDC).toString());
  });

  it("a model decline is a legitimate no-action", async () => {
    expect((await decide(new SyntheticProvider(DECLINE_JSON), usdcHeavy())).verdict).toEqual({ kind: "no-action", reason: "model-declined", detail: "synthetic decline" });
  });

  it.each([
    ["invalid JSON", "propose usdc 1"],
    ["text around the JSON", `${proposeJson("usdc", USDC)} done`],
    ["an extra authority field in the proposal", JSON.stringify({ action: "propose", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 1, recipient: "evil.near" }, reason: "x" })],
    ["an extra top-level field", JSON.stringify({ action: "propose", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 1 }, reason: "x", withdraw_to: "evil.near" })],
    ["an unknown action", JSON.stringify({ action: "withdraw", proposal: null, reason: "x" })],
  ])("rejects %s at the adapter schema and sends nothing", async (_name, text) => {
    expect((await decide(new SyntheticProvider(text), usdcHeavy())).verdict).toMatchObject({ kind: "rejected", boundary: "adapter-schema" });
  });

  it("a provider error is recorded as a provider rejection", async () => {
    const d = await decide(new SyntheticProvider(new Error("synthetic outage")), usdcHeavy());
    expect(d.verdict).toEqual({ kind: "rejected", boundary: "provider", problems: ["synthetic outage"] });
  });
});

describe("fresh inputs", () => {
  const reading = (asset: Asset, over: Partial<NonNullable<FreshObservations["prices"]["usdc"]>> = {}) => ({ price_id: PRICE_IDS[asset], max_age_sec: 60, price: (asset === "usdc" ? ONE : 3n * ONE).toString(), conf: "1000", expo: -8, publish_time: 1_000, age_sec: 5, ...over });
  const obs = (over: Partial<FreshObservations> = {}): FreshObservations => ({
    block: { height: 10, hash: "h", timestamp_ns: "1005000000000" },
    grant: inputs({ usdc: USDC, wnear: WNEAR }, prices(ONE, 3n * ONE)).grant,
    balances: { usdc: "1000000", wnear: WNEAR.toString() },
    prices: { usdc: reading("usdc"), wnear: reading("wnear") },
    read_errors: [],
    ...over,
  });

  it("requires each price to keep min_remaining_sec + 15 s of its maximum age before signing", () => {
    // DEMO_POLICY: oracle_max_age_sec 60, min_remaining_sec 15, so a price may be at most 30 s old.
    const at = (age: number) => obs({ prices: { usdc: reading("usdc", { age_sec: age }), wnear: reading("wnear") } });
    expect(priceMarginProblems(at(30), DEMO_POLICY)).toEqual([]);
    expect(priceMarginProblems(at(31), DEMO_POLICY)).toEqual(["usdc: price has 29 s of its 60 s maximum age left, below the 30 s margin (min_remaining_sec + 15)"]);
    expect(inputsFrom(at(31), DECIMALS).ok).toBe(true);
  });

  it("builds inputs from the read observations (current prices)", () => {
    const r = inputsFrom(obs(), DECIMALS);
    expect(r.ok && r.inputs.prices.wnear).toEqual({ price_id: PRICE_IDS.wnear, price: "300000000", conf: "1000", expo: -8, publish_time_sec: "1000" });
  });

  it.each([
    ["a stale price", obs({ prices: { usdc: reading("usdc"), wnear: reading("wnear", { age_sec: 61 }) } }), /wnear: price is 61 s old, above 60 s/],
    ["a missing price", obs({ prices: { usdc: null, wnear: reading("wnear") } }), /usdc: no oracle price within 60 s/],
    ["an unconfident price", obs({ prices: { usdc: reading("usdc", { conf: "600000" }), wnear: reading("wnear") } }), /usdc: confidence 600000 above 50 bps/],
    ["a non-positive price", obs({ prices: { usdc: reading("usdc", { price: "0" }), wnear: reading("wnear") } }), /usdc: invalid price/],
    ["a revoking grant", obs({ grant: { ...inputs({ usdc: USDC, wnear: WNEAR }, prices(ONE, 3n * ONE)).grant, status: "revoking" } }), /grant status revoking, not active/],
    ["no grant", obs({ grant: null }), /no grant/],
    ["a failed oracle read", obs({ read_errors: ["wnear oracle read failed: boom"], prices: { usdc: reading("usdc"), wnear: null } }), /oracle read failed/],
  ])("refuses %s", (_name, o, re) => {
    const r = inputsFrom(o, DECIMALS);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.problems.join("; ")).toMatch(re);
  });
});

describe("manifest model source", () => {
  it("live steps accept only near-ai, with an explicit model and bounds", () => {
    // anthropic and claude-cli serve fixture recording (tools/src/agent/record.ts) only.
    expect(ModelSource.safeParse({ from: "model", provider: "claude-cli", notes: [] }).success).toBe(false);
    expect(ModelSource.safeParse({ from: "model", provider: "anthropic", model: "m", timeout_ms: 30_000, max_tokens: 1_000, notes: [] }).success).toBe(false);
    expect(ModelSource.safeParse({ from: "model", provider: "near-ai", notes: [] }).success).toBe(false);
    expect(ModelSource.safeParse({ from: "model", provider: "near-ai", model: "m", timeout_ms: 30_000, notes: [] }).success).toBe(false);
    expect(ModelSource.safeParse({ from: "model", provider: "near-ai", model: "m", timeout_ms: 30_000, max_tokens: 1_000, notes: [] }).success).toBe(true);
    expect(ModelSource.safeParse({ from: "model", provider: "near-ai", model: "m", timeout_ms: 30_000, max_tokens: 1_000_000, notes: [] }).success).toBe(false);
    expect(ModelSource.safeParse({ from: "model", provider: "anthropic", timeout_ms: 30_000, notes: [] }).success).toBe(false);
    expect(ModelSource.safeParse({ from: "model", provider: "near-ai", model: "m", timeout_ms: 30_000, max_tokens: 1_000, notes: [], api_key: "x" }).success).toBe(false);
  });
});

describe("NEAR AI Cloud provider (mocked fetch, synthetic responses)", () => {
  const KEY = "sk-synthetic-test-key-0123456789";
  const OPTS = { model: "synthetic/model-id", timeoutMs: 5_000, maxTokens: 777 };
  const completion = (content: string | null, finish = "stop", over: Record<string, unknown> = {}) =>
    JSON.stringify({ id: "chatcmpl-synthetic", object: "chat.completion", model: "synthetic/model-id", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], ...over });
  interface Sent {
    url: string;
    init: RequestInit;
  }
  const mock = (status: number, body: string): { fetch: typeof fetch; sent: Sent[] } => {
    const sent: Sent[] = [];
    const f: typeof fetch = (url, init) => {
      sent.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
      return Promise.resolve(new Response(body, { status }));
    };
    return { fetch: f, sent };
  };
  const usdcHeavy = () => inputs({ usdc: 1_000n * USDC, wnear: 200n * WNEAR }, prices(ONE, 3n * ONE));
  const promptOf = () => {
    const a = assess(usdcHeavy(), NOTES);
    if (a.kind !== "ask") throw new Error("expected a model call");
    return a.prompt;
  };

  it("sends one bounded chat-completions request; the credential is only in the header and never recorded", async () => {
    const m = mock(200, completion(proposeJson("usdc", 150n * USDC)));
    const p = NearAiProvider.fromEnv({ [NEAR_AI_API_KEY_ENV]: KEY }, OPTS, m.fetch);
    const prompt = promptOf();
    const call = await p.decide(prompt);
    expect(m.sent.length).toBe(1);
    const [sent] = m.sent;
    expect(sent?.url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect(sent?.init.method).toBe("POST");
    expect(sent?.init.redirect).toBe("error");
    expect(sent?.init.signal).toBeInstanceOf(AbortSignal);
    expect(sent?.init.headers).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    const sentBody = sent?.init.body;
    if (typeof sentBody !== "string") throw new Error("request body is not a string");
    const body = JSON.parse(sentBody) as Record<string, unknown>;
    expect(body).toEqual({
      model: "synthetic/model-id",
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_tokens: 777,
      stream: false,
      response_format: { type: "json_schema", json_schema: { name: "mandate_decision", strict: true, schema: DECISION_JSON_SCHEMA } },
    });
    expect(call.request_body).toBe(sent?.init.body);
    expect(p.requestBody(prompt)).toBe(sent?.init.body);
    expect(call).toMatchObject({ provider: "near-ai", requested_model: "synthetic/model-id", model: "synthetic/model-id", decision_text: proposeJson("usdc", 150n * USDC) });
    expect(call.error).toBeUndefined();
    expect(JSON.stringify(call)).not.toContain(KEY);
    expect(JSON.stringify(p)).not.toContain(KEY);
  });

  it("refuses to start without the credential (no default, no fallback)", () => {
    expect(() => NearAiProvider.fromEnv({}, OPTS)).toThrow(/requires NEAR_AI_API_KEY/);
  });

  it.each([
    ["truncation (finish_reason length)", 200, completion('{"action":"propose","proposal":{"sell":"usdc"', "length"), /finish_reason length/],
    ["a content-filter stop", 200, completion(null, "content_filter"), /finish_reason content_filter/],
    ["tool calls", 200, JSON.stringify({ model: "synthetic/model-id", choices: [{ message: { content: null, tool_calls: [{ id: "t" }] }, finish_reason: "stop" }] }), /tool calls/],
    ["two choices", 200, JSON.stringify({ model: "synthetic/model-id", choices: [{ message: { content: "{}" }, finish_reason: "stop" }, { message: { content: "{}" }, finish_reason: "stop" }] }), /exactly one choice/],
    ["empty content", 200, completion("   "), /no content/],
    ["a different model than requested (fallback)", 200, completion(proposeJson("usdc", 150n * USDC), "stop", { model: "synthetic/other-model" }), /response reports model synthetic\/other-model, requested synthetic\/model-id/],
    ["an HTTP error", 402, JSON.stringify({ error: { message: "insufficient credits", type: "payment_required" } }), /HTTP 402: .*insufficient credits/],
    ["a non-JSON body", 200, "<html>gateway</html>", /unparseable response/],
  ])("produces no decision for %s; the guard sends nothing", async (_name, status, body, re) => {
    expect(parseNearAiResponse(status, body, OPTS.model).decision_text).toBeNull();
    const p = new NearAiProvider(OPTS, KEY, mock(status, body).fetch);
    const d = await decideRebalance(p, usdcHeavy(), NOTES);
    expect(d.verdict).toMatchObject({ kind: "rejected", boundary: "provider" });
    expect(JSON.stringify(d.verdict)).toMatch(re);
    expect(d.result?.call?.raw_output).toBe(body);
  });

  it("aborts after timeout_ms: one attempt, nothing sent to the chain", async () => {
    let attempts = 0;
    const hang: typeof fetch = (_url, init) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("synthetic abort"));
        });
      });
    };
    const d = await decideRebalance(new NearAiProvider({ ...OPTS, timeoutMs: 50 }, KEY, hang), usdcHeavy(), NOTES);
    expect(attempts).toBe(1);
    expect(d.verdict).toEqual({ kind: "rejected", boundary: "provider", problems: ["near-ai: no complete response within 50 ms (aborted)"] });
  });
});

describe("recorded live decisions replay without credentials or funds", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const KEY = "sk-synthetic-test-key-replay";
  const observations: FreshObservations = {
    block: { height: 42, hash: "synthetic-block", timestamp_ns: "1010000000000" },
    grant: inputs({ usdc: 1_000n * USDC, wnear: 200n * WNEAR }, prices(ONE, 3n * ONE)).grant,
    balances: { usdc: (1_000n * USDC).toString(), wnear: (200n * WNEAR).toString() },
    prices: {
      usdc: { price_id: PRICE_IDS.usdc, max_age_sec: 60, price: ONE.toString(), conf: "1000", expo: -8, publish_time: 1_000, age_sec: 10 },
      wnear: { price_id: PRICE_IDS.wnear, max_age_sec: 60, price: (3n * ONE).toString(), conf: "1000", expo: -8, publish_time: 1_000, age_sec: 10 },
    },
    read_errors: [],
  };

  const record = async (status: number, body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "bm-live-rec-"));
    dirs.push(dir);
    const usable = inputsFrom(observations, DECIMALS);
    if (!usable.ok) throw new Error(usable.problems.join());
    const f: typeof fetch = () => Promise.resolve(new Response(body, { status }));
    const p = new NearAiProvider({ model: "synthetic/model-id", timeoutMs: 5_000, maxTokens: 500 }, KEY, f);
    let requestBody: string | null = null;
    const d = await decideRebalance(p, usable.inputs, NOTES, (_prompt, b) => {
      requestBody = b;
    });
    const rec = toRecording({ step: 3, requestSeq: 9, provider: p.name, requestedModel: "synthetic/model-id", observations, decimals: DECIMALS, notes: NOTES, requestBody }, d);
    return { dir, d, written: writeRecording(dir, rec) };
  };

  it("replays an accepted proposal and a truncated answer to the same verdicts, and refuses a tampered file", async () => {
    const answer = JSON.stringify({ model: "synthetic/model-id", choices: [{ message: { content: proposeJson("usdc", 150n * USDC) }, finish_reason: "stop" }] });
    for (const [status, body] of [
      [200, answer],
      [200, JSON.stringify({ model: "synthetic/model-id", choices: [{ message: { content: "{" }, finish_reason: "length" }] })],
    ] as const) {
      const { dir, d, written } = await record(status, body);
      const text = readFileSync(join(dir, written.file), "utf8");
      expect(text).not.toContain(KEY);
      const rec = loadRecording(dir, written.file, written.sha256);
      expect(rec.request_body).toBe(d.result?.call?.request_body);
      expect(rec.raw_output).toBe(body);
      const replayed = await replayRecording(rec);
      expect(d.verdict.kind).toBe(body === answer ? "proposal" : "rejected");
      expect(replayed.verdict).toEqual(d.verdict);
      expect(replayed.result?.call?.provider).toBe("recorded");
      writeFileSync(join(dir, written.file), text.replace('"height": 42', '"height": 43'));
      expect(() => loadRecording(dir, written.file, written.sha256)).toThrow(/sha256/);
    }
  });

  it("replays a provider failure that produced no output to the same verdict", async () => {
    const usable = inputsFrom(observations, DECIMALS);
    if (!usable.ok) throw new Error(usable.problems.join());
    const d = await decideRebalance(new SyntheticProvider(new Error("synthetic timeout")), usable.inputs, NOTES);
    const dir = mkdtempSync(join(tmpdir(), "bm-live-rec-"));
    dirs.push(dir);
    const written = writeRecording(dir, toRecording({ step: 3, requestSeq: 9, provider: "synthetic", requestedModel: null, observations, decimals: DECIMALS, notes: NOTES, requestBody: null }, d));
    const rec = loadRecording(dir, written.file, written.sha256);
    expect(rec.raw_output).toBeNull();
    expect((await replayRecording(rec)).verdict).toEqual(d.verdict);
  });
});
