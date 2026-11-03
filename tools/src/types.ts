// Shared interface types mirroring contract/src/types.rs, plus the evidence schema.
// Provisional: the coordinator changes these as integration requires.
import { z } from "zod";

const u128 = z.string().regex(/^(0|[1-9][0-9]*)$/, "decimal integer string");
const u64 = u128;

export const Asset = z.enum(["usdc", "wnear"]);
export type Asset = z.infer<typeof Asset>;

/** The only agent input accepted by `propose_order`. Unknown fields are rejected. */
export const Proposal = z
  .object({
    sell: Asset,
    sell_amount: u128,
    max_concession_bps: z.number().int().min(0).max(65_535),
  })
  .strict();
export type Proposal = z.infer<typeof Proposal>;

export const Policy = z.object({
  per_order_cap_bps: z.number().int(),
  outstanding_cap_bps: z.number().int(),
  max_concession_bps: z.number().int(),
  oracle_max_age_sec: z.number().int(),
  max_confidence_bps: z.number().int(),
  breaker_drawdown_bps: z.number().int(),
  turnover_cap_bps: z.number().int(),
  order_ttl_sec: z.number().int(),
  min_remaining_sec: z.number().int(),
  max_pricing_delay_sec: z.number().int(),
});
export type Policy = z.infer<typeof Policy>;

export const PriceObservation = z.object({
  price_id: z.string(),
  price: u64,
  conf: u64,
  expo: z.number().int(),
  publish_time_sec: u64,
});
export type PriceObservation = z.infer<typeof PriceObservation>;

export const Reference = z.object({
  usdc: PriceObservation,
  wnear: PriceObservation,
  observed_at_ns: u64,
});
export type Reference = z.infer<typeof Reference>;

export const GrantStatus = z.enum(["activating", "active", "revoking", "revoked"]);
export type GrantStatus = z.infer<typeof GrantStatus>;

export const BreakerTrip = z.object({
  observed_at_ns: u64,
  observed_value: u128,
  executable_orders: z.number().int(),
  executable_value: u128,
});

export const GrantView = z.object({
  epoch: z.number().int(),
  path: z.string(),
  public_key: z.string().nullable(),
  status: GrantStatus,
  policy: Policy,
  initial_reference: Reference.nullable(),
  initial_value: u128.nullable(),
  turnover_used: u128,
  outstanding: u128,
  breaker: BreakerTrip.nullable(),
  key_op_in_flight: z.boolean(),
});
export type GrantView = z.infer<typeof GrantView>;

export const ReleaseReason = z.enum(["settled", "expired", "key_removed", "unsigned"]);
export type ReleaseReason = z.infer<typeof ReleaseReason>;

export const OrderState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pricing") }),
  z.object({ state: z.literal("signing") }),
  z.object({ state: z.literal("signed") }),
  z.object({ state: z.literal("sign_unknown") }),
  z.object({ state: z.literal("rejected"), reason: z.string() }),
  z.object({ state: z.literal("released"), reason: ReleaseReason }),
]);
export type OrderState = z.infer<typeof OrderState>;

export const Nep413Payload = z.object({
  message: z.string(),
  nonce: z.string(),
  recipient: z.string(),
});
export type Nep413Payload = z.infer<typeof Nep413Payload>;

export const OrderView = z.object({
  id: u64,
  epoch: z.number().int(),
  sell: Asset,
  sell_amount: u128,
  buy: Asset,
  buy_amount: u128.nullable(),
  concession_bps: z.number().int(),
  reserved_value: u128,
  deadline_ns: u64.nullable(),
  reference: Reference.nullable(),
  payload: Nep413Payload.nullable(),
  payload_hash: z.string().nullable(),
  signature: z.string().nullable(),
  state: OrderState,
  created_at_ns: u64,
  sign_requested_at_ns: u64.nullable(),
  signed_at_ns: u64.nullable(),
});
export type OrderView = z.infer<typeof OrderView>;

/** NEAR Intents `MultiPayload` NEP-413 arm, as submitted to `execute_intents`. */
export const SignedNep413 = z.object({
  standard: z.literal("nep413"),
  payload: z.object({
    message: z.string(),
    nonce: z.string(),
    recipient: z.string(),
    callbackUrl: z.string().optional(),
  }),
  public_key: z.string(),
  signature: z.string(),
});
export type SignedNep413 = z.infer<typeof SignedNep413>;

/**
 * Execution mode of an evidence record. Never label a mode stronger than what ran:
 * - source: static/source verification only
 * - sandbox: local sandbox executing our contract and the pinned verifier WASM, with labelled mocks
 * - recorded-model: genuine model output recorded earlier and replayed
 * - live-model: a model call made during this run
 * - mainnet: receipts from NEAR mainnet
 */
export const EvidenceMode = z.enum(["source", "sandbox", "recorded-model", "live-model", "mainnet"]);
export type EvidenceMode = z.infer<typeof EvidenceMode>;

export const Assertion = z.object({
  id: z.string(),
  gate: z.string(),
  description: z.string(),
  passed: z.boolean(),
  observed: z.unknown(),
});
export type Assertion = z.infer<typeof Assertion>;

export const Receipt = z.object({
  label: z.string(),
  tx_hash: z.string().optional(),
  receipt_id: z.string().optional(),
  block_height: z.number().int().optional(),
  outcome: z.enum(["success", "failure"]),
  detail: z.unknown(),
});
export type Receipt = z.infer<typeof Receipt>;

export const Evidence = z.object({
  schema_version: z.literal(1),
  generated_at: z.string(),
  mode: EvidenceMode,
  source: z.object({
    product_commit: z.string(),
    dirty: z.boolean(),
    spec_sha256: z.string(),
    spec_commit: z.string(),
    contract_wasm_sha256: z.string(),
    fixtures: z.record(z.string(), z.string()),
  }),
  environment: z.record(z.string(), z.string()),
  command: z.string(),
  seed: z.string().optional(),
  identifiers: z.record(z.string(), z.string()),
  receipts: z.array(Receipt),
  assertions: z.array(Assertion),
  unknowns: z.array(z.string()),
});
export type Evidence = z.infer<typeof Evidence>;
