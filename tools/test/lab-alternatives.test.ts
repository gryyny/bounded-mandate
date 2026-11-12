// gate: LAB — the owner's alternatives the lab's compare tab executes, on a local sandbox with the prebuilt WASM set
// (the pinned verifier, the labelled token double). Every alternative runs once in each of two scopes, all at the same
// time. Nothing below copies an outcome from a run: the relays are looked up on the chain by hash, and what must have
// executed follows from the verifier's own checks (deadline, then key, then nonce) applied to the conditions observed
// before each relay. The account's key is a labelled TEST key standing in for the account's signer.
import { baseEncode } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CaseRecorder } from "../src/evidence/report.js";
import { counterDiff } from "../src/filler/arithmetic.js";
import { rfc3339FromNs } from "../src/filler/nep413.js";
import {
  ALTERNATIVES,
  BUY_WNEAR,
  FILLER_WNEAR,
  ORDER_TTL_S,
  SELL_USDC,
  TREASURY_USDC,
  runAlternative,
  type AlternativeId,
  type AlternativeOrder,
  type AlternativeResult,
  type AlternativeTransaction,
  type AlternativeWasm,
} from "../src/lab/alternatives.js";
import { VerifierClient, tokenId } from "../src/near/contracts.js";
import { LocalNetwork, REPO_ROOT } from "../src/near/sandbox.js";
import { loadPrebuilt } from "../src/quick/prebuilt.js";
import { SignedNep413 } from "../src/types.js";

const SCOPES = ["lab-one", "lab-two"] as const;
type Scope = (typeof SCOPES)[number];

interface Run {
  scope: Scope;
  result: AlternativeResult;
  started: number;
  ended: number;
}

let net: LocalNetwork;
let wasm: AlternativeWasm;
let runs: Run[] = [];

const evidence = new CaseRecorder("LAB", "owner-alternatives", [
  "equal-starting-conditions",
  "relays-are-chain-transactions",
  "outcomes-follow-verifier-checks",
  "wait",
  "cancel-complete",
  "cancel-incomplete",
  "cancel-signer-unavailable",
  "remove-fresh-key",
  "remove-same-key",
  "concurrent-scopes-isolated",
]);

beforeAll(async () => {
  net = await LocalNetwork.start();
  wasm = loadPrebuilt(REPO_ROOT).wasm;
  runs = await Promise.all(
    SCOPES.flatMap((scope) =>
      ALTERNATIVES.map(async (id) => {
        const started = Date.now();
        const result = await runAlternative(net, wasm, scope, id);
        return { scope, result, started, ended: Date.now() };
      }),
    ),
  );
}, 300_000);

afterAll(async () => {
  // The token double is deployed from fixtures/prebuilt, whose stem a target/near build shares; the fixture manifest hash covers it.
  evidence.write("sandbox", typeof wasm === "undefined" ? {} : { "defuse-0.4.5": wasm.verifier.sha256 }, {
    account_key: "TEST key standing in for the account's signer",
    token_double_sha256: typeof wasm === "undefined" ? null : wasm.ft.sha256,
    scopes: SCOPES,
    outcomes: runs.map(({ scope, result: r }) => ({
      scope,
      id: r.id,
      account_key_signatures: r.account_key_signatures,
      owner_transactions: r.transactions.filter((t) => t.step === "owner_action").map((t) => ({ label: t.label, tx_hash: t.tx_hash, success: t.success, error: t.error })),
      orders: r.orders.map(brief),
      other_relays: r.other_relays.map(brief),
      setup_ms: r.setup_ms,
      duration_ms: r.duration_ms,
    })),
  });
  await net.stop();
});

const brief = (o: AlternativeOrder) => ({
  label: o.label,
  phase: o.phase,
  recorded_by_owner: o.recorded_by_owner,
  key_registered_before_relay: o.key_registered_before_relay,
  nonce_used_before_relay: o.nonce_used_before_relay,
  relayed_before_deadline: o.relayed_before_deadline,
  executed: o.executed_after_action,
  relay_tx_hash: o.relay_tx_hash,
  error: o.error,
});

const of = (id: AlternativeId): AlternativeResult[] => {
  const found = runs.filter((r) => r.result.id === id).map((r) => r.result);
  expect(found.map((r) => r.scope).sort()).toEqual([...SCOPES].sort());
  return found;
};
const relays = (r: AlternativeResult): AlternativeOrder[] => [...r.orders, ...r.other_relays];
const ownerTxs = (r: AlternativeResult): AlternativeTransaction[] => r.transactions.filter((t) => t.step === "owner_action");
const verifierOf = (r: AlternativeResult): VerifierClient => new VerifierClient(net.client, r.accounts.verifier);

const FunctionCall = z.object({ FunctionCall: z.object({ method_name: z.string(), args: z.string(), deposit: z.string() }).loose() });

interface ChainCall {
  signer: string;
  receiver: string;
  method: string;
  args: unknown;
  deposit: string;
  success: boolean;
  error: string | null;
  /** Block time of the receiver's first receipt. */
  executedAtNs: bigint;
}

/** The transaction as the chain reports it, looked up by hash: who signed what, and whether it succeeded. */
async function chainCall(signerId: string, txHash: string): Promise<ChainCall> {
  const o = await net.client.resolve("lookup", signerId, txHash);
  if (o?.transaction === undefined) throw new Error(`transaction ${txHash} by ${signerId} is not on the chain`);
  expect(o.transaction.actions).toHaveLength(1);
  const { FunctionCall: fc } = FunctionCall.parse(o.transaction.actions[0]);
  const receipt = o.receipts.find((r) => r.executor_id === o.transaction?.receiver_id);
  const success = o.submitted && o.success && !o.any_receipt_failed;
  if (receipt === undefined) throw new Error(`transaction ${txHash} has no receipt on its receiver`);
  return {
    signer: o.transaction.signer_id,
    receiver: o.transaction.receiver_id,
    method: fc.method_name,
    args: JSON.parse(Buffer.from(fc.args, "base64").toString("utf8")) as unknown,
    deposit: fc.deposit,
    success,
    error: success ? null : (o.error ?? o.receipts.find((r) => r.error !== undefined)?.error ?? null),
    executedAtNs: await net.client.blockTimestampAt(receipt.block_hash),
  };
}

const Bundle = z.object({ signed: z.array(SignedNep413) });
const Message = z.object({ signer_id: z.string(), deadline: z.string(), intents: z.array(z.unknown()) });
const KeyArgs = z.object({ public_key: z.string() });

/**
 * What the pinned verifier does with a relayed order, from the conditions seen before the relay: it checks the
 * deadline, then the key, then the nonce, and executes only when all three hold.
 */
function expectFollowsVerifierChecks(r: AlternativeResult, o: AlternativeOrder): void {
  const at = `${r.scope}/${r.id}/${o.label}/${o.phase}`;
  const firstFailed = !o.relayed_before_deadline ? "deadline" : !o.key_registered_before_relay ? "key" : o.nonce_used_before_relay ? "nonce" : null;
  expect(o.executed_after_action, at).toBe(firstFailed === null);
  if (firstFailed === null) {
    expect(o.error, at).toBeNull();
    return;
  }
  const rejection = {
    deadline: "deadline has expired",
    key: `public key '${o.signed_with}' doesn't exist for account '${r.accounts.treasury}'`,
    nonce: "nonce was already used",
  }[firstFailed];
  expect(o.error, at).toContain(rejection);
}

/** The owner's only transactions are the given verifier calls by the treasury account, each with its success. */
async function ownerCalls(r: AlternativeResult): Promise<ChainCall[]> {
  const calls = await Promise.all(ownerTxs(r).map((t) => chainCall(r.accounts.treasury, t.tx_hash)));
  for (const [i, c] of calls.entries()) {
    const reported = ownerTxs(r)[i];
    expect({ signer: c.signer, receiver: c.receiver, success: c.success, error: c.error }).toEqual({ signer: r.accounts.treasury, receiver: r.accounts.verifier, success: reported?.success, error: reported?.error });
  }
  return calls;
}

const withheldNonces = (r: AlternativeResult, only: (o: AlternativeOrder) => boolean = () => true): string[] => r.orders.filter(only).map((o) => o.nonce).sort();

/** The cancellation the owner submitted: empty intents for the treasury, one per payload, with their nonces and signing keys. */
async function cancellation(r: AlternativeResult): Promise<{ success: boolean; nonces: string[]; keys: string[] }> {
  const calls = await ownerCalls(r);
  expect(calls.map((c) => c.method)).toEqual(["execute_intents"]);
  const { signed } = Bundle.parse(calls[0]?.args);
  for (const p of signed) {
    const message = Message.parse(JSON.parse(p.payload.message));
    expect({ signer_id: message.signer_id, intents: message.intents, recipient: p.payload.recipient }).toEqual({ signer_id: r.accounts.treasury, intents: [], recipient: r.accounts.verifier });
  }
  return { success: calls[0]?.success === true, nonces: signed.map((p) => p.payload.nonce).sort(), keys: signed.map((p) => p.public_key) };
}

const allAfterAction = (r: AlternativeResult): void => {
  expect(r.orders).toHaveLength(3);
  for (const o of r.orders) expect({ signed_with: o.signed_with, relayed_before_deadline: o.relayed_before_deadline }).toEqual({ signed_with: r.account_key, relayed_before_deadline: true });
};

describe("the owner's alternatives on the pinned verifier", () => {
  // gate: LAB
  it("start every alternative from the same deposits, key and three unexpired withheld orders", () => evidence.check("equal-starting-conditions", async () => {
    expect(runs).toHaveLength(SCOPES.length * ALTERNATIVES.length);
    const first = runs[0]?.result;
    if (first === undefined) throw new Error("no run");
    // The configured starting point: deposits and order terms are inputs of the scenario, not results.
    expect(first.start).toMatchObject({
      treasury_usdc: TREASURY_USDC.toString(),
      treasury_wnear: "0",
      filler_usdc: "0",
      filler_wnear: FILLER_WNEAR.toString(),
      account_key_registered: true,
      order_ttl_seconds: ORDER_TTL_S,
    });
    expect(first.start.withheld.map((o) => o.recorded_by_owner)).toEqual([true, true, false]);
    for (const o of first.start.withheld) expect(o).toMatchObject({ sell_usdc: SELL_USDC.toString(), buy_wnear: BUY_WNEAR.toString(), nonce_used: false, unexpired: true });
    for (const { result: r } of runs) {
      expect(r.start, `${r.scope}/${r.id}`).toEqual(first.start);
      // The same three orders are the ones relayed: distinct nonces, one deadline, the recorded flags of the start.
      expect(r.orders.map((o) => ({ label: o.label, recorded_by_owner: o.recorded_by_owner }))).toEqual(r.start.withheld.map((o) => ({ label: o.label, recorded_by_owner: o.recorded_by_owner })));
      expect(new Set(r.orders.map((o) => o.nonce)).size).toBe(3);
      expect(new Set(r.orders.map((o) => o.deadline_ns)).size).toBe(1);
      // Each run executes the pinned verifier and the labelled token double, by code hash on the chain.
      const codeHash = async (accountId: string) => (await net.client.accountView(accountId)).code_hash;
      expect(await codeHash(r.accounts.verifier)).toBe(baseEncode(Buffer.from(wasm.verifier.sha256, "hex")));
      expect(r.verifier_wasm_sha256).toBe(wasm.verifier.sha256);
      for (const token of [r.accounts.usdc_token, r.accounts.wnear_token]) expect(await codeHash(token)).toBe(baseEncode(Buffer.from(wasm.ft.sha256, "hex")));
      expect(r.labels.join("\n")).toMatch(/TEST key standing in for the account's signer/);
      expect(r.labels.join("\n")).toMatch(/sandbox/);
      expect(r.labels.join("\n")).toContain(wasm.verifier.sha256);
    }
  }));

  // gate: LAB
  it("report relays that are transactions by an unrelated account carrying the order", () => evidence.check("relays-are-chain-transactions", async () => {
    for (const { result: r } of runs) {
      const { relayer, treasury, filler, operator, verifier } = r.accounts;
      expect(new Set([relayer, treasury, filler, operator, verifier]).size).toBe(5);
      for (const o of relays(r)) {
        const at = `${r.scope}/${r.id}/${o.label}/${o.phase}`;
        const tx = await chainCall(relayer, o.relay_tx_hash);
        expect({ signer: tx.signer, receiver: tx.receiver, method: tx.method, success: tx.success, error: tx.error }, at).toEqual({
          signer: relayer,
          receiver: verifier,
          method: "execute_intents",
          success: o.executed_after_action,
          error: o.error,
        });
        const { signed } = Bundle.parse(tx.args);
        const order = signed.find((p) => p.payload.nonce === o.nonce);
        if (order === undefined) throw new Error(`${at}: the relay does not carry the order`);
        const message = Message.parse(JSON.parse(order.payload.message));
        expect({ key: order.public_key, signer_id: message.signer_id, deadline: message.deadline, intents: message.intents.length }, at).toEqual({
          key: o.signed_with,
          signer_id: treasury,
          deadline: rfc3339FromNs(BigInt(o.deadline_ns)),
          intents: 1,
        });
        expect(tx.executedAtNs.toString(), at).toBe(o.relayed_at_ns);
        expect(o.relayed_before_deadline, at).toBe(tx.executedAtNs < BigInt(o.deadline_ns));
      }
      expect(new Set(relays(r).map((o) => o.relay_tx_hash)).size).toBe(relays(r).length);
      for (const t of r.transactions.filter((x) => x.step === "relay" || x.step === "resume").filter((x) => x.method === "execute_intents")) {
        expect(relays(r).map((o) => o.relay_tx_hash)).toContain(t.tx_hash);
      }
    }
  }));

  // gate: LAB
  it("execute an order exactly when its deadline, key and nonce all pass, and account for every unit moved", () => evidence.check("outcomes-follow-verifier-checks", async () => {
    for (const { result: r } of runs) {
      for (const o of relays(r)) expectFollowsVerifierChecks(r, o);
      const v = verifierOf(r);
      const executed = BigInt(relays(r).filter((o) => o.executed_after_action).length);
      // Balances read here, after the run: only the executed relays moved anything, each by the order's own amounts.
      const usdc = tokenId(r.accounts.usdc_token);
      const wnear = tokenId(r.accounts.wnear_token);
      const counter = counterDiff({ sellToken: usdc, sellAmount: SELL_USDC, buyToken: wnear, buyAmount: BUY_WNEAR }, BigInt(r.start.fee_pips));
      expect(await v.balance(r.accounts.treasury, r.accounts.usdc_token)).toBe(BigInt(r.start.treasury_usdc) - executed * SELL_USDC);
      expect(await v.balance(r.accounts.treasury, r.accounts.wnear_token)).toBe(BigInt(r.start.treasury_wnear) + executed * BUY_WNEAR);
      expect(await v.balance(r.accounts.filler, r.accounts.usdc_token)).toBe(BigInt(r.start.filler_usdc) + executed * (counter[usdc] ?? 0n));
      expect(await v.balance(r.accounts.filler, r.accounts.wnear_token)).toBe(BigInt(r.start.filler_wnear) + executed * (counter[wnear] ?? 0n));
      // A nonce is committed by an executed order or by a cancellation, and by nothing else: no rejected relay commits one.
      for (const nonce of new Set(relays(r).map((o) => o.nonce))) {
        const same = relays(r).filter((o) => o.nonce === nonce);
        const committed = same.some((o) => o.executed_after_action || o.nonce_used_before_relay);
        expect(await v.isNonceUsed(r.accounts.treasury, nonce), `${r.scope}/${r.id}/${same[0]?.label ?? ""}`).toBe(committed);
      }
    }
  }));

  // gate: LAB
  it("wait: nothing stops an order before its deadline; after its deadline an order is rejected as expired", () => evidence.check("wait", () => {
    for (const r of of("wait")) {
      expect(ownerTxs(r)).toEqual([]);
      expect(r.account_key_signatures).toBe(0);
      allAfterAction(r);
      // Key registered, nonce unused, deadline ahead: by the verifier's checks all three execute.
      for (const o of r.orders) expect(o).toMatchObject({ key_registered_before_relay: true, nonce_used_before_relay: false, executed_after_action: true });
      // The same key and an unused nonce, so the passed deadline is the only check that can have rejected it.
      expect(r.other_relays).toHaveLength(1);
      expect(r.other_relays[0]).toMatchObject({ signed_with: r.account_key, key_registered_before_relay: true, nonce_used_before_relay: false, relayed_before_deadline: false, executed_after_action: false });
      expect(r.other_relays[0]?.error).toContain("deadline has expired");
    }
  }));

  // gate: LAB
  it("cancel a complete list: one signature by the account's key per nonce stops every order; the key keeps working", () => evidence.check("cancel-complete", async () => {
    for (const r of of("cancel_complete")) {
      const c = await cancellation(r);
      expect(c).toEqual({ success: true, nonces: withheldNonces(r), keys: r.orders.map(() => r.account_key) });
      expect(r.account_key_signatures).toBe(c.keys.length);
      allAfterAction(r);
      for (const o of r.orders) expect(o).toMatchObject({ key_registered_before_relay: true, nonce_used_before_relay: true, executed_after_action: false });
      expect(r.other_relays).toHaveLength(1);
      expect(r.other_relays[0]).toMatchObject({ signed_with: r.account_key, relayed_before_deadline: true, executed_after_action: true });
    }
  }));

  // gate: LAB
  it("cancel an incomplete list: the order missing from the owner's record still executes", () => evidence.check("cancel-incomplete", async () => {
    for (const r of of("cancel_incomplete")) {
      const c = await cancellation(r);
      const recorded = r.orders.filter((o) => o.recorded_by_owner);
      expect(recorded.length).toBeLessThan(r.orders.length);
      expect(c).toEqual({ success: true, nonces: withheldNonces(r, (o) => o.recorded_by_owner), keys: recorded.map(() => r.account_key) });
      expect(r.account_key_signatures).toBe(recorded.length);
      allAfterAction(r);
      // Only a listed nonce is committed, so exactly the orders outside the owner's record execute.
      for (const o of r.orders) {
        expect(o, o.label).toMatchObject({ key_registered_before_relay: true, nonce_used_before_relay: o.recorded_by_owner, executed_after_action: !o.recorded_by_owner });
      }
      expect(r.other_relays).toHaveLength(1);
      expect(r.other_relays[0]).toMatchObject({ signed_with: r.account_key, executed_after_action: true });
    }
  }));

  // gate: LAB
  it("cancel with the signer unavailable: without a signature by the account's key nothing is cancelled", () => evidence.check("cancel-signer-unavailable", async () => {
    for (const r of of("cancel_signer_unavailable")) {
      const c = await cancellation(r);
      // The complete list, signed, but by no key of the account: the verifier rejects the bundle for that key.
      expect(c.nonces).toEqual(withheldNonces(r));
      expect(c.keys).not.toContain(r.account_key);
      expect(new Set(c.keys).size).toBe(1);
      expect(c.success).toBe(false);
      expect(ownerTxs(r)[0]?.error).toContain(`public key '${c.keys[0] ?? ""}' doesn't exist for account '${r.accounts.treasury}'`);
      expect(r.account_key_signatures).toBe(0);
      allAfterAction(r);
      for (const o of r.orders) expect(o).toMatchObject({ key_registered_before_relay: true, nonce_used_before_relay: false, executed_after_action: true });
      expect(r.other_relays).toEqual([]);
    }
  }));

  /** The removal is one direct call by the account, attaching 1 yoctoNEAR and naming the account's key. */
  const expectRemoval = (r: AlternativeResult, c: ChainCall | undefined): void => {
    expect({ method: c?.method, key: KeyArgs.parse(c?.args).public_key, deposit: c?.deposit, success: c?.success }).toEqual({ method: "remove_public_key", key: r.account_key, deposit: "1", success: true });
  };

  // gate: LAB
  it("remove the key, fresh key: no order signed with the removed key executes, before or after resuming", () => evidence.check("remove-fresh-key", async () => {
    for (const r of of("remove_fresh_key")) {
      const calls = await ownerCalls(r);
      expect(calls).toHaveLength(1);
      expectRemoval(r, calls[0]);
      expect(r.account_key_signatures).toBe(0);
      allAfterAction(r);
      for (const o of r.orders) expect(o).toMatchObject({ key_registered_before_relay: false, nonce_used_before_relay: false, executed_after_action: false });
      // Resuming: an order under a different, registered key executes; an old order relayed again does not.
      const [fresh, old, ...rest] = r.other_relays;
      expect(rest).toEqual([]);
      expect(fresh?.signed_with).not.toBe(r.account_key);
      expect(fresh).toMatchObject({ key_registered_before_relay: true, executed_after_action: true });
      expect(r.orders.map((o) => o.nonce)).toContain(old?.nonce);
      expect(old).toMatchObject({ signed_with: r.account_key, key_registered_before_relay: false, relayed_before_deadline: true, executed_after_action: false });
      expect(await verifierOf(r).hasPublicKey(r.accounts.treasury, r.account_key)).toBe(false);
    }
  }));

  // gate: LAB
  it("remove the key, same key: the orders are rejected while it is removed and execute once it is re-added", () => evidence.check("remove-same-key", async () => {
    for (const r of of("remove_same_key")) {
      const calls = await ownerCalls(r);
      expect(calls).toHaveLength(2);
      expectRemoval(r, calls[0]);
      expect({ method: calls[1]?.method, key: KeyArgs.parse(calls[1]?.args).public_key, success: calls[1]?.success }).toEqual({ method: "add_public_key", key: r.account_key, success: true });
      expect(r.account_key_signatures).toBe(0);
      // While removed: the same three orders, unexpired, nonces unused, rejected for the key alone.
      expect(r.other_relays.map((o) => o.nonce)).toEqual(r.orders.map((o) => o.nonce));
      for (const o of r.other_relays) {
        expect(o).toMatchObject({ signed_with: r.account_key, key_registered_before_relay: false, nonce_used_before_relay: false, relayed_before_deadline: true, executed_after_action: false });
        // Rejected before the re-add, in chain time.
        expect(BigInt(o.relayed_at_ns)).toBeLessThan(calls[1]?.executedAtNs ?? 0n);
      }
      allAfterAction(r);
      for (const o of r.orders) {
        expect(o).toMatchObject({ key_registered_before_relay: true, nonce_used_before_relay: false, executed_after_action: true });
        expect(BigInt(o.relayed_at_ns)).toBeGreaterThan(calls[1]?.executedAtNs ?? 0n);
      }
    }
  }));

  // gate: LAB
  it("keep two scopes that ran at the same time apart", () => evidence.check("concurrent-scopes-isolated", async () => {
    const [one, two] = SCOPES.map((scope) => runs.filter((r) => r.scope === scope));
    if (one === undefined || two === undefined) throw new Error("two scopes expected");
    // They did overlap: every run of one scope was in progress while a run of the other was.
    for (const a of one) expect(two.some((b) => a.started < b.ended && b.started < a.ended), a.result.id).toBe(true);
    // No account or transaction in common, and every account sits under an account named after its scope.
    const accountsOf = (rs: Run[]): string[] => rs.flatMap((r) => Object.values(r.result.accounts));
    const hashesOf = (rs: Run[]): string[] => rs.flatMap((r) => r.result.transactions.map((t) => t.tx_hash));
    expect(accountsOf(one).filter((a) => accountsOf(two).includes(a))).toEqual([]);
    expect(hashesOf(one).filter((h) => hashesOf(two).includes(h))).toEqual([]);
    expect(new Set([...accountsOf(one), ...accountsOf(two)]).size).toBe(runs.length * 7);
    for (const { scope, result: r } of runs) {
      expect(r.scope).toBe(scope);
      expect(r.accounts.operator).toBe(`${scope}-${r.accounts.operator.slice(scope.length + 1)}`);
      expect(r.accounts.operator.endsWith(`.${net.root.id}`)).toBe(true);
      for (const a of Object.values(r.accounts)) expect(a === r.accounts.operator || a.endsWith(`.${r.accounts.operator}`), a).toBe(true);
      // Every transaction of a run is signed inside the run, apart from the root funding its operator account.
      for (const t of r.transactions) {
        expect(Object.values(r.accounts), t.label).toContain(t.receiver_id);
        expect([...Object.values(r.accounts), net.root.id], t.label).toContain(t.signer_id);
      }
      expect(r.transactions.filter((t) => t.signer_id === net.root.id).map((t) => t.receiver_id)).toEqual([r.accounts.operator]);
    }
    // The same alternative gave the same outcomes in both scopes (balances per scope are accounted for above).
    const table = (rs: Run[]) =>
      Object.fromEntries(
        rs.map(({ result: r }) => [
          r.id,
          { signatures: r.account_key_signatures, owner: ownerTxs(r).map((t) => [t.method, t.success]), relays: relays(r).map((o) => [o.label, o.phase, o.executed_after_action]) },
        ]),
      );
    expect(table(one)).toEqual(table(two));
    expect(Object.keys(table(one)).sort()).toEqual([...ALTERNATIVES].sort());
    // A scope and alternative that already ran cannot run again, and the attempt leaves the first run's state alone.
    const first = one.find((r) => r.result.id === "cancel_incomplete")?.result;
    if (first === undefined) throw new Error("no run");
    const treasuryUsdc = () => verifierOf(first).balance(first.accounts.treasury, first.accounts.usdc_token);
    const before = await treasuryUsdc();
    await expect(runAlternative(net, wasm, first.scope, first.id)).rejects.toThrow(/AccountAlreadyExists|already exists/);
    expect(await treasuryUsdc()).toBe(before);
    await expect(runAlternative(net, wasm, "Not A Scope", "wait")).rejects.toThrow(/cannot be part of an account name/);
  }));
});
