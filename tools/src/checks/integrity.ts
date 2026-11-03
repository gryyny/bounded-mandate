// Verifies the pinned spec snapshot and every curated fixture against recorded hashes.
// Works offline and without access to the private meta repository.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const SpecSource = z.object({
  meta_repository: z.string(),
  path: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  snapshot: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const FixtureManifest = z.object({
  schema_version: z.literal(1),
  files: z.record(
    z.string(),
    z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), kind: z.string(), source: z.string() }).loose(),
  ),
});

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });

export interface IntegrityReport {
  spec: { path: string; sha256: string; commit: string };
  fixtures: Record<string, string>;
}

export function checkIntegrity(root: string): IntegrityReport {
  const problems: string[] = [];
  const spec = SpecSource.parse(JSON.parse(readFileSync(join(root, "spec-source.json"), "utf8")));
  const specHash = sha256File(join(root, spec.snapshot));
  if (specHash !== spec.sha256) problems.push(`${spec.snapshot}: sha256 ${specHash} != recorded ${spec.sha256}`);

  const fixturesDir = join(root, "fixtures");
  const manifest = FixtureManifest.parse(JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8")));
  const present = listFiles(fixturesDir)
    .map((p) => relative(fixturesDir, p).split(sep).join("/"))
    .filter((p) => p !== "manifest.json" && !p.endsWith(".DS_Store"));
  const fixtures: Record<string, string> = {};
  for (const path of present) {
    const entry = manifest.files[path];
    if (entry === undefined) {
      problems.push(`fixtures/${path}: not listed in fixtures/manifest.json`);
      continue;
    }
    const actual = sha256File(join(fixturesDir, path));
    if (actual !== entry.sha256) problems.push(`fixtures/${path}: sha256 ${actual} != recorded ${entry.sha256}`);
    fixtures[path] = actual;
  }
  for (const path of Object.keys(manifest.files)) {
    if (!present.includes(path)) problems.push(`fixtures/${path}: listed but missing`);
  }
  if (problems.length > 0) throw new Error(`integrity check failed:\n${problems.join("\n")}`);
  return { spec: { path: spec.snapshot, sha256: specHash, commit: spec.commit }, fixtures };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const report = checkIntegrity(resolve(import.meta.dirname, "../../.."));
  console.log(`spec ${report.spec.path} ${report.spec.sha256} (meta commit ${report.spec.commit})`);
  for (const [path, hash] of Object.entries(report.fixtures)) console.log(`fixture ${path} ${hash}`);
}
