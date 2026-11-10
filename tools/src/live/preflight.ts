// Preflight: bind the chain we are talking to and every identity, code, key, dependency and balance to
// the approved manifest. Every check is listed with pass/fail; any failure refuses the run before a
// transaction is signed. All reads use the client's finality ("final" in live runs).
import { z } from "zod";
import type { AccessKeyInfo, NearClient } from "../near/client.js";
import { OPEN_ORDER_STATES, TokenClient, type MandateClient, type VerifierClient } from "../near/contracts.js";
import { wasmFunctionExports } from "../near/wasm.js";
import type { Asset, OrderView, Policy } from "../types.js";
import { canonical } from "./ledger.js";
import { EXTERNAL_GAS_SLACK_TGAS, isExternal, type LiveManifest, type OwnerKey, type Step, type StepKind } from "./manifest.js";

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
  /** owner_external only when the manifest names a distinct external owner key. */
  nonces: Record<"owner" | "agent" | "filler", string> & { owner_external?: string };
  mandate_balances: Record<Asset, string>;
  filler_balances: Record<Asset, string>;
  open_orders: { id: string; state: string; epoch: number; sell: Asset; sell_amount: string }[];
  /** The owner account's complete access-key list: the run's baseline for keys and untracked nonces. */
  owner_keys: OwnerKey[];
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
  refused_proposal: "propose_order",
  settle: "settle_order",
  revoke: "revoke",
  reconcile_registration: "reconcile_registration",
  recover: "recover",
  revoke_external: "revoke",
  recover_external: "recover",
};

/** Which account signs each transaction-bearing step. */
export const STEP_SIGNER: Partial<Record<StepKind, "owner" | "agent" | "filler">> = {
  grant: "owner",
  propose: "agent",
  refused_proposal: "agent",
  fill: "filler",
  relay_withheld: "filler",
  settle: "owner",
  revoke: "owner",
  reconcile_registration: "owner",
  recover: "owner",
  register_storage: "owner",
  withdraw: "owner",
  // Signed outside the runner, by the owner account's approved external key; the owner account pays the fee.
  revoke_external: "owner",
  recover_external: "owner",
  withdraw_external: "owner",
};

/** Prepaid-gas allocation each transaction-bearing step uses; `check` and `withhold` send nothing. */
export const STEP_GAS: Partial<Record<StepKind, keyof LiveManifest["gas_tgas"]>> = {
  grant: "grant",
  propose: "propose",
  refused_proposal: "propose",
  fill: "fill",
  relay_withheld: "fill",
  settle: "settle",
  revoke: "revoke",
  reconcile_registration: "reconcile_registration",
  recover: "recover",
  register_storage: "storage_deposit",
  withdraw: "withdraw",
  revoke_external: "revoke",
  recover_external: "recover",
  withdraw_external: "withdraw",
};

/** Prepaid gas of one step's action (TGas); an external signer may attach up to the slack more. */
export function stepGasTgas(m: LiveManifest, kind: StepKind): { proposed: number; max: number } | null {
  const gas = STEP_GAS[kind];
  if (gas === undefined) return null;
  const proposed = m.gas_tgas[gas];
  return { proposed, max: isExternal(kind) ? Math.min(300, proposed + EXTERNAL_GAS_SLACK_TGAS) : proposed };
}

/** Worst-case fee of one step: (largest prepaid gas + 5 TGas of action/send costs) x gas price. */
export function worstFee(m: LiveManifest, kind: StepKind, gasPrice: bigint): bigint {
  const gas = stepGasTgas(m, kind);
  if (gas === null) return 0n;
  return (BigInt(gas.max) + 5n) * 1_000_000_000_000n * gasPrice;
}

const SourceMetadata = z.object({ version: z.string().nullable().optional() }).loose();
const PythPrice = z.object({ price: z.string(), conf: z.string(), expo: z.number().int(), publish_time: z.number().int() }).loose();
const ProtocolConfig = z.object({ runtime_config: z.object({ storage_amount_per_byte: z.string(), min_gas_purchase_price: z.string().optional() }).loose() }).loose();

/**
 * Price at which a signer buys prepaid gas: since protocol 85 the higher of the gas price and the runtime's
 * min_gas_purchase_price (EXPERIMENTAL_protocol_config runtime_config); the difference to the burnt price is refunded.
 * Without that field, the gas price.
 */
export function gasPurchasePrice(protocolConfig: unknown, gasPrice: bigint): bigint {
  const min = ProtocolConfig.parse(protocolConfig).runtime_config.min_gas_purchase_price;
  return min !== undefined && BigInt(min) > gasPrice ? BigInt(min) : gasPrice;
}

/**
 * NEAR (or allowance) a signer must hold for its pending steps, signed one at a time: before each step it has spent
 * the worst-case burnt fees of its earlier steps and must still cover that step's prepaid gas at the purchase price.
 */
export function signingFloat(m: LiveManifest, steps: readonly Step[], signer: "owner" | "agent" | "filler", gasPrice: bigint, purchasePrice: bigint): bigint {
  let spent = 0n;
  let need = 0n;
  for (const s of steps) {
    if (STEP_SIGNER[s.kind] !== signer) continue;
    const gas = stepGasTgas(m, s.kind);
    if (gas === null) continue;
    const float = spent + (BigInt(gas.max) + 5n) * 1_000_000_000_000n * purchasePrice;
    if (float > need) need = float;
    spent += worstFee(m, s.kind, gasPrice);
  }
  return need;
}

/** An access-key list in the manifest's form, sorted by public key. */
export function ownerKeySnapshot(keys: readonly AccessKeyInfo[]): OwnerKey[] {
  return keys
    .map((k) => ({
      public_key: k.public_key,
      permission: k.permission.kind === "full" ? ("full_access" as const) : { receiver_id: k.permission.receiver_id, method_names: [...k.permission.method_names].sort() },
      nonce: k.nonce.toString(),
    }))
    .sort((a, b) => (a.public_key < b.public_key ? -1 : a.public_key > b.public_key ? 1 : 0));
}

/**
 * Differences between an expected owner key list and the chain's: an added or removed key, a changed permission, and
 * a changed nonce of any key not in `tracked` (the keys whose nonces the ledger accounts for itself).
 */
export function ownerKeyChanges(expected: readonly OwnerKey[], chain: readonly OwnerKey[], tracked: ReadonlySet<string> = new Set()): string[] {
  const p: string[] = [];
  const perm = (k: OwnerKey) => canonical(k.permission === "full_access" ? k.permission : { ...k.permission, method_names: [...k.permission.method_names].sort() });
  const want = new Map(expected.map((k) => [k.public_key, k]));
  const have = new Map(chain.map((k) => [k.public_key, k]));
  for (const k of chain) if (!want.has(k.public_key)) p.push(`key added: ${k.public_key} (${perm(k)}, nonce ${k.nonce})`);
  for (const k of expected) {
    const c = have.get(k.public_key);
    if (c === undefined) p.push(`key removed: ${k.public_key}`);
    else {
      if (perm(c) !== perm(k)) p.push(`permission of ${k.public_key} changed from ${perm(k)} to ${perm(c)}`);
      if (!tracked.has(k.public_key) && c.nonce !== k.nonce) p.push(`nonce of ${k.public_key}, a key the ledger does not track, changed from ${k.nonce} to ${c.nonce}`);
    }
  }
  return p;
}

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
  /** Filler payouts already counted in the ledger (resume). */
  fillerPaid: Record<Asset, bigint>;
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

  const ownerKeys = await client.accessKeys(m.accounts.owner);
  const fullKey = async (role: "owner" | "filler"): Promise<{ ok: boolean; nonce: bigint | null }> => {
    const keys = role === "owner" ? ownerKeys : await client.accessKeys(m.accounts[role]);
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
  // A distinct key for owner actions signed outside the runner: a full-access key of the owner account.
  const extKey = m.keys.owner_external?.public_key;
  let extNonce: bigint | null = null;
  if (extKey !== undefined && extKey !== m.keys.owner.public_key) {
    const k = ownerKeys.find((x) => x.public_key === extKey);
    extNonce = k?.nonce ?? -1n;
    check("keys.owner_external", k?.permission.kind === "full", { manifest: extKey, present: k !== undefined, permission: k?.permission.kind ?? null });
  }
  if (input.fresh && m.expected_nonces !== undefined) {
    const e = m.expected_nonces;
    // A distinct external key must have its approval-time nonce too: its earlier use would otherwise go unnoticed.
    const extOk = extNonce === null || extNonce.toString() === e.owner_external;
    // A published agent key may be used by anyone after approval; the run never signs with it.
    const agentOk = m.agent_key_published === true || nonces.agent.toString() === e.agent;
    check("keys.unused_since_approval", nonces.owner.toString() === e.owner && agentOk && nonces.filler.toString() === e.filler && extOk, {
      chain: { owner: nonces.owner.toString(), agent: nonces.agent.toString(), filler: nonces.filler.toString(), ...(extNonce === null ? {} : { owner_external: extNonce.toString() }) },
      manifest: e,
    });
  }

  const ownerSnapshot = ownerKeySnapshot(ownerKeys);
  if (input.fresh && m.expected_owner_keys !== undefined) {
    const changes = ownerKeyChanges(m.expected_owner_keys, ownerSnapshot);
    check("keys.owner_key_set_since_approval", changes.length === 0, { changes, chain: ownerSnapshot, manifest: m.expected_owner_keys });
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
  // With a published agent key, anyone may have opened orders of the current grant; such a manifest never acts on an
  // order (publishedKeyProblems), and confirmed revocation releases them.
  const byKeyHolder = (o: { epoch: number }) => m.agent_key_published === true && grant !== null && grant.status !== "revoked" && o.epoch === grant.epoch;
  const unlisted = open.filter((o) => !m.fillable_preexisting_orders.includes(o.id) && !input.createdOrders.includes(o.id) && !byKeyHolder(o));
  check("orders.no_unlisted_open", unlisted.length === 0, { open, unlisted: unlisted.map((o) => o.id), ...(m.agent_key_published === true ? { agent_key_published: true } : {}) });

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
  if (has("fill") || has("withhold")) {
    check("balance.filler_inventory", fillerBal.usdc > 0n || fillerBal.wnear > 0n, { filler: { usdc: fillerBal.usdc.toString(), wnear: fillerBal.wnear.toString() } });
    // A filler short of its remaining spend cap would leave the withheld order untested.
    for (const a of ["usdc", "wnear"] as const) {
      const remaining = BigInt(m.budget.filler_spend_max[a]) - input.fillerPaid[a];
      if (remaining > 0n) check(`balance.filler_covers_spend_cap.${a}`, fillerBal[a] >= remaining, { filler: fillerBal[a].toString(), remaining_cap: remaining.toString() });
    }
  }

  // Fees at the live gas price, the owner's recovery reserve and the mandate's storage.
  const gasPrice = await client.gasPrice();
  const protocolConfig = await client.provider.experimental_protocolConfig({ finality: client.finality });
  const perByte = BigInt(ProtocolConfig.parse(protocolConfig).runtime_config.storage_amount_per_byte);
  const purchase = gasPurchasePrice(protocolConfig, gasPrice);
  // A storage registration sends nothing when the owner is already registered on that token.
  const ownerRegistered: Partial<Record<Asset, boolean>> = {};
  for (const s of pending) if (s.kind === "register_storage") ownerRegistered[s.asset] ??= await new TokenClient(client, m.mandate_config[s.asset].token).isRegistered(m.accounts.owner);
  const sending = pending.filter((s) => s.kind !== "register_storage" || ownerRegistered[s.asset] !== true);
  if (pending.some((s) => s.kind === "register_storage")) check("owner.token_registration_listed", true, { owner: m.accounts.owner, registered: ownerRegistered });
  let worst = 0n;
  const perSigner: Record<"owner" | "agent" | "filler", bigint> = { owner: 0n, agent: 0n, filler: 0n };
  for (const s of sending) {
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
  // Signing floats: prepaid gas is bought at the purchase price when each transaction is signed (refunded later).
  const floatOf = (signer: "owner" | "agent" | "filler") => signingFloat(m, sending, signer, gasPrice, purchase);
  const floatObserved = (have: bigint | null, need: bigint) => ({ have: have?.toString() ?? null, need: need.toString(), gas_price: gasPrice.toString(), purchase_price: purchase.toString() });
  const agentFloat = floatOf("agent");
  if (agentFloat > 0n) {
    check("float.agent_allowance", allowance !== null && allowance >= agentFloat, floatObserved(allowance, agentFloat));
    const agentFree = await free(m.accounts.agent);
    check("float.agent_balance", agentFree >= agentFloat, floatObserved(agentFree, agentFloat));
  }
  const fillerFloat = floatOf("filler");
  if (fillerFloat > 0n) check("float.filler_balance", fillerFree >= fillerFloat, floatObserved(fillerFree, fillerFloat));
  const ownerFloat = floatOf("owner");
  if (ownerFloat > 0n) check("float.owner_balance", ownerFree >= ownerFloat, floatObserved(ownerFree, ownerFloat));
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
      nonces: { owner: nonces.owner.toString(), agent: nonces.agent.toString(), filler: nonces.filler.toString(), ...(extNonce === null ? {} : { owner_external: extNonce.toString() }) },
      mandate_balances: { usdc: mandateBal.usdc.toString(), wnear: mandateBal.wnear.toString() },
      filler_balances: { usdc: fillerBal.usdc.toString(), wnear: fillerBal.wnear.toString() },
      open_orders: open,
      owner_keys: ownerSnapshot,
    },
  };
}
