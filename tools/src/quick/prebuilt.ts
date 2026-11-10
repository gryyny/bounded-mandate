// Pinned WASMs for `make quick`: the exact deployment candidate, the pinned verifier and prebuilt test doubles
// (fixtures/prebuilt). Every file is checked against both its provenance record and fixtures/manifest.json before
// anything runs; any missing entry or differing byte fails closed.
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

export interface PrebuiltSet {
  wasm: Record<QuickRole, Wasm>;
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
  for (const [role, rel] of Object.entries(QUICK_WASM) as [QuickRole, string][]) {
    const bytes = read(rel);
    if (bytes === null) continue;
    if (rel.startsWith("prebuilt/")) {
      const name = rel.slice("prebuilt/".length);
      const recorded = provenance?.files[name];
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
  return { wasm: wasm as Record<QuickRole, Wasm>, provenance, provenance_sha256: sha256(provenanceBytes) };
}
