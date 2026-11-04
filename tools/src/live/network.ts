// Static network-shape consistency: a manifest labelled mainnet may contain nothing sandbox- or
// test-shaped, and a sandbox manifest nothing that points at mainnet. Checked before any RPC use.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { baseEncode } from "near-api-js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PUBLIC_KEY } from "near-sandbox";
import { sandboxKey } from "../near/keys.js";
import { REPO_ROOT } from "../near/sandbox.js";
import type { LiveManifest } from "./manifest.js";

export const MAINNET = {
  chain_id: "mainnet",
  genesis_hash: "EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H",
  /** Pinned production dependencies (read-only RPC, 2026-11-03). */
  code_hashes: {
    verifier: "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk",
    signer: "DAE5ng4ZFR2ctMx9SizQBqmGkVbKUutgZ4ZECD4R8Sm9",
    oracle: "9vafnXzrPYQ4ErDqt2triRkQJHdxtG7tfkyb24t5Ttrg",
  },
  accounts: { verifier: "intents.near", signer: "v1.signer", oracle: "aggregate-oracle.near" },
  tokens: { usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", wnear: "wrap.near" },
  verifier_fee_pips: 1,
  max_agent_allowance_yocto: 250_000_000_000_000_000_000_000n,
} as const;

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$|\.localhost$|\.test$/i;
const TEST_ACCOUNT = /(^|\.)sandbox$|\.test\.near$|(^|\.)testnet$|^test\.near$/;

export const codeHashOf = (bytes: Uint8Array): string => baseEncode(createHash("sha256").update(bytes).digest());

/** Code hashes of every local build (test doubles and the non-reproducible mandate build). */
export function localBuildHashes(root = REPO_ROOT): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(root, "target/near");
  if (!existsSync(dir)) return out;
  for (const crate of readdirSync(dir)) {
    const wasm = join(dir, crate, `${crate}.wasm`);
    if (existsSync(wasm)) out.set(codeHashOf(readFileSync(wasm)), `target/near/${crate}/${crate}.wasm`);
  }
  return out;
}

/** Code hashes of the pinned reproducible deployment candidates in fixtures/deploy. */
export function deploymentHashes(root = REPO_ROOT): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(root, "fixtures/deploy");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".wasm"))) out.set(codeHashOf(readFileSync(join(dir, f))), `fixtures/deploy/${f}`);
  return out;
}

/** Public keys anyone can derive: sandbox roles, the near-sandbox genesis key and the NEP-413 vector keys. */
export function knownTestKeys(accountIds: string[], root = REPO_ROOT): Set<string> {
  const keys = new Set<string>([DEFAULT_PUBLIC_KEY]);
  const roles = ["owner", "agent", "filler", "relayer", "attacker", "operator", "fees", "mandate", "intents", "oracle", "mpc", "usdc", "wnear"];
  for (const id of [...accountIds, ...roles.map((r) => `${r}.${DEFAULT_ACCOUNT_ID}`)]) {
    keys.add(sandboxKey(id).getPublicKey().toString());
    keys.add(sandboxKey(`${id}/intents-signing`).getPublicKey().toString());
  }
  const vectors = join(root, "fixtures/vectors/nep413.json");
  if (existsSync(vectors)) {
    const text = readFileSync(vectors, "utf8");
    for (const m of text.matchAll(/ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}/g)) keys.add(m[0]);
  }
  return keys;
}

const hostOf = (url: string): string => new URL(url).hostname;

function allAccountIds(m: LiveManifest): string[] {
  const c = m.mandate_config;
  return [...Object.values(m.accounts), c.owner_id, c.agent_id, c.verifier_id, c.signer_id, c.oracle_id, c.usdc.token, c.wnear.token];
}

/** Problems with the manifest's static fields for its declared network. Empty means consistent. */
export function networkProblems(m: LiveManifest, root = REPO_ROOT): string[] {
  const p: string[] = [];
  const host = hostOf(m.network.rpc_url);
  const ids = allAccountIds(m);
  if (m.network.name === "mainnet") {
    if (LOCAL_HOST.test(host)) p.push(`mainnet manifest uses a local/test RPC host ${host}`);
    if (new URL(m.network.rpc_url).protocol !== "https:") p.push("mainnet RPC must use https");
    if (m.network.chain_id !== MAINNET.chain_id) p.push(`mainnet manifest has chain_id ${m.network.chain_id}`);
    if (m.network.genesis_hash !== MAINNET.genesis_hash) p.push(`mainnet manifest has genesis_hash ${m.network.genesis_hash}`);
    for (const id of ids) if (TEST_ACCOUNT.test(id) || id === DEFAULT_ACCOUNT_ID) p.push(`mainnet manifest names test/sandbox account ${id}`);
    for (const role of ["verifier", "signer", "oracle"] as const) {
      if (m.accounts[role] !== MAINNET.accounts[role]) p.push(`mainnet ${role} must be ${MAINNET.accounts[role]}, got ${m.accounts[role]}`);
      if (m.code_hashes[role] !== MAINNET.code_hashes[role]) p.push(`mainnet ${role} code hash must be the pinned ${MAINNET.code_hashes[role]}`);
    }
    if (m.mandate_config.usdc.token !== MAINNET.tokens.usdc || m.mandate_config.wnear.token !== MAINNET.tokens.wnear) p.push("mainnet tokens must be the pinned USDC and wrap.near");
    const local = localBuildHashes(root);
    for (const [role, hash] of Object.entries(m.code_hashes)) {
      const build = local.get(hash);
      if (build !== undefined) p.push(`mainnet ${role} code hash equals local build ${build}`);
    }
    const deploy = deploymentHashes(root);
    if (!deploy.has(m.code_hashes.mandate)) p.push(`mainnet mandate code hash ${m.code_hashes.mandate} is not a pinned reproducible build in fixtures/deploy`);
    if (m.verifier_fee_pips !== MAINNET.verifier_fee_pips) p.push(`mainnet verifier fee must be pinned at ${MAINNET.verifier_fee_pips} pip`);
    if (BigInt(m.keys.agent.max_allowance_yocto) > MAINNET.max_agent_allowance_yocto) p.push("mainnet agent allowance cap must be at most 0.25 NEAR");
  } else {
    if (!LOCAL_HOST.test(host)) p.push(`sandbox manifest uses a non-local RPC host ${host}`);
    if (m.network.chain_id === MAINNET.chain_id || m.network.chain_id === "testnet") p.push(`sandbox manifest has chain_id ${m.network.chain_id}`);
    if (m.network.genesis_hash === MAINNET.genesis_hash) p.push("sandbox manifest has the mainnet genesis hash");
    const production = new Set<string>([...Object.values(MAINNET.accounts), ...Object.values(MAINNET.tokens)]);
    for (const id of ids) if (production.has(id)) p.push(`sandbox manifest names production account ${id}`);
    for (const id of ids) if (/\.near$|\.tg$/.test(id) && !TEST_ACCOUNT.test(id)) p.push(`sandbox manifest names mainnet-shaped account ${id}`);
  }
  return p;
}

/** Credential keys must not be publicly derivable test keys on mainnet. */
export function credentialProblems(m: LiveManifest, credentialKeys: Record<string, string>, root = REPO_ROOT): string[] {
  if (m.network.name !== "mainnet") return [];
  const known = knownTestKeys(allAccountIds(m), root);
  return Object.entries(credentialKeys)
    .filter(([, pk]) => known.has(pk))
    .map(([role]) => `mainnet credential ${role} is a publicly derivable sandbox/test key`);
}
