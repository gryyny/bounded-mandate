// Preflight: bind the chain we are talking to and every identity, code, key and balance to the approved
// manifest. Any mismatch refuses the run before a transaction is signed.
import { z } from "zod";
import type { NearClient } from "../near/client.js";
import { OPEN_ORDER_STATES, type MandateClient, type VerifierClient } from "../near/contracts.js";
import { wasmFunctionExports } from "../near/wasm.js";
import type { Asset, OrderView } from "../types.js";
import { canonical } from "./ledger.js";
import type { LiveManifest, StepKind } from "./manifest.js";

export interface Check {
  id: string;
  passed: boolean;
  observed: unknown;
}

export interface PreflightFacts {
  chain_id: string;
  genesis_hash: string;
  gas_price: string;
  nonces: Record<"owner" | "agent" | "filler", string>;
  mandate_balances: Record<Asset, string>;
  filler_balances: Record<Asset, string>;
  open_orders: { id: string; state: string; epoch: number; sell: Asset; sell_amount: string }[];
}

export interface PreflightResult {
  checks: Check[];
  facts: PreflightFacts;
  passed: boolean;
}

/** Mandate methods each step calls; they must be exported by the deployed code. */
export const STEP_METHODS: Partial<Record<StepKind, string>> = {
  grant: "grant",
  propose: "propose_order",
  settle: "settle_order",
  revoke: "revoke",
  reconcile_registration: "reconcile_registration",
  recover: "recover",
};

/** Which account signs each transaction-bearing step. */
export const STEP_SIGNER: Partial<Record<StepKind, "owner" | "agent" | "filler">> = {
  grant: "owner",
  propose: "agent",
  fill: "filler",
  settle: "owner",
  revoke: "owner",
  reconcile_registration: "owner",
  recover: "owner",
};

/** Worst-case fee of one step: (prepaid gas + 5 TGas of action/send costs) x gas price. */
export function worstFee(m: LiveManifest, kind: StepKind, gasPrice: bigint): bigint {
  if (kind === "check") return 0n;
  return (BigInt(m.gas_tgas[kind]) + 5n) * 1_000_000_000_000n * gasPrice;
}

const SourceMetadata = z.object({ version: z.string().nullable().optional() }).loose();

export interface PreflightInput {
  client: NearClient;
  manifest: LiveManifest;
  mandate: MandateClient;
  verifier: VerifierClient;
  /** Public keys of the loaded credential files. */
  credentialKeys: Record<"owner" | "agent" | "filler" | "filler_intents", string>;
  /** Fresh start (true) or resume of an existing ledger. */
  fresh: boolean;
  /** Fees already spent according to the ledger (resume). */
  spentFeeYocto: bigint;
  /** Steps not yet completed. */
  remaining: LiveManifest["steps"];
}

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const { client, manifest: m, mandate, verifier } = input;
  const checks: Check[] = [];
  const check = (id: string, passed: boolean, observed: unknown): void => {
    checks.push({ id, passed, observed });
  };

  const status = await client.nodeStatus();
  check("network.chain_id", status.chain_id === m.network.chain_id, { chain: status.chain_id, manifest: m.network.chain_id });
  check("network.genesis_hash", status.genesis_hash === m.network.genesis_hash, { chain: status.genesis_hash, manifest: m.network.genesis_hash });

  for (const role of ["mandate", "verifier", "signer", "oracle"] as const) {
    const account = m.accounts[role];
    const info = await client.accountView(account).catch(() => null);
    check(`code_hash.${role}`, info?.code_hash === m.code_hashes[role], { account, chain: info?.code_hash ?? null, manifest: m.code_hashes[role] });
  }
  for (const role of ["verifier", "signer", "oracle"] as const) {
    const expected = m.versions[role];
    if (expected === undefined) continue;
    const meta = await client.tryView(m.accounts[role], "contract_source_metadata", {}, SourceMetadata);
    const version = meta.ok ? (meta.value.version ?? null) : null;
    check(`version.${role}`, version === expected, { chain: version, manifest: expected });
  }

  const config = await mandate.config();
  check("mandate.config", canonical(config) === canonical(m.mandate_config), { chain: config, manifest: m.mandate_config });
  check(
    "mandate.config.accounts",
    config.owner_id === m.accounts.owner && config.agent_id === m.accounts.agent && config.verifier_id === m.accounts.verifier && config.signer_id === m.accounts.signer && config.oracle_id === m.accounts.oracle,
    { config_roles: [config.owner_id, config.agent_id, config.verifier_id, config.signer_id, config.oracle_id] },
  );

  const exports = new Set(wasmFunctionExports(await client.code(m.accounts.mandate)));
  for (const step of input.remaining) {
    const method = STEP_METHODS[step.kind];
    if (method !== undefined) check(`mandate.exports.${method}`, exports.has(method), { method, present: exports.has(method) });
  }

  // Access keys.
  const mandateKeys = await client.accessKeys(m.accounts.mandate);
  const mandateFull = mandateKeys.filter((k) => k.permission.kind === "full").map((k) => k.public_key).sort();
  check("keys.mandate", mandateKeys.length === mandateFull.length && canonical(mandateFull) === canonical([...m.keys.mandate_full_access].sort()), {
    chain: mandateKeys.map((k) => ({ public_key: k.public_key, permission: k.permission.kind })),
    manifest_full_access: m.keys.mandate_full_access,
  });

  const agentKeys = await client.accessKeys(m.accounts.agent);
  const agentKey = agentKeys[0];
  const agentOk =
    agentKeys.length === 1 &&
    agentKey !== undefined &&
    agentKey.public_key === m.keys.agent.public_key &&
    agentKey.public_key === input.credentialKeys.agent &&
    agentKey.permission.kind === "function_call" &&
    agentKey.permission.receiver_id === m.accounts.mandate &&
    canonical(agentKey.permission.method_names) === canonical(["propose_order"]) &&
    agentKey.permission.allowance !== null &&
    agentKey.permission.allowance <= BigInt(m.keys.agent.max_allowance_yocto);
  check("keys.agent", agentOk, {
    keys: agentKeys.map((k) => ({ public_key: k.public_key, permission: k.permission.kind === "full" ? "full" : { ...k.permission, allowance: k.permission.allowance?.toString() ?? null } })),
    manifest: m.keys.agent,
  });

  const fullKey = async (role: "owner" | "filler"): Promise<{ ok: boolean; nonce: bigint | null }> => {
    const keys = await client.accessKeys(m.accounts[role]);
    const k = keys.find((x) => x.public_key === m.keys[role].public_key);
    return { ok: k !== undefined && k.permission.kind === "full" && k.public_key === input.credentialKeys[role], nonce: k?.nonce ?? null };
  };
  const owner = await fullKey("owner");
  check("keys.owner", owner.ok, { manifest: m.keys.owner.public_key, credential: input.credentialKeys.owner });
  const filler = await fullKey("filler");
  check("keys.filler", filler.ok, { manifest: m.keys.filler.public_key, credential: input.credentialKeys.filler });
  const intentsKey = m.keys.filler.intents_public_key;
  const registered = await verifier.hasPublicKey(m.accounts.filler, intentsKey);
  check("keys.filler_intents", registered && intentsKey === input.credentialKeys.filler_intents, { registered, manifest: intentsKey, credential: input.credentialKeys.filler_intents });

  const nonces = { owner: owner.nonce ?? -1n, agent: agentKey?.nonce ?? -1n, filler: filler.nonce ?? -1n };
  if (input.fresh && m.expected_nonces !== undefined) {
    const e = m.expected_nonces;
    check("keys.unused_since_approval", nonces.owner.toString() === e.owner && nonces.agent.toString() === e.agent && nonces.filler.toString() === e.filler, {
      chain: { owner: nonces.owner.toString(), agent: nonces.agent.toString(), filler: nonces.filler.toString() },
      manifest: e,
    });
  }

  // Balances and open orders.
  const bal = async (account: string): Promise<Record<Asset, bigint>> => ({
    usdc: await verifier.balance(account, m.mandate_config.usdc.token),
    wnear: await verifier.balance(account, m.mandate_config.wnear.token),
  });
  const mandateBal = await bal(m.accounts.mandate);
  const fillerBal = await bal(m.accounts.filler);
  if (input.fresh) {
    for (const a of ["usdc", "wnear"] as const) {
      check(`budget.owner_inventory.${a}`, mandateBal[a] <= BigInt(m.budget.owner_inventory_max[a]), { mandate: mandateBal[a].toString(), cap: m.budget.owner_inventory_max[a] });
    }
  }
  const proposedSell: Record<Asset, bigint> = { usdc: 0n, wnear: 0n };
  for (const s of input.remaining) if (s.kind === "propose" && s.source.from === "manifest") proposedSell[s.source.proposal.sell] += BigInt(s.source.proposal.sell_amount);
  for (const a of ["usdc", "wnear"] as const) {
    if (proposedSell[a] > 0n) check(`balance.mandate.${a}`, mandateBal[a] >= proposedSell[a], { mandate: mandateBal[a].toString(), proposed: proposedSell[a].toString() });
  }
  if (input.remaining.some((s) => s.kind === "fill")) {
    check("balance.filler", fillerBal.usdc > 0n || fillerBal.wnear > 0n, { filler: { usdc: fillerBal.usdc.toString(), wnear: fillerBal.wnear.toString() } });
  }
  const orders: OrderView[] = await mandate.allOrders();
  const open = orders.filter((o) => OPEN_ORDER_STATES.includes(o.state.state)).map((o) => ({ id: o.id, state: o.state.state, epoch: o.epoch, sell: o.sell, sell_amount: o.sell_amount }));
  check("orders.open_listed", true, open);

  // Worst-case fees and deposits for what remains, per payer.
  const gasPrice = await client.gasPrice();
  let worst = 0n;
  const perSigner: Record<"owner" | "agent" | "filler", bigint> = { owner: 0n, agent: 0n, filler: 0n };
  for (const s of input.remaining) {
    const fee = worstFee(m, s.kind, gasPrice);
    worst += fee;
    const signer = STEP_SIGNER[s.kind];
    if (signer !== undefined) perSigner[signer] += fee;
  }
  check("budget.fees.worst_case", input.spentFeeYocto + worst <= BigInt(m.budget.max_fee_yocto), {
    spent: input.spentFeeYocto.toString(),
    worst_case_remaining: worst.toString(),
    cap: m.budget.max_fee_yocto,
    gas_price: gasPrice.toString(),
  });
  for (const role of ["owner", "filler"] as const) {
    const info = await client.accountView(m.accounts[role]);
    check(`balance.near.${role}`, BigInt(info.amount) >= perSigner[role], { available: info.amount, worst_case: perSigner[role].toString() });
  }
  const allowance = agentKey?.permission.kind === "function_call" ? agentKey.permission.allowance : null;
  check("balance.agent_allowance", allowance !== null && allowance >= perSigner.agent, { allowance: allowance?.toString() ?? null, worst_case: perSigner.agent.toString() });

  return {
    checks,
    passed: checks.every((c) => c.passed),
    facts: {
      chain_id: status.chain_id,
      genesis_hash: status.genesis_hash,
      gas_price: gasPrice.toString(),
      nonces: { owner: nonces.owner.toString(), agent: nonces.agent.toString(), filler: nonces.filler.toString() },
      mandate_balances: { usdc: mandateBal.usdc.toString(), wnear: mandateBal.wnear.toString() },
      filler_balances: { usdc: fillerBal.usdc.toString(), wnear: fillerBal.wnear.toString() },
      open_orders: open,
    },
  };
}
