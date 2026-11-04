// Shared helpers for the live-orchestrator tests (TEST keys and manifests only).
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyPair } from "near-api-js";
import type { LiveManifest } from "../src/live/manifest.js";
import { sandboxKey } from "../src/near/keys.js";

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
    code_hashes: { mandate: "11111111111111111111111111111111", verifier: "11111111111111111111111111111111", signer: "11111111111111111111111111111111", oracle: "11111111111111111111111111111111" },
    versions: {},
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
    },
    gas_tgas: { grant: 250, propose: 150, fill: 100, settle: 50, revoke: 150, reconcile_registration: 200, recover: 80 },
    fillable_preexisting_orders: [],
    steps: [{ kind: "check" }],
    ...over,
  };
}
