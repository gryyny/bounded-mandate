// Preflight: bind the chain we are talking to and every identity, code, key, dependency and balance to
// the approved manifest. Every check is listed with pass/fail; any failure refuses the run before a
// transaction is signed. All reads use the client's finality ("final" in live runs).
import { z } from "zod";
import type { NearClient } from "../near/client.js";
import { OPEN_ORDER_STATES, type MandateClient, type VerifierClient } from "../near/contracts.js";
import { wasmFunctionExports } from "../near/wasm.js";
import type { Asset, OrderView, Policy } from "../types.js";
import { canonical } from "./ledger.js";
import type { LiveManifest, Step, StepKind } from "./manifest.js";

export interface Check {
  id: string;
  passed: boolean;
  observed: unknown;
}

export interface PreflightFacts {
  chain_id: string;
  genesis_hash: string;
  gas_price: string;
  storage_amount_per_byte: string;
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
const PythPrice = z.object({ price: z.string(), conf: z.string(), expo: z.number().int(), publish_time: z.number().int() }).loose();
const ProtocolConfig = z.object({ runtime_config: z.object({ storage_amount_per_byte: z.string() }).loose() }).loose();

export interface PreflightInput {
  client: NearClient;
  manifest: LiveManifest;
  mandate: MandateClient;
  verifier: VerifierClient;
  /** Public keys of the loaded credential files. */
  credentialKeys: Record<"owner" | "agent" | "filler" | "filler_intents", string>;
  /** Fresh start (true) or resume of an existing ledger. */
  fresh: boolean;
  /** Fees already reserved or spent according to the ledger (resume). */
  spentFeeYocto: bigint;
  /** Steps that will still send a new transaction (steps already intended are reserved in the ledger). */
  pending: Step[];
  /** Orders created by this run (resume). */
  createdOrders: string[];
}

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const { client, manifest: m, mandate, verifier, pending } = input;
  const checks: Check[] = [];
  const check = (id: string, passed: boolean, observed: unknown): void => {
    checks.push({ id, passed, observed });
  };
  const has = (kind: StepKind) => pending.some((s) => s.kind === kind);

  // Network and pinned code.
  const status = await client.nodeStatus();
  check("network.chain_id", status.chain_id === m.network.chain_id, { chain: status.chain_id, manifest: m.network.chain_id });
  check("network.genesis_hash", status.genesis_hash === m.network.genesis_hash, { chain: status.genesis_hash, manifest: m.network.genesis_hash });
  for (const role of ["mandate", "verifier", "signer", "oracle"] as const) {
    const account = m.accounts[role];
    const info = await client.accountView(account).catch(() => null);
    check(`code_hash.${role}`, info?.code_hash === m.code_hashes[role], { account, chain: info?.code_hash ?? null, manifest: m.code_hashes[role] });
  }
  for (const asset of ["usdc", "wnear"] as const) {
    const account = m.mandate_config[asset].token;
    const info = await client.accountView(account).catch(() => null);
    check(`code_hash.${asset}`, info?.code_hash === m.code_hashes[asset], { account, chain: info?.code_hash ?? null, manifest: m.code_hashes[asset] });
  }
  for (const role of ["verifier", "signer", "oracle"] as const) {
    const expected = m.versions[role];
    if (expected === undefined) continue;
    const meta = await client.tryView(m.accounts[role], "contract_source_metadata", {}, SourceMetadata);
    const version = meta.ok ? (meta.value.version ?? null) : null;
    check(`version.${role}`, version === expected, { chain: version, manifest: expected });
  }
  const fee = await verifier.feePips().catch(() => null);
  check("verifier.fee_pips", fee === BigInt(m.verifier_fee_pips), { chain: fee?.toString() ?? null, manifest: m.verifier_fee_pips });

  // Mandate configuration and deployed methods.
  const config = await mandate.config();
  check("mandate.config", canonical(config) === canonical(m.mandate_config), { chain: config, manifest: m.mandate_config });
  check(
    "mandate.config.accounts",
    config.owner_id === m.accounts.owner && config.agent_id === m.accounts.agent && config.verifier_id === m.accounts.verifier && config.signer_id === m.accounts.signer && config.oracle_id === m.accounts.oracle,
    { config_roles: [config.owner_id, config.agent_id, config.verifier_id, config.signer_id, config.oracle_id] },
  );
  const exports = new Set(wasmFunctionExports(await client.code(m.accounts.mandate)));
  for (const method of new Set(pending.flatMap((s) => STEP_METHODS[s.kind] ?? []))) check(`mandate.exports.${method}`, exports.has(method), { method, present: exports.has(method) });

  // Access keys.
  const mandateKeys = await client.accessKeys(m.accounts.mandate);
  const mandateFull = mandateKeys.filter((k) => k.permission.kind === "full").map((k) => k.public_key).sort();
  check("keys.mandate_policy", mandateKeys.length === mandateFull.length && canonical(mandateFull) === canonical([...m.keys.mandate_full_access].sort()), {
    chain: mandateKeys.map((k) => ({ public_key: k.public_key, permission: k.permission.kind })),
    manifest_full_access: m.keys.mandate_full_access,
  });
  const agentKeys = await client.accessKeys(m.accounts.agent);
  const agentKey = agentKeys[0];
  const allowance = agentKey?.permission.kind === "function_call" ? agentKey.permission.allowance : null;
  const agentShape =
    agentKeys.length === 1 &&
    agentKey !== undefined &&
    agentKey.public_key === m.keys.agent.public_key &&
    agentKey.public_key === input.credentialKeys.agent &&
    agentKey.permission.kind === "function_call" &&
    agentKey.permission.receiver_id === m.accounts.mandate &&
    canonical(agentKey.permission.method_names) === canonical(["propose_order"]);
  check("keys.agent_single_propose_key", agentShape, {
    keys: agentKeys.map((k) => ({ public_key: k.public_key, permission: k.permission.kind === "full" ? "full" : { ...k.permission, allowance: k.permission.allowance?.toString() ?? null } })),
    manifest: m.keys.agent.public_key,
  });
  check("keys.agent_allowance_cap", allowance !== null && allowance <= BigInt(m.keys.agent.max_allowance_yocto), { chain: allowance?.toString() ?? null, cap: m.keys.agent.max_allowance_yocto });

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
  check("keys.filler_intents_registered", registered && intentsKey === input.credentialKeys.filler_intents, { registered, manifest: intentsKey, credential: input.credentialKeys.filler_intents });
  const nonces = { owner: owner.nonce ?? -1n, agent: agentKey?.nonce ?? -1n, filler: filler.nonce ?? -1n };
  if (input.fresh && m.expected_nonces !== undefined) {
    const e = m.expected_nonces;
    check("keys.unused_since_approval", nonces.owner.toString() === e.owner && nonces.agent.toString() === e.agent && nonces.filler.toString() === e.filler, {
      chain: { owner: nonces.owner.toString(), agent: nonces.agent.toString(), filler: nonces.filler.toString() },
      manifest: e,
    });
  }

  // Grant state and open orders.
  const grant = await mandate.grant();
  if (input.fresh && !m.expect_existing_grant) {
    check("mandate.no_active_grant", grant === null || (grant.status === "revoked" && !grant.key_op_in_flight), { status: grant?.status ?? null, key_op_in_flight: grant?.key_op_in_flight ?? null });
  } else {
    check("mandate.grant_state_listed", true, { status: grant?.status ?? null, epoch: grant?.epoch ?? null, expect_existing_grant: m.expect_existing_grant });
  }
  const orders: OrderView[] = await mandate.allOrders();
  const open = orders.filter((o) => OPEN_ORDER_STATES.includes(o.state.state)).map((o) => ({ id: o.id, state: o.state.state, epoch: o.epoch, sell: o.sell, sell_amount: o.sell_amount }));
  const unlisted = open.filter((o) => !m.fillable_preexisting_orders.includes(o.id) && !input.createdOrders.includes(o.id));
  check("orders.no_unlisted_open", unlisted.length === 0, { open, unlisted: unlisted.map((o) => o.id) });

  // Dependencies needed by the pending steps (recovery alone needs neither oracle nor MPC).
  if (has("grant") || has("propose")) {
    const grantStep = pending.find((s): s is Extract<Step, { kind: "grant" }> => s.kind === "grant");
    const policy: Policy | null = grantStep?.policy ?? grant?.policy ?? null;
    if (policy === null) {
      check("oracle.policy_known", false, "no grant step or grant to take oracle age/confidence limits from");
    } else {
      for (const asset of ["usdc", "wnear"] as const) {
        const r = await client.tryView(m.accounts.oracle, "get_price_no_older_than", { price_id: m.mandate_config[asset].price_id, age: policy.oracle_max_age_sec }, PythPrice.nullable());
        const price = r.ok ? r.value : null;
        const ok = price !== null && BigInt(price.price) > 0n && BigInt(price.conf) * 10_000n <= BigInt(price.price) * BigInt(policy.max_confidence_bps);
        check(`oracle.${asset}_fresh_and_confident`, ok, { price, max_age_sec: policy.oracle_max_age_sec, max_confidence_bps: policy.max_confidence_bps, ...(r.ok ? {} : { error: r.error }) });
      }
    }
  }
  if (has("grant")) {
    const path = `mandate/v1/${(grant?.epoch ?? 0) + 1}`;
    const key = await client.tryView(m.accounts.signer, "derived_public_key", { path, predecessor: m.accounts.mandate, domain_id: 1 }, z.string());
    check("mpc.derived_public_key", key.ok && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key.value), { path, result: key.ok ? key.value : key.error });
  }

  // Inventory and balances.
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
  for (const s of pending) if (s.kind === "propose" && s.source.from === "manifest") proposedSell[s.source.proposal.sell] += BigInt(s.source.proposal.sell_amount);
  for (const a of ["usdc", "wnear"] as const) {
    if (proposedSell[a] > 0n) check(`balance.mandate_${a}_covers_proposals`, mandateBal[a] >= proposedSell[a], { mandate: mandateBal[a].toString(), proposed: proposedSell[a].toString() });
  }
  if (has("fill")) check("balance.filler_inventory", fillerBal.usdc > 0n || fillerBal.wnear > 0n, { filler: { usdc: fillerBal.usdc.toString(), wnear: fillerBal.wnear.toString() } });

  // Fees at the live gas price, the owner's recovery reserve and the mandate's storage.
  const gasPrice = await client.gasPrice();
  const perByte = BigInt(ProtocolConfig.parse(await client.provider.experimental_protocolConfig({ finality: client.finality })).runtime_config.storage_amount_per_byte);
  let worst = 0n;
  const perSigner: Record<"owner" | "agent" | "filler", bigint> = { owner: 0n, agent: 0n, filler: 0n };
  for (const s of pending) {
    const f = worstFee(m, s.kind, gasPrice);
    worst += f;
    const signer = STEP_SIGNER[s.kind];
    if (signer !== undefined) perSigner[signer] += f;
  }
  check("budget.fees_worst_case_at_live_gas_price", input.spentFeeYocto + worst <= BigInt(m.budget.max_fee_yocto), {
    spent_or_reserved: input.spentFeeYocto.toString(),
    worst_case_pending: worst.toString(),
    cap: m.budget.max_fee_yocto,
    gas_price: gasPrice.toString(),
  });
  const free = async (account: string): Promise<bigint> => {
    const info = await client.accountView(account);
    return BigInt(info.amount) - BigInt(info.storage_usage) * perByte;
  };
  const ownerFree = await free(m.accounts.owner);
  check("balance.owner_recovery_reserve", ownerFree - perSigner.owner >= BigInt(m.budget.owner_recovery_reserve_yocto), {
    free: ownerFree.toString(),
    worst_case_fees: perSigner.owner.toString(),
    reserve: m.budget.owner_recovery_reserve_yocto,
  });
  const fillerFree = await free(m.accounts.filler);
  check("balance.filler_near_for_fees", fillerFree >= perSigner.filler, { free: fillerFree.toString(), worst_case_fees: perSigner.filler.toString() });
  check("balance.agent_allowance_for_fees", allowance !== null && allowance >= perSigner.agent, { allowance: allowance?.toString() ?? null, worst_case_fees: perSigner.agent.toString() });
  const storageBytes = BigInt(pending.filter((s) => s.kind === "propose").length) * BigInt(m.storage.order_record_bytes) + BigInt(pending.filter((s) => s.kind === "grant").length) * BigInt(m.storage.grant_state_bytes);
  const mandateFree = await free(m.accounts.mandate);
  check("balance.mandate_storage", mandateFree >= storageBytes * perByte, { free: mandateFree.toString(), expected_bytes: storageBytes.toString(), needed: (storageBytes * perByte).toString() });

  return {
    checks,
    passed: checks.every((c) => c.passed),
    facts: {
      chain_id: status.chain_id,
      genesis_hash: status.genesis_hash,
      gas_price: gasPrice.toString(),
      storage_amount_per_byte: perByte.toString(),
      nonces: { owner: nonces.owner.toString(), agent: nonces.agent.toString(), filler: nonces.filler.toString() },
      mandate_balances: { usdc: mandateBal.usdc.toString(), wnear: mandateBal.wnear.toString() },
      filler_balances: { usdc: fillerBal.usdc.toString(), wnear: fillerBal.wnear.toString() },
      open_orders: open,
    },
  };
}
