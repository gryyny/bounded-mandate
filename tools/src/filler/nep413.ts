// NEP-413 encoding for NEAR Intents payloads, as implemented by the pinned verifier (defuse 0.4.5):
// prehash = sha256(borsh(2147484061u32, Nep413Payload)); message JSON = {signer_id, deadline, intents}.
import { createHash, randomBytes } from "node:crypto";
import { baseEncode, type KeyPair } from "near-api-js";
import type { SignedNep413 } from "../types.js";

export const NEP413_TAG = 2_147_484_061; // 2^31 + 413
export const VERSIONED_NONCE_MAGIC = Buffer.from("5628f6c6", "hex");

export interface Nep413Fields {
  message: string;
  /** 32 bytes. */
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
}

const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const borshString = (s: string): Buffer => {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32le(bytes.length), bytes]);
};

export function borshPayload(p: Nep413Fields): Buffer {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  return Buffer.concat([
    borshString(p.message),
    Buffer.from(p.nonce),
    borshString(p.recipient),
    p.callbackUrl === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]),
  ]);
}

export function nep413Prehash(p: Nep413Fields): Buffer {
  return createHash("sha256").update(Buffer.concat([u32le(NEP413_TAG), borshPayload(p)])).digest();
}

/** Versioned nonce V1: magic || 0x00 (V1) || salt(4) || deadline i64 ns LE || 15 random bytes. */
export function versionedNonce(saltHex: string, deadlineNs: bigint, random: Uint8Array = randomBytes(15)): Buffer {
  const salt = Buffer.from(saltHex, "hex");
  if (salt.length !== 4) throw new Error(`salt must be 4 bytes hex, got ${saltHex}`);
  if (random.length !== 15) throw new Error("nonce random part must be 15 bytes");
  const deadline = Buffer.alloc(8);
  deadline.writeBigInt64LE(deadlineNs);
  return Buffer.concat([VERSIONED_NONCE_MAGIC, Buffer.from([0]), salt, deadline, Buffer.from(random)]);
}

/** RFC 3339 with nanosecond precision, as the verifier's Timestamp serializes. */
export function rfc3339FromNs(ns: bigint): string {
  const ms = ns / 1_000_000n;
  const iso = new Date(Number(ms)).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  const subSecondNs = (ns % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${iso.slice(0, 19)}${subSecondNs === "" ? "" : `.${subSecondNs}`}Z`;
}

/** Defuse NEP-413 message with one token_diff intent. Deltas are decimal i128 strings keyed by `nep141:<token>`. */
export function tokenDiffMessage(signerId: string, deadlineNs: bigint, diff: Record<string, bigint>): string {
  const sorted = Object.fromEntries(
    Object.entries(diff)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([token, delta]) => [token, delta.toString()]),
  );
  return JSON.stringify({
    signer_id: signerId,
    deadline: rfc3339FromNs(deadlineNs),
    intents: [{ intent: "token_diff", diff: sorted }],
  });
}

export function signNep413(key: KeyPair, fields: Nep413Fields): SignedNep413 {
  const signature = key.sign(nep413Prehash(fields));
  return {
    standard: "nep413",
    payload: {
      message: fields.message,
      nonce: Buffer.from(fields.nonce).toString("base64"),
      recipient: fields.recipient,
      ...(fields.callbackUrl === undefined ? {} : { callbackUrl: fields.callbackUrl }),
    },
    public_key: key.getPublicKey().toString(),
    signature: `ed25519:${baseEncode(signature.signature)}`,
  };
}
