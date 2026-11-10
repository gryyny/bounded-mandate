// Offline license and disclosure check. Enumerates npm packages from tools/package-lock.json (license from
// the lockfile, else the installed package.json) and Cargo packages from `cargo metadata --offline`, flags
// copyleft and unknown licenses, marks the crates linked into the contract WASM, and checks that NOTICE
// names every external fixture.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";

export type LicenseClass = "permissive" | "weak-copyleft" | "strong-copyleft" | "unknown";

const PERMISSIVE = new Set([
  "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0", "Zlib", "BSL-1.0",
  "Unicode-DFS-2016", "Unicode-3.0", "CDLA-Permissive-2.0", "Python-2.0", "BlueOak-1.0.0", "CC-BY-4.0", "CC-BY-3.0", "WTFPL", "X11", "PSF-2.0", "Apache-2.0 WITH LLVM-exception",
]);
const WEAK = /^(MPL-|LGPL-|EPL-|CDDL-|EUPL-|OSL-|CPL-|MS-RL)/;
const STRONG = /^(GPL-|AGPL-|SSPL-|CC-BY-SA-|CC-BY-NC)/;

const RANK: Record<LicenseClass, number> = { permissive: 0, "weak-copyleft": 1, "strong-copyleft": 2, unknown: 3 };

const atom = (id: string): LicenseClass => {
  const t = id.trim().replace(/^\(+|\)+$/g, "").replace(/\+$/, "");
  if (PERMISSIVE.has(t)) return "permissive";
  if (WEAK.test(t)) return "weak-copyleft";
  if (STRONG.test(t)) return "strong-copyleft";
  return "unknown";
};

/**
 * Classifies an SPDX expression (also the legacy `MIT/Apache-2.0` form). OR picks the most permissive
 * alternative; AND takes the most restrictive part. Parenthesised groups are evaluated recursively.
 */
export function classify(expr: string | null | undefined): LicenseClass {
  if (expr === null || expr === undefined || expr.trim() === "" || /^(UNLICENSED|SEE LICENSE)/i.test(expr.trim())) return "unknown";
  const e = expr.trim().replace(/\s*\/\s*/g, " OR ");
  const split = (s: string, op: "OR" | "AND"): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    const tokens = s.split(/(\(|\)|\s+)/).filter((t) => t !== "" && !/^\s+$/.test(t));
    for (const tok of tokens) {
      if (tok === "(") depth += 1;
      if (tok === ")") depth -= 1;
      if (depth === 0 && tok === op) {
        parts.push(cur.trim());
        cur = "";
      } else cur += (tok === "(" || tok === ")" ? tok : ` ${tok} `);
    }
    parts.push(cur.trim());
    return parts.map((p) => p.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")"));
  };
  const unwrap = (s: string): string => {
    let t = s.trim();
    while (t.startsWith("(") && t.endsWith(")")) {
      let depth = 0;
      let wraps = true;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "(") depth += 1;
        if (t[i] === ")") depth -= 1;
        if (depth === 0 && i < t.length - 1) {
          wraps = false;
          break;
        }
      }
      if (!wraps) break;
      t = t.slice(1, -1).trim();
    }
    return t;
  };
  const evalExpr = (s: string): LicenseClass => {
    const t = unwrap(s);
    const ors = split(t, "OR");
    if (ors.length > 1) return ors.map(evalExpr).reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
    const ands = split(t, "AND");
    if (ands.length > 1) return ands.map(evalExpr).reduce((a, b) => (RANK[a] >= RANK[b] ? a : b));
    return atom(t);
  };
  return evalExpr(e);
}

export interface Dependency {
  ecosystem: "npm" | "cargo";
  name: string;
  version: string;
  license: string | null;
  class: LicenseClass;
  /** npm: dev-only; cargo: not reachable through normal dependencies of a contract crate. */
  dev: boolean;
  /** cargo: linked into the production contract WASM (normal dependencies of `bounded-mandate`). */
  in_contract_wasm: boolean;
  source: string;
}

const LockPackage = z.looseObject({ version: z.string().optional(), license: z.unknown().optional(), dev: z.boolean().optional(), devOptional: z.boolean().optional(), optional: z.boolean().optional(), link: z.boolean().optional() });
const Lockfile = z.looseObject({ lockfileVersion: z.number(), packages: z.record(z.string(), LockPackage) });

const licenseText = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "type" in v && typeof v.type === "string") return v.type;
  if (Array.isArray(v)) return v.map(licenseText).filter((x) => x !== null).join(" OR ") || null;
  return null;
};

export function npmDependencies(toolsDir: string): Dependency[] {
  const lock = Lockfile.parse(JSON.parse(readFileSync(join(toolsDir, "package-lock.json"), "utf8")));
  const out: Dependency[] = [];
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (path === "" || pkg.link === true) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    let license = licenseText(pkg.license);
    let source = "package-lock.json";
    const installed = join(toolsDir, path, "package.json");
    if (license === null && existsSync(installed)) {
      const manifest: unknown = JSON.parse(readFileSync(installed, "utf8"));
      if (typeof manifest === "object" && manifest !== null) license = licenseText("license" in manifest ? manifest.license : "licenses" in manifest ? manifest.licenses : null);
      source = `${path}/package.json`;
    }
    out.push({ ecosystem: "npm", name, version: pkg.version ?? "?", license, class: classify(license), dev: pkg.dev === true || pkg.devOptional === true, in_contract_wasm: false, source });
  }
  return out;
}

const CargoMeta = z.looseObject({
  packages: z.array(z.looseObject({ id: z.string(), name: z.string(), version: z.string(), license: z.string().nullable(), license_file: z.string().nullable().optional(), source: z.string().nullable(), manifest_path: z.string() })),
  workspace_members: z.array(z.string()),
  resolve: z.looseObject({
    nodes: z.array(z.looseObject({ id: z.string(), deps: z.array(z.looseObject({ pkg: z.string(), dep_kinds: z.array(z.looseObject({ kind: z.string().nullable(), target: z.string().nullable() })) })) })),
  }),
});
export type CargoMeta = z.infer<typeof CargoMeta>;

export function cargoMetadata(root: string): CargoMeta {
  const r = spawnSync("cargo", ["metadata", "--format-version", "1", "--locked", "--offline"], { cwd: root, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`cargo metadata failed: ${r.stderr.toString()}`);
  return CargoMeta.parse(JSON.parse(r.stdout.toString()));
}

/** Packages reachable from `roots` through normal or build dependencies (all targets; a superset). */
const reachable = (meta: CargoMeta, roots: string[]): Set<string> => {
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null || k.kind === "build")) stack.push(d.pkg);
  }
  return seen;
};

/**
 * `name version` of every crate linked into the contract WASM: normal edges for wasm32, proc-macros excluded.
 * cargo metadata unifies features across the workspace (dev-dependencies included), so it overstates this set.
 */
export function contractWasmCrates(root: string, crate = "bounded-mandate"): Set<string> {
  const r = spawnSync(
    "cargo",
    ["tree", "-p", crate, "-e", "normal,no-proc-macro", "--target", "wasm32-unknown-unknown", "--prefix", "none", "--format", "{p}", "--offline", "--locked"],
    { cwd: root, maxBuffer: 1 << 26 },
  );
  if (r.status !== 0) throw new Error(`cargo tree failed: ${r.stderr.toString()}`);
  return new Set(
    r.stdout
      .toString()
      .split("\n")
      .map((l) => /^(\S+) v(\S+)/.exec(l))
      .filter((m) => m !== null)
      .map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`),
  );
}

/** Recognises a license text; null when it is not one of the common permissive texts. */
export function detectLicenseText(text: string): string | null {
  if (/Permission is hereby granted, free of charge/.test(text)) return "MIT";
  if (/Apache License/.test(text) && /Version 2\.0/.test(text)) return "Apache-2.0";
  if (/Redistribution and use in source and binary forms/.test(text)) return /Neither the name/.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  return null;
}

/**
 * For a crate that declares no SPDX license (or only a license file), reads the nearest LICENSE file from the
 * crate directory up to its checkout root (a git checkout's revision directory or the registry crate directory).
 */
function licenseFromFile(manifestPath: string, declaredFile: string | null | undefined): { license: string; file: string } | null {
  let dir = dirname(manifestPath);
  for (let depth = 0; depth < 6; depth++) {
    const names = declaredFile != null && depth === 0 ? [declaredFile] : existsSync(dir) ? readdirSync(dir).filter((n) => /^(LICEN[CS]E|COPYING)/i.test(n)) : [];
    for (const n of names) {
      const file = join(dir, n);
      if (!existsSync(file) || statSync(file).isDirectory()) continue;
      const license = detectLicenseText(readFileSync(file, "utf8"));
      if (license !== null) return { license, file };
    }
    if (/\/checkouts\/[^/]+\/[^/]+$/.test(dir) || /\/registry\/src\/[^/]+\/[^/]+$/.test(dir)) break;
    dir = dirname(dir);
  }
  return null;
}

export function cargoDependencies(meta: CargoMeta, wasm: ReadonlySet<string>): Dependency[] {
  const members = new Set(meta.workspace_members);
  const anyNormal = reachable(meta, [...members]);
  return meta.packages
    .filter((p) => !members.has(p.id))
    .map((p) => {
      const fromFile = p.license === null ? licenseFromFile(p.manifest_path, p.license_file) : null;
      const license = p.license ?? fromFile?.license ?? (p.license_file != null ? `SEE LICENSE FILE ${p.license_file}` : null);
      return {
        ecosystem: "cargo" as const,
        name: p.name,
        version: p.version,
        license,
        class: classify(license),
        dev: !anyNormal.has(p.id),
        in_contract_wasm: wasm.has(`${p.name} ${p.version}`),
        source: `${p.source ?? "path"}${fromFile === null ? "" : `; license read from ${fromFile.file}`}`,
      };
    });
}

const Manifest = z.object({ files: z.record(z.string(), z.looseObject({ kind: z.string(), license: z.string().optional() })) });

/** Kinds produced by this repository; everything else in fixtures/ is external and must be named in NOTICE. */
const OWN_KINDS = new Set(["generated-vectors", "deployment-candidate", "provenance-record", "prebuilt-test-double"]);

export interface FixtureDisclosure {
  path: string;
  kind: string;
  in_manifest: boolean;
  external: boolean;
  in_notice: boolean;
}

const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)])) : [];

export function fixtureDisclosures(root: string): FixtureDisclosure[] {
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(root, "fixtures/manifest.json"), "utf8")));
  const notice = readFileSync(join(root, "NOTICE"), "utf8");
  const files = walk(join(root, "fixtures"))
    .map((f) => relative(join(root, "fixtures"), f))
    .filter((f) => f !== "manifest.json" && !f.endsWith(".DS_Store") && !f.endsWith(".gitkeep"));
  return files.sort().map((f) => {
    const entry = manifest.files[f];
    const kind = entry?.kind ?? "unlisted";
    const external = !OWN_KINDS.has(kind);
    return { path: `fixtures/${f}`, kind, in_manifest: entry !== undefined, external, in_notice: notice.includes(`fixtures/${f}`) };
  });
}

export interface LicenseReport {
  schema: "bounded-mandate/license-check/v1";
  counts: Record<string, number>;
  flagged: Dependency[];
  contract_wasm: Dependency[];
  fixtures: FixtureDisclosure[];
  problems: string[];
  open_items: string[];
}

export function licenseReport(root: string, deps: Dependency[]): LicenseReport {
  const counts: Record<string, number> = {};
  for (const d of deps) {
    const key = `${d.ecosystem}:${d.class}`;
    counts[key] = (counts[key] ?? 0) + 1;
    counts[`${d.ecosystem}:total`] = (counts[`${d.ecosystem}:total`] ?? 0) + 1;
  }
  const flagged = deps.filter((d) => d.class !== "permissive");
  const fixtures = fixtureDisclosures(root);
  const problems: string[] = [
    ...flagged.filter((d) => d.class === "strong-copyleft" && (d.in_contract_wasm || (d.ecosystem === "npm" && !d.dev))).map((d) => `${d.ecosystem} ${d.name}@${d.version}: ${d.license ?? "no license"} is strong copyleft and is distributed`),
    ...flagged.filter((d) => d.class === "unknown").map((d) => `${d.ecosystem} ${d.name}@${d.version}: license unknown (${d.license ?? "none declared"}); confirm by hand`),
    ...fixtures.filter((f) => !f.in_manifest).map((f) => `${f.path}: not listed in fixtures/manifest.json (provenance and hash missing)`),
    ...fixtures.filter((f) => f.external && !f.in_notice).map((f) => `${f.path}: external fixture (${f.kind}) not named in NOTICE`),
  ];
  return {
    schema: "bounded-mandate/license-check/v1",
    counts,
    flagged,
    contract_wasm: deps.filter((d) => d.in_contract_wasm),
    fixtures,
    problems,
    open_items: ["Owner confirmation of the README AI-tools disclosure (rule Q-005) and of NOTICE authorship remains open."],
  };
}
