// Required acceptance cases (BRIEF2 / SPEC.md "Acceptance tests" and "Also require"), as data.
// A gate passes only when every case listed here is present exactly once in the run and passed.

export const REQUIRED_CASES = {
  T1: ["withheld-regrant", "pending-sign", "revoke-during-activation", "failed-removal-retry"],
  T2: ["unit-interleavings", "sandbox-interleavings"],
  T2b: ["disclosed-relay", "callback-failed-after-disclosure"],
  T3: ["concession", "feeds-timing", "breaker"],
  T4: ["dependency-failure", "record-bound", "open-order-limit", "registration-reconcile"],
  T5: ["baseline"],
  BOUNDARY: ["contract", "attacks"],
  MODEL: ["recorded-proposal"],
  /** The proposed deployment binary (reproducible-build fixture) exercised in sandbox. */
  DEPLOY: ["candidate"],
  /** A pinned Sputnik DAO (mainnet factory code) as the fixed owner, threshold-voted, in sandbox. */
  DAO: ["sputnik-owner"],
  /** Runner sale budgets in the agent snapshot, prompt and validation; the no-transaction provider rehearsal (stub providers). */
  AGENT: ["budget-bounds", "rehearsal"],
  /** External owner actions persisted as intents and imported by transaction hash; refusals; lost-response resume. */
  HANDOFF: ["import-verified", "import-refusals", "lost-response-resume", "unrecorded-owner-tx"],
  /** The owner's ft_withdraw of both assets after recovery, outside recovery claims. */
  WITHDRAW: ["both-assets", "unregistered-owner", "failed-receipt-retry"],
  /** The optional live-agent template's full sequence in live-sandbox on the exact deployment binary (synthetic provider). */
  /** And the optional open challenge: open and close templates after a completed run, adversary holding the agent key (sandbox). */
  LIVE: ["agent-template", "open-challenge"],
  /**
   * The owner console in headless Chromium against sandbox: through the labelled local test signer, and through NEAR
   * Connect with the labelled sandbox test wallet. Neither is a real wallet provider.
   */
  CONSOLE: ["browser-sandbox", "access-controls", "wallet-sandbox"],
  /**
   * Matched comparison of the owner's alternatives on the pinned verifier: wait for expiry, cancel recorded nonces,
   * remove the key and resume with a fresh key, remove and re-add the same key.
   */
  COMPARE: ["revocation-alternatives"],
  /** The contract's MPC decoder and key check against a recorded mainnet v1.signer EdDSA response (unit VM, read-only fixture). */
  SIGNER: ["conformance"],
  /** The historical replay of the withheld order: verify.mjs and the page's verification panel on shared SYNTHETIC cases against a local archival RPC stub (no chain). */
  REPLAY: ["historical-rules"],
  /** The sandbox lab and its comparison view on the exact deployment candidate with hash-pinned prebuilt test doubles. */
  LAB: ["workflow", "isolation", "reset", "limits-change-outcomes", "refusals", "export-replay", "flood-limits", "page", "owner-alternatives"],
  /** The independent strategy client (examples/strategy-client) against a local sandbox with prebuilt test doubles: accepted, refused, revoked. */
  EXAMPLE: ["strategy-client"],
} as const satisfies Record<string, readonly string[]>;

/** Reported and shown separately; never counts toward any gate (the owner-key rescue is not ordinary recovery). */
export const SEPARATE_CASES = {
  RESCUE: ["owner-key"],
} as const satisfies Record<string, readonly string[]>;

export type RequiredGate = keyof typeof REQUIRED_CASES;

export const caseId = (gate: string, name: string): string => `${gate}.${name}`;

export const requiredCaseIds = (): string[] =>
  Object.entries(REQUIRED_CASES).flatMap(([gate, cases]) => cases.map((c) => caseId(gate, c)));

export const separateCaseIds = (): string[] =>
  Object.entries(SEPARATE_CASES).flatMap(([gate, cases]) => cases.map((c) => caseId(gate, c)));
