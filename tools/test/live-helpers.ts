// Shared helpers for the live-orchestrator tests (TEST keys and manifests only).
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseEncode, type KeyPair } from "near-api-js";
import { DECIMALS, PRICE_IDS } from "../src/demo/market.js";
import { AGENT_ALLOWANCE, fillerKey, type World } from "../src/demo/world.js";
import type { LiveManifest } from "../src/live/manifest.js";
import { NEAR } from "../src/near/client.js";
import { sandboxKey } from "../src/near/keys.js";

/** Base58 sha256 of WASM bytes: the NEAR code hash, derived independently of the chain. */
export const hash58 = (bytes: Uint8Array): string => baseEncode(createHash("sha256").update(bytes).digest());

export const writeJson = (dir: string, name: string, value: unknown, mode = 0o600): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, mode);
  return path;
};

export const writeCredential = (dir: string, name: string, accountId: string, key: KeyPair): string =>
  writeJson(dir, name, { account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() });

const pk = (label: string) => sandboxKey(label).getPublicKey().toString();

/** A syntactically valid manifest whose credentials exist; network identity is fake. */
export function offlineManifest(dir: string, over: Partial<LiveManifest> = {}): LiveManifest {
  const accounts = { mandate: "mandate.sandbox", owner: "owner.sandbox", agent: "agent.sandbox", filler: "filler.sandbox", verifier: "intents.sandbox", signer: "mpc.sandbox", oracle: "oracle.sandbox" };
  return {
    schema_version: 2,
    network: { name: "sandbox", chain_id: "test-chain", genesis_hash: "11111111111111111111111111111111", rpc_url: "http://127.0.0.1:9" },
    approval: { approved_by: "test", reference: "unit test" },
    accounts,
    code_hashes: { mandate: "11111111111111111111111111111111", verifier: "11111111111111111111111111111111", signer: "11111111111111111111111111111111", oracle: "11111111111111111111111111111111", usdc: "11111111111111111111111111111111", wnear: "11111111111111111111111111111111" },
    versions: {},
    verifier_fee_pips: 1,
    mandate_config: {
      owner_id: accounts.owner,
      agent_id: accounts.agent,
      verifier_id: accounts.verifier,
      signer_id: accounts.signer,
      oracle_id: accounts.oracle,
      usdc: { token: "usdc.sandbox", decimals: 6, price_id: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a" },
      wnear: { token: "wnear.sandbox", decimals: 24, price_id: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750" },
    },
    keys: { mandate_full_access: [], agent: { public_key: pk("a"), max_allowance_yocto: "1" }, owner: { public_key: pk("o") }, filler: { public_key: pk("f"), intents_public_key: pk("fi") } },
    credentials: {
      owner: writeCredential(dir, "o.json", accounts.owner, sandboxKey("o")),
      agent: writeCredential(dir, "a.json", accounts.agent, sandboxKey("a")),
      filler: writeCredential(dir, "f.json", accounts.filler, sandboxKey("f")),
      filler_intents: writeCredential(dir, "fi.json", accounts.filler, sandboxKey("fi")),
    },
    budget: {
      max_fee_yocto: "0",
      max_deposit_yocto: "0",
      max_transactions: 1,
      owner_inventory_max: { usdc: "0", wnear: "0" },
      max_order_sell: { usdc: "0", wnear: "0" },
      max_total_sell: { usdc: "0", wnear: "0" },
      filler_spend_max: { usdc: "0", wnear: "0" },
      owner_recovery_reserve_yocto: "0",
    },
    gas_tgas: { grant: 250, propose: 150, fill: 100, settle: 50, revoke: 150, reconcile_registration: 200, recover: 80, withdraw: 100, storage_deposit: 30 },
    storage: { order_record_bytes: 1_000, grant_state_bytes: 2_000 },
    expect_existing_grant: false,
    fillable_preexisting_orders: [],
    steps: [{ kind: "check" }],
    ...over,
  };
}

export interface RpcCall {
  method: string;
  params: unknown;
}

/** Records every JSON-RPC request a provider sends (the transport), then forwards it. */
export function recordRpc(provider: object): RpcCall[] {
  const calls: RpcCall[] = [];
  const target = provider as unknown as { sendJsonRpc: (method: string, params: unknown) => Promise<unknown> };
  const original = target.sendJsonRpc.bind(provider);
  target.sendJsonRpc = (method: string, params: unknown) => {
    calls.push({ method, params });
    return original(method, params);
  };
  return calls;
}

/** Replaces a provider's transport with `handler` (no network), recording every request. */
export function stubRpc(provider: object, handler: (method: string, params: unknown) => unknown): RpcCall[] {
  const calls: RpcCall[] = [];
  const target = provider as unknown as { sendJsonRpc: (method: string, params: unknown) => Promise<unknown> };
  target.sendJsonRpc = (method: string, params: unknown) => {
    calls.push({ method, params });
    try {
      return Promise.resolve(handler(method, params));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return calls;
}

/** A sandbox manifest bound to `world` (identities, independently hashed code, TEST credentials); steps: one check. */
export async function sandboxManifest(world: World, dir: string): Promise<LiveManifest> {
  const status = await world.client.nodeStatus();
  const key = (k: World["owner"]["key"]): KeyPair => {
    if (k === null) throw new Error("missing key");
    return k;
  };
  const w = world;
  return offlineManifest(dir, {
    network: { name: "sandbox", chain_id: status.chain_id, genesis_hash: status.genesis_hash, rpc_url: w.client.rpcUrl },
    accounts: { mandate: w.mandate.id, owner: w.owner.id, agent: w.agent.id, filler: w.filler.id, verifier: w.verifier.id, signer: w.mpcId, oracle: w.oracleId },
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
      max_deposit_yocto: (NEAR / 100n).toString(),
      max_transactions: 20,
      owner_inventory_max: { usdc: (1_000n * 10n ** 6n).toString(), wnear: (300n * 10n ** 24n).toString() },
      max_order_sell: { usdc: (20n * 10n ** 6n).toString(), wnear: (10n * 10n ** 24n).toString() },
      max_total_sell: { usdc: (60n * 10n ** 6n).toString(), wnear: (10n * 10n ** 24n).toString() },
      filler_spend_max: { usdc: (60n * 10n ** 6n).toString(), wnear: (20n * 10n ** 24n).toString() },
      owner_recovery_reserve_yocto: (NEAR / 2n).toString(),
    },
  });
}
