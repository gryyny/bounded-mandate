// Live orchestrator against a local sandbox (never a public network): preflight refusals, a fully
// verified end-to-end run, mid-run budget stop, failed terminal check, unlisted pre-existing order,
// ambiguous outcome without replacement and reconciled resume, and resume refusals.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, actions, baseEncode, type SignedTransaction, type TxExecutionStatus } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECIMALS, DEMO_POLICY, PRICE_IDS } from "../src/demo/market.js";
import { AGENT_ALLOWANCE, balances, fillerKey, mintAndDeposit, postPrices, setupWorld, type World } from "../src/demo/world.js";
import { Ledger } from "../src/live/ledger.js";
import { runLive, type LiveDeps, type LiveResult } from "../src/live/main.js";
import type { LiveManifest } from "../src/live/manifest.js";
import { NearClient, NEAR } from "../src/near/client.js";
import { LocalNetwork, requireSuccess } from "../src/near/sandbox.js";
import { offlineManifest, writeCredential, writeJson } from "./live-helpers.js";

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
const failedChecks = (r: LiveResult) => (r.preflight ?? []).filter((c) => !c.passed).map((c) => c.id);

/** Transport that broadcasts a transaction but loses the response, and cannot look it up. */
class LossyProvider extends JsonRpcProvider {
  dropNext = false;
  blind = false;
  override async sendTransactionUntil(tx: SignedTransaction, waitUntil: TxExecutionStatus): ReturnType<JsonRpcProvider["sendTransactionUntil"]> {
    if (this.dropNext) {
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

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
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
    code_hashes: { mandate: hash58(w.wasm.mandate.bytes), verifier: hash58(w.wasm.verifier.bytes), signer: hash58(w.wasm.mpc.bytes), oracle: hash58(w.wasm.oracle.bytes) },
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
    ["chain id", (m) => ({ ...m, network: { ...m.network, chain_id: "mainnet" } }), "network.chain_id"],
    ["genesis hash", (m) => ({ ...m, network: { ...m.network, genesis_hash: "11111111111111111111111111111111" } }), "network.genesis_hash"],
    ["mandate code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, mandate: "11111111111111111111111111111111" } }), "code_hash.mandate"],
    ["verifier code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, verifier: "11111111111111111111111111111111" } }), "code_hash.verifier"],
    ["oracle code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, oracle: "9vafnXzrPYQ4ErDqt2triRkQJHdxtG7tfkyb24t5Ttrg" } }), "code_hash.oracle"],
    ["config price id", (m) => ({ ...m, mandate_config: { ...m.mandate_config, usdc: { ...m.mandate_config.usdc, price_id: "00" } } }), "mandate.config"],
    ["config decimals", (m) => ({ ...m, mandate_config: { ...m.mandate_config, wnear: { ...m.mandate_config.wnear, decimals: 18 } } }), "mandate.config"],
    ["agent allowance above approval", (m) => ({ ...m, keys: { ...m.keys, agent: { ...m.keys.agent, max_allowance_yocto: "1" } } }), "keys.agent"],
    ["mandate upgrade-key policy", (m) => ({ ...m, keys: { ...m.keys, mandate_full_access: [otherKey] } }), "keys.mandate"],
    ["filler Intents key", (m) => ({ ...m, keys: { ...m.keys, filler: { ...m.keys.filler, intents_public_key: otherKey } } }), "keys.filler_intents"],
    ["owner inventory cap", (m) => ({ ...m, budget: { ...m.budget, owner_inventory_max: { ...m.budget.owner_inventory_max, usdc: "1" } } }), "budget.owner_inventory.usdc"],
    ["worst-case fees", (m) => ({ ...m, budget: { ...m.budget, max_fee_yocto: "1000" }, steps: [{ kind: "grant", policy: DEMO_POLICY }] }), "budget.fees.worst_case"],
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
});

describe("verified runs", () => {
  let e2ePath = "";

  it("completes grant, propose, fill, settle, revoke and recovery with every terminal check passing", async () => {
    await postPrices(world);
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
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: e2ePath }, deps());
    expect(r.message).toBe("completed");
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
});

describe("stops", () => {
  let withheld = "";

  it("stops mid-run before a fill whose filler payout exceeds the budget", async () => {
    await mintAndDeposit(world, world.owner, "usdc", 100n * 10n ** 6n, world.mandate.id);
    await mintAndDeposit(world, world.owner, "wnear", 20n * 10n ** 24n, world.mandate.id);
    await postPrices(world);
    const fillerBefore = await balances(world, world.filler.id);
    const r = await run({
      ...base,
      budget: { ...base.budget, filler_spend_max: { ...base.budget.filler_spend_max, wnear: "1" } },
      steps: [{ kind: "grant", policy: DEMO_POLICY }, sell(15n * 10n ** 6n), { kind: "fill" }],
    });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/filler_spend_max/);
    expect(await balances(world, world.filler.id)).toEqual(fillerBefore);
    const orders = await world.mandate.allOrders();
    const last = orders.at(-1);
    expect(last?.state.state).toBe("signed");
    expect(await world.verifier.isNonceUsed(world.mandate.id, last?.payload?.nonce ?? "")).toBe(false);
    withheld = last?.id ?? "";
  });

  it("exits nonzero when a successful transaction fails its terminal check (settle of an unfilled order)", async () => {
    const r = await run({ ...base, fillable_preexisting_orders: [withheld], steps: [{ kind: "settle", order_id: withheld }] });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/terminal verification failed.*released:settled/);
    expect(r.evidence?.receipts[0]?.outcome).toBe("success");
  });

  it("refuses to fill a pre-existing order the manifest does not list", async () => {
    const fillerBefore = await balances(world, world.filler.id);
    const r = await run({ ...base, steps: [{ kind: "fill", order_id: withheld }] });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/not created by this run/);
    expect(await balances(world, world.filler.id)).toEqual(fillerBefore);
  });

  it("stops on an ambiguous outcome without a replacement, then resumes only after reconciling", async () => {
    await postPrices(world);
    const ordersBefore = (await world.mandate.allOrders()).length;
    const provider = new LossyProvider({ url: world.client.rpcUrl });
    provider.dropNext = true;
    const m: LiveManifest = { ...base, steps: [sell(5n * 10n ** 6n), { kind: "fill" }, { kind: "settle" }] };
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
