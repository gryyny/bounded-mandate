// The only answer shape the model may give. The proposal object is exactly types.Proposal; anything else
// (recipients, payloads, keys, paths, token ids, withdrawals) has no field to live in and is rejected.
import { createHash } from "node:crypto";
import { z } from "zod";
import { Proposal } from "../types.js";

export const ModelDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose"), proposal: Proposal, reason: z.string().max(2000) }).strict(),
  z.object({ action: z.literal("decline"), proposal: z.null(), reason: z.string().max(2000) }).strict(),
]);
export type ModelDecision = z.infer<typeof ModelDecision>;

/** JSON Schema given to the model (structured output / strict tool input). Mirrors `ModelDecision`. */
export const DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "proposal", "reason"],
  properties: {
    action: { type: "string", enum: ["propose", "decline"] },
    proposal: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["sell", "sell_amount", "max_concession_bps"],
          properties: {
            sell: { type: "string", enum: ["usdc", "wnear"], description: "Asset to sell; the other asset is bought." },
            sell_amount: {
              type: "string",
              description: "Integer base units of the sold asset as a decimal string (USDC 6 decimals, wNEAR 24).",
            },
            max_concession_bps: { type: "integer", description: "Maximum price concession in basis points." },
          },
        },
        { type: "null" },
      ],
    },
    reason: { type: "string", description: "One or two sentences explaining the decision." },
  },
} as const;

export type AdapterVerdict =
  | { kind: "proposal"; proposal: Proposal; reason: string }
  | { kind: "decline"; reason: string }
  | { kind: "rejected"; boundary: "adapter-schema"; errors: string[] };

/** Strict validation of untrusted model output. Never repairs, coerces or drops fields. */
export function validateDecision(raw: unknown): AdapterVerdict {
  const parsed = ModelDecision.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "rejected",
      boundary: "adapter-schema",
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    };
  }
  const d = parsed.data;
  return d.action === "propose"
    ? { kind: "proposal", proposal: d.proposal, reason: d.reason }
    : { kind: "decline", reason: d.reason };
}

/** Parses model text that should be exactly one JSON value. */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text.trim()) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
