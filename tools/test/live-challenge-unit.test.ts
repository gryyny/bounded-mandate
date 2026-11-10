// gate: LIVE — offline checks of the open challenge templates and of the published-agent-key manifest rule (no network).
// The sandbox case is live-challenge.test.ts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CHALLENGE_DOES_NOT_SHOW, challengePhase, runChallenge } from "../src/live/challenge.js";
import { LiveManifest, loadManifest } from "../src/live/manifest.js";
import { DEMO_POLICY } from "../src/demo/market.js";
import { offlineManifest, writeJson } from "./live-helpers.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bm-challenge-unit-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TEMPLATES = join(import.meta.dirname, "../src/live");
const raw = (name: string): string => readFileSync(join(TEMPLATES, name), "utf8");
const tpl = (name: string) => JSON.parse(raw(name)) as Record<string, unknown> & { notes: string[]; steps: unknown[]; budget: LiveManifest["budget"]; gas_tgas: LiveManifest["gas_tgas"]; expect_existing_grant: boolean; agent_key_published: boolean; keys: { agent: { public_key: string } } };
const OPEN = "manifest.open-challenge.example.json";
const CLOSE = "manifest.open-challenge-close.example.json";

/** An offline manifest carrying a template's challenge fields (identities stay the offline test's). */
const fromTemplate = (d: string, name: string): LiveManifest => {
  const t = tpl(name);
  return offlineManifest(d, { budget: t.budget, gas_tgas: t.gas_tgas, expect_existing_grant: t.expect_existing_grant, agent_key_published: t.agent_key_published, steps: LiveManifest.shape.steps.parse(t.steps) });
};
const load = (d: string, m: unknown) => {
  try {
    return { manifest: loadManifest({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, `m-${Math.random()}.json`, m) }).manifest, error: null };
  } catch (error) {
    return { manifest: null, error: error instanceof Error ? error.message : String(error) };
  }
};

describe("open challenge templates", () => {
  // gate: LIVE
  it.each([[OPEN, "open"], [CLOSE, "close"]] as const)("%s loads as the %s phase with the agent key marked published", (name, phase) => {
    const d = tmp();
    const r = load(d, fromTemplate(d, name));
    expect(r.error).toBeNull();
    if (r.manifest === null) return;
    expect(challengePhase(r.manifest)).toEqual({ phase });
    expect(r.manifest.agent_key_published).toBe(true);
  });

  // gate: LIVE
  it.each([OPEN, CLOSE])("%s states what the challenge does not show and where the key is published, and holds no private key", (name) => {
    const t = tpl(name);
    for (const s of CHALLENGE_DOES_NOT_SHOW) expect(t.notes.some((n) => n.includes(s)), s).toBe(true);
    const text = raw(name);
    expect(text).toMatch(/published outside every repository/);
    expect(t.keys.agent.public_key).toMatch(/^REPLACE_ME/);
    // An ed25519 secret key string is 64 bytes in base58 (about 87-88 characters); public keys are 32 bytes.
    expect(text).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/);
    expect(text).not.toMatch(/private_key/);
  });

  // gate: LIVE
  it.each([OPEN, CLOSE])("%s is refused as is (placeholders), sending nothing", async (name) => {
    const d = tmp();
    const r = await runChallenge({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "t.json", tpl(name)), MANDATE_LIVE_CONFIRM: "x" }, { outRoot: join(d, "live") });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/invalid manifest/);
  });

  // gate: LIVE
  it("the open template's grant bounds proposals to turnover / charge and keeps the spec's thresholds", () => {
    const steps = LiveManifest.shape.steps.parse(tpl(OPEN).steps);
    const grant = steps.find((s) => s.kind === "grant");
    if (grant?.kind !== "grant") throw new Error("no grant step");
    const p = grant.policy;
    for (const k of ["per_order_cap_bps", "outstanding_cap_bps", "max_concession_bps", "oracle_max_age_sec", "max_confidence_bps", "breaker_drawdown_bps", "turnover_cap_bps", "order_ttl_sec"] as const) expect(p[k]).toBe(DEMO_POLICY[k]);
    expect(p.proposal_charge_bps > 0 && p.proposal_charge_bps <= p.per_order_cap_bps).toBe(true);
    expect(Math.floor(p.turnover_cap_bps / p.proposal_charge_bps)).toBe(10);
  });
});

describe("a published agent key", () => {
  // gate: LIVE
  it.each([
    ["propose", { kind: "propose", source: { from: "manifest", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 0 } } }],
    ["refused_proposal", { kind: "refused_proposal", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 0 }, error: "x" }],
    ["fill", { kind: "fill" }],
    ["settle", { kind: "settle" }],
    ["withhold", { kind: "withhold" }],
  ])("refuses a %s step in a manifest whose agent key is published", (kind, step) => {
    const d = tmp();
    const r = load(d, { ...offlineManifest(d), agent_key_published: true, steps: [{ kind: "grant", policy: DEMO_POLICY }, step] });
    expect(r.error).toMatch(new RegExp(`step 2 ${kind} is not allowed when agent_key_published is set`));
  });

  // gate: LIVE
  it("without the flag, or with other steps, the manifest is not a challenge manifest", () => {
    const d = tmp();
    expect(challengePhase({ ...fromTemplate(d, OPEN), agent_key_published: undefined })).toEqual({ problems: ["agent_key_published must be true"] });
    expect(challengePhase({ ...fromTemplate(d, CLOSE), expect_existing_grant: false })).toEqual({ problems: ["the close phase needs expect_existing_grant true"] });
    const other = challengePhase({ ...fromTemplate(d, OPEN), steps: [{ kind: "check" }] });
    expect("problems" in other && other.problems.join(" ")).toMatch(/steps must be/);
  });
});
