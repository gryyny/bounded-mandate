// What the console's signers accept: the runner's persisted `bounded-mandate/external-intent@1` (src/live/external.ts,
// owned by the runner) or, when no runner intent is loaded, the console's own `bounded-mandate/console-intent@1` with
// the same transaction fields. Both are identified by sha256 of their canonical JSON, the digest the runner uses.
import { createHash } from "node:crypto";
import { z } from "zod";
import { ExternalIntent, canonicalJson } from "../live/external.js";

const dec = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const CONSOLE_INTENT_SCHEMA = "bounded-mandate/console-intent@1";

export const ConsoleIntent = z
  .object({
    schema: z.literal(CONSOLE_INTENT_SCHEMA),
    action: z.enum(["revoke", "recover", "withdraw", "register"]),
    asset: z.enum(["usdc", "wnear"]).nullable(),
    network: z.object({ chain_id: z.string().min(1), genesis_hash: z.string().min(32) }).strict(),
    signer_id: z.string().min(2),
    public_key: z.string().startsWith("ed25519:").nullable(),
    receiver_id: z.string().min(2),
    actions: z.array(z.object({ method: z.string().min(1), args: z.record(z.string(), z.unknown()), gas: dec, deposit: dec }).strict()).length(1),
  })
  .strict();
export type ConsoleIntent = z.infer<typeof ConsoleIntent>;

/** The fields a signer needs, from either record. */
export interface Signable {
  sha256: string;
  source: "runner" | "console";
  network: { chain_id: string; genesis_hash: string };
  signer_id: string;
  public_key: string | null;
  receiver_id: string;
  actions: { method: string; args: Record<string, unknown>; gas: string; deposit: string }[];
}

/** sha256 (hex) of the canonical JSON (sorted keys, no whitespace), the identity a handoff names. */
export const intentSha256 = (record: unknown): string => createHash("sha256").update(canonicalJson(record)).digest("hex");

export function signableOf(raw: unknown): Signable | { error: string } {
  const runner = ExternalIntent.safeParse(raw);
  if (runner.success) {
    const r = runner.data;
    return { sha256: intentSha256(r), source: "runner", network: { chain_id: r.network.chain_id, genesis_hash: r.network.genesis_hash }, signer_id: r.signer_id, public_key: r.public_key, receiver_id: r.receiver_id, actions: r.actions };
  }
  const own = ConsoleIntent.safeParse(raw);
  if (own.success) {
    const c = own.data;
    return { sha256: intentSha256(c), source: "console", network: c.network, signer_id: c.signer_id, public_key: c.public_key, receiver_id: c.receiver_id, actions: c.actions };
  }
  return { error: "neither a bounded-mandate/external-intent@1 nor a bounded-mandate/console-intent@1 record" };
}
