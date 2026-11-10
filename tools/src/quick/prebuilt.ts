// Pinned WASMs for `make quick`: the exact deployment candidate, the pinned verifier and prebuilt test doubles
// (fixtures/prebuilt). Every file is checked against the sha256 pinned in this file (CODE_PINS), its provenance record
// and fixtures/manifest.json before anything runs; any missing entry or differing byte fails closed. The pins in code
// are what makes "the deployment candidate" mean one binary: the manifest and the provenance record sit beside the
// bytes, so re-pinning both to other bytes would otherwise pass.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Wasm } from "../near/sandbox.js";

export const PROVENANCE = "prebuilt/provenance.json";
export const QUICK_WASM = {
  mandate: "deploy/bounded_mandate-163ccfa-reproducible.wasm",
  verifier: "verifier/defuse-0.4.5.wasm",
  ft: "prebuilt/mock_ft.wasm",
  oracle: "prebuilt/mock_oracle.wasm",
  mpc: "prebuilt/mock_mpc.wasm",
} as const;
export type QuickRole = keyof typeof QUICK_WASM;

/**
 * sha256 of each WASM `make quick` deploys, pinned in code. Changing a binary needs a reviewed change to this file,
 * not only to the hashes stored beside the bytes.
 */
export const CODE_PINS: Readonly<Record<QuickRole, string>> = {
  mandate: "629fc90fee6506413aa428e2cb5fae61faf98f77d419f2c3bd1ab4d6d8319a30",
  verifier: "a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547",
  ft: "20602d14448eb476c8c67c8a5d3078fe3b7847d57373aad4d9989cc538563b89",
  oracle: "672e95e0e5c6daaa31b62a77e86c7c7e48f375469339ada758ebc71773ecfa8c",
  mpc: "ada6f78437be156625696480b4a209a9d8d92b8931791a10712bed7b22dd5694",
};

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const Provenance = z.object({
  schema: z.literal("bounded-mandate/prebuilt-test-doubles/v1"),
  label: z.string(),
  reproducible: z.literal(true),
  statement: z.string(),
  source: z.object({ revision: z.string().regex(/^[0-9a-f]{40}$/), stubs_tree: z.string(), cargo_lock_sha256: Sha256, dirty: z.literal(false) }),
  toolchain: z.object({ rust_toolchain_toml_sha256: Sha256, channel: z.string(), rustc: z.string(), cargo_near: z.string(), host: z.string() }),
  build_command: z.string(),
  built_at: z.string(),
  files: z.record(z.string(), z.object({ crate: z.string(), manifest_path: z.string(), role: z.string(), bytes: z.number().int().positive(), sha256: Sha256 })),
});
export type Provenance = z.infer<typeof Provenance>;

const Manifest = z.object({ files: z.record(z.string(), z.looseObject({ sha256: Sha256 })) });

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** One deployed file's bytes against each of its pins; `provenance` is null for files the provenance record does not cover. */
export interface PinCheck {
  role: QuickRole;
  path: string;
  sha256: string;
  code: string;
  manifest: string | null;
  provenance: string | null;
}

/** True when the bytes equal the pin in code, the manifest pin and, for a prebuilt double, the provenance pin. */
export const pinHolds = (p: PinCheck): boolean =>
  p.sha256 === p.code && p.sha256 === p.manifest && (p.path.startsWith("fixtures/prebuilt/") ? p.sha256 === p.provenance : p.provenance === null);

export interface PrebuiltSet {
  wasm: Record<QuickRole, Wasm>;
  pins: PinCheck[];
  provenance: Provenance;
  provenance_sha256: string;
}

/** Loads the quick WASM set from `<root>/fixtures`; throws listing every pin that does not hold. */
export function loadPrebuilt(root: string): PrebuiltSet {
  const fixtures = join(root, "fixtures");
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(fixtures, "manifest.json"), "utf8")));
  const problems: string[] = [];
  const read = (rel: string): Uint8Array | null => {
    const path = join(fixtures, rel);
    if (!existsSync(path)) {
      problems.push(`fixtures/${rel}: missing`);
      return null;
    }
    const bytes = readFileSync(path);
    const pinned = manifest.files[rel]?.sha256;
    const actual = sha256(bytes);
    if (pinned === undefined) problems.push(`fixtures/${rel}: not pinned in fixtures/manifest.json`);
    else if (pinned !== actual) problems.push(`fixtures/${rel}: sha256 ${actual} != manifest ${pinned}`);
    return bytes;
  };

  const provenanceBytes = read(PROVENANCE);
  let provenance: Provenance | null = null;
  if (provenanceBytes !== null) {
    const parsed = Provenance.safeParse(JSON.parse(Buffer.from(provenanceBytes).toString("utf8")));
    if (parsed.success) provenance = parsed.data;
    else problems.push(`fixtures/${PROVENANCE}: ${parsed.error.message}`);
  }

  const wasm: Partial<Record<QuickRole, Wasm>> = {};
  const pins: PinCheck[] = [];
  for (const [role, rel] of Object.entries(QUICK_WASM) as [QuickRole, string][]) {
    const bytes = read(rel);
    if (bytes === null) continue;
    if (sha256(bytes) !== CODE_PINS[role]) problems.push(`fixtures/${rel}: sha256 ${sha256(bytes)} != the pin in tools/src/quick/prebuilt.ts ${CODE_PINS[role]}`);
    const recorded = rel.startsWith("prebuilt/") ? provenance?.files[rel.slice("prebuilt/".length)] : undefined;
    pins.push({ role, path: `fixtures/${rel}`, sha256: sha256(bytes), code: CODE_PINS[role], manifest: manifest.files[rel]?.sha256 ?? null, provenance: recorded?.sha256 ?? null });
    if (rel.startsWith("prebuilt/")) {
      if (provenance !== null && recorded === undefined) problems.push(`fixtures/${rel}: not in ${PROVENANCE}`);
      else if (recorded !== undefined && recorded.sha256 !== sha256(bytes)) problems.push(`fixtures/${rel}: sha256 ${sha256(bytes)} != provenance ${recorded.sha256}`);
    }
    wasm[role] = { path: `fixtures/${rel}`, bytes, sha256: sha256(bytes) };
  }
  if (provenance !== null) {
    for (const name of Object.keys(provenance.files)) {
      if (!Object.values(QUICK_WASM).includes(`prebuilt/${name}` as (typeof QUICK_WASM)[QuickRole])) problems.push(`${PROVENANCE}: ${name} is not used by make quick`);
    }
  }
  if (problems.length > 0 || provenance === null || provenanceBytes === null) throw new Error(`prebuilt pin check failed:\n${problems.join("\n")}`);
  return { wasm: wasm as Record<QuickRole, Wasm>, pins, provenance, provenance_sha256: sha256(provenanceBytes) };
}
