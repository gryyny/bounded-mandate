// Loads a NEAR CLI-style credential file ({account_id, public_key, private_key}) for live mode.
// The secret never leaves this module's return value; errors name the file, never its contents.
import { readFileSync, statSync } from "node:fs";
import { KeyPair, type KeyPairString } from "near-api-js";
import { z } from "zod";

const CredentialFile = z
  .object({
    account_id: z.string().min(2),
    public_key: z.string().startsWith("ed25519:"),
    private_key: z.string().startsWith("ed25519:"),
  })
  .loose();

export interface Credential {
  accountId: string;
  key: KeyPair;
}

export function loadCredential(path: string, expectedAccountId: string): Credential {
  const mode = statSync(path).mode & 0o077;
  if (mode !== 0) throw new Error(`credential file ${path} is readable by group/others; chmod 600 it`);
  let parsed: z.infer<typeof CredentialFile>;
  try {
    parsed = CredentialFile.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error(`credential file ${path} is not a valid NEAR credential JSON`);
  }
  if (parsed.account_id !== expectedAccountId) {
    throw new Error(`credential file ${path} is for ${parsed.account_id}, expected ${expectedAccountId}`);
  }
  const key = KeyPair.fromString(parsed.private_key as KeyPairString);
  if (key.getPublicKey().toString() !== parsed.public_key) {
    throw new Error(`credential file ${path}: private key does not match its public_key`);
  }
  return { accountId: parsed.account_id, key };
}
