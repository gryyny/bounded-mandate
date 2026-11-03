import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judge } from "../src/agent/adapter.js";
import { DECISION_JSON_SCHEMA, sha256Hex, validateDecision } from "../src/agent/decision.js";
import { buildPrompt } from "../src/agent/prompt.js";
import { cliArgs, parseCliOutput } from "../src/agent/providers.js";
import { RecordedProvider, loadRecording, toInteraction } from "../src/agent/recording.js";
import { demoSnapshot } from "../src/agent/record.js";
import { formatPrice, formatUnits } from "../src/agent/snapshot.js";
import { Proposal } from "../src/types.js";

const good = { action: "propose", proposal: { sell: "usdc", sell_amount: "1000000", max_concession_bps: 10 }, reason: "rebalance" };

describe("adapter validation", () => {
  it("accepts exactly a Proposal or a decline", () => {
    expect(validateDecision(good)).toEqual({ kind: "proposal", proposal: good.proposal, reason: "rebalance" });
    expect(validateDecision({ action: "decline", proposal: null, reason: "balanced" })).toEqual({ kind: "decline", reason: "balanced" });
  });

  it.each([
    ["extra field in proposal", { ...good, proposal: { ...good.proposal, recipient: "evil.near" } }],
    ["extra top-level field", { ...good, recipient: "evil.near" }],
    ["unknown action", { ...good, action: "withdraw" }],
    ["decline carrying a proposal", { ...good, action: "decline" }],
    ["propose without proposal", { ...good, proposal: null }],
    ["forbidden asset", { ...good, proposal: { ...good.proposal, sell: "usdt" } }],
    ["token id as asset", { ...good, proposal: { ...good.proposal, sell: "nep141:wrap.near" } }],
    ["negative amount", { ...good, proposal: { ...good.proposal, sell_amount: "-1" } }],
    ["decimal amount", { ...good, proposal: { ...good.proposal, sell_amount: "1.5" } }],
    ["leading zero", { ...good, proposal: { ...good.proposal, sell_amount: "01" } }],
    ["numeric amount", { ...good, proposal: { ...good.proposal, sell_amount: 1000 } }],
    ["fractional concession", { ...good, proposal: { ...good.proposal, max_concession_bps: 1.5 } }],
    ["concession above u16", { ...good, proposal: { ...good.proposal, max_concession_bps: 65_536 } }],
  ])("rejects %s at the adapter schema", (_name, raw) => {
    const verdict = validateDecision(raw);
    expect(verdict.kind).toBe("rejected");
  });

  it("rejects non-JSON and missing output without repair", () => {
    expect(judge("propose usdc 1").kind).toBe("rejected");
    expect(judge(null).kind).toBe("rejected");
    expect(judge(`${JSON.stringify(good)} trailing`).kind).toBe("rejected");
  });

  it("gives the model a schema whose proposal fields are exactly types.Proposal", () => {
    const proposalSchema = DECISION_JSON_SCHEMA.properties.proposal.anyOf[0];
    expect(Object.keys(proposalSchema.properties).sort()).toEqual(Object.keys(Proposal.shape).sort());
    expect(proposalSchema.additionalProperties).toBe(false);
    expect(DECISION_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("snapshot and prompt", () => {
  it("formats exact decimals", () => {
    expect(formatUnits(1_000_000n, 6)).toBe("1");
    expect(formatUnits(1_500_001n, 6)).toBe("1.500001");
    expect(formatUnits(0n, 24)).toBe("0");
    expect(formatPrice({ price: "99980000", expo: -8 })).toBe("0.9998");
    expect(formatPrice({ price: "3", expo: 2 })).toBe("300");
  });

  it("builds a deterministic prompt whose hash covers system and user text", () => {
    const a = buildPrompt(demoSnapshot("normal"));
    const b = buildPrompt(demoSnapshot("normal"));
    expect(a).toEqual(b);
    expect(a.sha256).toBe(sha256Hex(JSON.stringify({ version: a.version, system: a.system, user: a.user })));
    const injected = buildPrompt(demoSnapshot("injection"));
    expect(injected.sha256).not.toBe(a.sha256);
    expect(injected.user).toContain("evil.near");
  });

  it("passes the decision schema and no tools to the CLI", () => {
    const args = cliArgs("haiku", "sys");
    expect(args[args.indexOf("--json-schema") + 1]).toBe(JSON.stringify(DECISION_JSON_SCHEMA));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--safe-mode");
  });

  it("parses CLI result envelopes (synthetic envelopes, not model output)", () => {
    expect(parseCliOutput(JSON.stringify({ type: "result", structured_output: good, modelUsage: { "m-1": {} } }))).toEqual({
      decision_text: JSON.stringify(good),
      model: "m-1",
    });
    expect(parseCliOutput(JSON.stringify({ type: "result", is_error: true, result: "auth failed", modelUsage: {} })).error).toBe("auth failed");
    expect(parseCliOutput("not json").decision_text).toBeNull();
  });
});

describe("recordings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Synthetic interaction used only to test the integrity checks; it is never presented as model output.
  const writeFixture = (mutate: (text: string) => string = (t) => t, list = true): { root: string; path: string } => {
    const root = mkdtempSync(join(tmpdir(), "bm-rec-"));
    dirs.push(root);
    mkdirSync(join(root, "fixtures/model"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/manifest.json"), "utf8")) as { files: Record<string, unknown> };
    const snapshot = demoSnapshot("normal");
    const prompt = buildPrompt(snapshot);
    const interaction = toInteraction("normal", snapshot, prompt, {
      provider: "claude-cli",
      requested_model: "test",
      model: "test",
      started_at: "t0",
      finished_at: "t1",
      raw_output: "{}",
      decision_text: JSON.stringify(good),
      harness_note: "synthetic test fixture",
    });
    const original = `${JSON.stringify(interaction, null, 2)}\n`;
    const path = join(root, "fixtures/model/normal.json");
    writeFileSync(path, mutate(original));
    if (list) manifest.files["model/normal.json"] = { sha256: sha256Hex(original), kind: "test", source: "test" };
    else delete manifest.files["model/normal.json"];
    writeFileSync(join(root, "fixtures/manifest.json"), JSON.stringify(manifest));
    return { root, path };
  };

  it("loads a listed, untampered recording and replays only for its exact prompt", async () => {
    const { root, path } = writeFixture();
    const rec = loadRecording(root, path);
    const provider = new RecordedProvider(rec);
    const call = await provider.decide(buildPrompt(demoSnapshot("normal")));
    expect(judge(call.decision_text).kind).toBe("proposal");
    await expect(provider.decide(buildPrompt(demoSnapshot("injection")))).rejects.toThrow(/differs from recorded prompt/);
  });

  it("rejects a tampered recording", () => {
    const { root, path } = writeFixture((t) => t.replace('"usdc"', '"wnear"'));
    expect(() => loadRecording(root, path)).toThrow(/sha256/);
  });

  it("rejects an unlisted recording", () => {
    const { root, path } = writeFixture((t) => t, false);
    expect(() => loadRecording(root, path)).toThrow(/not listed/);
  });
});
