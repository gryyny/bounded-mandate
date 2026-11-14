// A small strategy client for a bounded mandate. An example, not an SDK.
//
// It uses only what an agent is given: its restricted function-call key, the mandate's `propose_order` method and the
// mandate's views (`get_config`, `get_grant`, `get_order`). It prints one JSON line per observation:
//   accepted  an allowed proposal was signed by the mandate
//   refused   a proposal outside the grant's limits was refused, with the contract's reason
//   revoked   the owner revoked the grant, and a further proposal was refused
// and exits non-zero when an observation is missing.
//
// Run (after `npm ci` here):
//   node client.js --rpc <url> --mandate <account> --agent <account> --key-file <path>
// or set MANDATE_RPC_URL, MANDATE_ACCOUNT, MANDATE_AGENT_ACCOUNT and MANDATE_AGENT_KEY_FILE.
// The key file is NEAR CLI credential JSON: {"account_id", "public_key", "private_key"}.
// `make example` (repository root) runs it against a local sandbox with test doubles.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPairSigner, actions } from "near-api-js";

const { values: flags } = parseArgs({ options: { rpc: { type: "string" }, mandate: { type: "string" }, agent: { type: "string" }, "key-file": { type: "string" } } });
const input = (flag, env) => {
  const value = flags[flag] ?? process.env[env];
  if (!value) throw new Error(`missing --${flag} (or ${env})`);
  return value;
};
const rpcUrl = input("rpc", "MANDATE_RPC_URL");
const mandate = input("mandate", "MANDATE_ACCOUNT");
const agentId = input("agent", "MANDATE_AGENT_ACCOUNT");
const credential = JSON.parse(readFileSync(input("key-file", "MANDATE_AGENT_KEY_FILE"), "utf8"));
if (credential.account_id !== agentId) throw new Error(`the key file is for ${credential.account_id}, not ${agentId}`);

const provider = new JsonRpcProvider({ url: rpcUrl });
const agent = new Account(agentId, provider, KeyPairSigner.fromSecretKey(credential.private_key));

// propose_order pays for its oracle reads and the signing chain out of the attached gas. 150 TGas is the live runner's
// tested budget; more would not fit a provisioned agent key, whose allowance must prepay the gas at the purchase price.
const GAS = 150_000_000_000_000n;
const view = (method, args = {}) => provider.callFunction({ contractId: mandate, method, args, blockQuery: { finality: "optimistic" } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (observation, fields) => console.log(JSON.stringify({ observation, ...fields }));

/** Sends one proposal. Returns the order id, or the contract's reason when it refuses the call. */
async function propose(proposal) {
  const tx = await agent.signAndSendTransaction({
    receiverId: mandate,
    actions: [actions.functionCall("propose_order", { proposal }, GAS, 0n)],
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: false,
  });
  const txHash = tx.transaction.hash;
  if (tx.status.SuccessValue === undefined) {
    const failure = JSON.stringify(tx.status.Failure ?? tx.status);
    return { txHash, refused: /Smart contract panicked: ([^"\\]+)/.exec(failure)?.[1] ?? failure };
  }
  return { txHash, orderId: JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString("utf8")) };
}

/** Reads a view until `done` accepts its value; gives up after `seconds`. */
async function poll(read, done, seconds, otherwise) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${otherwise} within ${seconds}s`);
    await sleep(500);
  }
}

const config = await view("get_config");
if (config.agent_id !== agentId) throw new Error(`${mandate} names ${config.agent_id} as its agent, not ${agentId}`);
const grant = await view("get_grant");
if (grant?.status !== "active") throw new Error(`${mandate} has no active grant (status ${grant?.status ?? "none"})`);

// The grant states its caps as shares of its initial value (10^-12 USD units). Size orders in USDC at the grant's
// reference price: a tenth of the per-order cap is inside the limits, twice the cap is outside them.
const perOrderCap = (BigInt(grant.initial_value) * BigInt(grant.policy.per_order_cap_bps)) / 10_000n;
const usdcWorth = (value) => {
  const { price, expo } = grant.initial_reference.usdc;
  const scale = config.usdc.decimals - expo - 12;
  return ((scale >= 0 ? value * 10n ** BigInt(scale) : value / 10n ** BigInt(-scale)) / BigInt(price)).toString();
};
const concession = Math.floor(grant.policy.max_concession_bps / 2);
const allowed = { sell: "usdc", sell_amount: usdcWorth(perOrderCap / 10n), max_concession_bps: concession };
const tooLarge = { sell: "usdc", sell_amount: usdcWorth(perOrderCap * 2n), max_concession_bps: concession };

// 1. An allowed trade: the mandate signs an order for it.
const first = await propose(allowed);
if (first.refused !== undefined) throw new Error(`the allowed proposal was refused: ${first.refused}`);
// Callbacks price and sign the order after the proposal returns its id.
const order = await poll(() => view("get_order", { order_id: first.orderId }), (o) => !["pricing", "signing"].includes(o.state.state), 60, "the order was not priced and signed");
if (order.state.state !== "signed") throw new Error(`the allowed proposal was not signed: ${JSON.stringify(order.state)}`);
report("accepted", { order_id: first.orderId, tx_hash: first.txHash, proposal: allowed, state: order.state.state, buy: order.buy, buy_amount: order.buy_amount });

// 2. A trade outside the limits: the contract refuses and says why.
const second = await propose(tooLarge);
if (second.refused === undefined) throw new Error(`the proposal above the per-order cap was not refused (order ${second.orderId})`);
report("refused", { tx_hash: second.txHash, proposal: tooLarge, reason: second.refused });

// 3. Revocation is the owner's act. Wait for the grant to show it, then confirm the same key can no longer trade.
const current = await poll(() => view("get_grant"), (g) => g.status === "revoked", 120, "the grant was not revoked");
const third = await propose(allowed);
if (third.refused === undefined) throw new Error(`a proposal after revocation was not refused (order ${third.orderId})`);
report("revoked", { grant_status: current.status, epoch: current.epoch, tx_hash: third.txHash, proposal: allowed, reason: third.refused });
