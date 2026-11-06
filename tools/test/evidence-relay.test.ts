// The demo's withheld-rejected rule on SYNTHETIC inputs built here: only the verifier's exact removed-key error, in a
// block before the order's deadline, with the nonce unused and no balance change, counts as the effect of revocation.
import { describe, expect, it } from "vitest";
import { relayRejectionProblems, removedKeyError, type RelayRejectionInput } from "../src/evidence/journey.js";

const KEY = "ed25519:SYNTHETICremovedkey";
const MANDATE = "mandate.synthetic";
const DEADLINE = 2_000_000_000_000_000_000n;
const held: RelayRejectionInput = {
  relaySucceeded: false,
  verifierError: `{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: public key '${KEY}' doesn't exist for account '${MANDATE}'"}}}}`,
  revokedKey: KEY,
  mandate: MANDATE,
  deadlineNs: DEADLINE,
  rejectedAtNs: DEADLINE - 30_000_000_000n,
  nonceUsed: false,
  balancesUnchanged: true,
};

describe("withheld relay rejection", () => {
  it("holds for the verifier's removed-key error before the deadline", () => {
    expect(removedKeyError(KEY, MANDATE)).toBe(`public key '${KEY}' doesn't exist for account '${MANDATE}'`);
    expect(relayRejectionProblems(held)).toEqual([]);
  });

  it("does not hold for a malformed signature, another key or another account", () => {
    for (const verifierError of [
      "Smart contract panicked: invalid signature",
      "Smart contract panicked: public key 'ed25519:OTHER' doesn't exist for account 'mandate.synthetic'",
      `Smart contract panicked: public key '${KEY}' doesn't exist for account 'other.synthetic'`,
    ]) {
      expect(relayRejectionProblems({ ...held, verifierError })).toEqual([`the verifier error does not name the removed key: expected "${removedKeyError(KEY, MANDATE)}"`]);
    }
  });

  it("does not hold for an order rejected at or after its deadline, even when broadcast before it", () => {
    expect(relayRejectionProblems({ ...held, rejectedAtNs: DEADLINE })).toEqual(["the rejection's block is at or after the order's deadline"]);
    expect(relayRejectionProblems({ ...held, rejectedAtNs: DEADLINE + 1n })).toEqual(["the rejection's block is at or after the order's deadline"]);
    expect(relayRejectionProblems({ ...held, rejectedAtNs: null })).toEqual(["the rejection's block time is not known"]);
    expect(relayRejectionProblems({ ...held, deadlineNs: null })).toEqual(["the order's deadline is not known"]);
  });

  it("does not hold for an unrelated failure, a success, a used nonce or a balance change", () => {
    expect(relayRejectionProblems({ ...held, verifierError: null })).toEqual(["no verifier receipt failed"]);
    expect(relayRejectionProblems({ ...held, relaySucceeded: true, verifierError: null, nonceUsed: true, balancesUnchanged: false })).toEqual([
      "the relay succeeded",
      "no verifier receipt failed",
      "the order's nonce was used",
      "the mandate's balances changed",
    ]);
  });
});
