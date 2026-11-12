// The cases of the historical replay shared by verify.mjs and the page's verification panel (SPEC.md "Historical
// replay of the withheld order"). SYNTHETIC: each case is the synthetic run served by ./chain.ts with one stated
// difference. A case states which rules of the spec its chain contradicts and whether the provider withholds state the
// replay needs; the expected result follows from those two facts by the spec's rule, not from either implementation.
import { STRANGER_KEY } from "../verify/synthetic.js";
import { OTHER_CODE_HASH, REMOVAL_AT, REVOKE_INCLUDED_AT, type ReplayInput, type ReplayOptions } from "./chain.js";

/** The rules of the spec's list, in its order. */
export const REPLAY_ITEMS = ["bundle", "preceding", "removal", "deadlines", "relay", "code"] as const;
export type ReplayItem = (typeof REPLAY_ITEMS)[number];
export type ReplayStatus = "verified" | "failed" | "inconclusive";

export interface ReplayCase {
  id: string;
  /** What this recorded chain shows. */
  shows: string;
  options: ReplayOptions;
  /** Rules the recorded chain contradicts. */
  contradicts: readonly ReplayItem[];
  /** The provider does not serve state the replay needs, even after its bounded retries. */
  unserved: boolean;
  /** What the run's evidence records differently from the synthetic run. */
  input?: Partial<ReplayInput>;
}

/** "Evidence that contradicts any item yields failed; state a provider cannot serve yields inconclusive." */
export const expectedStatus = (c: ReplayCase): ReplayStatus => (c.contradicts.length > 0 ? "failed" : c.unserved ? "inconclusive" : "verified");

const holds = (id: string, shows: string, options: ReplayOptions = {}): ReplayCase => ({ id, shows, options, contradicts: [], unserved: false });
const contradicts = (id: string, items: readonly ReplayItem[], shows: string, options: ReplayOptions, input?: Partial<ReplayInput>): ReplayCase => ({ id, shows, options, contradicts: items, unserved: false, ...(input === undefined ? {} : { input }) });
const unserved = (id: string, shows: string, options: ReplayOptions): ReplayCase => ({ id, shows, options, contradicts: [], unserved: true });

export const REPLAY_CASES: readonly ReplayCase[] = [
  holds("verified", "every rule holds: the bundle is accepted at the block before the removal executed and refused for the removed key at the block of the removal"),
  holds("rate-limited-then-served", "the provider answers the first two simulate_intents requests with HTTP 429 and then serves them", { unserved: { what: "simulate", how: "http-429", times: 2 } }),
  holds("refusal-as-rpc-error", "the node reports the contract's refusal as a CONTRACT_EXECUTION_ERROR instead of inside the result", { structuredRefusals: true }),

  contradicts("altered-bundle", ["preceding"], "the relay transaction carries the bundle with the counterparty's leg changed, which the verifier does not accept at the preceding snapshot", { relayed: "counter-altered" }),
  contradicts("no-bundle", ["bundle"], "the relay transaction carries no signed intents", { relayed: "nothing" }),
  contradicts("unbound-order", ["bundle"], "the mandate logged no signed-order event for the relayed order", { signedEvent: "absent" }),
  contradicts("signed-after-removal", ["bundle"], "the mandate's signed-order event for the relayed order is in a block after the removal", { signedEvent: "after-removal" }),
  contradicts("another-key", ["preceding", "removal"], "the relayed order is signed with a key the revoke did not remove, so no removal of that key defines a snapshot", { orderKey: "stranger" }),
  contradicts("inclusion-block", ["preceding"], "the key's registration ends in the block that included the revoke transaction: only that block and the one before it would pass, the removal receipt's block and its prev_hash do not", { keyGoneFrom: REVOKE_INCLUDED_AT }),
  contradicts("one-block-late", ["removal"], "the key is still registered in the block in which the removal receipt executed and gone only in the next one", { keyGoneFrom: REMOVAL_AT + 1 }),
  contradicts("key-never-removed", ["removal"], "the key stays registered after the revoke", { keyNeverRemoved: true }),
  contradicts("removal-on-another-contract", ["removal"], "the revoke's remove_public_key receipt went to another account than the verifier", { removalReceiver: "fake-intents.near" }),
  contradicts("revoke-failed", ["removal"], "the revoke failed on the mandate and removed no key", { revokeFails: true }),
  contradicts("expired-order", ["deadlines", "relay"], "the order's deadline passed before both snapshots", { orderDeadlineAtBlock: REMOVAL_AT - 7 }),
  contradicts("expires-at-removal", ["deadlines", "relay"], "the order's deadline equals the removal snapshot's block time, which is not before it", { orderDeadlineAtBlock: REMOVAL_AT }),
  contradicts("expired-before-relay", ["relay"], "the order's deadline is after both snapshots and before the block in which the relay failed", { orderDeadlineAtBlock: REMOVAL_AT + 4 }),
  contradicts("mandate-code-changed", ["code"], "the mandate account has another code hash at the preceding snapshot", { mandateCodeBefore: { block: REMOVAL_AT, code: OTHER_CODE_HASH } }),
  contradicts("verifier-code-changed", ["code"], "the verifier account has another code hash at the removal snapshot", { verifierCodeFrom: REMOVAL_AT }),
  contradicts("verifier-code-not-recorded", ["code"], "the run's evidence records no code hash for the verifier", {}, { verifier_code_hash: null }),
  contradicts("mandate-code-not-recorded", ["code"], "the run's evidence records no deployment candidate's code hash for the mandate", {}, { mandate_code_hash: null }),
  contradicts("relay-other-key", ["relay"], "the relay failed on the verifier for another key than the order's", { rejectedKey: STRANGER_KEY }),
  contradicts("relay-other-error", ["relay"], "the relay failed on the verifier for a used nonce, not for a missing key", { relayError: "nonce was already used" }),
  contradicts("refused-for-used-nonce", ["removal"], "at the removal snapshot the verifier refuses the bundle for a used nonce, not for a missing key", { simulate: { removal: "nonce-used" } }),
  contradicts("refused-as-expired", ["removal"], "at the removal snapshot the verifier refuses the bundle as expired, not for a missing key", { simulate: { removal: "expired" } }),
  contradicts("invariant-violated", ["preceding"], "at the preceding snapshot the simulation reports an invariant violation", { simulate: { preceding: "invariant" } }),
  contradicts("partly-executed", ["preceding"], "at the preceding snapshot the simulation executes only one of the two signed intents", { simulate: { preceding: "partial" } }),

  unserved("pruned-state", "the provider does not know the snapshot blocks for contract views", { unserved: { what: "state", how: "unknown-block" } }),
  unserved("garbage-collected-accounts", "the provider has garbage-collected the accounts at the snapshot blocks", { unserved: { what: "code", how: "garbage-collected" } }),
  unserved("rate-limited", "the provider answers every simulate_intents request with HTTP 429", { unserved: { what: "simulate", how: "http-429" } }),
  unserved("blocks-unavailable", "the provider fails every block lookup", { unserved: { what: "blocks", how: "http-503" } }),
  unserved("receipts-unavailable", "the provider does not return the revoke's receipts", { unserved: { what: "receipts", how: "http-503" } }),
  unserved("relay-unavailable", "the provider does not return the relay transaction", { unserved: { what: "relay", how: "http-503" } }),
  unserved("answer-for-another-block", "the provider answers contract views for another block than the requested snapshot", { unserved: { what: "state", how: "other-block" } }),

  { id: "altered-and-unserved", shows: "the relayed bundle is altered and the provider does not serve the accounts: the contradiction stands", options: { relayed: "counter-altered", unserved: { what: "code", how: "http-503" } }, contradicts: ["preceding"], unserved: true },
];
