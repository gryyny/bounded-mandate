// SYNTHETIC open-challenge records for the page tests; none was produced by a challenge run or read from any chain.
import { CHALLENGE_DOES_NOT_SHOW, CHALLENGE_RECORD_SCHEMA, CHALLENGE_SHOWS, ChallengeRecord, KEY_PUBLICATION } from "../src/live/challenge.js";

const POLICY = { per_order_cap_bps: 1000, outstanding_cap_bps: 2000, max_concession_bps: 50, oracle_max_age_sec: 60, max_confidence_bps: 100, breaker_drawdown_bps: 1500, turnover_cap_bps: 5000, order_ttl_sec: 60, min_remaining_sec: 10, max_pricing_delay_sec: 30, proposal_charge_bps: 10 };
export const AGENT_PUBLIC = "ed25519:SYNTHETICagentPublicKey1111111111111111111";
// 64-byte-looking base58 string standing in for a private key; SYNTHETIC, not a key of any account.
export const SECRET_LOOKING = `ed25519:${"5".repeat(88)}`;

export const record = (status: "open" | "closed" | "not-opened", over: Record<string, unknown> = {}): ChallengeRecord => {
  const opened = status !== "not-opened";
  return ChallengeRecord.parse({
    schema: CHALLENGE_RECORD_SCHEMA,
    mode: "sandbox",
    status,
    generated_at: "2026-11-10T00:00:00Z",
    separate_from_completed_run: true,
    network: { chain_id: "sandbox-SYNTHETIC", genesis_hash: "SYNTHETICgenesis" },
    read_at: { block_height: 4242, block_hash: "SYNTHETICblock", timestamp_ns: "1" },
    accounts: { mandate: "mandate.synthetic", owner: "owner.synthetic", agent: "agent.synthetic", verifier: "verifier.synthetic", signer: "signer.synthetic" },
    mandate_code_hash: "SYNTHETICcode",
    agent_key: { public_key: AGENT_PUBLIC, allowance_yocto: "250000000000000000000000", nonce: "7", publication: KEY_PUBLICATION, publication_url: null },
    manifests: { open: opened ? "f".repeat(64) : null, close: status === "closed" ? "e".repeat(64) : null },
    opened: opened ? { tx_hash: "SYNTHETICopenTx", block_height: 4000 } : null,
    grant: opened
      ? { epoch: 3, path: "mandate/v1/3", public_key: "ed25519:SYNTHETICgrantKey", key_registered: status === "open", status: status === "closed" ? "revoked" : "active", policy: POLICY, initial_value: "200000000000000", turnover_used: "123400000", outstanding: "0", breaker: null, proposal_budget_upper_bound: 500 }
      : null,
    earlier_grants: [{ epoch: 2, path: "mandate/v1/2", derived_public_key: "ed25519:SYNTHETICearlierKey", registered: false }],
    earlier_unexecuted_orders: [{ id: "SYNTHETIC-withheld-9", epoch: 2, state: "released:key_removed", deadline_ns: "999", nonce_used: false }],
    challenge_orders: { total: opened ? 5 : 0, by_state: opened ? { executed: 2, "rejected:over_cap": 3 } : {} },
    mandate_balances: { usdc: "100000000", wnear: "33000000000000000000000000" },
    close: status === "closed" ? { exit_code: 0, message: "SYNTHETIC close completed", receipts: [{ label: "owner revoke (SYNTHETIC)", tx_hash: "SYNTHETICrevokeTx", method: "revoke", outcome: "success" }] } : null,
    shows: CHALLENGE_SHOWS,
    does_not_show: [...CHALLENGE_DOES_NOT_SHOW],
    ...over,
  });
};

