// Live orchestrator against a local sandbox (never a public network): preflight refusals, a fully
// verified end-to-end run, mid-run budget stop, failed terminal check, unlisted pre-existing order,
// ambiguous outcome without replacement and reconciled resume, and resume refusals. The mainnet template's
// sequence (refused proposal, trade, withheld order relayed after revocation, recovery) runs on the exact
// deployment binary from fixtures/deploy, including an ambiguous relay and an order too close to its deadline.
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
import { totals } from "../src/live/budget.js";
import { worstFee } from "../src/live/preflight.js";
import { NearClient, NEAR } from "../src/near/client.js";
import { MandateClient } from "../src/near/contracts.js";
import { LocalNetwork, REPO_ROOT, requireSuccess } from "../src/near/sandbox.js";
import { offlineManifest, recordRpc, writeCredential, writeJson } from "./live-helpers.js";

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
    const template = LiveManifest.parse({ ...(JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.example.json"), "utf8")) as Record<string, unknown>), network: base.network, accounts: base.accounts, code_hashes: base.code_hashes, versions: {}, mandate_config: base.mandate_config, keys: base.keys, credentials: base.credentials, expected_nonces: undefined, budget: base.budget });
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
    expect((assertion(resumed, "relay_withheld")?.observed as { classification: string }).classification).toBe("rejected_revoked_key");
    const ledger = ledgerOf(path);
    expect(ledger.ofKind("tx-intent").filter((e) => e.data.kind === "relay_withheld").length).toBe(1);
    expect(ledger.ofKind("reconciled").map((e) => e.data.step)).toEqual([9]);
    expect(await balances(world, cand.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
  }, 300_000);

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
    expect(ledgerOf(path).ofKind("tx-intent").map((e) => e.data.kind)).not.toContain("relay_withheld");
    expect(await balances(world, cand.accounts.mandate)).toEqual({ usdc: 0n, wnear: 0n });
    // A resume of the finished run keeps the finding: an inconclusive relay never turns into a pass.
    const again = await resume(path);
    expect(again.exitCode).toBe(1);
    expect(again.message).toMatch(/inconclusive, not sent/);
  }, 300_000);
});
