// Runner-manifest preparation after setup (src/live/prepare.ts): the R1 state check against the setup record, the
// filled template with post-setup nonces, and the hash of the written bytes. No network: the chain is a fixture.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { LiveManifest, loadManifest } from "../src/live/manifest.js";
import { fillManifest, manifestBytes, placeholders, prepare, readPostSetup, setupProblems, specDeviations, type PostSetupState, type PrepareInput, type ReadOnlyChain } from "../src/live/prepare.js";
import { ownerKeySnapshot } from "../src/live/preflight.js";
import type { AccessKeyInfo, AccountInfo } from "../src/near/client.js";
import { sandboxKey } from "../src/near/keys.js";

const live = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.live-agent.example.json"), "utf8")) as Record<string, unknown> & {
  network: { chain_id: string; genesis_hash: string };
  code_hashes: { mandate: string };
  mandate_config: Record<string, unknown>;
};
const fallback = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.example.json"), "utf8")) as Record<string, unknown>;
const pins = { chain_id: live.network.chain_id, genesis_hash: live.network.genesis_hash, mandate_code_hash: live.code_hashes.mandate };
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** 5.2 NEAR: above the full-bound rule for 310,100 bytes of storage, (310,100 + 2000 + 200 x 1000 + 4096) x 1e19 = 5.16196 NEAR. */
const FUNDED = "5200000000000000000000000";
const EXACT = (310_100n + 2_000n + 200n * 1_000n + 4_096n) * 10n ** 19n;
const pk = (label: string) => sandboxKey(`prepare-test/${label}`).getPublicKey().toString();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function input(over: { ownerExternal?: string | null; model?: boolean; timing?: number } = {}): PrepareInput {
  const external = over.ownerExternal === undefined ? pk("owner-external") : over.ownerExternal;
  return {
    schema: "bounded-mandate/prepare-input@1",
    setup: {
      approval: { approved_by: "Test Lead", reference: "setup approval (test)" },
      accounts: { owner: "lead.near", mandate: "mandate.lead.near", agent: "agent.lead.near", filler: "filler.lead.near" },
      keys: {
        owner: pk("owner"),
        ...(external === null ? {} : { owner_external: external }),
        agent: pk("agent"),
        filler: pk("filler"),
        filler_intents: pk("filler-intents"),
        mandate_full_access: [pk("rescue")],
      },
      agent_allowance_yocto: "250000000000000000000000",
      deposits: { mandate: { usdc: "5000000", wnear: "910000000000000000000000" }, filler: { usdc: "0", wnear: "500000000000000000000000" } },
    },
    runner: {
      approval: { approved_by: "Test Lead", reference: "runner approval (test)" },
      grant_timing: { order_ttl_sec: over.timing ?? 120, oracle_max_age_sec: over.timing ?? 120 },
      credentials: { owner: "/secure/owner.json", agent: "/secure/agent.json", filler: "/secure/filler.json", filler_intents: "/secure/filler-intents.json" },
      ...(over.model === false ? {} : { model: { id: "anthropic/claude-haiku-5-5", timeout_ms: 90_000, max_tokens: 4096 } }),
    },
  };
}

const full = (public_key: string, nonce: bigint): AccessKeyInfo => ({ public_key, nonce, permission: { kind: "full" } });
const account = (amount: string, storage_usage: number, code_hash = "11111111111111111111111111111111"): AccountInfo => ({ amount, locked: "0", code_hash, storage_usage });

/** The post-setup chain exactly as the record approves it. */
function matching(i: PrepareInput): PostSetupState {
  const s = i.setup;
  const ownerKeys = [full(s.keys.owner, 223500000000010n), full(pk("owner-other"), 7n), {
    public_key: pk("owner-app"),
    nonce: 3n,
    permission: { kind: "function_call" as const, receiver_id: "app.near", method_names: ["b", "a"], allowance: null },
  }];
  if (s.keys.owner_external !== undefined && s.keys.owner_external !== s.keys.owner) ownerKeys.push(full(s.keys.owner_external, 223500000000020n));
  return {
    block_before: { height: 223600000, timestamp_ns: "1794100000000000000" },
    block_after: { height: 223600003, timestamp_ns: "1794100003000000000" },
    chain: { chain_id: pins.chain_id, genesis_hash: pins.genesis_hash },
    storage_amount_per_byte: "10000000000000000000",
    accounts: {
      owner: account("900000000000000000000000", 500),
      mandate: account(FUNDED, 310_100, pins.mandate_code_hash),
      agent: account("300000000000000000000000", 250),
      filler: account("280000000000000000000000", 182),
    },
    keys: {
      owner: ownerKeys,
      mandate: s.keys.mandate_full_access.map((k) => full(k, 223500000000000n)),
      agent: [{ public_key: s.keys.agent, nonce: 223500000000030n, permission: { kind: "function_call", receiver_id: s.accounts.mandate, method_names: ["propose_order"], allowance: BigInt(s.agent_allowance_yocto) } }],
      filler: [full(s.keys.filler, 223500000000044n)],
    },
    mandate_config: { ...live.mandate_config, owner_id: s.accounts.owner, agent_id: s.accounts.agent },
    grant: null,
    orders: [],
    mandate_verifier_keys: [],
    filler_intents_key_registered: true,
    intents_balances: { mandate: { ...s.deposits.mandate }, filler: { ...s.deposits.filler } },
    owner_registered: { usdc: true, wnear: true },
  };
}

describe("R1: the post-setup state against the approved setup record", () => {
  it("passes the state the record approves", () => {
    expect(setupProblems(input(), live, matching(input()), pins)).toEqual([]);
  });

  const cases: [string, (s: PostSetupState, i: PrepareInput) => void, RegExp][] = [
    ["a missing account", (s) => (s.accounts.filler = null), /filler\.lead\.near \(filler\) does not exist/],
    ["another mandate binary", (s) => (s.accounts.mandate = account(FUNDED, 310_100, "22222222222222222222222222222222")), /mandate code hash/],
    ["another initialization", (s) => (s.mandate_config = { ...live.mandate_config, owner_id: "other.near", agent_id: "agent.lead.near" }), /get_config/],
    ["an extra mandate key", (s) => s.keys.mandate.push(full(pk("stray"), 1n)), /mandate access keys/],
    ["a keyless policy violated by a function-call key", (s, i) => { i.setup.keys.mandate_full_access = []; s.keys.mandate = [{ public_key: pk("fc"), nonce: 1n, permission: { kind: "function_call", receiver_id: "x.near", method_names: [], allowance: null } }]; }, /mandate access keys/],
    ["an agent key for another method", (s) => { const k = s.keys.agent[0]; if (k?.permission.kind === "function_call") k.permission.method_names = ["propose_order", "settle_order"]; }, /agent keys/],
    ["an agent key for another receiver", (s) => { const k = s.keys.agent[0]; if (k?.permission.kind === "function_call") k.permission.receiver_id = "other.near"; }, /agent keys/],
    ["another agent allowance", (s) => { const k = s.keys.agent[0]; if (k?.permission.kind === "function_call") k.permission.allowance = 1n; }, /agent keys/],
    ["a second agent key", (s) => s.keys.agent.push(full(pk("agent-2"), 1n)), /agent keys/],
    ["a second filler key", (s) => s.keys.filler.push(full(pk("filler-2"), 1n)), /filler keys/],
    ["no external owner key on chain", (s, i) => (s.keys.owner = s.keys.owner.filter((k) => k.public_key !== i.setup.keys.owner_external)), /no full-access key .* \(owner_external\)/],
    ["the filler Intents key unregistered", (s) => (s.filler_intents_key_registered = false), /filler Intents key/],
    ["verifier keys on the mandate", (s) => (s.mandate_verifier_keys = [pk("grant")]), /already has verifier keys/],
    ["an existing grant", (s) => (s.grant = { epoch: 1, status: "active" }), /has a grant/],
    ["an order record", (s) => (s.orders = [{ id: "0" }]), /1 order record/],
    ["unreadable orders", (s) => (s.orders = null), /could not be read/],
    ["another mandate deposit", (s) => (s.intents_balances.mandate.wnear = "900000000000000000000000"), /mandate Intents wnear balance/],
    ["a filler short of its spend cap", (s, i) => { i.setup.deposits.filler.wnear = "400000000000000000000000"; s.intents_balances.filler.wnear = "400000000000000000000000"; }, /below filler_spend_max/],
    ["a deposit above the inventory ceiling", (s, i) => { i.setup.deposits.mandate.wnear = "1300000000000000000000000"; s.intents_balances.mandate.wnear = "1300000000000000000000000"; }, /above owner_inventory_max/],
    ["an unregistered owner", (s) => (s.owner_registered.wnear = false), /not registered on the wnear token/],
    ["the underfunded mandate against the full record bound", (s) => (s.accounts.mandate = account("3500000000000000000000000", 310_100, pins.mandate_code_hash)), /below the funding rule for 200 records/],
    ["another chain", (s) => (s.chain = { chain_id: "testnet", genesis_hash: "x" }), /not the template's mainnet/],
  ];
  for (const [name, mutate, problem] of cases) {
    it(`refuses ${name}`, () => {
      const i = input();
      const s = matching(i);
      mutate(s, i);
      expect(setupProblems(i, live, s, pins).join("\n")).toMatch(problem);
    });
  }

  it("derives the record bound from the grant step and holds the funding boundary to the yocto", () => {
    const i = input();
    const s = matching(i);
    s.accounts.mandate = account(EXACT.toString(), 310_100, pins.mandate_code_hash);
    expect(setupProblems(i, live, s, pins)).toEqual([]);
    s.accounts.mandate = account((EXACT - 1n).toString(), 310_100, pins.mandate_code_hash);
    expect(setupProblems(i, live, s, pins).join("\n")).toMatch(/below the funding rule for 200 records: \(2000 grant \+ 200 x 1000 \+ 4096\)/);
    // The bound follows the template's own policy: turnover 10000 bps / charge 50 bps.
    const halfCharge = structuredClone(live) as typeof live & { steps: { kind: string; policy?: { proposal_charge_bps: number } }[] };
    const g = halfCharge.steps.find((x) => x.kind === "grant");
    if (g?.policy !== undefined) g.policy.proposal_charge_bps = 100;
    s.accounts.mandate = account((EXACT - 100n * 1_000n * 10n ** 19n).toString(), 310_100, pins.mandate_code_hash);
    expect(setupProblems(i, halfCharge, s, pins)).toEqual([]);
  });

  it("accepts the 3.5 NEAR mandate only with an explicit, referenced storage deviation, and reports it", () => {
    const i = input();
    const s = matching(i);
    s.accounts.mandate = account("3500000000000000000000000", 310_100, pins.mandate_code_hash);
    expect(setupProblems(i, live, s, pins).join("\n")).toMatch(/funding rule for 200 records/);
    i.setup.storage_deviation = { records: 30, approved_reference: "A6 deviation (test)" };
    expect(setupProblems(i, live, s, pins)).toEqual([]);
    expect(specDeviations(i, live).join("\n")).toMatch(/STORAGE DEVIATION \(A6 deviation \(test\)\): .* 30 order records, below the grant's bound of 200/);
    i.setup.storage_deviation = { records: 34, approved_reference: "too many for 3.5 NEAR" };
    expect(setupProblems(i, live, s, pins).join("\n")).toMatch(/funding rule for 34 records/);
  });

  it("refuses a deviation that is not below the bound or below the run's own proposals", () => {
    const i = input();
    i.setup.storage_deviation = { records: 200, approved_reference: "x" };
    expect(setupProblems(i, live, matching(i), pins).join("\n")).toMatch(/not below the bound 200/);
    i.setup.storage_deviation = { records: 2, approved_reference: "x" };
    expect(setupProblems(i, live, matching(i), pins).join("\n")).toMatch(/below the 3 proposals/);
  });

  it("flags grant timing other than the spec's 60 s as a deviation, and nothing for 60/60", () => {
    expect(specDeviations(input(), live).join("\n")).toMatch(/TIMING DEVIATION: order_ttl_sec 120 s and oracle_max_age_sec 120 s; SPEC.md requires 60 s/);
    expect(specDeviations(input({ timing: 60 }), live)).toEqual([]);
  });

  it("refuses a distinct external key for the fixed-proposal template, which has no external steps", () => {
    expect(setupProblems(input({ model: false }), fallback, matching(input({ model: false })), pins).join("\n")).toMatch(/no external steps/);
  });
});

describe("R2-R3: the filled manifest and its hash", () => {
  it("fills every placeholder from the record and the post-setup reads; the runner accepts exactly those bytes", () => {
    const i = input({ timing: 60 });
    const s = matching(i);
    expect(placeholders(live).length).toBeGreaterThan(0);
    const filled = fillManifest(live, i, s);
    expect(placeholders(filled)).toEqual([]);
    const m = LiveManifest.parse(filled);
    expect(m.approval).toEqual(i.runner.approval);
    expect(m.expected_nonces).toEqual({ owner: "223500000000010", agent: "223500000000030", filler: "223500000000044", owner_external: "223500000000020" });
    expect(m.expected_owner_keys).toEqual(ownerKeySnapshot(s.keys.owner));
    expect(m.expected_owner_keys?.find((k) => k.public_key === pk("owner-app"))?.permission).toEqual({ receiver_id: "app.near", method_names: ["a", "b"] });
    expect(m.keys.owner_external?.public_key).toBe(i.setup.keys.owner_external);
    const grant = m.steps.find((x) => x.kind === "grant");
    expect(grant?.kind === "grant" ? [grant.policy.order_ttl_sec, grant.policy.oracle_max_age_sec, grant.policy.max_concession_bps] : null).toEqual([60, 60, 50]);
    const model = m.steps.find((x) => x.kind === "propose" && x.source.from === "model");
    expect(model?.kind === "propose" && model.source.from === "model" ? [model.source.model, model.source.timeout_ms, model.source.max_tokens] : null).toEqual(["anthropic/claude-haiku-5-5", 90_000, 4096]);
    expect(m.mandate_config.owner_id).toBe("lead.near");
    expect(m.mandate_config.usdc.token).toBe(USDC);
    // Pinned template values are carried over unchanged.
    expect(m.budget).toEqual(LiveManifest.shape.budget.parse(live.budget));
    expect(filled.notes).toEqual(live.notes);

    const { text, sha256 } = manifestBytes(filled);
    expect(sha256).toBe(createHash("sha256").update(text).digest("hex"));
    const d = mkdtempSync(join(tmpdir(), "bm-prepare-"));
    dirs.push(d);
    const path = join(d, "manifest.json");
    writeFileSync(path, text);
    expect(() => loadManifest({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path })).toThrow(new RegExp(`MANDATE_LIVE_CONFIRM.*${sha256}`));
    expect(loadManifest({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path, MANDATE_LIVE_CONFIRM: sha256 }).sha256).toBe(sha256);
  });

  it("omits the external key when the owner signs external actions with the runner's key", () => {
    for (const ownerExternal of [null, pk("owner")]) {
      const i = input({ ownerExternal });
      const m = LiveManifest.parse(fillManifest(live, i, matching(i)));
      expect(m.keys.owner_external).toBeUndefined();
      expect(m.expected_nonces?.owner_external).toBeUndefined();
    }
  });

  it("requires the model inputs exactly when the template has a model step", () => {
    const i = input({ model: false, ownerExternal: null });
    expect(() => fillManifest(live, i, matching(i))).toThrow(/runner\.model .* is required/);
    expect(() => fillManifest(fallback, input({ ownerExternal: null }), matching(input({ ownerExternal: null })))).toThrow(/no model step/);
    const m = LiveManifest.parse(fillManifest(fallback, i, matching(i)));
    expect(m.steps.some((x) => x.kind === "revoke")).toBe(true);
    expect(m.keys.owner_external).toBeUndefined();
  });

  it("refuses a template value still left as a placeholder", () => {
    const t = { ...live, code_hashes: { ...live.code_hashes, usdc: "REPLACE_ME: pinned USDC code hash" } };
    const i = input();
    expect(() => fillManifest(t, i, matching(i))).toThrow(/unfilled template values: code_hashes\.usdc/);
  });

  it("refuses a key the chain does not list and a result the runner would refuse", () => {
    const i = input();
    const s = matching(i);
    s.keys.agent = [];
    expect(() => fillManifest(live, i, s)).toThrow(/not found on chain/);
    const bad = input();
    bad.setup.accounts.owner = "owner.sandbox";
    expect(() => fillManifest(live, bad, matching(bad))).toThrow(/test\/sandbox account owner\.sandbox/);
  });
});

/** A read-only chain answering from a post-setup state; `calls` records every read. */
function fakeChain(i: PrepareInput, want: PostSetupState, calls: string[] = [], accountError?: Error): ReadOnlyChain {
  const roleOf = (id: string) => (Object.entries(i.setup.accounts).find(([, a]) => a === id)?.[0] ?? "") as keyof PostSetupState["accounts"];
  return {
    nodeStatus: () => Promise.resolve(want.chain),
    finalBlock: () => Promise.resolve(calls.length === 0 ? want.block_before : want.block_after),
    storageAmountPerByte: () => Promise.resolve(want.storage_amount_per_byte),
    accountView: (id) => {
      calls.push(`view_account ${id}`);
      if (accountError !== undefined) return Promise.reject(accountError);
      const info = want.accounts[roleOf(id)];
      return info === null ? Promise.reject(new Error(`[-32000] Server error: account ${id} does not exist while viewing`)) : Promise.resolve(info);
    },
    accessKeys: (id) => {
      calls.push(`view_access_key_list ${id}`);
      return Promise.resolve(want.keys[roleOf(id)]);
    },
    view: <T,>(contract: string, method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
      calls.push(`${contract} ${method}`);
      const a = args as { account_id?: string; token_id?: string };
      const holder = a.account_id === i.setup.accounts.mandate ? "mandate" : "filler";
      const asset = a.token_id === `nep141:${USDC}` ? "usdc" : "wnear";
      const value: Record<string, unknown> = {
        get_config: want.mandate_config,
        get_grant: want.grant,
        list_orders: want.orders,
        public_keys_of: want.mandate_verifier_keys,
        has_public_key: want.filler_intents_key_registered,
        mt_balance_of: want.intents_balances[holder][asset],
        storage_balance_of: { total: "1250000000000000000000", available: "0" },
      };
      return Promise.resolve(schema.parse(value[method]));
    },
  };
}

describe("reading the post-setup state", () => {
  it("uses view calls only and assembles the state R1 checks", async () => {
    const i = input();
    const want = matching(i);
    const calls: string[] = [];
    const state = await readPostSetup(fakeChain(i, want, calls), i, live);
    expect(state).toEqual(want);
    expect(setupProblems(i, live, state, pins)).toEqual([]);
    expect(calls).toContain("intents.near mt_balance_of");
    expect(calls).toContain(`${USDC} storage_balance_of`);
    expect(calls).toContain("mandate.lead.near get_config");
  });

  it("reads only the RPC's unknown-account error as a missing account and rethrows any other error", async () => {
    const i = input();
    const want = matching(i);
    want.accounts.filler = null;
    want.keys.filler = [];
    expect((await readPostSetup(fakeChain(i, want), i, live)).accounts.filler).toBeNull();
    await expect(readPostSetup(fakeChain(i, matching(i), [], new Error("[-32000] Server error: request timed out")), i, live)).rejects.toThrow(/request timed out/);
  });
});

describe("the CLI path", () => {
  const files = (i: PrepareInput) => {
    const d = mkdtempSync(join(tmpdir(), "bm-prepare-cli-"));
    dirs.push(d);
    const template = join(d, "template.json");
    const inputPath = join(d, "input.json");
    writeFileSync(template, readFileSync(join(import.meta.dirname, "../src/live/manifest.live-agent.example.json")));
    writeFileSync(inputPath, JSON.stringify(i));
    return { d, template, input: inputPath, out: join(d, "manifest.json"), report: join(d, "r1.json") };
  };
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const deps = (i: PrepareInput, state: PostSetupState, urls: string[]) => ({
    chainFor: (url: string) => {
      urls.push(url);
      return fakeChain(i, state);
    },
    revision: () => ({ revision: "f427ac9", dirty: true }),
    argv: ["node", "src/live/prepare.ts", "--template", "t"],
  });

  it("writes no manifest when R1 finds a difference, and binds the report to its inputs", async () => {
    const i = input();
    const state = matching(i);
    state.grant = { epoch: 1, status: "active" };
    const f = files(i);
    const urls: string[] = [];
    const r = await prepare({ template: f.template, input: f.input, out: f.out, report: f.report }, deps(i, state, urls));
    expect(r.exitCode).toBe(1);
    expect(existsSync(f.out)).toBe(false);
    const report = JSON.parse(readFileSync(f.report, "utf8")) as Record<string, unknown>;
    expect(report).toMatchObject({
      r1_passed: false,
      manifest: null,
      command: "node src/live/prepare.ts --template t",
      product: { revision: "f427ac9", dirty: true },
      template: { sha256: sha(f.template) },
      input: { sha256: sha(f.input) },
      rpc_url: "https://free.rpc.fastnear.com",
      chain_read: state.chain,
      blocks: { before: state.block_before, after: state.block_after },
    });
    expect(String(report.problems)).toMatch(/has a grant/);
    expect(urls).toEqual(["https://free.rpc.fastnear.com"]);
  });

  it("writes the manifest only after R1 passes, with the hash, deviations and bindings in the report", async () => {
    const i = input();
    const f = files(i);
    const urls: string[] = [];
    const r = await prepare({ template: f.template, input: f.input, out: f.out, report: f.report, rpc: "https://rpc.example.org" }, deps(i, matching(i), urls));
    expect(r.exitCode).toBe(0);
    expect(urls).toEqual(["https://rpc.example.org"]);
    const report = JSON.parse(readFileSync(f.report, "utf8")) as { manifest: { sha256: string }; confirm: string; deviations: string[]; rpc_url: string };
    expect(report.manifest.sha256).toBe(sha(f.out));
    expect(report.confirm).toBe(`MANDATE_LIVE_CONFIRM=${sha(f.out)}`);
    expect(report.rpc_url).toBe("https://rpc.example.org");
    expect(report.deviations.join("\n")).toMatch(/TIMING DEVIATION/);
    expect(r.summary).toMatchObject({ manifest: report.manifest, deviations: report.deviations });
  });
});
