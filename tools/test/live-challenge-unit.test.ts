// gate: LIVE — offline checks of the open challenge templates and of the published-agent-key manifest rule (no network).
// The sandbox case is live-challenge.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import { afterAll, describe, expect, it } from "vitest";
import { CHALLENGE_DOES_NOT_SHOW, ChallengeRecord, challengePhase, challengeRecord, previousProblems, publicationUrl, runChallenge, type RecordInput } from "../src/live/challenge.js";
import { evidenceFile, runLive, type LiveResult } from "../src/live/main.js";
import { LiveManifest, loadManifest, publishedKeyProblems } from "../src/live/manifest.js";
import { NearClient } from "../src/near/client.js";
import { DEMO_POLICY } from "../src/demo/market.js";
import { sandboxKey } from "../src/near/keys.js";
import type { Evidence, GrantView } from "../src/types.js";
import { offlineManifest, stubRpc, writeJson } from "./live-helpers.js";
import { record } from "./page-challenge-specimen.js";

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

describe("the challenge record carries an earlier record forward only when it is this challenge's", () => {
  const SHA = "a".repeat(64);
  const KEY_URL = "https://example.invalid/SYNTHETIC-published-key";
  const specimen = record("open");
  type Grant = NonNullable<ChallengeRecord["grant"]>;
  const chainGrant = (over: Partial<Grant> = {}): Grant => ({ ...(specimen.grant as Grant), ...over });
  /** A fake client: one chain grant, no orders, no keys, zero balances. No transport and no transaction method. */
  const fake = (m: LiveManifest, grant: Grant | null): NearClient =>
    ({
      provider: { viewBlock: () => Promise.resolve({ header: { height: 100, hash: "SYNTHETICblock100", timestamp_nanosec: "100" } }) },
      nodeStatus: () => Promise.resolve({ chain_id: m.network.chain_id, genesis_hash: m.network.genesis_hash }),
      view: (_account: string, method: string) => {
        if (method === "get_grant") return Promise.resolve(grant);
        if (method === "list_orders") return Promise.resolve([]);
        if (method === "has_public_key") return Promise.resolve(grant?.status === "active");
        if (method === "mt_balance_of") return Promise.resolve("0");
        return Promise.reject(new Error(`unexpected view ${method}`));
      },
      tryView: () => Promise.resolve({ ok: false, error: "SYNTHETIC: no signer" }),
      accessKeys: () => Promise.resolve([]),
    }) as unknown as NearClient;
  /** An earlier record of this manifest's own challenge: same network, mandate, code, agent key, and `grant`. */
  const ownRecord = (m: LiveManifest, grant: Grant, over: Record<string, unknown> = {}): ChallengeRecord =>
    record("open", {
      network: { chain_id: m.network.chain_id, genesis_hash: m.network.genesis_hash },
      accounts: { mandate: m.accounts.mandate, owner: m.accounts.owner, agent: m.accounts.agent, verifier: m.accounts.verifier, signer: m.accounts.signer },
      mandate_code_hash: m.code_hashes.mandate,
      agent_key: { ...specimen.agent_key, public_key: m.keys.agent.public_key, publication_url: KEY_URL },
      grant,
      ...over,
    });
  const build = (m: LiveManifest, grant: Grant | null, over: Partial<RecordInput>): Promise<ChallengeRecord> =>
    challengeRecord({ client: fake(m, grant), manifest: m, manifestSha256: SHA, phase: "open", result: { exitCode: 1, message: "SYNTHETIC: open failed" }, previous: null, publicationUrl: null, ...over });
  const opening = (epoch: number, passed = true): LiveResult => ({
    exitCode: passed ? 0 : 1,
    message: passed ? "completed" : "SYNTHETIC: grant verification failed",
    evidence: {
      receipts: [{ label: "step 2 grant (SYNTHETIC)", tx_hash: "SYNTHETICgrantTx", block_height: 90, outcome: "success", detail: { method: "grant" } }],
      assertions: [{ id: "step-2-grant", gate: "LIVE", description: "grant: terminal verification (SYNTHETIC)", passed, observed: { epoch } }],
    } as unknown as Evidence,
  });

  // gate: LIVE
  it("a failed opening does not inherit another mandate's opening, and is not called open", async () => {
    // The reviewer's counterexample: the record on disk is another mandate's closed challenge; this open failed
    // before any grant, and the mandate's grant on chain is an earlier, revoked one.
    const m = offlineManifest(tmp());
    const previous = record("closed", { agent_key: { ...specimen.agent_key, publication_url: KEY_URL } });
    expect(previous.accounts.mandate).not.toBe(m.accounts.mandate);
    const got = await build(m, chainGrant({ epoch: 1, path: "mandate/v1/1", status: "revoked" }), { previous });
    expect(got.status).toBe("not-opened");
    expect(got.opened).toBeNull();
    expect(got.grant).toBeNull();
    expect(got.agent_key.publication_url).toBeNull();
    expect(got.manifests).toEqual({ open: SHA, close: null });
    expect(got.challenge_orders).toEqual({ total: 0, by_state: {} });
    expect(got.previous_record_ignored).toEqual(expect.arrayContaining([`mandate account was ${previous.accounts.mandate}, this manifest's is ${m.accounts.mandate}`]));
    // Without any earlier record the same failed opening is not-opened as well, and says nothing about one.
    const alone = await build(m, chainGrant({ epoch: 1, path: "mandate/v1/1", status: "revoked" }), {});
    expect([alone.status, alone.opened, alone.previous_record_ignored]).toEqual(["not-opened", null, undefined]);
  });

  // gate: LIVE
  it("carries its own earlier record forward, and derives the status from the grant on chain and the outcome", async () => {
    const m = offlineManifest(tmp());
    const active = chainGrant();
    const previous = ownRecord(m, active);
    expect(previousProblems(previous, m, active as unknown as GrantView)).toEqual([]);
    const close = (exitCode: 0 | 1): LiveResult => ({ exitCode, message: exitCode === 0 ? "completed" : "SYNTHETIC: awaiting the owner's signature" });
    // Control: a close that is still waiting, the grant still active: open, with the opening and the link carried.
    const waiting = await build(m, active, { phase: "close", result: close(1), previous });
    expect([waiting.status, waiting.opened, waiting.agent_key.publication_url, waiting.manifests]).toEqual(["open", previous.opened, KEY_URL, { open: previous.manifests.open, close: SHA }]);
    expect(waiting.previous_record_ignored).toBeUndefined();
    // Revoked but the close did not complete: no longer open, not yet closed.
    const revoked = chainGrant({ status: "revoked" });
    expect((await build(m, revoked, { phase: "close", result: close(1), previous })).status).toBe("inactive");
    expect((await build(m, chainGrant({ status: "revoking" }), { phase: "close", result: close(1), previous })).status).toBe("inactive");
    // Closed needs both the completed close and the revoked grant.
    expect((await build(m, revoked, { phase: "close", result: close(0), previous })).status).toBe("closed");
    expect((await build(m, active, { phase: "close", result: close(0), previous })).status).toBe("open");
    // A failed re-run of the open manifest keeps its own opening while that grant is active, and only then.
    expect((await build(m, active, { previous })).status).toBe("open");
    expect((await build(m, revoked, { previous })).status).toBe("inactive");
  });

  // gate: LIVE
  // The reviewer's counterexample: refreshing a closed challenge with the open manifest made it "inactive" and
  // dropped its close manifest and receipts from the latest record.
  it("keeps a completed close when the record is refreshed or a close re-run does not complete", async () => {
    const m = offlineManifest(tmp());
    const revoked = chainGrant({ status: "revoked" });
    const closedRecord = record("closed");
    const previous = ownRecord(m, revoked, { status: "closed", manifests: closedRecord.manifests, close: closedRecord.close });
    expect(previous.close?.exit_code).toBe(0);
    expect(previousProblems(previous, m, revoked as unknown as GrantView)).toEqual([]);
    for (const over of [{}, { phase: "close", result: { exitCode: 1, message: "SYNTHETIC: close re-run failed" } }] as const) {
      const got = await build(m, revoked, { previous, ...over });
      expect([got.status, got.manifests.close, got.close, got.opened]).toEqual(["closed", previous.manifests.close, previous.close, previous.opened]);
    }
    // Controls. A close that completes now records its own manifest and receipts.
    const again = await build(m, revoked, { phase: "close", result: { exitCode: 0, message: "completed" }, previous });
    expect([again.status, again.manifests.close, again.close?.message]).toEqual(["closed", SHA, "completed"]);
    // The grant is active again on chain (same epoch cannot be, but the status is read, not assumed): not closed.
    expect((await build(m, chainGrant(), { previous })).status).toBe("open");
    expect((await build(m, chainGrant(), { previous })).close).toBeNull();
    // An earlier record that was never closed gives a refresh nothing to keep.
    const neverClosed = await build(m, revoked, { previous: ownRecord(m, revoked) });
    expect([neverClosed.status, neverClosed.close, neverClosed.manifests.close]).toEqual(["inactive", null, null]);
  });

  // gate: LIVE
  it("ignores an earlier record that differs in network, mandate, code, agent key or grant, one binding at a time", async () => {
    const m = offlineManifest(tmp());
    const active = chainGrant();
    const own = ownRecord(m, active);
    const cases: [string, ChallengeRecord, Grant | null][] = [
      ["chain id", { ...own, network: { ...own.network, chain_id: "another-chain" } }, active],
      ["genesis hash", { ...own, network: { ...own.network, genesis_hash: "SYNTHETICotherGenesis" } }, active],
      ["mandate account", { ...own, accounts: { ...own.accounts, mandate: "other-mandate.sandbox" } }, active],
      ["mandate code hash", { ...own, mandate_code_hash: "SYNTHETICotherCode" }, active],
      ["agent key", { ...own, agent_key: { ...own.agent_key, public_key: "ed25519:SYNTHETICotherAgentKey" } }, active],
      ["grant epoch", own, chainGrant({ epoch: active.epoch + 1, path: `mandate/v1/${String(active.epoch + 1)}` })],
      ["grant path", own, chainGrant({ path: "mandate/v2/3" })],
      ["grant key", own, chainGrant({ public_key: "ed25519:SYNTHETICotherGrantKey" })],
      ["no grant on chain", own, null],
      ["no opening recorded", { ...own, opened: null, grant: null, status: "not-opened" }, active],
    ];
    for (const [name, previous, grant] of cases) {
      expect(previousProblems(previous, m, grant as unknown as GrantView), name).toHaveLength(1);
      const got = await build(m, grant, { phase: "close", result: { exitCode: 1, message: "SYNTHETIC" }, previous });
      expect([name, got.status, got.opened, got.grant, got.agent_key.publication_url, got.manifests.open]).toEqual([name, "not-opened", null, null, null, null]);
      // Said in the record whenever an opening was dropped.
      expect(got.previous_record_ignored === undefined, name).toBe(previous.opened === null);
    }
    // A grant key the chain no longer reports (or the record never held) does not unbind epoch and path.
    expect(previousProblems(own, m, chainGrant({ public_key: null }) as unknown as GrantView)).toEqual([]);
  });

  // gate: LIVE
  it("counts this run's opening only for a verified grant that is the grant on chain", async () => {
    const m = offlineManifest(tmp());
    const active = chainGrant();
    // Control: the run's grant transaction succeeded, its verification passed, and it is the grant on chain.
    const opened = await build(m, active, { result: opening(active.epoch) });
    expect([opened.status, opened.opened, opened.grant?.epoch]).toEqual(["open", { tx_hash: "SYNTHETICgrantTx", block_height: 90 }, active.epoch]);
    // The grant on chain is another epoch (a resumed open ledger after a later regrant): not this run's opening.
    expect((await build(m, chainGrant({ epoch: active.epoch + 1 }), { result: opening(active.epoch) })).status).toBe("not-opened");
    // The transaction succeeded but its terminal verification did not pass.
    const unverified = await build(m, active, { result: opening(active.epoch, false) });
    expect([unverified.status, unverified.opened]).toEqual(["not-opened", null]);
    // A grant transaction in a close run's evidence opens nothing.
    expect((await build(m, active, { phase: "close", result: opening(active.epoch) })).status).toBe("not-opened");
    // Activating: opened by this run, not active yet.
    expect((await build(m, chainGrant({ status: "activating" }), { result: opening(active.epoch) })).status).toBe("inactive");
  });
});
