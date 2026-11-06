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
