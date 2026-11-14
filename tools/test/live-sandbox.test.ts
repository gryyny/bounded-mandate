// Live orchestrator against a local sandbox (never a public network): preflight refusals, a fully
// verified end-to-end run, mid-run budget stop, failed terminal check, unlisted pre-existing order,
// ambiguous outcome without replacement and reconciled resume, and resume refusals. The mainnet template's
// sequence (refused proposal, trade, withheld order relayed after revocation, recovery) runs on the exact
// deployment binary from fixtures/deploy, including an ambiguous relay, an order too close to its deadline, an RPC
// delay that consumes the margin after preparation, RPC views that misreport revocation (zero relay broadcasts),
// and lost propose/revoke responses whose deadline timeline uses the runner's confirmation after reconciliation.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, actions, baseEncode, type SignedTransaction, type TxExecutionStatus } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECIMALS, DEMO_POLICY, PRICE_IDS } from "../src/demo/market.js";
import { AGENT_ALLOWANCE, balances, fillerKey, mintAndDeposit, postPrices, setupWorld, type World } from "../src/demo/world.js";
import { Ledger, canonical } from "../src/live/ledger.js";
import { runLive, type LiveDeps, type LiveResult } from "../src/live/main.js";
import { LiveManifest } from "../src/live/manifest.js";
import { readOnlyChain, readPostSetup, setupProblems, type PrepareInput } from "../src/live/prepare.js";
import { runVerdict } from "../src/page/mainnet.js";
import { totals } from "../src/live/budget.js";
import { worstFee } from "../src/live/preflight.js";
import { NearClient, NEAR } from "../src/near/client.js";
import { MandateClient } from "../src/near/contracts.js";
import { LocalNetwork, REPO_ROOT, requireSuccess } from "../src/near/sandbox.js";
import { offlineManifest, recordRpc, writeCredential, writeJson } from "./live-helpers.js";
import { mkdirSync } from "node:fs";
import { loadRecording, recordingName, replayRecording } from "../src/agent/live-recording.js";
import { RebalanceVerdict } from "../src/agent/rebalance.js";
import { SyntheticProvider, proposeJson } from "./agent-live-helpers.js";
import { PRICES } from "../src/demo/market.js";
import type { Asset } from "../src/types.js";

let net: LocalNetwork;
let world: World;
let dir: string;
let base: LiveManifest;

const hash58 = (bytes: Uint8Array): string => baseEncode(createHash("sha256").update(bytes).digest());
const deps = (extra: Partial<LiveDeps> = {}): LiveDeps => ({ outRoot: join(dir, "live"), timeoutMs: 30_000, pollMs: 300, ...extra });
let counter = 0;
const run = (m: LiveManifest, extra: Partial<LiveDeps> = {}, env: Record<string, string> = {}): Promise<LiveResult> =>
  runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(dir, `m-${counter++}.json`, m), ...env }, deps(extra));
const resume = (path: string, extra: Partial<LiveDeps> = {}): Promise<LiveResult> =>
  runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_RESUME: "1", MANDATE_LIVE_MANIFEST: path }, deps(extra));
const nonce = (account: string, pk: string) => world.client.accessKeyNonce(account, pk);
/** Waits until the final block has caught up with the latest optimistic block (setup writes are optimistic). */
async function settleFinal(): Promise<void> {
  const target = (await world.client.provider.viewBlock({ finality: "optimistic" })).header.height;
  while ((await world.client.provider.viewBlock({ finality: "final" })).header.height < target) await new Promise((r) => setTimeout(r, 200));
}
const failedChecks = (r: LiveResult) => (r.preflight ?? []).filter((c) => !c.passed).map((c) => c.id);

/** Transport that broadcasts a transaction but loses the response, and cannot look it up. */
class LossyProvider extends JsonRpcProvider {
  dropNext = false;
  /** Drops the response of the n-th transaction sent through this provider (1-based). */
  dropAt: number | null = null;
  blind = false;
  private sends = 0;
  override async sendTransactionUntil(tx: SignedTransaction, waitUntil: TxExecutionStatus): ReturnType<JsonRpcProvider["sendTransactionUntil"]> {
    this.sends += 1;
    if (this.dropNext || this.sends === this.dropAt) {
      this.dropNext = false;
      this.blind = true;
      await super.sendTransactionAsync(tx);
      throw new Error("socket hang up (simulated transport loss)");
    }
    return super.sendTransactionUntil(tx, waitUntil);
  }
  override async viewTransactionStatusWithReceipts(params: Parameters<JsonRpcProvider["viewTransactionStatusWithReceipts"]>[0]): ReturnType<JsonRpcProvider["viewTransactionStatusWithReceipts"]> {
    if (this.blind) throw new Error("request timed out (simulated)");
    return super.viewTransactionStatusWithReceipts(params);
  }
}

type Lie = "not_revoked" | "key_op_in_flight" | "key_present";

/**
 * Transport rigged at the relay's preparation: after `armAfter` sends, the first balance read of `trigger` (the
 * relay plan reads the filler's balances, after the pre-check) arms it. Armed, it misreports revocation state in
 * get_grant / has_public_key views, and runs `delay` once before that read returns.
 */
class RigProvider extends JsonRpcProvider {
  armAfter = Number.POSITIVE_INFINITY;
  trigger: string | null = null;
  lie: Lie | null = null;
  delay: (() => Promise<void>) | null = null;
  armed = false;
  private sends = 0;
  override async sendTransactionUntil(tx: SignedTransaction, waitUntil: TxExecutionStatus): ReturnType<JsonRpcProvider["sendTransactionUntil"]> {
    const r = await super.sendTransactionUntil(tx, waitUntil);
    this.sends += 1;
    return r;
  }
  override async callFunctionRaw(params: Parameters<JsonRpcProvider["callFunctionRaw"]>[0]): ReturnType<JsonRpcProvider["callFunctionRaw"]> {
    const p = params as { method?: string; args?: { account_id?: string } };
    if (!this.armed && this.sends >= this.armAfter && p.method === "mt_balance_of" && p.args?.account_id === this.trigger) {
      this.armed = true;
      await this.delay?.();
    }
    const raw = await super.callFunctionRaw(params);
    if (!this.armed || this.lie === null) return raw;
    const json = (v: unknown) => ({ ...raw, result: [...Buffer.from(JSON.stringify(v))] });
    if (p.method === "has_public_key" && this.lie === "key_present") return json(true);
    if (p.method === "get_grant" && this.lie !== "key_present") {
      const grant = JSON.parse(Buffer.from(raw.result).toString("utf8")) as Record<string, unknown>;
      return json(this.lie === "not_revoked" ? { ...grant, status: "revoking" } : { ...grant, key_op_in_flight: true });
    }
    return raw;
  }
}

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  await settleFinal();
  dir = mkdtempSync(join(tmpdir(), "bm-live-sbx-"));
  const status = await world.client.nodeStatus();
  const key = (k: World["owner"]["key"]) => {
    if (k === null) throw new Error("missing key");
    return k;
  };
  const w = world;
  base = offlineManifest(dir, {
    network: { name: "sandbox", chain_id: status.chain_id, genesis_hash: status.genesis_hash, rpc_url: w.client.rpcUrl },
    accounts: { mandate: w.mandate.id, owner: w.owner.id, agent: w.agent.id, filler: w.filler.id, verifier: w.verifier.id, signer: w.mpcId, oracle: w.oracleId },
    // Independently derived from the local build artifacts, not read back from the chain.
    code_hashes: { mandate: hash58(w.wasm.mandate.bytes), verifier: hash58(w.wasm.verifier.bytes), signer: hash58(w.wasm.mpc.bytes), oracle: hash58(w.wasm.oracle.bytes), usdc: hash58(w.wasm.ft.bytes), wnear: hash58(w.wasm.ft.bytes) },
    mandate_config: {
      owner_id: w.owner.id,
      agent_id: w.agent.id,
      verifier_id: w.verifier.id,
      signer_id: w.mpcId,
      oracle_id: w.oracleId,
      usdc: { token: w.tokens.usdc, decimals: DECIMALS.usdc, price_id: PRICE_IDS.usdc },
      wnear: { token: w.tokens.wnear, decimals: DECIMALS.wnear, price_id: PRICE_IDS.wnear },
    },
    keys: {
      mandate_full_access: [],
      agent: { public_key: key(w.agent.key).getPublicKey().toString(), max_allowance_yocto: AGENT_ALLOWANCE.toString() },
      owner: { public_key: key(w.owner.key).getPublicKey().toString() },
      filler: { public_key: key(w.filler.key).getPublicKey().toString(), intents_public_key: fillerKey(w).getPublicKey().toString() },
    },
    credentials: {
      owner: writeCredential(dir, "owner.json", w.owner.id, key(w.owner.key)),
      agent: writeCredential(dir, "agent.json", w.agent.id, key(w.agent.key)),
      filler: writeCredential(dir, "filler.json", w.filler.id, key(w.filler.key)),
      filler_intents: writeCredential(dir, "filler-intents.json", w.filler.id, fillerKey(w)),
    },
    budget: {
      max_fee_yocto: (NEAR / 10n).toString(),
      max_deposit_yocto: "0",
      max_transactions: 20,
      owner_inventory_max: { usdc: (1_000n * 10n ** 6n).toString(), wnear: (300n * 10n ** 24n).toString() },
      max_order_sell: { usdc: (20n * 10n ** 6n).toString(), wnear: (10n * 10n ** 24n).toString() },
      max_total_sell: { usdc: (60n * 10n ** 6n).toString(), wnear: (10n * 10n ** 24n).toString() },
      filler_spend_max: { usdc: (60n * 10n ** 6n).toString(), wnear: (20n * 10n ** 24n).toString() },
      owner_recovery_reserve_yocto: (NEAR / 2n).toString(),
    },
  });
}, 180_000);

afterAll(async () => {
  await net.stop();
  rmSync(dir, { recursive: true, force: true });
});

const sell = (units: bigint) => ({ kind: "propose" as const, source: { from: "manifest" as const, proposal: { sell: "usdc" as const, sell_amount: units.toString(), max_concession_bps: 10 } }, expect: "signed" as const });

describe("preflight binds the chain to the manifest", () => {
  const otherKey = "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct";
  const cases: [string, (m: LiveManifest) => LiveManifest, string][] = [
    ["chain id", (m) => ({ ...m, network: { ...m.network, chain_id: "other-chain" } }), "network.chain_id"],
    ["genesis hash", (m) => ({ ...m, network: { ...m.network, genesis_hash: "11111111111111111111111111111111" } }), "network.genesis_hash"],
    ["mandate code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, mandate: "7dzGdFk3UaY9m3eQedMaiN2tjnxcp1awe1gdo5MH4ywV" } }), "code_hash.mandate"],
    ["verifier code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, verifier: "11111111111111111111111111111111" } }), "code_hash.verifier"],
    ["oracle code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, oracle: "9vafnXzrPYQ4ErDqt2triRkQJHdxtG7tfkyb24t5Ttrg" } }), "code_hash.oracle"],
    ["USDC token code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, usdc: "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q" } }), "code_hash.usdc"],
    ["wNEAR token code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, wnear: "DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1" } }), "code_hash.wnear"],
    ["verifier fee", (m) => ({ ...m, verifier_fee_pips: 2 }), "verifier.fee_pips"],
    ["config price id", (m) => ({ ...m, mandate_config: { ...m.mandate_config, usdc: { ...m.mandate_config.usdc, price_id: "00" } } }), "mandate.config"],
    ["config decimals", (m) => ({ ...m, mandate_config: { ...m.mandate_config, wnear: { ...m.mandate_config.wnear, decimals: 18 } } }), "mandate.config"],
    ["agent allowance above approval", (m) => ({ ...m, keys: { ...m.keys, agent: { ...m.keys.agent, max_allowance_yocto: "1" } } }), "keys.agent_allowance_cap"],
    ["mandate upgrade-key policy", (m) => ({ ...m, keys: { ...m.keys, mandate_full_access: [otherKey] } }), "keys.mandate_policy"],
    ["filler Intents key", (m) => ({ ...m, keys: { ...m.keys, filler: { ...m.keys.filler, intents_public_key: otherKey } } }), "keys.filler_intents_registered"],
    ["owner inventory cap", (m) => ({ ...m, budget: { ...m.budget, owner_inventory_max: { ...m.budget.owner_inventory_max, usdc: "1" } } }), "budget.owner_inventory.usdc"],
    ["worst-case fees", (m) => ({ ...m, budget: { ...m.budget, max_fee_yocto: "1000" }, steps: [{ kind: "grant", policy: DEMO_POLICY }] }), "budget.fees_worst_case_at_live_gas_price"],
    ["owner recovery reserve", (m) => ({ ...m, budget: { ...m.budget, owner_recovery_reserve_yocto: (1_000n * NEAR).toString() } }), "balance.owner_recovery_reserve"],
    ["mandate storage", (m) => ({ ...m, storage: { order_record_bytes: 1_000_000_000, grant_state_bytes: 2_000 }, steps: [sell(1n)] }), "balance.mandate_storage"],
    ["missing oracle price", (m) => ({ ...m, steps: [{ kind: "grant", policy: DEMO_POLICY }] }), "oracle.usdc_fresh_and_confident"],
    ["missing ABI method", (m) => ({ ...m, steps: [{ kind: "reconcile_registration" }] }), "mandate.exports.reconcile_registration"],
  ];

  it.each(cases)("refuses a mismatched %s and sends nothing", async (_name, mutate, id) => {
    const owner = await nonce(world.owner.id, base.keys.owner.public_key);
    const m = mutate(base);
    // The ABI case only refuses when the deployed code really lacks the method.
    if (id === "mandate.exports.reconcile_registration") {
      const { wasmFunctionExports } = await import("../src/near/wasm.js");
      if (wasmFunctionExports(world.wasm.mandate.bytes).includes("reconcile_registration")) {
        const r = await run({ ...m, steps: [{ kind: "check" }] });
        expect(r.message).toBe("completed");
        return;
      }
    }
    const r = await run(m);
    expect(r.exitCode).toBe(2);
    expect(failedChecks(r)).toContain(id);
    expect(await nonce(world.owner.id, base.keys.owner.public_key)).toBe(owner);
  });

  it("refuses an oracle price outside the confidence limit", async () => {
    await postPrices(world, { usdc: { price: 100_000_000n, conf: 600_000n, expo: -8 } }); // 60 bps > 50 bps
    await settleFinal();
    const r = await run({ ...base, steps: [{ kind: "grant", policy: DEMO_POLICY }] });
    expect(r.exitCode).toBe(2);
    expect(failedChecks(r)).toEqual(["oracle.usdc_fresh_and_confident"]);
  });

  it("lists every check with pass/fail, including the MPC grant-path key", async () => {
    await postPrices(world);
    await settleFinal();
    const r = await run({ ...base, steps: [{ kind: "check" }, { kind: "grant", policy: DEMO_POLICY }], budget: { ...base.budget, max_transactions: 0 } });
    const ids = (r.preflight ?? []).map((c) => c.id);
    for (const id of ["mpc.derived_public_key", "oracle.wnear_fresh_and_confident", "verifier.fee_pips", "mandate.no_active_grant", "orders.no_unlisted_open", "keys.mandate_policy", "balance.mandate_storage"]) expect(ids).toContain(id);
    expect(r.preflight?.every((c) => c.passed)).toBe(true);
    // max_transactions 0 stops the grant before it is signed.
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/max_transactions/);
  });
});

describe("verified runs", () => {
  let e2ePath = "";

  it("completes grant, propose, fill, settle, revoke and recovery with every terminal check passing", async () => {
    await postPrices(world);
    await settleFinal();
    const m: LiveManifest = {
      ...base,
      steps: [
        { kind: "check" },
        { kind: "grant", policy: DEMO_POLICY },
        sell(15n * 10n ** 6n),
        { kind: "fill" },
        { kind: "settle" },
        { kind: "revoke" },
        { kind: "recover", asset: "usdc" },
        { kind: "recover", asset: "wnear" },
      ],
    };
    e2ePath = writeJson(dir, "e2e.json", m);
    const ownerBefore = await balances(world, world.owner.id);
    const mandateBefore = await balances(world, world.mandate.id);
    const provider = new JsonRpcProvider({ url: world.client.rpcUrl });
    const calls = recordRpc(provider);
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: e2ePath }, deps({ client: new NearClient(world.client.rpcUrl, provider) }));
    expect(r.message).toBe("completed");
    // Finality on the wire: every state query and block read is final; every transaction is awaited to FINAL.
    const finalityOf = (p: unknown) => (typeof p === "object" && p !== null && "finality" in p ? p.finality : undefined);
    const stateQueries = calls.filter((c) => c.method === "query" && typeof c.params === "object" && c.params !== null && "request_type" in c.params && c.params.request_type !== "view_access_key");
    expect(stateQueries.length).toBeGreaterThan(20);
    expect(stateQueries.filter((c) => finalityOf(c.params) !== "final")).toEqual([]);
    const sends = calls.filter((c) => c.method === "send_tx");
    expect(sends.length).toBe(7);
    expect(sends.every((c) => (c.params as { wait_until?: string }).wait_until === "FINAL")).toBe(true);
    expect(calls.filter((c) => c.method === "block" && finalityOf(c.params) === "optimistic")).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.preflight?.every((c) => c.passed)).toBe(true);
    const ev = r.evidence;
    expect(ev?.mode).toBe("sandbox");
    expect(ev?.assertions.every((a) => a.passed)).toBe(true);
    expect(ev?.assertions.filter((a) => a.id.startsWith("step-")).map((a) => a.id)).toEqual([
      "step-1-check",
      "step-2-grant",
      "step-3-propose",
      "step-4-fill",
      "step-5-settle",
      "step-6-revoke",
      "step-7-recover",
      "step-8-recover",
    ]);
    expect(ev?.receipts.every((x) => x.outcome === "success")).toBe(true);
    expect(ev?.receipts.every((x) => (x.detail as { final?: boolean }).final === true)).toBe(true);
    // Recovery: the owner gained exactly what the mandate held after trading.
    const mandateAfter = await balances(world, world.mandate.id);
    const ownerAfter = await balances(world, world.owner.id);
    expect(mandateAfter).toEqual({ usdc: 0n, wnear: 0n });
    expect(ownerAfter.usdc - ownerBefore.usdc).toBe(mandateBefore.usdc - 15n * 10n ** 6n);
    // Fees come from receipts and stay under the cap.
    const fees = (ev?.receipts ?? []).reduce((s, x) => s + BigInt((x.detail as { fee_yocto?: string }).fee_yocto ?? "0"), 0n);
    expect(fees > 0n && fees <= NEAR / 10n).toBe(true);
  });

  it("a resume of a finished run reconciles and does nothing", async () => {
    const r = await resume(e2ePath);
    expect(r.message).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  it("refuses to resume when chain state shows a transaction the ledger does not record", async () => {
    requireSuccess(await world.client.send("out-of-band owner tx", world.owner.account, world.relayer.id, [actions.transfer(1n)], "transfer"));
    await settleFinal();
    const r = await resume(e2ePath);
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/owner key nonce on chain/);
  });

  it("refuses to resume a tampered ledger", async () => {
    const sha = createHash("sha256").update(readFileSync(e2ePath)).digest("hex");
    const file = join(Ledger.dirFor(join(dir, "live"), sha), "ledger.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace(/"fee_yocto":"[1-9]/, '"fee_yocto":"0'));
    const r = await resume(e2ePath);
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/hash chain/);
  });

  it("a lost grant response under the template cap resumes within budget, reserving each intent once", async () => {
    const template = LiveManifest.parse({ ...(JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.example.json"), "utf8")) as Record<string, unknown>), network: base.network, accounts: base.accounts, code_hashes: base.code_hashes, versions: {}, mandate_config: base.mandate_config, keys: base.keys, credentials: base.credentials, expected_nonces: undefined, expected_owner_keys: undefined, budget: base.budget });
    await mintAndDeposit(world, world.owner, "usdc", 5n * 10n ** 6n, world.mandate.id);
    await mintAndDeposit(world, world.owner, "wnear", 1n * 10n ** 24n, world.mandate.id);
    await postPrices(world);
    await settleFinal();
    const tpl = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.example.json"), "utf8")) as { budget: { max_fee_yocto: string }; gas_tgas: LiveManifest["gas_tgas"]; steps: LiveManifest["steps"] };
    const m: LiveManifest = { ...template, budget: { ...base.budget, max_fee_yocto: tpl.budget.max_fee_yocto }, gas_tgas: tpl.gas_tgas, steps: tpl.steps };
    const cap = BigInt(tpl.budget.max_fee_yocto);
    const gasPrice = await world.client.gasPrice();
    const worstAll = m.steps.reduce((s, x) => s + worstFee(m, x.kind, gasPrice), 0n);
    // The scenario is meaningful: reserving the grant twice would exceed the template cap.
    expect(worstAll <= cap).toBe(true);
    expect(worstAll + worstFee(m, "grant", gasPrice) > cap).toBe(true);
    const path = writeJson(dir, "lost-grant.json", m);
    const provider = new LossyProvider({ url: world.client.rpcUrl });
    provider.dropNext = true;
    const first = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps({ client: new NearClient(world.client.rpcUrl, provider) }));
    expect(first.exitCode).toBe(1);
    expect(first.message).toMatch(/step 2 grant: ambiguous outcome/);
    const resumed = await resume(path);
    expect(resumed.message).toBe("completed");
    expect(resumed.exitCode).toBe(0);
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    const ledger = Ledger.load(Ledger.dirFor(join(dir, "live"), sha), sha);
    const t = totals(ledger);
    const intents = ledger.ofKind("tx-intent");
    expect(intents.map((e) => e.data.kind)).toEqual(["grant", "refused_proposal", "propose", "fill", "settle", "propose", "revoke", "relay_withheld", "recover", "recover"]);
    expect(t.transactions).toBe(10);
    // Every intent settled to its actual fee: the total equals the sum of recorded actual fees.
    const actual = ledger.entries
      .filter((e) => (e.kind === "tx-result" || e.kind === "reconciled") && e.data.status === "executed")
      .reduce((s, e) => s + BigInt(String(e.data.fee_yocto)), 0n);
    expect(new Set(ledger.entries.filter((e) => e.kind === "reconciled").map((e) => e.data.tx_hash)).size).toBe(1);
    expect(t.fee_yocto).toBe(actual);
    expect(t.fee_yocto > 0n && t.fee_yocto <= cap).toBe(true);
    // The refused proposal and the withheld order are counted as sales: never assumed not to execute.
    expect(t.sold).toEqual({ usdc: 2_000_000n, wnear: 0n });
    expect(await balances(world, world.mandate.id)).toEqual({ usdc: 0n, wnear: 0n });
  });
});

describe("stops", () => {
  let withheld = "";

  it("stops mid-run before a fill whose filler payout exceeds the budget", async () => {
    await mintAndDeposit(world, world.owner, "usdc", 100n * 10n ** 6n, world.mandate.id);
    await mintAndDeposit(world, world.owner, "wnear", 20n * 10n ** 24n, world.mandate.id);
    await postPrices(world);
    await settleFinal();
    const fillerBefore = await balances(world, world.filler.id);
    const storageBefore = (await world.client.accountView(world.mandate.id)).storage_usage;
    const r = await run({
      ...base,
      budget: { ...base.budget, filler_spend_max: { ...base.budget.filler_spend_max, wnear: "1" } },
      steps: [{ kind: "grant", policy: DEMO_POLICY }, sell(15n * 10n ** 6n), { kind: "fill" }],
    });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/filler_spend_max/);
    expect(await balances(world, world.filler.id)).toEqual(fillerBefore);
    // The storage defaults cover one grant and one order record, as observed.
    const grown = (await world.client.accountView(world.mandate.id)).storage_usage - storageBefore;
    expect(grown).toBeGreaterThan(0);
    expect(grown).toBeLessThanOrEqual(base.storage.grant_state_bytes + base.storage.order_record_bytes);
    const orders = await world.mandate.allOrders();
    const last = orders.at(-1);
    expect(last?.state.state).toBe("signed");
    expect(await world.verifier.isNonceUsed(world.mandate.id, last?.payload?.nonce ?? "")).toBe(false);
    withheld = last?.id ?? "";
  });

  it("exits nonzero when a successful transaction fails its terminal check (settle of an unfilled order)", async () => {
    const r = await run({ ...base, expect_existing_grant: true, fillable_preexisting_orders: [withheld], steps: [{ kind: "settle", order_id: withheld }] });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/terminal verification failed.*released:settled/);
    expect(r.evidence?.receipts[0]?.outcome).toBe("success");
  });

  it("refuses an unlisted pre-existing open order and an unexpected active grant at preflight", async () => {
    const fillerBefore = await balances(world, world.filler.id);
    const r = await run({ ...base, steps: [{ kind: "fill", order_id: withheld }] });
    expect(r.exitCode).toBe(2);
    expect(failedChecks(r)).toEqual(expect.arrayContaining(["orders.no_unlisted_open", "mandate.no_active_grant"]));
    expect(await balances(world, world.filler.id)).toEqual(fillerBefore);
  });

  it("refuses at fill time an order neither created by the run nor listed", async () => {
    const r = await run({ ...base, expect_existing_grant: true, fillable_preexisting_orders: [withheld], steps: [{ kind: "fill", order_id: String(Number(withheld) + 1000) }] });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/not created by this run/);
  });

  it("stops on an ambiguous outcome without a replacement, then resumes only after reconciling", async () => {
    await postPrices(world);
    await settleFinal();
    const ordersBefore = (await world.mandate.allOrders()).length;
    const provider = new LossyProvider({ url: world.client.rpcUrl });
    provider.dropNext = true;
    const m: LiveManifest = { ...base, expect_existing_grant: true, fillable_preexisting_orders: [withheld], steps: [sell(5n * 10n ** 6n), { kind: "fill" }, { kind: "settle" }] };
    const path = writeJson(dir, "ambiguous.json", m);
    const first = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps({ client: new NearClient(world.client.rpcUrl, provider) }));
    expect(first.exitCode).toBe(1);
    expect(first.message).toMatch(/ambiguous outcome.*Not resubmitted/);
    // The lost transaction did execute; no second order was created by the orchestrator.
    await new Promise((r) => setTimeout(r, 3_000));
    expect((await world.mandate.allOrders()).length).toBe(ordersBefore + 1);
    const fresh = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps());
    expect(fresh.exitCode).toBe(2);
    expect(fresh.message).toMatch(/ledger already exists/);
    const resumed = await resume(path);
    expect(resumed.message).toBe("completed");
    expect(resumed.exitCode).toBe(0);
    expect((await world.mandate.allOrders()).length).toBe(ordersBefore + 1);
    const order = (await world.mandate.allOrders()).at(-1);
    expect(order?.state).toEqual({ state: "released", reason: "settled" });
  });
});

describe("withheld-order revocation on the exact deployment binary (fixtures/deploy)", () => {
  const FIXTURE = "fixtures/deploy/bounded_mandate-163ccfa-reproducible.wasm";
  const tpl = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.example.json"), "utf8")) as { budget: LiveManifest["budget"]; gas_tgas: LiveManifest["gas_tgas"]; steps: unknown[] };
  let cand: LiveManifest;
  const KINDS = ["check", "grant", "refused_proposal", "propose", "fill", "settle", "propose", "withhold", "revoke", "relay_withheld", "recover", "recover", "check"];

  beforeAll(async () => {
    const bytes = readFileSync(join(REPO_ROOT, FIXTURE));
    const root = net.root.id;
    const candidateId = `candidate.${root}`;
    const config = { ...base.mandate_config, agent_id: `agent2.${root}` };
    await net.createAccount("candidate", { balanceNear: 30n, wasm: bytes, init: { method: "new", args: { config } }, key: "none" });
    const agent2 = await net.createAccount("agent2", { balanceNear: 5n, key: { receiver: candidateId, methods: ["propose_order"], allowance: AGENT_ALLOWANCE } });
    if (agent2.key === null) throw new Error("agent2 key");
    const steps = LiveManifest.shape.steps.parse(tpl.steps);
    expect(steps.map((x) => x.kind)).toEqual(KINDS);
    cand = {
      ...base,
      accounts: { ...base.accounts, mandate: candidateId, agent: agent2.id },
      // Independently hashed from the fixture file, then checked against the chain by preflight.
      code_hashes: { ...base.code_hashes, mandate: hash58(bytes) },
      mandate_config: config,
      keys: { ...base.keys, agent: { public_key: agent2.key.getPublicKey().toString(), max_allowance_yocto: AGENT_ALLOWANCE.toString() } },
      credentials: { ...base.credentials, agent: writeCredential(dir, "agent2.json", agent2.id, agent2.key) },
      gas_tgas: tpl.gas_tgas,
      // The template's caps, except the filler's wNEAR cap: sandbox prices wNEAR at $3, not the mainnet price.
      budget: { ...tpl.budget, filler_spend_max: { usdc: "0", wnear: (10n ** 24n).toString() } },
      steps,
    };
  }, 120_000);

  const fund = async (): Promise<void> => {
    await mintAndDeposit(world, world.owner, "usdc", 5n * 10n ** 6n, cand.accounts.mandate);
    await mintAndDeposit(world, world.owner, "wnear", 125n * 10n ** 22n, cand.accounts.mandate);
    await postPrices(world);
    await settleFinal();
  };
  const ledgerOf = (path: string): Ledger => {
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    return Ledger.load(Ledger.dirFor(join(dir, "live"), sha), sha);
  };
  const assertion = (r: LiveResult, kind: string) => r.evidence?.assertions.find((a) => a.id.endsWith(`-${kind}`) && a.id.startsWith("step-"));
  const mandateOf = () => new MandateClient(world.client, cand.accounts.mandate);

  it("refuses the forbidden proposal, trades, rejects the withheld order after revocation and recovers", async () => {
    await fund();
    const ownerBefore = await balances(world, world.owner.id);
    const mandateBefore = await balances(world, cand.accounts.mandate);
    const path = writeJson(dir, "candidate-e2e.json", cand);
    const provider = new JsonRpcProvider({ url: world.client.rpcUrl });
    const calls = recordRpc(provider);
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps({ client: new NearClient(world.client.rpcUrl, provider) }));
    expect(r.message).toBe("completed");
    expect(r.exitCode).toBe(0);
    const steps = r.evidence?.assertions.filter((a) => a.id.startsWith("step-")) ?? [];
    expect(steps.map((a) => a.id)).toEqual(KINDS.map((k, i) => `step-${i + 1}-${k}`));
    expect(steps.every((a) => a.passed)).toBe(true);
    // The report records the manifest's step kinds, and the page's completion check holds on the runner's own output.
    expect(r.evidence?.environment.manifest_steps).toBe(cand.steps.map((x) => x.kind).join(","));
    expect(r.evidence === undefined ? null : runVerdict(r.evidence)).toMatchObject({ holds: true, cls: "success", missing: [], failedSteps: 0, steps: KINDS.length - 1 });
    expect(JSON.stringify(assertion(r, "refused_proposal")?.observed)).toMatch(/concession above policy maximum/);
    const relay = assertion(r, "relay_withheld")?.observed as { classification: string; error: string; revoked_key: string; mandate_nonce_used: boolean; order_id: string };
    expect(relay.classification).toBe("rejected_revoked_key");
    expect(relay.error).toContain(`public key '${relay.revoked_key}' doesn't exist for account '${cand.accounts.mandate}'`);
    expect(relay.mandate_nonce_used).toBe(false);
    expect((await mandateOf().order(relay.order_id))?.state).toEqual({ state: "released", reason: "key_removed" });
    const sends = calls.filter((c) => c.method === "send_tx");
    expect(sends.length).toBe(10);
    expect(sends.every((c) => (c.params as { wait_until?: string }).wait_until === "FINAL")).toBe(true);
    // The relay submitted exactly the bundle preserved by the withhold step.
    const ledger = ledgerOf(path);
    const withheld = ledger.ofKind("step-done").find((e) => e.data.kind === "withhold")?.data.withheld as { bundle_sha256: string };
    const relayIntent = ledger.ofKind("tx-intent").find((e) => e.data.kind === "relay_withheld");
    const tx = (await world.client.provider.viewTransactionStatusWithReceipts({ txHash: String(relayIntent?.data.tx_hash), accountId: world.filler.id, waitUntil: "FINAL" })) as unknown as { transaction: { actions: { FunctionCall: { args: string } }[] } };
    const sent = JSON.parse(Buffer.from(tx.transaction.actions[0]?.FunctionCall.args ?? "", "base64").toString("utf8")) as { signed: unknown };
    expect(createHash("sha256").update(canonical(sent.signed)).digest("hex")).toBe(withheld.bundle_sha256);
    const t = totals(ledger);
    expect(t.transactions).toBe(10);
    expect(t.sold).toEqual({ usdc: 2_000_000n, wnear: 0n });
    expect(t.fee_yocto > 0n && t.fee_yocto <= BigInt(cand.budget.max_fee_yocto)).toBe(true);
    expect(await balances(world, cand.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
    const ownerAfter = await balances(world, world.owner.id);
    expect(ownerAfter.usdc - ownerBefore.usdc).toBe(mandateBefore.usdc - 1_000_000n);
  }, 300_000);

  it("an ambiguous relay outcome stops; the resume classifies it from chain without sending it again", async () => {
    await fund();
    // A distinct manifest (approval reference): the ledger is keyed by the manifest's sha256.
    const path = writeJson(dir, "candidate-ambiguous-relay.json", { ...cand, approval: { ...cand.approval, reference: "ambiguous relay" } });
    const provider = new LossyProvider({ url: world.client.rpcUrl });
    provider.dropAt = 8; // grant, refused, propose, fill, settle, propose, revoke, relay
    const first = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps({ client: new NearClient(world.client.rpcUrl, provider) }));
    expect([first.message, failedChecks(first)]).toEqual([expect.stringMatching(/step 10 relay_withheld: ambiguous outcome/), []]);
    expect(first.exitCode).toBe(1);
    const resumed = await resume(path);
    expect(resumed.message).toBe("completed");
    expect(resumed.exitCode).toBe(0);
    const steps = resumed.evidence?.assertions.filter((a) => a.id.startsWith("step-")) ?? [];
    expect(steps.map((a) => a.id).sort()).toEqual(KINDS.map((k, i) => `step-${i + 1}-${k}`).sort());
    expect(steps.every((a) => a.passed)).toBe(true);
    // A resumed run's report covers the whole run: the page's completion check holds on it; the stopped one's does not.
    expect(resumed.evidence === undefined ? null : runVerdict(resumed.evidence)).toMatchObject({ holds: true, missing: [] });
    expect(first.evidence === undefined ? null : runVerdict(first.evidence)).toMatchObject({ holds: false, stopped: true });
    expect((assertion(resumed, "relay_withheld")?.observed as { classification: string }).classification).toBe("rejected_revoked_key");
    const ledger = ledgerOf(path);
    expect(ledger.ofKind("tx-intent").filter((e) => e.data.kind === "relay_withheld").length).toBe(1);
    expect(ledger.ofKind("reconciled").map((e) => e.data.step)).toEqual([9]);
    expect(await balances(world, cand.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
  }, 300_000);

  it("after a finished run, R1 accepts the same accounts only as an approved reuse of the revoked grant's epoch", async () => {
    const grant = await mandateOf().grant();
    if (grant === null) throw new Error("the previous test leaves a grant");
    const reuseInput = (reuse: PrepareInput["setup"]["reuse"]): PrepareInput => ({
      schema: "bounded-mandate/prepare-input@1",
      setup: {
        approval: { approved_by: "Test Lead", reference: "setup (sandbox reuse)" },
        accounts: { owner: cand.accounts.owner, mandate: cand.accounts.mandate, agent: cand.accounts.agent, filler: cand.accounts.filler },
        keys: { owner: cand.keys.owner.public_key, agent: cand.keys.agent.public_key, filler: cand.keys.filler.public_key, filler_intents: cand.keys.filler.intents_public_key, mandate_full_access: [] },
        agent_allowance_yocto: AGENT_ALLOWANCE.toString(),
        deposits: { mandate: { usdc: "0", wnear: "0" }, filler: { usdc: "0", wnear: "0" } },
        ...(reuse === undefined ? {} : { reuse }),
      },
      runner: { approval: { approved_by: "Test Lead", reference: "runner (sandbox reuse)" }, grant_timing: { order_ttl_sec: 120, oracle_max_age_sec: 120 }, credentials: cand.credentials },
    });
    const template = { ...(JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.example.json"), "utf8")) as Record<string, unknown>), accounts: cand.accounts, mandate_config: cand.mandate_config };
    const chain = readOnlyChain(new NearClient(world.client.rpcUrl));
    const lifecycle = /^reuse:|has a grant|order record|verifier keys|list_orders/;
    const approved = reuseInput({ previous_manifest_sha256: "0".repeat(64), previous_grant_epoch: grant.epoch, approved_reference: "sandbox reuse" });
    const state = await readPostSetup(chain, approved, template);
    expect(state.recovery).toEqual([expect.objectContaining({ asset: "usdc", in_flight: false }), expect.objectContaining({ asset: "wnear", in_flight: false })]);
    const pins = { chain_id: state.chain.chain_id, genesis_hash: state.chain.genesis_hash, mandate_code_hash: cand.code_hashes.mandate };
    expect(setupProblems(approved, template, state, pins).filter((x) => lifecycle.test(x))).toEqual([]);
    expect(setupProblems(reuseInput(undefined), template, state, pins).join("\n")).toMatch(/has a grant/);
    const wrongEpoch = reuseInput({ previous_manifest_sha256: "0".repeat(64), previous_grant_epoch: grant.epoch + 1, approved_reference: "sandbox reuse" });
    expect(setupProblems(wrongEpoch, template, state, pins).join("\n")).toMatch(/not the approved earlier epoch/);
  }, 120_000);

  it("an order too close to its deadline is not relayed: inconclusive, never a pass; recovery still runs", async () => {
    await fund();
    const steps = cand.steps.map((x) => (x.kind === "relay_withheld" ? { ...x, min_remaining_sec: 3_600 } : x));
    const path = writeJson(dir, "candidate-late-relay.json", { ...cand, approval: { ...cand.approval, reference: "late relay" }, steps });
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps());
    expect([r.message, failedChecks(r)]).toEqual([expect.stringMatching(/completed with findings: step 10 relay_withheld: inconclusive, not sent/), []]);
    expect(r.exitCode).toBe(1);
    const relay = assertion(r, "relay_withheld");
    expect(relay?.passed).toBe(false);
    expect((relay?.observed as { classification: string }).classification).toBe("inconclusive");
    expect(r.evidence?.unknowns.join()).toMatch(/inconclusive/);
    expect(r.evidence === undefined ? null : runVerdict(r.evidence)).toMatchObject({ holds: false, cls: "inconclusive", missing: [] });
    expect(ledgerOf(path).ofKind("tx-intent").map((e) => e.data.kind)).not.toContain("relay_withheld");
    expect(await balances(world, cand.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
    // A resume of the finished run keeps the finding: an inconclusive relay never turns into a pass.
    const again = await resume(path);
    expect(again.exitCode).toBe(1);
    expect(again.message).toMatch(/inconclusive, not sent/);
  }, 300_000);

  // grant, propose, withhold, revoke, relay_withheld, recover usdc, recover wnear: three sends before the relay.
  const GUARD_KINDS = ["grant", "propose", "withhold", "revoke", "relay_withheld", "recover", "recover"];
  const guardSteps = (): LiveManifest["steps"] => cand.steps.filter((_, k) => [1, 6, 7, 8, 9, 10, 11].includes(k));
  const sendsOf = (calls: { method: string }[]) => calls.filter((c) => c.method === "send_tx").length;

  it("never broadcasts the relay while revocation is unconfirmed, a key operation is pending or the key is present; a confirmed resume relays once", async () => {
    expect(guardSteps().map((x) => x.kind)).toEqual(GUARD_KINDS);
    const expected: Record<Lie, string> = { not_revoked: "status revoking", key_op_in_flight: "key operation in flight true", key_present: "key registered true" };
    for (const lie of ["not_revoked", "key_op_in_flight", "key_present"] as const) {
      await fund();
      const path = writeJson(dir, `candidate-guard-${lie}.json`, { ...cand, approval: { ...cand.approval, reference: `guard ${lie}` }, steps: guardSteps() });
      const provider = new RigProvider({ url: world.client.rpcUrl });
      provider.armAfter = 3;
      provider.trigger = cand.accounts.filler;
      provider.lie = lie;
      const calls = recordRpc(provider);
      const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps({ client: new NearClient(world.client.rpcUrl, provider) }));
      expect(provider.armed).toBe(true);
      expect(r.exitCode).toBe(1);
      expect(r.message).toContain("relay_withheld: revocation not confirmed at relay broadcast");
      expect(r.message).toContain(expected[lie]);
      // Signed after preparation, refused by the gate before the broadcast: no relay transaction exists.
      expect(sendsOf(calls)).toBe(3);
      expect(ledgerOf(path).ofKind("tx-intent").map((e) => e.data.kind)).toEqual(["grant", "propose", "revoke"]);
      // Once the views report confirmed revocation, the resume relays the bundle exactly once and recovers.
      const resumed = await resume(path);
      expect(resumed.message).toBe("completed");
      expect((assertion(resumed, "relay_withheld")?.observed as { classification: string }).classification).toBe("rejected_revoked_key");
      expect(ledgerOf(path).ofKind("tx-intent").filter((e) => e.data.kind === "relay_withheld").length).toBe(1);
      expect(await balances(world, cand.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
    }
  }, 900_000);

  it("an RPC delay after preparation that consumes the lifetime margin skips the relay at broadcast: inconclusive, recovery runs", async () => {
    await fund();
    const MIN_S = 90; // of the template's 120 s order lifetime
    const steps = guardSteps().map((x) => (x.kind === "relay_withheld" ? { ...x, min_remaining_sec: MIN_S } : x));
    const path = writeJson(dir, "candidate-relay-delay.json", { ...cand, approval: { ...cand.approval, reference: "relay delay" }, steps });
    const provider = new RigProvider({ url: world.client.rpcUrl });
    provider.armAfter = 3;
    provider.trigger = cand.accounts.filler;
    // Holds the relay plan's balance read until the final block is 2 s past (deadline - MIN_S).
    provider.delay = async () => {
      const deadline = (await mandateOf().allOrders()).reduce((d, o) => (o.deadline_ns !== null && BigInt(o.deadline_ns) > d ? BigInt(o.deadline_ns) : d), 0n);
      while ((await world.client.blockTimestampNs()) < deadline - BigInt(MIN_S - 2) * 1_000_000_000n) await new Promise((res) => setTimeout(res, 500));
    };
    const calls = recordRpc(provider);
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps({ client: new NearClient(world.client.rpcUrl, provider) }));
    expect(provider.armed).toBe(true);
    expect(r.message).toMatch(/completed with findings: step 5 relay_withheld: inconclusive, not sent: order deadline too close or passed at relay broadcast/);
    expect(r.exitCode).toBe(1);
    const relay = assertion(r, "relay_withheld");
    expect(relay?.passed).toBe(false);
    const observed = relay?.observed as { classification: string; timing: { phases: { phase: string; remaining_ms: number | null }[] } };
    expect(observed.classification).toBe("inconclusive");
    const phase = (name: string) => observed.timing.phases.find((x) => x.phase === name);
    expect(phase("relay pre-check")?.remaining_ms ?? 0).toBeGreaterThanOrEqual(MIN_S * 1000);
    expect(phase("relay broadcast")?.remaining_ms ?? Number.POSITIVE_INFINITY).toBeLessThan(MIN_S * 1000);
    expect(observed.timing.phases.map((x) => x.phase)).toEqual([
      "withheld order proposed (sent)",
      "withheld order signed (propose confirmed by runner)",
      "withheld bundle prepared and simulated",
      "revoke sent",
      "revoke confirmed by runner",
      "relay pre-check",
      "relay prepared",
      "relay broadcast",
    ]);
    // A skipped relay still records what revocation bought: the lifetime left at the confirmed removal (pre-check read).
    const windowOf = (observed.timing as unknown as { revocation_window: { remaining_after_confirmed_removal_ms: number; read_after_confirmed_removal_ns: string; deadline_ns: string; expired_when_read: boolean } }).revocation_window;
    expect(windowOf.remaining_after_confirmed_removal_ms).toBe(phase("relay pre-check")?.remaining_ms);
    expect(windowOf.remaining_after_confirmed_removal_ms).toBe(Number((BigInt(windowOf.deadline_ns) - BigInt(windowOf.read_after_confirmed_removal_ns)) / 1_000_000n));
    expect(windowOf.expired_when_read).toBe(false);
    // grant, propose, revoke, recover, recover: the relay was never broadcast.
    expect(sendsOf(calls)).toBe(5);
    expect(ledgerOf(path).ofKind("tx-intent").map((e) => e.data.kind)).not.toContain("relay_withheld");
    expect(await balances(world, cand.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
  }, 300_000);

  it("a lost propose or revoke response is timed by the runner's confirmation after reconciliation, never by the ambiguous response", async () => {
    const cases = [
      { drop: 2, step: 1, kind: "propose", phase: "withheld order signed (propose confirmed by runner)" },
      { drop: 3, step: 3, kind: "revoke", phase: "revoke confirmed by runner" },
    ];
    for (const c of cases) {
      await fund();
      const path = writeJson(dir, `candidate-lost-${c.kind}.json`, { ...cand, approval: { ...cand.approval, reference: `lost ${c.kind}` }, steps: guardSteps() });
      const provider = new LossyProvider({ url: world.client.rpcUrl });
      provider.dropAt = c.drop;
      const first = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path }, deps({ client: new NearClient(world.client.rpcUrl, provider) }));
      expect(first.message).toMatch(new RegExp(`step ${c.step + 1} ${c.kind}: ambiguous outcome`));
      const resumed = await resume(path);
      expect(resumed.message).toBe("completed");
      expect(resumed.exitCode).toBe(0);
      const relay = assertion(resumed, "relay_withheld")?.observed as { classification: string; timing: { phases: { phase: string; at: string }[] } };
      expect(relay.classification).toBe("rejected_revoked_key");
      const ledger = ledgerOf(path);
      const lost = ledger.ofKind("tx-result").filter((e) => e.data.step === c.step);
      expect(lost.map((e) => e.data.status)).toEqual(["ambiguous"]);
      const reconciled = ledger.ofKind("reconciled").filter((e) => e.data.step === c.step);
      expect(reconciled.map((e) => e.data.status)).toEqual(["executed"]);
      const done = ledger.ofKind("step-done").find((e) => e.data.step === c.step);
      const confirmed = relay.timing.phases.find((x) => x.phase === c.phase);
      // The phase is the verified step completion, recorded on the resume after reconciliation.
      expect(confirmed?.at).toBe(done?.at);
      expect(Date.parse(confirmed?.at ?? "")).toBeGreaterThanOrEqual(Date.parse(reconciled[0]?.at ?? ""));
      // Strictly after the lost response. (Timestamps are not identities: the same transaction's "sent" phase can
      // share the lost response's millisecond on a local sandbox.)
      expect(Date.parse(confirmed?.at ?? "")).toBeGreaterThan(Date.parse(lost[0]?.at ?? ""));
      expect(relay.timing.phases.map((x) => x.phase)).toEqual([
        "withheld order proposed (sent)",
        "withheld order signed (propose confirmed by runner)",
        "withheld bundle prepared and simulated",
        "revoke sent",
        "revoke confirmed by runner",
        "relay pre-check",
        "relay prepared",
        "relay broadcast",
      ]);
      expect(await balances(world, cand.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
    }
  }, 600_000);
});

// Model-sourced propose steps with SYNTHETIC provider answers (written by the test, never model output) on a fresh
// mandate: fresh oracle inputs, the 50/50 objective guard, no-action and skipped follow-up steps, and resume safety.
describe("live agent decisions (synthetic provider answers)", () => {
  const USDC = 10n ** 6n;
  const WNEAR = 10n ** 24n;
  let agentM: LiveManifest;
  const modelStep = {
    kind: "propose" as const,
    source: { from: "model" as const, provider: "near-ai" as const, model: "synthetic-never-called", timeout_ms: 10_000, max_tokens: 500, notes: ["synthetic market note"] },
    expect: "signed" as const,
  };

  /** Transport that fails the first get_grant view once armed: a crash after the decision, before signing. */
  class FaultProvider extends JsonRpcProvider {
    failGrantOnce = false;
    override async callFunctionRaw(params: Parameters<JsonRpcProvider["callFunctionRaw"]>[0]): ReturnType<JsonRpcProvider["callFunctionRaw"]> {
      if (this.failGrantOnce && (params as { method?: string }).method === "get_grant") {
        this.failGrantOnce = false;
        throw new Error("simulated crash after the decision, before signing");
      }
      return super.callFunctionRaw(params);
    }
  }

  beforeAll(async () => {
    const root = net.root.id;
    const mandateId = `agentmandate.${root}`;
    const config = { ...base.mandate_config, agent_id: `agent3.${root}` };
    await net.createAccount("agentmandate", { balanceNear: 30n, wasm: world.wasm.mandate.bytes, init: { method: "new", args: { config } }, key: "none" });
    const agent3 = await net.createAccount("agent3", { balanceNear: 5n, key: { receiver: mandateId, methods: ["propose_order"], allowance: AGENT_ALLOWANCE } });
    if (agent3.key === null) throw new Error("agent3 key");
    agentM = {
      ...base,
      accounts: { ...base.accounts, mandate: mandateId, agent: agent3.id },
      mandate_config: config,
      keys: { ...base.keys, agent: { public_key: agent3.key.getPublicKey().toString(), max_allowance_yocto: AGENT_ALLOWANCE.toString() } },
      credentials: { ...base.credentials, agent: writeCredential(dir, "agent3.json", agent3.id, agent3.key) },
      steps: [{ kind: "grant", policy: DEMO_POLICY }, modelStep, { kind: "fill" }, { kind: "settle" }, { kind: "revoke" }, { kind: "recover", asset: "usdc" }, { kind: "recover", asset: "wnear" }],
    };
  }, 120_000);

  const mandateOf = () => new MandateClient(world.client, agentM.accounts.mandate);
  const fund = async (usdc: bigint, wnear: bigint): Promise<void> => {
    await mintAndDeposit(world, world.owner, "usdc", usdc, agentM.accounts.mandate);
    await mintAndDeposit(world, world.owner, "wnear", wnear, agentM.accounts.mandate);
    await postPrices(world);
    await settleFinal();
  };
  const manifestFor = (reference: string): string => writeJson(dir, `agent-${reference.replace(/ /g, "-")}.json`, { ...agentM, approval: { ...agentM.approval, reference } });
  const ledgerOf = (path: string): Ledger => {
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    return Ledger.load(Ledger.dirFor(join(dir, "live"), sha), sha);
  };
  const live = (path: string, extra: Partial<LiveDeps>, env: Record<string, string> = {}) => runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path, ...env }, deps(extra));
  const kinds = (l: Ledger, kind: "tx-intent" | "decision" | "decision-request") => l.ofKind(kind).map((e) => e.data.kind ?? e.data.step);
  const doneOf = (l: Ledger, step: number) => l.ofKind("step-done").find((e) => e.data.step === step)?.data;
  const sendsOf = (calls: { method: string }[]) => calls.filter((c) => c.method === "send_tx").length;

  it("balanced at current prices: no model call, no propose transaction; fill and settle are skipped", async () => {
    await fund(30n * USDC, 10n * WNEAR); // $29.994 vs $30.00 at the oracle stub's 0.9998 / 3.00
    const provider = new SyntheticProvider(proposeJson("usdc", USDC));
    const rpc = new JsonRpcProvider({ url: world.client.rpcUrl });
    const calls = recordRpc(rpc);
    const ordersBefore = (await mandateOf().allOrders()).length;
    const path = manifestFor("balanced");
    const r = await live(path, { client: new NearClient(world.client.rpcUrl, rpc), modelProvider: provider });
    expect(r.message).toBe("completed");
    expect(r.exitCode).toBe(0);
    expect(provider.calls).toBe(0);
    expect(sendsOf(calls)).toBe(4); // grant, revoke, recover, recover
    const l = ledgerOf(path);
    expect(kinds(l, "tx-intent")).toEqual(["grant", "revoke", "recover", "recover"]);
    expect(l.ofKind("decision-request")).toEqual([]);
    const decision = l.ofKind("decision")[0]?.data as { model_called: boolean; verdict: unknown; observations: { block: { height: number }; prices: { usdc: { price: string; publish_time: number } } } };
    expect(decision.model_called).toBe(false);
    expect(RebalanceVerdict.parse(decision.verdict)).toMatchObject({ kind: "no-action", reason: "balanced" });
    expect(decision.observations.prices.usdc.price).toBe("99980000");
    expect(decision.observations.block.height).toBeGreaterThan(0);
    expect(doneOf(l, 1)).toMatchObject({ kind: "propose", no_action: true });
    expect(doneOf(l, 1)?.order_id).toBeUndefined();
    for (const step of [2, 3]) expect(doneOf(l, step)).toMatchObject({ skipped: true, reason: expect.stringMatching(/^step 2 propose made no order \(balanced/) as unknown });
    const steps = r.evidence?.assertions.filter((a) => a.id.startsWith("step-")) ?? [];
    expect(steps.map((a) => a.id)).toEqual(["step-1-grant", "step-2-propose", "step-3-fill", "step-4-settle", "step-5-revoke", "step-6-recover", "step-7-recover"]);
    expect(steps.every((a) => a.passed)).toBe(true);
    expect((await mandateOf().allOrders()).length).toBe(ordersBefore);
    expect(await balances(world, agentM.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
  }, 300_000);

  it("USDC-heavy: exactly one bounded trade, filled and settled; the recording replays to the same verdict", async () => {
    await fund(40n * USDC, 5n * WNEAR); // $39.992 vs $15.00: 72.7% USDC; 50/50 needs ~12.5 USDC, per-order cap ~$11
    const provider = new SyntheticProvider(proposeJson("usdc", 10n * USDC));
    const rpc = new JsonRpcProvider({ url: world.client.rpcUrl });
    const calls = recordRpc(rpc);
    const ordersBefore = (await mandateOf().allOrders()).length;
    const ownerBefore = await balances(world, world.owner.id);
    const mandateBefore = await balances(world, agentM.accounts.mandate);
    const path = manifestFor("usdc heavy");
    const r = await live(path, { client: new NearClient(world.client.rpcUrl, rpc), modelProvider: provider });
    expect(r.message).toBe("completed");
    expect(provider.calls).toBe(1);
    expect(sendsOf(calls)).toBe(7);
    const l = ledgerOf(path);
    expect(kinds(l, "tx-intent")).toEqual(["grant", "propose", "fill", "settle", "revoke", "recover", "recover"]);
    const [request] = l.ofKind("decision-request");
    const [decision] = l.ofKind("decision");
    const intent = l.ofKind("tx-intent").find((e) => e.data.kind === "propose");
    // Request before the call, decision before signing.
    expect(request !== undefined && decision !== undefined && intent !== undefined && request.seq < decision.seq && decision.seq < intent.seq).toBe(true);
    expect(RebalanceVerdict.parse(decision?.data.verdict)).toEqual({ kind: "proposal", proposal: { sell: "usdc", sell_amount: (10n * USDC).toString(), max_concession_bps: 30 }, reason: "synthetic rebalance" });
    expect(BigInt((decision?.data.allocation as { needed_units: string }).needed_units) > 10n * USDC).toBe(true);
    const orders = await mandateOf().allOrders();
    expect(orders.length).toBe(ordersBefore + 1);
    expect(orders.at(-1)).toMatchObject({ sell: "usdc", sell_amount: (10n * USDC).toString(), state: { state: "released", reason: "settled" } });
    expect((await balances(world, world.owner.id)).usdc - ownerBefore.usdc).toBe(mandateBefore.usdc - 10n * USDC);
    const ref = decision?.data.recording as { file: string; sha256: string };
    const rec = loadRecording(l.dir, ref.file, ref.sha256);
    expect(rec.provider).toBe("synthetic");
    expect(rec.snapshot.assets.usdc.price_usd).toBe("0.9998");
    expect((await replayRecording(rec)).verdict).toEqual(decision?.data.verdict);
  }, 300_000);

  it("a wrong-direction answer sends nothing: a finding, fill and settle skipped, recovery runs", async () => {
    await fund(40n * USDC, 5n * WNEAR);
    const provider = new SyntheticProvider(proposeJson("wnear", WNEAR));
    const path = manifestFor("wrong direction");
    const r = await live(path, { modelProvider: provider });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/completed with findings: step 2 propose: agent decision rejected at objective: sells wnear, but usdc is overweight/);
    const l = ledgerOf(path);
    expect(kinds(l, "tx-intent")).toEqual(["grant", "revoke", "recover", "recover"]);
    expect(doneOf(l, 2)).toMatchObject({ skipped: true });
    expect(await balances(world, agentM.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
  }, 300_000);

  it("a crash after the recorded decision: the resume does not ask again, re-checks and submits that proposal once", async () => {
    await fund(40n * USDC, 5n * WNEAR);
    const rpc = new FaultProvider({ url: world.client.rpcUrl });
    const provider = new SyntheticProvider(proposeJson("usdc", 10n * USDC));
    provider.onDecide = () => {
      rpc.failGrantOnce = true;
    };
    const ordersBefore = (await mandateOf().allOrders()).length;
    const path = manifestFor("crash after decision");
    const first = await live(path, { client: new NearClient(world.client.rpcUrl, rpc), modelProvider: provider });
    expect(first.exitCode).toBe(1);
    expect(first.message).toMatch(/simulated crash after the decision/);
    expect(kinds(ledgerOf(path), "tx-intent")).toEqual(["grant"]);
    provider.onDecide = null;
    await postPrices(world);
    await settleFinal();
    const resumed = await live(path, { modelProvider: provider }, { MANDATE_LIVE_RESUME: "1" });
    expect(resumed.message).toBe("completed");
    expect(provider.calls).toBe(1);
    const l = ledgerOf(path);
    expect([l.ofKind("decision-request").length, l.ofKind("decision").length]).toEqual([1, 1]);
    expect(kinds(l, "tx-intent")).toEqual(["grant", "propose", "fill", "settle", "revoke", "recover", "recover"]);
    const detail = l.ofKind("tx-intent").find((e) => e.data.kind === "propose")?.data.detail as { resumed_from_ledger?: boolean; recheck?: { problems: string[] }; decision_seq?: number };
    expect(detail.resumed_from_ledger).toBe(true);
    expect(detail.recheck?.problems).toEqual([]);
    expect(detail.decision_seq).toBe(l.ofKind("decision")[0]?.seq);
    expect((await mandateOf().allOrders()).length).toBe(ordersBefore + 1);
  }, 300_000);

  it("a model request without a recorded result stops the resume; only the explicit flag makes a new, recorded decision", async () => {
    await fund(40n * USDC, 5n * WNEAR);
    const path = manifestFor("request without result");
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    const ledgerDir = Ledger.dirFor(join(dir, "live"), sha);
    const provider = new SyntheticProvider(proposeJson("usdc", 10n * USDC));
    // Blocks the recording file of the pending request, so the run dies between the model call and its result.
    provider.onDecide = () => {
      const lines = readFileSync(join(ledgerDir, "ledger.jsonl"), "utf8").trim().split("\n");
      const seq = (JSON.parse(lines.at(-1) ?? "{}") as { seq: number }).seq;
      mkdirSync(join(ledgerDir, recordingName(1, seq)));
    };
    const ordersBefore = (await mandateOf().allOrders()).length;
    const first = await live(path, { modelProvider: provider });
    expect(first.exitCode).toBe(1);
    expect(first.message).toMatch(/EEXIST/);
    provider.onDecide = null;
    await postPrices(world);
    await settleFinal();
    const refused = await live(path, { modelProvider: provider }, { MANDATE_LIVE_RESUME: "1" });
    expect(refused.exitCode).toBe(1);
    expect(refused.message).toMatch(/step 2 propose: the model request in ledger entry \d+ has no recorded result.*MANDATE_LIVE_ALLOW_NEW_DECISION=1/);
    expect(provider.calls).toBe(1);
    expect(kinds(ledgerOf(path), "tx-intent")).toEqual(["grant"]);
    await postPrices(world);
    await settleFinal();
    const allowed = await live(path, { modelProvider: provider }, { MANDATE_LIVE_RESUME: "1", MANDATE_LIVE_ALLOW_NEW_DECISION: "1" });
    expect(allowed.message).toBe("completed");
    expect(provider.calls).toBe(2);
    const l = ledgerOf(path);
    const requests = l.ofKind("decision-request");
    expect(requests.length).toBe(2);
    expect(requests[1]?.data.supersedes).toBe(requests[0]?.seq);
    expect(l.ofKind("decision").map((e) => e.data.request_seq)).toEqual([requests[1]?.seq]);
    expect(kinds(l, "tx-intent").filter((k) => k === "propose").length).toBe(1);
    expect((await mandateOf().allOrders()).length).toBe(ordersBefore + 1);
  }, 600_000);

  it("an ambiguous propose submission is reconciled from chain on resume, never replaced or re-decided", async () => {
    await fund(40n * USDC, 5n * WNEAR);
    const provider = new SyntheticProvider(proposeJson("usdc", 10n * USDC));
    const lossy = new LossyProvider({ url: world.client.rpcUrl });
    lossy.dropAt = 2; // grant, propose
    const ordersBefore = (await mandateOf().allOrders()).length;
    const path = manifestFor("ambiguous propose");
    const first = await live(path, { client: new NearClient(world.client.rpcUrl, lossy), modelProvider: provider });
    expect(first.message).toMatch(/step 2 propose: ambiguous outcome/);
    const resumed = await live(path, { modelProvider: provider }, { MANDATE_LIVE_RESUME: "1" });
    expect(resumed.message).toBe("completed");
    expect(provider.calls).toBe(1);
    const l = ledgerOf(path);
    expect(kinds(l, "tx-intent").filter((k) => k === "propose").length).toBe(1);
    expect(l.ofKind("decision").length).toBe(1);
    expect(l.ofKind("reconciled").map((e) => e.data.step)).toEqual([1]);
    const orders = await mandateOf().allOrders();
    expect(orders.length).toBe(ordersBefore + 1);
    expect(orders.at(-1)?.state).toEqual({ state: "released", reason: "settled" });
    expect(await balances(world, agentM.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
  }, 300_000);
  /** SYNTHETIC oracle-stub write: the asset's price with an explicit publish time. */
  const setPrice = async (asset: Asset, ageSec: bigint): Promise<void> => {
    const p = PRICES[asset];
    const now = (await world.client.blockTimestampNs()) / 1_000_000_000n;
    requireSuccess(
      await world.client.call(`oracle set_price ${asset} (synthetic, ${ageSec} s old)`, world.operator.account, world.oracleId, "set_price", {
        price_id: PRICE_IDS[asset],
        price: p.price.toString(),
        conf: p.conf.toString(),
        expo: p.expo,
        publish_time: Number(now - ageSec),
      }),
    );
  };

  /** Makes the wNEAR price stale once armed, at the runner's last finalized get_grant read before signing. */
  class StaleAtSigning extends JsonRpcProvider {
    armed = false;
    override async callFunctionRaw(params: Parameters<JsonRpcProvider["callFunctionRaw"]>[0]): ReturnType<JsonRpcProvider["callFunctionRaw"]> {
      const p = params as { method?: string; blockQuery?: { finality?: string } };
      if (this.armed && p.method === "get_grant" && p.blockQuery?.finality !== undefined) {
        this.armed = false;
        await setPrice("wnear", 3_600n);
      }
      return super.callFunctionRaw(params);
    }
  }

  it("prices too close to their maximum age at the pre-signing check: a finding, nothing proposed", async () => {
    await fund(40n * USDC, 5n * WNEAR);
    const provider = new SyntheticProvider(proposeJson("usdc", 10n * USDC));
    // Between the decision and the pre-signing read, USDC becomes 45 s old: 15 s left of 60, below the 30 s margin.
    provider.onDecide = async () => {
      await setPrice("usdc", 45n);
      await settleFinal();
    };
    const path = manifestFor("price margin");
    const r = await live(path, { modelProvider: provider });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/step 2 propose: recorded proposal not acceptable immediately before signing: usdc: price has \d+ s of its 60 s maximum age left, below the 30 s margin/);
    const l = ledgerOf(path);
    expect(kinds(l, "tx-intent")).toEqual(["grant", "revoke", "recover", "recover"]);
    expect(doneOf(l, 2)).toMatchObject({ skipped: true });
    expect(await balances(world, agentM.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
  }, 300_000);

  it("the mandate refuses a guard-accepted proposal (price made stale before its read): a finding, not a stop; revoke and recover run", async () => {
    await fund(40n * USDC, 5n * WNEAR);
    const rpc = new StaleAtSigning({ url: world.client.rpcUrl });
    const provider = new SyntheticProvider(proposeJson("usdc", 10n * USDC));
    provider.onDecide = () => {
      rpc.armed = true;
    };
    const ordersBefore = (await mandateOf().allOrders()).length;
    const path = manifestFor("contract refusal");
    const r = await live(path, { client: new NearClient(world.client.rpcUrl, rpc), modelProvider: provider });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/completed with findings: step 2 propose: the mandate refused the agent's proposal: order \d+ rejected while pricing/);
    const l = ledgerOf(path);
    expect(kinds(l, "tx-intent")).toEqual(["grant", "propose", "revoke", "recover", "recover"]);
    const done = doneOf(l, 1);
    expect(done).toMatchObject({ kind: "propose", refused: true });
    expect(done?.order_id).toBeUndefined();
    for (const step of [2, 3]) expect(doneOf(l, step)).toMatchObject({ skipped: true, reason: expect.stringMatching(/the mandate refused the proposal/) as unknown });
    const orders = await mandateOf().allOrders();
    expect(orders.length).toBe(ordersBefore + 1);
    expect(orders.at(-1)?.state.state).toBe("rejected");
    expect(r.evidence?.assertions.find((a) => a.id === "step-5-revoke")?.passed).toBe(true);
    expect(await balances(world, agentM.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
  }, 300_000);

  it("a lost response to a proposal the mandate refused (insufficient gas attached) resumes to the same finding and completes", async () => {
    await fund(40n * USDC, 5n * WNEAR);
    const provider = new SyntheticProvider(proposeJson("usdc", 10n * USDC));
    const lossy = new LossyProvider({ url: world.client.rpcUrl });
    lossy.dropAt = 2; // grant, propose
    const ordersBefore = (await mandateOf().allOrders()).length;
    // SYNTHETIC misconfiguration: the manifest attaches less gas than propose_order requires, so the mandate panics.
    const path = writeJson(dir, "agent-refused-lost.json", { ...agentM, approval: { ...agentM.approval, reference: "refused lost" }, gas_tgas: { ...agentM.gas_tgas, propose: 20 } });
    const first = await live(path, { client: new NearClient(world.client.rpcUrl, lossy), modelProvider: provider });
    expect(first.message).toMatch(/step 2 propose: ambiguous outcome/);
    const resumed = await live(path, { modelProvider: provider }, { MANDATE_LIVE_RESUME: "1" });
    expect(resumed.exitCode).toBe(1);
    expect(resumed.message).toMatch(/completed with findings: step 2 propose: the mandate refused the agent's proposal: propose_order panicked on the mandate/);
    expect(provider.calls).toBe(1);
    const l = ledgerOf(path);
    expect(l.ofKind("reconciled").map((e) => [e.data.step, e.data.success])).toEqual([[1, false]]);
    expect(kinds(l, "tx-intent")).toEqual(["grant", "propose", "revoke", "recover", "recover"]);
    expect(JSON.stringify(doneOf(l, 1)?.verification)).toMatch(/insufficient gas attached/);
    expect(doneOf(l, 2)).toMatchObject({ skipped: true });
    expect((await mandateOf().allOrders()).length).toBe(ordersBefore);
    expect(await balances(world, agentM.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
    // A further resume of the finished run keeps the finding and sends nothing.
    const again = await live(path, { modelProvider: provider }, { MANDATE_LIVE_RESUME: "1" });
    expect(again.exitCode).toBe(1);
    expect(kinds(ledgerOf(path), "tx-intent").length).toBe(5);
  }, 300_000);
});
