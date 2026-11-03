import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPairSigner, baseEncode } from "near-api-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { borshPayload, nep413Prehash, NEP413_TAG, rfc3339FromNs, signNep413, tokenDiffMessage, versionedNonce } from "../src/filler/nep413.js";
import { ed25519FromSeed } from "../src/near/keys.js";
import { SignedNep413 } from "../src/types.js";

const Vectors = z.object({
  nep413_tag: z.number(),
  test_keys: z.record(z.string(), z.object({ seed_hex: z.string(), public_key: z.string() })),
  vectors: z.array(
    z.object({
      name: z.string(),
      signer_key: z.string(),
      inputs: z.object({
        signer_id: z.string(),
        verifying_contract: z.string(),
        deadline_ns: z.string(),
        salt_hex: z.string(),
        random_hex: z.string(),
        sell_token: z.string(),
        sell_amount: z.string(),
        buy_token: z.string(),
        buy_amount: z.string(),
      }),
      nonce_hex: z.string(),
      nonce_base64: z.string(),
      message: z.string(),
      nep413_borsh_hex: z.string(),
      prehash_hex: z.string(),
      public_key: z.string(),
      signature_hex: z.string(),
      multi_payload: SignedNep413,
    }),
  ),
});

// Produced by W2p from the Rust protocol module and cross-checked against defuse-core (see manifest).
const file = Vectors.parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/vectors/nep413.json"), "utf8")));

describe("NEP-413 encoding against fixtures/vectors/nep413.json", () => {
  it("uses the same tag", () => {
    expect(NEP413_TAG).toBe(file.nep413_tag);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))("%s: message, nonce, borsh, prehash, signature and MultiPayload", (_name, v) => {
    const i = v.inputs;
    const deadline = BigInt(i.deadline_ns);
    const message = tokenDiffMessage(i.signer_id, deadline, {
      [`nep141:${i.sell_token}`]: -BigInt(i.sell_amount),
      [`nep141:${i.buy_token}`]: BigInt(i.buy_amount),
    });
    expect(message).toBe(v.message);
    const nonce = versionedNonce(i.salt_hex, deadline, Buffer.from(i.random_hex, "hex"));
    expect(nonce.toString("hex")).toBe(v.nonce_hex);
    expect(nonce.toString("base64")).toBe(v.nonce_base64);
    const fields = { message, nonce, recipient: i.verifying_contract };
    const tag = Buffer.alloc(4);
    tag.writeUInt32LE(NEP413_TAG);
    expect(Buffer.concat([tag, borshPayload(fields)]).toString("hex")).toBe(v.nep413_borsh_hex);
    expect(nep413Prehash(fields).toString("hex")).toBe(v.prehash_hex);
    const key = file.test_keys[v.signer_key];
    if (key === undefined) throw new Error(`missing test key ${v.signer_key}`);
    const kp = ed25519FromSeed(Buffer.from(key.seed_hex, "hex"));
    expect(kp.getPublicKey().toString()).toBe(v.public_key);
    const signed = signNep413(kp, fields);
    expect(Buffer.from(kp.sign(nep413Prehash(fields)).signature).toString("hex")).toBe(v.signature_hex);
    expect(signed).toEqual(v.multi_payload);
  });

  it("agrees with near-api-js's own NEP-413 signer (independent implementation)", async () => {
    const kp = ed25519FromSeed(Buffer.alloc(32, 7));
    const fields = { message: '{"x":1}', nonce: Buffer.alloc(32, 9), recipient: "intents.near" };
    const theirs = await new KeyPairSigner(kp).signNep413Message("someone.near", fields);
    expect(baseEncode(theirs.signature)).toBe(signNep413(kp, fields).signature.replace("ed25519:", ""));
  });

  it("formats deadlines as RFC 3339 like the verifier", () => {
    expect(rfc3339FromNs(1_793_735_388_000_000_000n)).toBe("2026-11-03T19:49:48Z");
    expect(rfc3339FromNs(1_793_735_388_120_000_000n)).toBe("2026-11-03T19:49:48.12Z");
    expect(rfc3339FromNs(1n)).toBe("1970-01-01T00:00:00.000000001Z");
  });
});
