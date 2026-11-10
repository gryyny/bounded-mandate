// gate: LIVE — offline preflight checks against a fake chain (no network): the shape that makes the agent key
// publishable, the published key's absence from the verifier, the inventory cap on runs that expose funds versus runs
// that only return them, and what the agent's allowance must afford at the gas purchase price. The fake holds exactly
// what the manifest approves; each case changes one fact.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEMO_POLICY } from "../src/demo/market.js";
import { LiveManifest, type Step } from "../src/live/manifest.js";
import { MAINNET } from "../src/live/network.js";
import { agentKeyProblems, preflight, returnsFundsOnly, signingFloat, type PreflightInput } from "../src/live/preflight.js";
import type { AccessKeyInfo, NearClient } from "../src/near/client.js";
import type { MandateClient, VerifierClient } from "../src/near/contracts.js";
import { sandboxKey } from "../src/near/keys.js";
import { offlineManifest } from "./live-helpers.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bm-preflight-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const pk = (label: string): string => sandboxKey(label).getPublicKey().toString();
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
/** Mainnet, read 2026-11-10 (protocol 88): gas_price 1e8; runtime_config.min_gas_purchase_price 1e9 yocto per gas. */
const GAS_PRICE = 100_000_000n;
const PURCHASE_PRICE = 1_000_000_000n;
const ALLOWANCE_CAP = MAINNET.max_agent_allowance_yocto;

/** A WASM module holding only an export section with these function names. */
function wasmExporting(names: string[]): Uint8Array {
  const body = [names.length, ...names.flatMap((n) => [n.length, ...Buffer.from(n), 0, 0])];
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 7, body.length, ...body]);
}

const fc = (public_key: string, over: Partial<{ receiver_id: string; method_names: string[]; allowance: bigint | null }> = {}): AccessKeyInfo => ({
  public_key,
  nonce: 5n,
  permission: { kind: "function_call", receiver_id: "mandate.sandbox", method_names: ["propose_order"], allowance: ALLOWANCE_CAP, ...over },
});
const full = (public_key: string): AccessKeyInfo => ({ public_key, nonce: 5n, permission: { kind: "full" } });

interface Chain {
  keys: Record<string, AccessKeyInfo[]>;
  /** `account/public key` pairs registered on the verifier. */
  verifierKeys: Set<string>;
  mandateBalance: { usdc: bigint; wnear: bigint };
  agentNear: bigint;
}

const sell = (units: string): Step => ({ kind: "propose", source: { from: "manifest", proposal: { sell: "usdc", sell_amount: units, max_concession_bps: 10 } }, expect: "signed" });
const refused: Step = { kind: "refused_proposal", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 51 }, error: "x" };
const PRIMARY: Step[] = [{ kind: "check" }, { kind: "grant", policy: DEMO_POLICY }, refused, sell("1000000"), sell("500000"), { kind: "revoke" }, { kind: "recover", asset: "usdc" }, { kind: "recover", asset: "wnear" }];
const OPEN: Step[] = [{ kind: "check" }, { kind: "grant", policy: DEMO_POLICY }, { kind: "check" }];
const CLOSE: Step[] = [
  { kind: "revoke_external" },
  { kind: "recover_external", asset: "usdc" },
  { kind: "recover_external", asset: "wnear" },
  { kind: "register_storage", asset: "usdc" },
  { kind: "register_storage", asset: "wnear" },
  { kind: "withdraw_external", asset: "usdc" },
  { kind: "withdraw_external", asset: "wnear" },
  { kind: "check" },
];

function manifest(steps: Step[], over: Partial<LiveManifest> = {}): LiveManifest {
  const base = offlineManifest(tmp());
  return {
    ...base,
    keys: { ...base.keys, agent: { public_key: pk("a"), max_allowance_yocto: ALLOWANCE_CAP.toString() } },
    budget: {
      ...base.budget,
      max_fee_yocto: NEAR.toString(),
      max_transactions: 20,
      owner_inventory_max: { usdc: "5000000", wnear: (NEAR + NEAR / 4n).toString() },
      owner_recovery_reserve_yocto: (NEAR / 2n).toString(),
    },
    expect_existing_grant: !steps.some((s) => s.kind === "grant"),
    steps,
    ...over,
  };
}

/** The chain exactly as `m` approves it. */
function chain(m: LiveManifest): Chain {
  return {
    keys: { [m.accounts.mandate]: [], [m.accounts.agent]: [fc(pk("a"))], [m.accounts.owner]: [full(pk("o"))], [m.accounts.filler]: [full(pk("f"))] },
    verifierKeys: new Set([`${m.accounts.filler}/${pk("fi")}`]),
    mandateBalance: { usdc: 5_000_000n, wnear: NEAR },
    agentNear: NEAR,
  };
}

function input(m: LiveManifest, c: Chain): PreflightInput {
  const price = { price: "100000000", conf: "10000", expo: -8, publish_time: 1 };
  const client = {
    finality: "final",
    provider: { experimental_protocolConfig: () => Promise.resolve({ runtime_config: { storage_amount_per_byte: "10000000000000000000", min_gas_purchase_price: PURCHASE_PRICE.toString() } }) },
    nodeStatus: () => Promise.resolve({ chain_id: m.network.chain_id, genesis_hash: m.network.genesis_hash }),
    accountView: (account: string) => Promise.resolve({ amount: (account === m.accounts.agent ? c.agentNear : 10n * NEAR).toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 0 }),
    code: () => Promise.resolve(wasmExporting(["grant", "propose_order", "revoke", "recover"])),
    accessKeys: (account: string) => Promise.resolve(c.keys[account] ?? []),
    gasPrice: () => Promise.resolve(GAS_PRICE),
    view: (_account: string, method: string) => (method === "storage_balance_of" ? Promise.resolve({ total: "1" }) : Promise.reject(new Error(`unexpected view ${method}`))),
    tryView: (_account: string, method: string) => {
      if (method === "get_price_no_older_than") return Promise.resolve({ ok: true, value: price });
      if (method === "derived_public_key") return Promise.resolve({ ok: true, value: pk("grant") });
      return Promise.resolve({ ok: false, error: `unexpected view ${method}` });
    },
  };
  const mandate = { config: () => Promise.resolve(m.mandate_config), grant: () => Promise.resolve(null), allOrders: () => Promise.resolve([]) };
  const verifier = {
    feePips: () => Promise.resolve(BigInt(m.verifier_fee_pips)),
    hasPublicKey: (account: string, key: string) => Promise.resolve(c.verifierKeys.has(`${account}/${key}`)),
    balance: (account: string, token: string) => Promise.resolve(account !== m.accounts.mandate ? 0n : token === m.mandate_config.usdc.token ? c.mandateBalance.usdc : c.mandateBalance.wnear),
  };
  return {
    client: client as unknown as NearClient,
    manifest: m,
    mandate: mandate as unknown as MandateClient,
    verifier: verifier as unknown as VerifierClient,
    credentialKeys: { owner: pk("o"), agent: pk("a"), filler: pk("f"), filler_intents: pk("fi") },
    fresh: true,
    spentFeeYocto: 0n,
    pending: m.steps,
    createdOrders: [],
    fillerPaid: { usdc: 0n, wnear: 0n },
  };
}

const failed = async (m: LiveManifest, mutate: (c: Chain) => void = () => undefined): Promise<string[]> => {
  const c = chain(m);
  mutate(c);
  const r = await preflight(input(m, c));
  return r.checks.filter((x) => !x.passed).map((x) => x.id);
};
const ids = async (m: LiveManifest): Promise<string[]> => (await preflight(input(m, chain(m)))).checks.map((x) => x.id);
const published = (steps: Step[], over: Partial<LiveManifest> = {}): LiveManifest => manifest(steps, { agent_key_published: true, ...over });

describe("the fake chain as approved", () => {
  // gate: LIVE
  it.each([
    ["a primary-shaped run", manifest(PRIMARY)],
    ["a challenge open", published(OPEN)],
    ["a challenge close", published(CLOSE)],
  ])("passes every check of %s", async (_name, m) => {
    expect(await failed(m)).toEqual([]);
  });
});

describe("the agent account's key set (what makes the key publishable)", () => {
  const cases: [string, (c: Chain, agent: string) => void, string][] = [
    ["a full-access key instead", (c, a) => (c.keys[a] = [full(pk("a"))]), "keys.agent_single_propose_key"],
    ["an extra full-access key", (c, a) => c.keys[a]?.push(full(pk("extra"))), "keys.agent_single_propose_key"],
    ["an extra function-call key", (c, a) => c.keys[a]?.push(fc(pk("extra"))), "keys.agent_single_propose_key"],
    ["no key", (c, a) => (c.keys[a] = []), "keys.agent_single_propose_key"],
    ["another key than the manifest's", (c, a) => (c.keys[a] = [fc(pk("other"))]), "keys.agent_single_propose_key"],
    ["a key for another receiver", (c, a) => (c.keys[a] = [fc(pk("a"), { receiver_id: "intents.sandbox" })]), "keys.agent_single_propose_key"],
    ["an extra method", (c, a) => (c.keys[a] = [fc(pk("a"), { method_names: ["propose_order", "revoke"] })]), "keys.agent_single_propose_key"],
    ["any method (empty list)", (c, a) => (c.keys[a] = [fc(pk("a"), { method_names: [] })]), "keys.agent_single_propose_key"],
    ["an allowance above the cap", (c, a) => (c.keys[a] = [fc(pk("a"), { allowance: ALLOWANCE_CAP + 1n })]), "keys.agent_allowance_cap"],
    ["an unlimited allowance", (c, a) => (c.keys[a] = [fc(pk("a"), { allowance: null })]), "keys.agent_allowance_cap"],
  ];

  // gate: LIVE
  it.each(cases)("refuses %s, for a published key and for the primary run alike", async (_name, mutate, id) => {
    for (const m of [published(OPEN), published(CLOSE), manifest(PRIMARY)]) {
      expect(
        await failed(m, (c) => {
          mutate(c, m.accounts.agent);
        }),
      ).toContain(id);
    }
  });

  // gate: LIVE
  it("refuses a credential file holding another key than the chain's", async () => {
    const m = published(OPEN);
    const r = await preflight({ ...input(m, chain(m)), credentialKeys: { owner: pk("o"), agent: pk("other"), filler: pk("f"), filler_intents: pk("fi") } });
    expect(r.checks.find((c) => c.id === "keys.agent_single_propose_key")?.passed).toBe(false);
  });

  // gate: LIVE
  it("names each problem", () => {
    const m = manifest(PRIMARY);
    expect(agentKeyProblems([fc(pk("a"))], m, pk("a"))).toEqual([]);
    expect(agentKeyProblems([fc(pk("a")), full(pk("x"))], m, pk("a"))).toEqual(["the agent account holds 2 access keys, expected exactly one", `${pk("x")} is a full-access key`]);
    expect(agentKeyProblems([fc(pk("a"), { receiver_id: "other.sandbox", method_names: ["propose_order", "x"] })], m, pk("a"))).toEqual([
      `${pk("a")} is for receiver other.sandbox, not the mandate`,
      `${pk("a")} allows methods ["propose_order","x"], not exactly ["propose_order"]`,
    ]);
  });
});

describe("a published agent key on the verifier", () => {
  // gate: LIVE
  it.each(["owner", "filler", "mandate"] as const)("refuses a published key registered as a signing key of the %s account", async (role) => {
    for (const m of [published(OPEN), published(CLOSE)]) {
      expect(await failed(m, (c) => c.verifierKeys.add(`${m.accounts[role]}/${pk("a")}`))).toEqual(["keys.published_agent_key_not_on_verifier"]);
    }
  });

  // gate: LIVE
  it("is checked only for a published key", async () => {
    expect(await ids(published(OPEN))).toContain("keys.published_agent_key_not_on_verifier");
    expect(await ids(manifest(PRIMARY))).not.toContain("keys.published_agent_key_not_on_verifier");
  });
});

describe("the inventory cap", () => {
  const over = (c: Chain) => (c.mandateBalance = { usdc: 500_000_000n, wnear: 100n * NEAR });

  // gate: LIVE
  it("does not stop a run that only revokes, recovers and withdraws, whatever was deposited into the mandate", async () => {
    for (const m of [published(CLOSE), manifest([{ kind: "revoke" }, { kind: "recover", asset: "usdc" }, { kind: "recover", asset: "wnear" }])]) {
      expect(await failed(m, over)).toEqual([]);
      const c = chain(m);
      over(c);
      const listed = (await preflight(input(m, c))).checks.find((x) => x.id === "budget.owner_inventory_listed");
      expect(listed?.observed).toMatchObject({ mandate: { usdc: "500000000", wnear: (100n * NEAR).toString() }, enforced: false });
    }
  });

  // gate: LIVE
  it.each([
    ["a challenge open", published(OPEN)],
    ["a primary-shaped run", manifest(PRIMARY)],
    ["a read-only check", manifest([{ kind: "check" }], { expect_existing_grant: false })],
    ["a close that also proposes", manifest([sell("1"), { kind: "revoke" }])],
  ])("still refuses %s whose mandate holds more than the approved inventory", async (_name, m) => {
    const f = await failed(m, over);
    expect(f).toContain("budget.owner_inventory.usdc");
    expect(f).toContain("budget.owner_inventory.wnear");
  });

  // gate: LIVE
  it("counts a run as returning funds only when every step ends authority or returns funds, and one does", () => {
    expect(returnsFundsOnly(CLOSE)).toBe(true);
    expect(returnsFundsOnly([{ kind: "check" }])).toBe(false);
    expect(returnsFundsOnly(OPEN)).toBe(false);
    expect(returnsFundsOnly([...CLOSE, { kind: "reconcile_registration" }])).toBe(false);
    expect(returnsFundsOnly([{ kind: "revoke" }, { kind: "fill" }])).toBe(false);
  });
});

describe("what the agent's allowance must afford at the gas purchase price", () => {
  const withAllowance = (allowance: bigint) => (c: Chain) => (c.keys["agent.sandbox"] = [fc(pk("a"), { allowance })]);
  // One 150 TGas proposal: (150 + 5) TGas bought at 1e9 yocto per gas.
  const one = 155n * TGAS * PURCHASE_PRICE;

  // gate: LIVE
  it("refuses a primary run whose allowance cannot buy each proposal's prepaid gas after the earlier ones' fees", async () => {
    const m = manifest(PRIMARY);
    // Three agent transactions: two earlier worst-case fees at the gas price, then the third's prepaid gas.
    const need = 2n * 155n * TGAS * GAS_PRICE + one;
    expect(signingFloat(m, m.steps, "agent", GAS_PRICE, PURCHASE_PRICE)).toBe(need);
    expect(await failed(m, withAllowance(need - 1n))).toEqual(["float.agent_allowance"]);
    expect(await failed(m, withAllowance(need))).toEqual([]);
    // An allowance sized at the gas price alone (the pre-protocol-85 reading) buys not even the first proposal.
    expect(await failed(m, withAllowance(3n * 155n * TGAS * GAS_PRICE))).toEqual(["float.agent_allowance"]);
  });

  // gate: LIVE
  it("refuses to open a challenge whose published key cannot buy one proposal", async () => {
    const m = published(OPEN);
    expect(await failed(m, withAllowance(one - 1n))).toEqual(["float.published_agent_allowance_one_proposal"]);
    expect(await failed(m, withAllowance(one))).toEqual([]);
    expect(await failed(m, (c) => (c.agentNear = one - 1n))).toEqual(["float.published_agent_balance_one_proposal"]);
  });

  // gate: LIVE
  it("closes a challenge whose allowance is exhausted", async () => {
    const m = published(CLOSE);
    expect(await failed(m, withAllowance(0n))).toEqual([]);
    expect(await ids(m)).not.toContain("float.published_agent_allowance_one_proposal");
  });

  // gate: LIVE
  it.each(["manifest.live-agent.example.json", "manifest.example.json"])("%s: the allowance cap affords its agent steps at mainnet's purchase price", (name) => {
    const t = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live", name), "utf8")) as { steps: unknown[]; gas_tgas: LiveManifest["gas_tgas"]; keys: { agent: { max_allowance_yocto: string } } };
    const m = manifest(LiveManifest.shape.steps.parse(t.steps), { gas_tgas: LiveManifest.shape.gas_tgas.parse(t.gas_tgas) });
    const agentSteps = m.steps.filter((s) => s.kind === "propose" || s.kind === "refused_proposal").length;
    expect(agentSteps).toBe(3);
    const need = signingFloat(m, m.steps, "agent", GAS_PRICE, PURCHASE_PRICE);
    expect(need).toBe(186n * NEAR / 1000n);
    expect(BigInt(t.keys.agent.max_allowance_yocto)).toBe(ALLOWANCE_CAP);
    expect(need <= ALLOWANCE_CAP).toBe(true);
  });

  // gate: LIVE
  it.each(["manifest.open-challenge.example.json", "manifest.open-challenge-close.example.json"])("%s: the allowance cap affords one proposal at mainnet's purchase price", (name) => {
    const t = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live", name), "utf8")) as { gas_tgas: LiveManifest["gas_tgas"]; keys: { agent: { max_allowance_yocto: string } } };
    const need = (BigInt(t.gas_tgas.propose) + 5n) * TGAS * PURCHASE_PRICE;
    expect(need).toBe(155n * NEAR / 1000n);
    expect(need <= BigInt(t.keys.agent.max_allowance_yocto)).toBe(true);
  });
});
