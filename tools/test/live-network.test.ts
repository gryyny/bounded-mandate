// Network-shape refusals (mainnet manifests with sandbox/test pieces and the converse) and finality of
// every live request, all against a stubbed transport: nothing here reaches any network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, KeyPair, actions, baseEncode } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLive } from "../src/live/main.js";
import { LiveManifest } from "../src/live/manifest.js";
import { MAINNET, deploymentHashes, localBuildHashes, networkProblems } from "../src/live/network.js";
import { receiptTree } from "../src/live/verify.js";
import { NearClient } from "../src/near/client.js";
import { sandboxKey } from "../src/near/keys.js";
import { offlineManifest, stubRpc, writeCredential, writeJson, type RpcCall } from "./live-helpers.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-live-net-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const offline = (): { client: NearClient; calls: RpcCall[] } => {
  const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" });
  const calls = stubRpc(provider, () => {
    throw new Error("offline test transport");
  });
  return { client: new NearClient("https://rpc.mainnet.near.org", provider), calls };
};

let n = 0;
const runMainnet = async (m: LiveManifest) => {
  const path = writeJson(dir, `mn-${n++}.json`, m);
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  const { client, calls } = offline();
  const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path, MANDATE_LIVE_CONFIRM: sha }, { client, outRoot: join(dir, "live") });
  return { r, calls };
};

/** The template, filled with production-shaped values and fresh random (non-derivable) keys. */
function mainnetManifest(): LiveManifest {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.example.json"), "utf8")) as Record<string, unknown>;
  const k = { owner: KeyPair.fromRandom("ed25519"), agent: KeyPair.fromRandom("ed25519"), filler: KeyPair.fromRandom("ed25519"), intents: KeyPair.fromRandom("ed25519") };
  const accounts = { ...(raw.accounts as Record<string, string>), mandate: "mandate.lead.near", owner: "lead.near", agent: "agent.lead.near", filler: "filler.lead.near" };
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "expected_nonces"));
  return LiveManifest.parse({
    ...rest,
    approval: { approved_by: "lead", reference: "test" },
    accounts,
    mandate_config: { ...(raw.mandate_config as Record<string, unknown>), owner_id: accounts.owner, agent_id: accounts.agent },
    keys: {
      mandate_full_access: [],
      agent: { public_key: k.agent.getPublicKey().toString(), max_allowance_yocto: "250000000000000000000000" },
      owner: { public_key: k.owner.getPublicKey().toString() },
      filler: { public_key: k.filler.getPublicKey().toString(), intents_public_key: k.intents.getPublicKey().toString() },
    },
    credentials: {
      owner: writeCredential(dir, `o-${n}.json`, accounts.owner, k.owner),
      agent: writeCredential(dir, `a-${n}.json`, accounts.agent, k.agent),
      filler: writeCredential(dir, `f-${n}.json`, accounts.filler, k.filler),
      filler_intents: writeCredential(dir, `fi-${n}.json`, accounts.filler, k.intents),
    },
  });
}

describe("mainnet manifests refuse anything sandbox- or test-shaped before any RPC", () => {
  it("pins the reproducible mandate build in fixtures/deploy", () => {
    expect(deploymentHashes().get("7dzGdFk3UaY9m3eQedMaiN2tjnxcp1awe1gdo5MH4ywV")).toBe("fixtures/deploy/bounded_mandate-163ccfa-reproducible.wasm");
  });

  it("accepts a production-shaped manifest statically and then only reads (preflight)", async () => {
    const m = mainnetManifest();
    expect(networkProblems(m)).toEqual([]);
    const { r, calls } = await runMainnet(m);
    // The offline transport fails the first read: static validation passed and nothing was sent.
    expect(r.exitCode).not.toBe(0);
    expect(calls[0]?.method).toBe("status");
    expect(calls.filter((c) => c.method === "send_tx" || c.method === "broadcast_tx_commit")).toEqual([]);
  });

  it("requires MANDATE_LIVE_CONFIRM to be the exact manifest sha256", async () => {
    const path = writeJson(dir, `mn-${n++}.json`, mainnetManifest());
    const { client, calls } = offline();
    for (const confirm of [undefined, "0".repeat(64)]) {
      const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path, ...(confirm === undefined ? {} : { MANDATE_LIVE_CONFIRM: confirm }) }, { client, outRoot: join(dir, "live") });
      expect(r.exitCode).toBe(2);
      expect(r.message).toMatch(/MANDATE_LIVE_CONFIRM/);
    }
    expect(calls).toEqual([]);
  });

  const local = [...localBuildHashes().entries()];
  const stub = (name: string): string => {
    const found = local.find(([, path]) => path.includes(name));
    if (found === undefined) throw new Error(`missing local build ${name}: run make (cargo near build) first`);
    return found[0];
  };
  const mutations: [string, (m: LiveManifest) => LiveManifest, RegExp][] = [
    ["localhost RPC", (m) => ({ ...m, network: { ...m.network, rpc_url: "http://localhost:3030" } }), /local\/test RPC host/],
    ["127.0.0.1 RPC", (m) => ({ ...m, network: { ...m.network, rpc_url: "https://127.0.0.1:3030" } }), /local\/test RPC host/],
    ["[::1] RPC", (m) => ({ ...m, network: { ...m.network, rpc_url: "https://[::1]:3030" } }), /local\/test RPC host/],
    ["*.localhost RPC", (m) => ({ ...m, network: { ...m.network, rpc_url: "https://rpc.localhost" } }), /local\/test RPC host/],
    ["*.test RPC", (m) => ({ ...m, network: { ...m.network, rpc_url: "https://rpc.near.test" } }), /local\/test RPC host/],
    ["chain id", (m) => ({ ...m, network: { ...m.network, chain_id: "testnet" } }), /chain_id testnet/],
    ["genesis hash", (m) => ({ ...m, network: { ...m.network, genesis_hash: "11111111111111111111111111111111" } }), /genesis_hash/],
    ["sandbox account", (m) => ({ ...m, accounts: { ...m.accounts, filler: "filler.sandbox" } }), /test\/sandbox account filler\.sandbox/],
    ["sandbox root", (m) => ({ ...m, accounts: { ...m.accounts, owner: "sandbox" }, mandate_config: { ...m.mandate_config, owner_id: "sandbox" } }), /account sandbox/],
    ["test.near account", (m) => ({ ...m, accounts: { ...m.accounts, mandate: "mandate.test.near" } }), /mandate\.test\.near/],
    ["testnet account", (m) => ({ ...m, accounts: { ...m.accounts, agent: "agent.testnet" }, mandate_config: { ...m.mandate_config, agent_id: "agent.testnet" } }), /agent\.testnet/],
    ["sandbox token", (m) => ({ ...m, mandate_config: { ...m.mandate_config, usdc: { ...m.mandate_config.usdc, token: "usdc.sandbox" } } }), /usdc\.sandbox/],
    ["mock MPC code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, signer: stub("mock_mpc") } }), /signer code hash equals local build target\/near\/mock_mpc/],
    ["mock oracle code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, oracle: stub("mock_oracle") } }), /oracle code hash equals local build target\/near\/mock_oracle/],
    ["mock FT code as verifier", (m) => ({ ...m, code_hashes: { ...m.code_hashes, verifier: stub("mock_ft") } }), /verifier code hash equals local build target\/near\/mock_ft/],
    ["non-reproducible mandate build", (m) => ({ ...m, code_hashes: { ...m.code_hashes, mandate: stub("bounded_mandate") } }), /mandate code hash equals local build target\/near\/bounded_mandate/],
    ["unpinned mandate code", (m) => ({ ...m, code_hashes: { ...m.code_hashes, mandate: "11111111111111111111111111111111" } }), /not a pinned reproducible build/],
    ["verifier fee", (m) => ({ ...m, verifier_fee_pips: 2 }), /verifier fee must be pinned/],
    ["agent allowance above 0.25 NEAR", (m) => ({ ...m, keys: { ...m.keys, agent: { ...m.keys.agent, max_allowance_yocto: "250000000000000000000001" } } }), /at most 0\.25 NEAR/],
  ];

  it.each(mutations)("refuses a %s with exit 2 and no RPC request", async (_name, mutate, re) => {
    const { r, calls } = await runMainnet(mutate(mainnetManifest()));
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(re);
    expect(calls).toEqual([]);
  });

  it.each(["owner", "agent", "filler", "filler_intents"] as const)("refuses a sandbox key in the %s credential", async (role) => {
    const m = mainnetManifest();
    const account = role === "filler_intents" ? m.accounts.filler : m.accounts[role];
    const label = role === "filler_intents" ? "filler.sandbox/intents-signing" : `${role}.sandbox`;
    const path = writeCredential(dir, `sbx-${role}-${n++}.json`, account, sandboxKey(label));
    const { r, calls } = await runMainnet({ ...m, credentials: { ...m.credentials, [role]: path } });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(new RegExp(`credential\\.${role} is a publicly derivable`));
    expect(calls).toEqual([]);
  });
});

describe("sandbox manifests refuse mainnet-looking settings", () => {
  const sbx = () => offlineManifest(dir);
  const cases: [string, (m: LiveManifest) => LiveManifest, RegExp][] = [
    ["mainnet RPC", (m) => ({ ...m, network: { ...m.network, rpc_url: "https://rpc.mainnet.near.org" } }), /non-local RPC host/],
    ["mainnet chain id", (m) => ({ ...m, network: { ...m.network, chain_id: "mainnet" } }), /chain_id mainnet/],
    ["mainnet genesis", (m) => ({ ...m, network: { ...m.network, genesis_hash: MAINNET.genesis_hash } }), /mainnet genesis/],
    ["production verifier", (m) => ({ ...m, accounts: { ...m.accounts, verifier: "intents.near" } }), /production account intents\.near/],
    ["production token", (m) => ({ ...m, mandate_config: { ...m.mandate_config, wnear: { ...m.mandate_config.wnear, token: "wrap.near" } } }), /production account wrap\.near/],
    ["mainnet-shaped account", (m) => ({ ...m, accounts: { ...m.accounts, owner: "lead.near" }, mandate_config: { ...m.mandate_config, owner_id: "lead.near" } }), /mainnet-shaped account lead\.near/],
  ];
  it.each(cases)("refuses a %s with exit 2", async (_name, mutate, re) => {
    const { client, calls } = offline();
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(dir, `s-${n++}.json`, mutate(sbx())) }, { client, outRoot: join(dir, "live") });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(re);
    expect(calls).toEqual([]);
  });
});

describe("live requests are finalized", () => {
  const hash = baseEncode(Buffer.alloc(32, 7));
  const tx = (status: string) => ({
    status: { SuccessValue: "" },
    final_execution_status: status,
    transaction: { hash, signer_id: "a.near", receiver_id: "b.near", nonce: 6, actions: [{ FunctionCall: { method_name: "m", args: "", gas: 1, deposit: "1" } }] },
    transaction_outcome: { id: hash, block_hash: hash, outcome: { logs: [], receipt_ids: [], executor_id: "a.near", status: { SuccessReceiptId: hash }, gas_burnt: 1, tokens_burnt: "10" } },
    receipts_outcome: [{ id: "r", block_hash: hash, outcome: { logs: [], receipt_ids: [], executor_id: "b.near", status: { SuccessValue: "" }, gas_burnt: 1, tokens_burnt: "32" } }],
  });
  const handler = (status: string) => (method: string, params: unknown): unknown => {
    const p = params as Record<string, unknown>;
    if (method === "block") return { header: { hash, height: 10, timestamp_nanosec: "1" }, chunks: [] };
    if (method === "gas_price") return { gas_price: "100000000" };
    if (method === "send_tx" || method === "EXPERIMENTAL_tx_status") return tx(status);
    if (method === "query" && p.request_type === "call_function") return { result: [...Buffer.from("true")], logs: [], block_height: 10, block_hash: hash };
    if (method === "query" && p.request_type === "view_account") return { amount: "1", locked: "0", code_hash: hash, storage_usage: 1, block_height: 10, block_hash: hash };
    if (method === "query" && p.request_type === "view_access_key_list") return { keys: [], block_height: 10, block_hash: hash };
    if (method === "query" && p.request_type === "view_access_key") return { nonce: 5, permission: "FullAccess", block_height: 10, block_hash: hash };
    if (method === "query" && p.request_type === "view_code") return { code_base64: "", hash, block_height: 10, block_hash: hash };
    throw new Error(`unexpected ${method}`);
  };

  it("reads final state and awaits transactions to FINAL", async () => {
    const provider = new JsonRpcProvider({ url: "http://stub" });
    const calls = stubRpc(provider, handler("FINAL"));
    const client = new NearClient("http://stub", provider).final();
    await client.view("c.near", "v", {}, (await import("zod")).z.boolean());
    await client.accountView("c.near");
    await client.accessKeys("c.near");
    await client.code("c.near");
    await client.accessKeyNonce("a.near", KeyPair.fromRandom("ed25519").getPublicKey().toString());
    const gas = await client.gasPrice();
    const signer = client.account("a.near", KeyPair.fromRandom("ed25519"));
    const out = await client.submit("t", signer, "b.near", [actions.functionCall("m", {}, 1n, 1n)], "m");
    const resolved = await client.resolve("t", "a.near", hash);

    const queries = calls.filter((c) => c.method === "query").map((c) => c.params as Record<string, unknown>);
    // All state reads are final; the first view_access_key is ours (accessKeyNonce), later ones are the signer's own nonce lookup.
    expect(queries.filter((q) => q.request_type !== "view_access_key").every((q) => q.finality === "final")).toBe(true);
    expect(queries.find((q) => q.request_type === "view_access_key")?.finality).toBe("final");
    const gasCall = calls.find((c) => c.method === "gas_price");
    expect(gasCall?.params).toEqual([hash]);
    expect(calls.filter((c) => c.method === "block").every((c) => (c.params as Record<string, unknown>).finality !== "optimistic")).toBe(true);
    expect(calls.find((c) => c.method === "send_tx")?.params).toMatchObject({ wait_until: "FINAL" });
    expect(calls.find((c) => c.method === "EXPERIMENTAL_tx_status")?.params).toMatchObject({ wait_until: "FINAL" });
    expect(gas).toBe(100_000_000n);
    expect(out).toMatchObject({ final: true, submitted: true, success: true, fee_yocto: "42", deposit_yocto: "1" });
    expect(resolved?.final).toBe(true);
    expect(receiptTree(out)).toEqual([]);
  });

  it("an outcome that is not FINAL fails the receipt-tree check", async () => {
    const provider = new JsonRpcProvider({ url: "http://stub" });
    stubRpc(provider, handler("EXECUTED_OPTIMISTIC"));
    const client = new NearClient("http://stub", provider).final();
    const out = await client.submit("t", client.account("a.near", KeyPair.fromRandom("ed25519")), "b.near", [actions.functionCall("m", {}, 1n, 0n)], "m");
    expect(out.final).toBe(false);
    expect(receiptTree(out).join()).toMatch(/not final/);
  });
});
