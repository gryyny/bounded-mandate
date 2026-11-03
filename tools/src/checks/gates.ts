// Fails unless every required acceptance gate has at least one executable test tagged `gate: <ID>`.
// Presence only: the Rust and TypeScript test runners decide pass/fail. Skipped tests do not count.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const REQUIRED_GATES = ["T1", "T2", "T2b", "T3", "T4", "T5", "BOUNDARY", "MODEL"] as const;

const TEST_ROOTS = ["contract/tests", "contract/src", "tools/test", "baseline"];
const SKIP_MARKERS = [/#\[ignore/, /\.skip\(/, /\bit\.todo\(/, /\bxit\(/];

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (name === "node_modules" || name === "target") return [];
        return statSync(path).isDirectory() ? walk(path) : [path];
      })
    : [];

export function findGates(root: string): { found: Map<string, string[]>; problems: string[] } {
  const found = new Map<string, string[]>();
  const problems: string[] = [];
  for (const file of TEST_ROOTS.flatMap((r) => walk(join(root, r)))) {
    if (!/\.(rs|ts)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const tags = [...text.matchAll(/gate:\s*(T2b|T[1-5]|BOUNDARY|MODEL)\b/g)].map((m) => m[1]).filter((t) => t !== undefined);
    if (tags.length === 0) continue;
    const rel = relative(root, file);
    if (SKIP_MARKERS.some((re) => re.test(text))) problems.push(`${rel}: gate-tagged file contains a skipped test`);
    for (const tag of tags) found.set(tag, [...(found.get(tag) ?? []), rel]);
  }
  for (const gate of REQUIRED_GATES) if (!found.has(gate)) problems.push(`missing executable test for gate ${gate}`);
  return { found, problems };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { found, problems } = findGates(resolve(import.meta.dirname, "../../.."));
  for (const [gate, files] of found) console.log(`gate ${gate}: ${[...new Set(files)].join(", ")}`);
  if (problems.length > 0) {
    console.error(`acceptance gate inventory failed:\n${problems.join("\n")}`);
    process.exit(1);
  }
}
