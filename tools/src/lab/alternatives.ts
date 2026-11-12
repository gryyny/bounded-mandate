// The owner's alternatives when it withdraws trust from an Intents account that has signed orders outstanding,
// executed on the local sandbox with the pinned verifier WASM. Every run deploys its own verifier and token doubles
// under one account named after `scope`, deposits the same amounts and signs the same three withheld orders (two
// recorded by the owner, one not) before the owner's action; an unrelated account then relays each order. Nothing here
// decides an outcome: `executed_after_action` is the treasury's verifier balance moving by the order's amount, and it
// must agree with the relay transaction's own result. The conditions the verifier checks (deadline, key, nonce) are
// read from its views immediately before each relay and reported beside the outcome.
// The account's key is a labelled TEST key standing in for the account's signer.
import { actions, type Account, type Action, type KeyPair } from "near-api-js";
import { FEE_PIPS } from "../demo/world.js";
import { counterDiff } from "../filler/arithmetic.js";
import { mandateLeg } from "../filler/filler.js";
import { rfc3339FromNs, signNep413, tokenDiffMessage, versionedNonce } from "../filler/nep413.js";
import { NEAR, ONE_YOCTO, TGAS, type NearClient, type Outcome } from "../near/client.js";
import { VerifierClient, tokenId } from "../near/contracts.js";
import { sandboxKey } from "../near/keys.js";
import { requireSuccess, type LocalNetwork, type SandboxAccount, type Wasm } from "../near/sandbox.js";
import type { SignedNep413 } from "../types.js";

export const ALTERNATIVES = ["wait", "cancel_complete", "cancel_incomplete", "cancel_signer_unavailable", "remove_fresh_key", "remove_same_key"] as const;
export type AlternativeId = (typeof ALTERNATIVES)[number];

/** Compatible with `loadPrebuilt(root).wasm`: the pinned verifier and the labelled token double. */
export interface AlternativeWasm {
  verifier: Wasm;
  ft: Wasm;
}

/** Each withheld order sells 1 USDC for 0.3 wNEAR, as in the certified comparison (contract/tests/compare_revocation.rs). */
export const SELL_USDC = 1_000_000n;
export const BUY_WNEAR = 300_000_000_000_000_000_000_000n;
export const TREASURY_USDC = 10n * SELL_USDC;
export const FILLER_WNEAR = 20n * BUY_WNEAR;
/** Lifetime of the three withheld orders and of the orders signed on resuming. */
export const ORDER_TTL_S = 120;
/** Lifetime of the order the wait alternative holds until its deadline has passed, in real time. */
export const EXPIRY_PROBE_TTL_S = 10;
/** NEAR the run's operator account receives from the sandbox root; mostly the verifier's storage stake. */
export const RUN_FUNDING_NEAR = 30n;

const NS_PER_S = 1_000_000_000n;
// The filler's counter-intent outlives every order it closes, so an expiry rejection can only be the order's.
const FILLER_TTL_S = 600n;

export type AlternativeStep = "setup" | "owner_action" | "relay" | "resume";

export interface AlternativeTransaction {
  step: AlternativeStep;
  label: string;
  tx_hash: string;
  /** The transaction and every receipt it produced succeeded. */
  success: boolean;
  /** The failure as the chain reports it. */
  error: string | null;
  signer_id: string;
  receiver_id: string;
  method: string;
}

/** One relay of one order by the unrelated account. */
export interface AlternativeOrder {
  label: string;
  recorded_by_owner: boolean;
  /** When the relay happened relative to the owner's action. */
  phase: string;
  /** The order's nonce (base64), as `is_nonce_used` takes it. */
  nonce: string;
  /** Public key the order is signed with. */
  signed_with: string;
  deadline_ns: string;
  /** The verifier's views immediately before the relay. */
  key_registered_before_relay: boolean;
  nonce_used_before_relay: boolean;
  /** Block time of the verifier's receipt for the relay. */
  relayed_at_ns: string;
  relayed_before_deadline: boolean;
  /** The treasury's USDC on the verifier moved by the order's amount, and the relay transaction succeeded. */
  executed_after_action: boolean;
  relay_tx_hash: string;
  /** The verifier's rejection when the relay did not execute. */
  error: string | null;
}

/** What every alternative starts from, in account-independent terms so that runs can be compared. */
export interface AlternativeStart {
  treasury_usdc: string;
  treasury_wnear: string;
  filler_usdc: string;
  filler_wnear: string;
  account_key_registered: boolean;
  fee_pips: number;
  order_ttl_seconds: number;
  withheld: { label: string; recorded_by_owner: boolean; sell_usdc: string; buy_wnear: string; nonce_used: boolean; unexpired: boolean }[];
}

// A type alias, so that `Object.values` lists the account names as strings.
export type AlternativeAccounts = {
  /** Owns the test doubles (mint, verifier admin, fee collector) and funds the run. Not the owner. */
  operator: string;
  verifier: string;
  usdc_token: string;
  wnear_token: string;
  /** The Intents account under comparison; the owner acts through this NEAR account. */
  treasury: string;
  filler: string;
  /** Unrelated account that relays every bundle. */
  relayer: string;
};

export interface AlternativeResult {
  id: AlternativeId;
  scope: string;
  title: string;
  /** What the owner did, in plain words. */
  owner_action: string;
  /** Payloads in the owner's action that are signed with the account's key. */
  account_key_signatures: number;
  /** The three withheld orders, each relayed after the owner's action and before its deadline. */
  orders: AlternativeOrder[];
  /** Further relays of this alternative: while the key was removed, after a deadline, on resuming. */
  other_relays: AlternativeOrder[];
  /** What resuming trading requires afterwards. */
  resume: string;
  start: AlternativeStart;
  accounts: AlternativeAccounts;
  /** The account's key (TEST) the withheld orders are signed with. */
  account_key: string;
  transactions: AlternativeTransaction[];
  labels: string[];
  verifier_wasm_sha256: string;
  setup_ms: number;
  duration_ms: number;
}

interface Text {
  /** Part of every account name of the run. */
  slug: string;
  title: string;
  owner_action: string;
  resume: string;
}

const TEXT: Record<AlternativeId, Text> = {
  wait: {
    slug: "wait",
    title: "Stop issuing and wait for expiry",
    owner_action: "Sent nothing: the owner stops issuing new orders and waits for each outstanding order's own deadline.",
    resume: "Nothing to restore, the key stays registered. The last relay shows an order signed with it and relayed only after its deadline had passed.",
  },
  cancel_complete: {
    slug: "cancel-all",
    title: "Cancel a complete nonce list",
    owner_action: "Submitted one empty intent per outstanding nonce, each signed with the account's key. An empty intent executes nothing and commits its nonce.",
    resume: "The same key: the last relay is a new order signed with it after the cancellation. Cancelling needed the account's signer for every nonce and the full list of outstanding nonces.",
  },
  cancel_incomplete: {
    slug: "cancel-part",
    title: "Cancel an incomplete nonce list",
    owner_action: "Submitted one empty intent per nonce in the owner's record, each signed with the account's key. The record lacks the nonce of the order marked not recorded.",
    resume: "The same key: the last relay is a new order signed with it after the cancellation. Cancelling needed the account's signer for every recorded nonce.",
  },
  cancel_signer_unavailable: {
    slug: "no-signer",
    title: "Cancel with the signer unavailable",
    owner_action: "Had the complete nonce list but no signature by the account's key. Submitted the empty intents signed with another key the owner holds, which is not registered for the account.",
    resume: "Cancelling, like signing a new order, needs the account's signer back. Removing the key is a direct call by the account and uses no such signature; the two removal alternatives execute it.",
  },
  remove_fresh_key: {
    slug: "fresh-key",
    title: "Remove the key, resume with a fresh key",
    owner_action: "Called remove_public_key on the verifier for the account's key: a direct call by the account with 1 yoctoNEAR, with no nonce list and no signature by the account's key.",
    resume: "A new key: the owner registers a fresh key, and the last relays are a new order signed with it and an old order relayed again.",
  },
  remove_same_key: {
    slug: "same-key",
    title: "Remove the key, re-add the same key",
    owner_action: "Called remove_public_key on the verifier for the account's key, then add_public_key with the same key. The orders were relayed while the key was removed and again after it was re-added.",
    resume: "The same key again: resuming re-registers the key the withheld orders are signed with.",
  },
};

const PHASE = {
  after: "after the owner's action, before the deadline",
  removed: "while the key was removed",
  expired: "after the order's deadline had passed",
  resumed: "after resuming",
} as const;

interface Bench {
  client: NearClient;
  verifier: VerifierClient;
  salt: string;
  feePips: bigint;
  accounts: AlternativeAccounts;
  treasury: SandboxAccount;
  filler: SandboxAccount;
  relayer: SandboxAccount;
  accountKey: KeyPair;
  fillerKey: KeyPair;
  transactions: AlternativeTransaction[];
}

interface Withheld {
  label: string;
  recorded: boolean;
  signed: SignedNep413;
  deadlineNs: bigint;
}

interface Executed {
  ownerPayloads: SignedNep413[];
  orders: AlternativeOrder[];
  other: AlternativeOrder[];
}

const succeeded = (o: Outcome): boolean => o.submitted && o.success && !o.any_receipt_failed;
const failure = (o: Outcome): string | null => (succeeded(o) ? null : (o.error ?? o.receipts.find((r) => r.error !== undefined)?.error ?? "receipt failure"));

/** Adds an executed transaction to the run's list. One that never reached a block is not an outcome of the comparison. */
function record(b: Pick<Bench, "transactions">, step: AlternativeStep, o: Outcome): Outcome {
  if (!o.submitted || o.tx_hash === undefined) throw new Error(`${o.label} was not executed: ${o.error ?? "no final status"}`);
  b.transactions.push({ step, label: o.label, tx_hash: o.tx_hash, success: succeeded(o), error: failure(o), signer_id: o.signer_id, receiver_id: o.receiver_id, method: o.method });
  return o;
}

const call = (method: string, args: Record<string, unknown>, gasT: bigint, deposit = 0n): Action => actions.functionCall(method, args, gasT * TGAS, deposit);

async function setup(net: LocalNetwork, wasm: AlternativeWasm, scope: string, id: AlternativeId): Promise<Bench> {
  if (!/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(scope)) throw new Error(`scope ${JSON.stringify(scope)} cannot be part of an account name: use lower-case letters and digits separated by single - or _`);
  const client = net.client;
  const operatorId = `${scope}-${TEXT[id].slug}.${net.root.id}`;
  const sub = (name: string): string => `${name}.${operatorId}`;
  const accounts: AlternativeAccounts = {
    operator: operatorId,
    verifier: sub("intents"),
    usdc_token: sub("usdc"),
    wnear_token: sub("wnear"),
    treasury: sub("treasury"),
    filler: sub("filler"),
    relayer: sub("relayer"),
  };
  // The longest name of the run; NEAR account names end at 64 characters.
  if (accounts.treasury.length > 64) throw new Error(`scope ${scope} is ${accounts.treasury.length - 64} characters too long for the account name ${accounts.treasury}`);

  const transactions: AlternativeTransaction[] = [];
  const create = async (signer: Account, accountId: string, near: bigint, withKey: boolean, rest: Action[], label: string): Promise<SandboxAccount> => {
    const key = withKey ? sandboxKey(accountId) : null;
    const txActions = [actions.createAccount(), actions.transfer(near * NEAR), ...(key === null ? [] : [actions.addFullAccessKey(key.getPublicKey())]), ...rest];
    requireSuccess(record({ transactions }, "setup", await client.send(label, signer, accountId, txActions, "create_account")));
    return { id: accountId, key, account: key === null ? client.account(accountId) : client.account(accountId, key) };
  };

  const operator = await create(net.root.account, operatorId, RUN_FUNDING_NEAR, true, [], `create the run's operator ${operatorId}`);
  // No access key on the verifier or the tokens: only their own code acts for them.
  const config = { wnear_id: accounts.wnear_token, fees: { fee: FEE_PIPS, fee_collector: operatorId }, roles: { super_admins: [operatorId], admins: {}, grantees: {} } };
  await create(operator.account, accounts.verifier, 15n, false, [actions.deployContract(wasm.verifier.bytes), call("new", { config }, 100n)], "deploy the pinned verifier");
  // One transaction per token: deploy the double, register the verifier, mint and deposit for one Intents account.
  const token = (accountId: string, symbol: string, decimals: number, amount: bigint, receiver: string): Promise<SandboxAccount> =>
    create(
      operator.account,
      accountId,
      3n,
      false,
      [
        actions.deployContract(wasm.ft.bytes),
        call("new", { owner_id: operatorId, name: `${symbol} (TEST DOUBLE)`, symbol, decimals }, 20n),
        call("storage_deposit", { account_id: accounts.verifier, registration_only: true }, 20n, NEAR / 100n),
        call("mint", { account_id: operatorId, amount: amount.toString() }, 20n),
        call("ft_transfer_call", { receiver_id: accounts.verifier, amount: amount.toString(), msg: receiver }, 150n, ONE_YOCTO),
      ],
      `deploy the ${symbol} test double and deposit ${amount} for ${receiver}`,
    );
  const person = (accountId: string, role: string): Promise<SandboxAccount> => create(operator.account, accountId, 2n, true, [], `create the ${role} ${accountId}`);
  const [, , treasury, filler, relayer] = await Promise.all([
    token(accounts.usdc_token, "USDC", 6, TREASURY_USDC, accounts.treasury),
    token(accounts.wnear_token, "wNEAR", 24, FILLER_WNEAR, accounts.filler),
    person(accounts.treasury, "treasury"),
    person(accounts.filler, "filler"),
    person(accounts.relayer, "relayer"),
  ]);

  const verifier = new VerifierClient(client, accounts.verifier);
  const accountKey = sandboxKey(`${accounts.treasury}/account-signer-TEST`);
  const fillerKey = sandboxKey(`${accounts.filler}/intents-signing`);
  const register = async (account: SandboxAccount, key: KeyPair): Promise<void> => {
    requireSuccess(record({ transactions }, "setup", await verifier.addPublicKey(account.account, key.getPublicKey().toString())));
  };
  await Promise.all([register(treasury, accountKey), register(filler, fillerKey)]);
  return { client, verifier, salt: await verifier.currentSalt(), feePips: await verifier.feePips(), accounts, treasury, filler, relayer, accountKey, fillerKey, transactions };
}

/** Signs orders that sell 1 USDC for 0.3 wNEAR from the treasury, all with one deadline `ttlS` after the current block. */
async function signOrders(b: Bench, key: KeyPair, specs: readonly { label: string; recorded: boolean }[], ttlS: number): Promise<Withheld[]> {
  const deadlineNs = (await b.client.blockTimestampNs()) + BigInt(ttlS) * NS_PER_S;
  const diff = { [tokenId(b.accounts.usdc_token)]: -SELL_USDC, [tokenId(b.accounts.wnear_token)]: BUY_WNEAR };
  return specs.map(({ label, recorded }) => ({
    label,
    recorded,
    deadlineNs,
    signed: signNep413(key, { message: tokenDiffMessage(b.accounts.treasury, deadlineNs, diff), nonce: versionedNonce(b.salt, deadlineNs), recipient: b.accounts.verifier }),
  }));
}

const balance = (b: Bench, accountId: string, token: string): Promise<bigint> => b.verifier.balance(accountId, token);

async function startingConditions(b: Bench, withheld: readonly Withheld[]): Promise<AlternativeStart> {
  const { treasury, filler, usdc_token: usdc, wnear_token: wnear } = b.accounts;
  const now = await b.client.blockTimestampNs();
  return {
    treasury_usdc: (await balance(b, treasury, usdc)).toString(),
    treasury_wnear: (await balance(b, treasury, wnear)).toString(),
    filler_usdc: (await balance(b, filler, usdc)).toString(),
    filler_wnear: (await balance(b, filler, wnear)).toString(),
    account_key_registered: await b.verifier.hasPublicKey(treasury, b.accountKey.getPublicKey().toString()),
    fee_pips: Number(b.feePips),
    order_ttl_seconds: ORDER_TTL_S,
    withheld: await Promise.all(
      withheld.map(async (o) => {
        const leg = mandateLeg(o.signed, treasury, b.accounts.verifier, [tokenId(usdc), tokenId(wnear)]);
        return {
          label: o.label,
          recorded_by_owner: o.recorded,
          sell_usdc: leg.sellAmount.toString(),
          buy_wnear: leg.buyAmount.toString(),
          nonce_used: await b.verifier.isNonceUsed(treasury, o.signed.payload.nonce),
          unexpired: now < o.deadlineNs,
        };
      }),
    ),
  };
}

/** The relayer submits the order with the filler's closing counter-intent; the outcome is read from the chain. */
async function relay(b: Bench, o: Withheld, phase: string, step: AlternativeStep = "relay"): Promise<AlternativeOrder> {
  const { treasury, verifier, usdc_token: usdc, wnear_token: wnear } = b.accounts;
  const leg = mandateLeg(o.signed, treasury, verifier, [tokenId(usdc), tokenId(wnear)]);
  const [keyRegistered, nonceUsed, before, now] = await Promise.all([
    b.verifier.hasPublicKey(treasury, o.signed.public_key),
    b.verifier.isNonceUsed(treasury, o.signed.payload.nonce),
    balance(b, treasury, usdc),
    b.client.blockTimestampNs(),
  ]);
  const fillerDeadline = now + FILLER_TTL_S * NS_PER_S;
  const counter = signNep413(b.fillerKey, {
    message: tokenDiffMessage(b.accounts.filler, fillerDeadline, counterDiff(leg, b.feePips)),
    nonce: versionedNonce(b.salt, fillerDeadline),
    recipient: verifier,
  });
  const outcome = record(b, step, await b.verifier.execute(b.relayer.account, [o.signed, counter], `relay ${o.label}, ${phase}`));
  const moved = before - (await balance(b, treasury, usdc));
  const ok = succeeded(outcome);
  if (moved !== (ok ? leg.sellAmount : 0n)) {
    throw new Error(`relay of ${o.label}: the transaction ${ok ? "succeeded" : "failed"} but the treasury's USDC moved by ${moved}`);
  }
  const receipt = outcome.receipts.find((r) => r.executor_id === verifier);
  if (receipt === undefined || outcome.tx_hash === undefined) throw new Error(`relay of ${o.label}: no verifier receipt`);
  const relayedAt = await b.client.blockTimestampAt(receipt.block_hash);
  return {
    label: o.label,
    recorded_by_owner: o.recorded,
    phase,
    nonce: o.signed.payload.nonce,
    signed_with: o.signed.public_key,
    deadline_ns: o.deadlineNs.toString(),
    key_registered_before_relay: keyRegistered,
    nonce_used_before_relay: nonceUsed,
    relayed_at_ns: relayedAt.toString(),
    relayed_before_deadline: relayedAt < o.deadlineNs,
    executed_after_action: ok,
    relay_tx_hash: outcome.tx_hash,
    error: failure(outcome),
  };
}

async function relayAll(b: Bench, orders: readonly Withheld[], phase: string, step: AlternativeStep = "relay"): Promise<AlternativeOrder[]> {
  const out: AlternativeOrder[] = [];
  for (const o of orders) out.push(await relay(b, o, phase, step));
  return out;
}

/** One empty intent per order, reusing the order's nonce and deadline: executing it commits that nonce. */
const cancellations = (b: Bench, key: KeyPair, orders: readonly Withheld[]): SignedNep413[] =>
  orders.map((o) =>
    signNep413(key, {
      message: JSON.stringify({ signer_id: b.accounts.treasury, deadline: rfc3339FromNs(o.deadlineNs), intents: [] }),
      nonce: Buffer.from(o.signed.payload.nonce, "base64"),
      recipient: b.accounts.verifier,
    }),
  );

/** The owner's transactions are reported, not required to succeed: a rejected cancellation is a result. */
const ownerCall = async (b: Bench, step: AlternativeStep, label: string, method: string, args: Record<string, unknown>, deposit = 0n): Promise<void> => {
  record(b, step, await b.client.call(label, b.treasury.account, b.accounts.verifier, method, args, { deposit }));
};

const submitCancellations = (b: Bench, payloads: SignedNep413[], label: string): Promise<void> => ownerCall(b, "owner_action", label, "execute_intents", { signed: payloads });

const setKey = (b: Bench, step: AlternativeStep, method: "add_public_key" | "remove_public_key", key: KeyPair, label: string): Promise<void> =>
  ownerCall(b, step, label, method, { public_key: key.getPublicKey().toString() }, ONE_YOCTO);

async function waitPast(b: Bench, deadlineNs: bigint): Promise<void> {
  const giveUp = Date.now() + (EXPIRY_PROBE_TTL_S + 120) * 1000;
  while ((await b.client.blockTimestampNs()) <= deadlineNs) {
    if (Date.now() > giveUp) throw new Error("the sandbox clock did not pass the order's deadline");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const resumeOrder = async (b: Bench, key: KeyPair, label: string): Promise<AlternativeOrder> => {
  const [order] = await signOrders(b, key, [{ label, recorded: true }], ORDER_TTL_S);
  if (order === undefined) throw new Error("no order signed");
  return relay(b, order, PHASE.resumed, "resume");
};

async function cancelThenRelay(b: Bench, withheld: readonly Withheld[], listed: readonly Withheld[], key: KeyPair, label: string, resumes: boolean): Promise<Executed> {
  const ownerPayloads = cancellations(b, key, listed);
  await submitCancellations(b, ownerPayloads, label);
  const orders = await relayAll(b, withheld, PHASE.after);
  return { ownerPayloads, orders, other: resumes ? [await resumeOrder(b, key, "O4 (signed with the same key after the cancellation)")] : [] };
}

const EXECUTE: Record<AlternativeId, (b: Bench, withheld: readonly Withheld[]) => Promise<Executed>> = {
  wait: async (b, withheld) => {
    const orders = await relayAll(b, withheld, PHASE.after);
    // Real time only: other sessions share this sandbox's clock, so nothing here moves it.
    const [probe] = await signOrders(b, b.accountKey, [{ label: `O4 (not recorded, ${EXPIRY_PROBE_TTL_S} s lifetime, held until its deadline had passed)`, recorded: false }], EXPIRY_PROBE_TTL_S);
    if (probe === undefined) throw new Error("no order signed");
    await waitPast(b, probe.deadlineNs);
    return { ownerPayloads: [], orders, other: [await relay(b, probe, PHASE.expired)] };
  },
  cancel_complete: (b, withheld) => cancelThenRelay(b, withheld, withheld, b.accountKey, "owner cancels every outstanding nonce", true),
  cancel_incomplete: (b, withheld) =>
    cancelThenRelay(
      b,
      withheld,
      withheld.filter((o) => o.recorded),
      b.accountKey,
      "owner cancels the recorded nonces",
      true,
    ),
  cancel_signer_unavailable: (b, withheld) =>
    cancelThenRelay(b, withheld, withheld, sandboxKey(`${b.accounts.treasury}/owner-held-not-the-account-signer-TEST`), "owner submits cancellations not signed by the account's key", false),
  remove_fresh_key: async (b, withheld) => {
    await setKey(b, "owner_action", "remove_public_key", b.accountKey, "owner removes the account's key");
    const orders = await relayAll(b, withheld, PHASE.after);
    const fresh = sandboxKey(`${b.accounts.treasury}/account-signer-TEST-fresh`);
    await setKey(b, "resume", "add_public_key", fresh, "owner registers a fresh key");
    const resumed = await resumeOrder(b, fresh, "O4 (signed with the fresh key)");
    const [first] = withheld;
    if (first === undefined) throw new Error("no withheld order");
    return { ownerPayloads: [], orders, other: [resumed, await relay(b, first, PHASE.resumed, "resume")] };
  },
  remove_same_key: async (b, withheld) => {
    await setKey(b, "owner_action", "remove_public_key", b.accountKey, "owner removes the account's key");
    const whileRemoved = await relayAll(b, withheld, PHASE.removed);
    await setKey(b, "owner_action", "add_public_key", b.accountKey, "owner re-adds the same key");
    return { ownerPayloads: [], orders: await relayAll(b, withheld, PHASE.after), other: whileRemoved };
  },
};

/**
 * Runs one alternative from the common starting conditions and reports what executed. `scope` goes into every account
 * name the run creates, so runs with different scopes share nothing but the sandbox; a scope and alternative that
 * already ran cannot run again (its accounts exist). Throws when the starting conditions cannot be built or a
 * transaction never reaches a block; a rejection by the verifier is a result, not an error.
 */
export async function runAlternative(net: LocalNetwork, wasm: AlternativeWasm, scope: string, id: AlternativeId): Promise<AlternativeResult> {
  const started = Date.now();
  const b = await setup(net, wasm, scope, id);
  const setupMs = Date.now() - started;
  const withheld = await signOrders(
    b,
    b.accountKey,
    [
      { label: "O1 (recorded)", recorded: true },
      { label: "O2 (recorded)", recorded: true },
      { label: "O3 (not recorded)", recorded: false },
    ],
    ORDER_TTL_S,
  );
  const start = await startingConditions(b, withheld);
  const { ownerPayloads, orders, other } = await EXECUTE[id](b, withheld);
  const accountKey = b.accountKey.getPublicKey().toString();
  const { title, owner_action, resume } = TEXT[id];
  return {
    id,
    scope,
    title,
    owner_action,
    account_key_signatures: ownerPayloads.filter((p) => p.public_key === accountKey).length,
    orders,
    other_relays: other,
    resume,
    start,
    accounts: b.accounts,
    account_key: accountKey,
    transactions: b.transactions,
    labels: [
      "sandbox: a local chain with disposable keys; nothing is sent to a public network",
      `verifier: ${wasm.verifier.path}, sha256 ${wasm.verifier.sha256}`,
      "account key: a TEST key standing in for the account's signer",
      `tokens: TEST DOUBLES named USDC and wNEAR (${wasm.ft.path})`,
      "times are sandbox block times, not mainnet latency",
    ],
    verifier_wasm_sha256: wasm.verifier.sha256,
    setup_ms: setupMs,
    duration_ms: Date.now() - started,
  };
}
