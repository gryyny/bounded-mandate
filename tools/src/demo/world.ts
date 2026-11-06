// Sandbox world shared by the demo and the sandbox tests: the pinned verifier WASM, labelled test doubles
// (mock FT x2, mock oracle, mock MPC), the mandate contract and the role accounts.
import { join } from "node:path";
import { NEAR, ONE_YOCTO, TGAS, type NearClient } from "../near/client.js";
import { MandateClient, VerifierClient } from "../near/contracts.js";
import { sandboxKey } from "../near/keys.js";
import { LocalNetwork, crateWasm, loadWasm, requireSuccess, type SandboxAccount, type Wasm } from "../near/sandbox.js";
import type { Asset } from "../types.js";
import { DECIMALS, DEPOSITS, FILLER_DEPOSITS, PRICES, PRICE_IDS } from "./market.js";

export const VERIFIER_WASM = "fixtures/verifier/defuse-0.4.5.wasm";
/** Mainnet verifier fee is 1 pip; using it keeps fee handling honest. */
export const FEE_PIPS = 1;
/** Finite gas allowance of the agent's only key. */
export const AGENT_ALLOWANCE = 2n * NEAR;

export interface World {
  net: LocalNetwork;
  client: NearClient;
  wasm: Record<"mandate" | "verifier" | "ft" | "oracle" | "mpc", Wasm>;
  verifier: VerifierClient;
  mandate: MandateClient;
  tokens: Record<Asset, string>;
  oracleId: string;
  mpcId: string;
  owner: SandboxAccount;
  agent: SandboxAccount;
  filler: SandboxAccount;
  relayer: SandboxAccount;
  attacker: SandboxAccount;
  /** Owner of the test doubles (mint, prices, MPC mode). Not a mandate role. */
  operator: SandboxAccount;
  feeCollector: SandboxAccount;
}

export function loadWorldWasm(): World["wasm"] {
  return {
    mandate: loadWasm(crateWasm("bounded-mandate")),
    verifier: loadWasm(VERIFIER_WASM),
    ft: loadWasm(crateWasm("mock-ft")),
    oracle: loadWasm(crateWasm("mock-oracle")),
    mpc: loadWasm(crateWasm("mock-mpc")),
  };
}

export interface WorldOptions {
  fillerDeposits?: boolean;
  /**
   * Tokens on which the owner holds no storage registration after its deposit (its NEAR-side balance is zero then),
   * as for an owner who funded through another account. The demo uses this so the owner's withdrawal exercises
   * registration; the default leaves the owner registered on both tokens.
   */
  ownerUnregistered?: readonly Asset[];
}

export async function setupWorld(net: LocalNetwork, opts: WorldOptions = {}): Promise<World> {
  const wasm = loadWorldWasm();
  const client = net.client;
  const root = net.root.id;
  const operator = await net.createAccount("operator", { balanceNear: 50n });
  const feeCollector = await net.createAccount("fees");
  const owner = await net.createAccount("owner");
  const filler = await net.createAccount("filler");
  const relayer = await net.createAccount("relayer");
  const attacker = await net.createAccount("attacker");

  const token = (name: string, symbol: string, decimals: number) =>
    net.createAccount(name, {
      balanceNear: 10n,
      wasm: wasm.ft.bytes,
      init: { method: "new", args: { owner_id: operator.id, name: `${symbol} (TEST DOUBLE)`, symbol, decimals } },
      key: "none",
    });
  const usdcToken = await token("usdc", "USDC", DECIMALS.usdc);
  const wnearToken = await token("wnear", "wNEAR", DECIMALS.wnear);
  const tokens = { usdc: usdcToken.id, wnear: wnearToken.id };

  const verifier = await net.createAccount("intents", {
    balanceNear: 50n,
    wasm: wasm.verifier.bytes,
    init: {
      method: "new",
      args: {
        config: {
          wnear_id: tokens.wnear,
          fees: { fee: FEE_PIPS, fee_collector: feeCollector.id },
          roles: { super_admins: [operator.id], admins: {}, grantees: {} },
        },
      },
    },
    key: "none",
  });
  const oracle = await net.createAccount("oracle", {
    balanceNear: 10n,
    wasm: wasm.oracle.bytes,
    init: { method: "new", args: { owner_id: operator.id } },
    key: "none",
  });
  const mpc = await net.createAccount("mpc", {
    balanceNear: 10n,
    wasm: wasm.mpc.bytes,
    init: { method: "new", args: { owner_id: operator.id } },
    key: "none",
  });

  const mandateId = `mandate.${root}`;
  const agentId = `agent.${root}`;
  const config = {
    owner_id: owner.id,
    agent_id: agentId,
    verifier_id: verifier.id,
    signer_id: mpc.id,
    oracle_id: oracle.id,
    usdc: { token: tokens.usdc, decimals: DECIMALS.usdc, price_id: PRICE_IDS.usdc },
    wnear: { token: tokens.wnear, decimals: DECIMALS.wnear, price_id: PRICE_IDS.wnear },
  };
  // No access key: only the contract's own code acts for the mandate account.
  await net.createAccount("mandate", { balanceNear: 30n, wasm: wasm.mandate.bytes, init: { method: "new", args: { config } }, key: "none" });
  // The agent's only key: function-call, `propose_order` on the mandate, finite allowance.
  const agent = await net.createAccount("agent", {
    balanceNear: 5n,
    key: { receiver: mandateId, methods: ["propose_order"], allowance: AGENT_ALLOWANCE },
  });

  const op = operator.account;
  for (const t of Object.values(tokens)) {
    requireSuccess(
      await client.call(`storage_deposit verifier on ${t}`, op, t, "storage_deposit", { account_id: verifier.id, registration_only: true }, {
        gas: 30n * TGAS,
        deposit: NEAR / 100n,
      }),
    );
  }
  const world: World = {
    net,
    client,
    wasm,
    verifier: new VerifierClient(client, verifier.id),
    mandate: new MandateClient(client, mandateId),
    tokens,
    oracleId: oracle.id,
    mpcId: mpc.id,
    owner,
    agent,
    filler,
    relayer,
    attacker,
    operator,
    feeCollector,
  };
  // Owner funds the mandate's Intents account; the filler funds its own and registers its key.
  for (const asset of ["usdc", "wnear"] as const) {
    await mintAndDeposit(world, owner, asset, DEPOSITS[asset], mandateId);
    if (opts.fillerDeposits !== false) await mintAndDeposit(world, filler, asset, FILLER_DEPOSITS[asset], filler.id);
  }
  for (const asset of opts.ownerUnregistered ?? []) {
    requireSuccess(await client.call(`owner storage_unregister on ${asset} token`, owner.account, tokens[asset], "storage_unregister", { force: false }, { gas: 30n * TGAS, deposit: ONE_YOCTO }));
  }
  requireSuccess(await world.verifier.addPublicKey(filler.account, fillerKey(world).getPublicKey().toString()));
  return world;
}

/** The filler's signing key on the verifier (separate from its account key by construction). */
export const fillerKey = (world: World) => sandboxKey(`${world.filler.id}/intents-signing`);

export async function mintAndDeposit(world: World, holder: SandboxAccount, asset: Asset, amount: bigint, receiver: string): Promise<void> {
  const t = world.tokens[asset];
  requireSuccess(await world.client.call(`mint ${asset} to ${holder.id}`, world.operator.account, t, "mint", { account_id: holder.id, amount: amount.toString() }));
  requireSuccess(
    await world.client.call(
      `deposit ${asset} for ${receiver}`,
      holder.account,
      t,
      "ft_transfer_call",
      { receiver_id: world.verifier.id, amount: amount.toString(), msg: receiver },
      { gas: 100n * TGAS, deposit: ONE_YOCTO },
    ),
  );
}

/** Posts both oracle prices with publish time = current block time (the oracle keeper's job). */
export async function postPrices(world: World, overrides: Partial<Record<Asset, { price: bigint; conf: bigint; expo: number }>> = {}): Promise<bigint> {
  const nowSec = (await world.client.blockTimestampNs()) / 1_000_000_000n;
  for (const asset of ["usdc", "wnear"] as const) {
    const p = overrides[asset] ?? PRICES[asset];
    requireSuccess(
      await world.client.call(`oracle set_price ${asset}`, world.operator.account, world.oracleId, "set_price", {
        price_id: PRICE_IDS[asset],
        price: p.price.toString(),
        conf: p.conf.toString(),
        expo: p.expo,
        publish_time: Number(nowSec),
      }),
    );
  }
  return nowSec;
}

export async function balances(world: World, accountId: string): Promise<Record<Asset, bigint>> {
  return {
    usdc: await world.verifier.balance(accountId, world.tokens.usdc),
    wnear: await world.verifier.balance(accountId, world.tokens.wnear),
  };
}

export const stateDir = (repoRoot: string, run: string): string => join(repoRoot, "out", run);

