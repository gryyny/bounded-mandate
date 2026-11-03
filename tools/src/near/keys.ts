// Key helpers. Deterministic keys are for the local sandbox only; live keys come from credential files.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { KeyPair, baseEncode, type KeyPairString } from "near-api-js";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function ed25519FromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const publicKey = spki.subarray(spki.length - 32);
  return KeyPair.fromString(`ed25519:${baseEncode(Buffer.concat([seed, publicKey]))}` as KeyPairString);
}

/** Deterministic sandbox key derived from a label. Never use for a public network. */
export function sandboxKey(label: string): KeyPair {
  return ed25519FromSeed(createHash("sha256").update(`bounded-mandate/sandbox/${label}`).digest());
}
