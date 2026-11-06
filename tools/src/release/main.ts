// Release-preparation checks. Nothing here publishes, deploys or contacts a remote host.
//   tsx src/release/main.ts secrets [--repo <name>=<path> ...] [--allow <file>]
//   tsx src/release/main.ts site --page <index.html> [--console <dir>] [--route <path> ...]
//   tsx src/release/main.ts licenses
//   tsx src/release/main.ts links          (README local links, line anchors and headings)
// Reports go to out/release/ (ignored). Exit status 1 when a check has open problems.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { checkReadme } from "./links.js";
import { cargoDependencies, cargoMetadata, contractWasmCrates, licenseReport, npmDependencies } from "./licenses.js";
import { renderMarkdown, scanRepos, type AllowEntry } from "./secrets.js";
import { assembleSite, checkSite } from "./site.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "out/release");

const flags = (args: string[], name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1] ?? ""] : []));

const write = (name: string, data: string): string => {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, name);
  writeFileSync(path, data);
  return path;
};

const AllowList = z.array(z.object({ repo: z.string(), rule: z.string(), path: z.string(), fingerprint: z.string(), reason: z.string().min(1) }).strict());

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "secrets") {
    const repos = flags(args, "repo").map((spec) => {
      const eq = spec.indexOf("=");
      return eq < 0 ? { name: spec, path: spec } : { name: spec.slice(0, eq), path: spec.slice(eq + 1) };
    });
    if (repos.length === 0) repos.push({ name: "bounded-mandate", path: ROOT });
    const allowFile = flags(args, "allow")[0] ?? join(ROOT, "tools/src/release/secret-allowlist.json");
    const allow: AllowEntry[] = existsSync(allowFile) ? AllowList.parse(JSON.parse(readFileSync(allowFile, "utf8"))) : [];
    const report = scanRepos(repos, allow);
    const json = write("secret-scan.json", JSON.stringify(report, null, 2) + "\n");
    const md = write("secret-scan.md", renderMarkdown(report));
    console.log(`secret scan: ${report.findings.length} findings, ${report.untriaged} untriaged; ${json}, ${md}`);
    return report.untriaged === 0 ? 0 : 1;
  }
  if (command === "site") {
    const page = flags(args, "page")[0] ?? join(ROOT, "out/page/index.html");
    const consoleDir = flags(args, "console")[0];
    const site = assembleSite({ page, console: consoleDir, out: join(OUT, "site") });
    const routes = flags(args, "route");
    if (routes.length === 0) routes.push("", ...(consoleDir === undefined ? [] : ["console/"]));
    const report = await checkSite(site, routes);
    const path = write("site-check.json", JSON.stringify({ ...report, page, console: consoleDir ?? null }, null, 2) + "\n");
    for (const p of report.problems) console.error(`site: ${p}`);
    console.log(`site check: ${report.pages.length} pages, ${report.assets.length} assets, ${report.external_links.length} external links, ${report.problems.length} problems; ${path}`);
    if (consoleDir === undefined) console.log("site check: no --console given; the console route was not checked");
    return report.passed ? 0 : 1;
  }
  if (command === "licenses") {
    const deps = [...npmDependencies(join(ROOT, "tools")), ...cargoDependencies(cargoMetadata(ROOT), contractWasmCrates(ROOT))];
    const report = licenseReport(ROOT, deps);
    const path = write("license-check.json", JSON.stringify({ ...report, dependencies: deps }, null, 2) + "\n");
    console.log(`license check: ${JSON.stringify(report.counts)}`);
    for (const d of report.flagged) console.log(`  flagged ${d.ecosystem} ${d.name}@${d.version}: ${d.license ?? "none"} (${d.class}${d.dev ? ", dev/test only" : ""}${d.in_contract_wasm ? ", in contract WASM" : ""})`);
    for (const p of report.problems) console.error(`license: ${p}`);
    console.log(`report: ${path}`);
    return report.problems.length === 0 ? 0 : 1;
  }
  if (command === "links") {
    const report = checkReadme(ROOT);
    write("readme-links.json", JSON.stringify(report, null, 2) + "\n");
    for (const p of report.problems) console.error(`links: ${p}`);
    console.log(`README links: ${report.local} local (${report.line_anchors} line anchors), ${report.external.length} external not requested, ${report.problems.length} problems`);
    return report.problems.length === 0 ? 0 : 1;
  }
  console.error("usage: main.ts secrets|site|licenses|links [options]");
  return 2;
}

process.exitCode = await main();
