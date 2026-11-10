// gate: LIVE — offline checks of the open challenge templates and of the published-agent-key manifest rule (no network).
// The sandbox case is live-challenge.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import { afterAll, describe, expect, it } from "vitest";
import { CHALLENGE_DOES_NOT_SHOW, challengePhase, publicationUrl, runChallenge } from "../src/live/challenge.js";
import { evidenceFile, runLive } from "../src/live/main.js";
import { LiveManifest, loadManifest, publishedKeyProblems } from "../src/live/manifest.js";
import { NearClient } from "../src/near/client.js";
import { DEMO_POLICY } from "../src/demo/market.js";
import { sandboxKey } from "../src/near/keys.js";
import { offlineManifest, stubRpc, writeJson } from "./live-helpers.js";

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
    ["propose", 2, [{ kind: "propose", source: { from: "manifest", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 0 } } }]],
    ["refused_proposal", 2, [{ kind: "refused_proposal", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 0 }, error: "x" }]],
    ["fill", 2, [{ kind: "fill" }]],
    ["settle", 2, [{ kind: "settle" }]],
    ["withhold", 2, [{ kind: "withhold" }]],
    // A relay is a valid sequence only after its withhold and a revocation.
    ["relay_withheld", 4, [{ kind: "withhold" }, { kind: "revoke" }, { kind: "relay_withheld" }]],
  ])("refuses a %s step in a manifest whose agent key is published", (kind, at, steps) => {
    const d = tmp();
    const r = load(d, { ...offlineManifest(d), agent_key_published: true, steps: [{ kind: "grant", policy: DEMO_POLICY }, ...steps] });
    expect(r.error).toMatch(/^live: invalid step sequence: /);
    expect(r.error).toMatch(new RegExp(`step ${at} ${kind} is not allowed when agent_key_published is set`));
  });

  // gate: LIVE
  it("forbids exactly the steps that sign with the agent key or act on an order", () => {
    const d = tmp();
    const all: LiveManifest["steps"] = [
      { kind: "check" },
      { kind: "grant", policy: DEMO_POLICY },
      { kind: "propose", source: { from: "manifest", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 0 } }, expect: "signed" },
      { kind: "refused_proposal", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 0 }, error: "x" },
      { kind: "fill" },
      { kind: "withhold" },
      { kind: "relay_withheld", min_remaining_sec: 10 },
      { kind: "settle" },
      { kind: "revoke" },
      { kind: "reconcile_registration" },
      { kind: "recover", asset: "usdc" },
      { kind: "revoke_external" },
      { kind: "recover_external", asset: "usdc" },
      { kind: "register_storage", asset: "usdc" },
      { kind: "withdraw", asset: "usdc" },
      { kind: "withdraw_external", asset: "usdc" },
    ];
    const forbidden = publishedKeyProblems({ ...offlineManifest(d), agent_key_published: true, steps: all }).steps.map((p) => p.split(" ")[2]);
    expect(forbidden).toEqual(["propose", "refused_proposal", "fill", "withhold", "relay_withheld", "settle"]);
  });

  const sandboxPk = (label: string): string => sandboxKey(`challenge-${label}`).getPublicKey().toString();
  /** A template manifest with every key field of the template filled, each distinct. */
  const withAllKeys = (d: string, name: string): LiveManifest => {
    const m = fromTemplate(d, name);
    const ownerExt = sandboxPk("owner-external");
    return {
      ...m,
      keys: { ...m.keys, mandate_full_access: [sandboxPk("mandate")], owner_external: { public_key: ownerExt } },
      expected_nonces: { owner: "1", agent: "1", filler: "1", owner_external: "1" },
      expected_owner_keys: [
        { public_key: m.keys.owner.public_key, permission: "full_access", nonce: "1" },
        { public_key: ownerExt, permission: "full_access", nonce: "1" },
        { public_key: sandboxPk("owner-fc"), permission: { receiver_id: "x.sandbox", method_names: [] }, nonce: "1" },
      ],
    };
  };

  // gate: LIVE
  it.each([OPEN, CLOSE])("%s with every key field filled distinctly still loads", (name) => {
    const d = tmp();
    expect(load(d, withAllKeys(d, name)).error).toBeNull();
  });

  // gate: LIVE
  it.each([
    ["keys.owner.public_key", (m: LiveManifest) => m.keys.owner.public_key],
    ["keys.owner_external.public_key", (m: LiveManifest) => m.keys.owner_external?.public_key ?? ""],
    ["keys.filler.public_key", (m: LiveManifest) => m.keys.filler.public_key],
    ["keys.filler.intents_public_key", (m: LiveManifest) => m.keys.filler.intents_public_key],
    ["keys.mandate_full_access\\[0\\]", (m: LiveManifest) => m.keys.mandate_full_access[0] ?? ""],
    ["expected_owner_keys\\[2\\]", (m: LiveManifest) => m.expected_owner_keys?.[2]?.public_key ?? ""],
  ])("refuses a published agent key equal to %s", (field, pick) => {
    const d = tmp();
    const m = withAllKeys(d, OPEN);
    const r = load(d, { ...m, keys: { ...m.keys, agent: { ...m.keys.agent, public_key: pick(m) } } });
    expect(r.error).toMatch(new RegExp(`^live: published agent key collision: keys\\.agent\\.public_key equals ${field}: the published key must not be one the run or the owner relies on`));
    expect(r.error).not.toMatch(/invalid step sequence/);
  });

  // gate: LIVE
  it("without the flag, a shared agent key is not refused by the published-key rule", () => {
    const d = tmp();
    const m = withAllKeys(d, OPEN);
    expect(publishedKeyProblems({ ...m, agent_key_published: undefined, keys: { ...m.keys, agent: { ...m.keys.agent, public_key: m.keys.owner.public_key } } })).toEqual({ steps: [], collisions: [] });
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

describe("make live and make challenge keep to their own manifests and evidence", () => {
  const offlineClient = () => {
    const provider = new JsonRpcProvider({ url: "http://127.0.0.1:9" });
    const calls = stubRpc(provider, () => {
      throw new Error("no network in this test");
    });
    return { client: new NearClient("http://127.0.0.1:9", provider), calls };
  };

  // gate: LIVE
  it.each([OPEN, CLOSE])("make live refuses the challenge manifest %s before any network action and writes nothing", async (name) => {
    const d = tmp();
    const { client, calls } = offlineClient();
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "m.json", fromTemplate(d, name)) }, { client, outRoot: join(d, "live") });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/agent_key_published.*runs only with make challenge/);
    expect(calls).toEqual([]);
    expect(existsSync(join(d, "live"))).toBe(false);
    expect(existsSync(join(d, "evidence"))).toBe(false);
  });

  // gate: LIVE
  it("make challenge refuses a manifest that is not a challenge manifest before any network action and writes nothing", async () => {
    const d = tmp();
    const { client, calls } = offlineClient();
    const r = await runChallenge({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "m.json", offlineManifest(d)) }, { client, outRoot: join(d, "live") });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/not a challenge manifest/);
    expect(calls).toEqual([]);
    expect(existsSync(join(d, "evidence"))).toBe(false);
  });

  // gate: LIVE
  it("the completed run and each challenge phase write different evidence files, even under one root", () => {
    const files = [evidenceFile("/x/live", "mainnet"), evidenceFile("/x/live", "mainnet", "open"), evidenceFile("/x/live", "mainnet", "close")];
    expect(files).toEqual(["/x/evidence/live-mainnet.json", "/x/evidence/live-mainnet-challenge-open.json", "/x/evidence/live-mainnet-challenge-close.json"]);
    expect(new Set(files).size).toBe(3);
  });

  // gate: LIVE
  it("records only an https link to the published key, and refuses anything else before any network action", async () => {
    expect(publicationUrl({})).toBeNull();
    expect(publicationUrl({ MANDATE_CHALLENGE_KEY_URL: "" })).toBeNull();
    expect(publicationUrl({ MANDATE_CHALLENGE_KEY_URL: "https://example.com/key" })).toBe("https://example.com/key");
    const d = tmp();
    const { client, calls } = offlineClient();
    for (const url of ["http://example.com/key", "not a url", "javascript:alert(1)"]) {
      const r = await runChallenge({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "m.json", fromTemplate(d, OPEN)), MANDATE_CHALLENGE_KEY_URL: url }, { client, outRoot: join(d, "live") });
      expect([r.exitCode, r.message]).toEqual([2, "challenge: MANDATE_CHALLENGE_KEY_URL must be an https URL"]);
    }
    expect(calls).toEqual([]);
  });
});
