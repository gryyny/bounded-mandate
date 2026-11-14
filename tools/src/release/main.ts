// Release-preparation checks. Nothing here publishes, deploys or contacts a remote host.
//   tsx src/release/main.ts secrets [--repo <name>=<path> ...] [--allow <file>]
//   tsx src/release/main.ts site --page <index.html> [--console <dir>] [--video <dir> --video-manifest <video.json>] [--presentation <presentation dir>] [--route <path> ...]
//   tsx src/release/main.ts licenses
//   tsx src/release/main.ts links          (README local links, line anchors and headings)
// Reports go to out/release/ (ignored). Exit status 1 when a check has open problems.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { checkReadme } from "./links.js";
import { cargoDependencies, cargoMetadata, contractWasmCrates, licenseReport, npmDependencies } from "./licenses.js";
import { renderMarkdown, scanRepos, type AllowEntry } from "./secrets.js";
import { PLANNED_URLS } from "../evidence/journey.js";
import { assembleSite, checkPresentation, checkSite, checkVideos, PLANNED_BASE, PLANNED_ORIGIN } from "./site.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "out/release");

const flags = (args: string[], name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1] ?? ""] : []));

const write = (name: string, data: string): string => {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, name);
  writeFileSync(path, data);
  return path;
};

const VideoManifest = z.object({ cuts: z.record(z.string(), z.object({ mp4: z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }) })) });

/** The planned video paths relative to the site base, with the certified sha256 of the same file name when a manifest is given. */
const plannedVideos = (manifest: string | undefined): { path: string; sha256: string | null }[] => {
  const certified = new Map<string, string>();
  if (manifest !== undefined) for (const cut of Object.values(VideoManifest.parse(JSON.parse(readFileSync(manifest, "utf8"))).cuts)) certified.set(basename(cut.mp4.path), cut.mp4.sha256);
  return [PLANNED_URLS.video, PLANNED_URLS.walkthrough].map((url) => {
    const path = url.slice(`${PLANNED_ORIGIN}${PLANNED_BASE}`.length);
    return { path, sha256: manifest === undefined ? null : certified.get(basename(path)) ?? "missing-from-manifest" };
  });
};

const PresentationProvenance = z.object({ files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)) });

const AllowList =z.array(z.object({ repo: z.string(), rule: z.string(), path: z.string(), fingerprint: z.string(), reason: z.string().min(1) }).strict());

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
    const videoDir = flags(args, "video")[0];
    const presentationDir = flags(args, "presentation")[0];
    // Every file is assembled before any route, link, CSP, media or hash check runs.
    const site = assembleSite({ page, console: consoleDir, video: videoDir, presentation: presentationDir, out: join(OUT, "site") });
    const routes = flags(args, "route");
    if (routes.length === 0) routes.push("", ...(consoleDir === undefined ? [] : ["console/"]), ...(presentationDir === undefined ? [] : ["overview/"]));
    const manifest = flags(args, "video-manifest")[0];
    const report = await checkSite(site, routes);
    // Without --video the planned video URLs are not served, and the report says so (video: null).
    const video = videoDir === undefined ? null : { dir: videoDir, manifest: manifest ?? null, ...(await checkVideos(site, plannedVideos(manifest))) };
    const presentation = presentationDir === undefined ? null : { dir: presentationDir, ...(await checkPresentation(site, PresentationProvenance.parse(JSON.parse(readFileSync(join(presentationDir, "provenance.json"), "utf8"))).files)) };
    // Served cuts are only meaningful against the certified ones, so --video and --video-manifest go together.
    const pairing = manifest !== undefined && videoDir === undefined ? ["--video-manifest given without --video"] : manifest === undefined && videoDir !== undefined ? ["--video given without --video-manifest: the cuts cannot be compared with the certified ones"] : [];
    const problems = [...report.problems, ...(video?.problems ?? []), ...(presentation?.problems ?? []), ...pairing];
    const passed = report.passed && problems.length === report.problems.length;
    const path = write("site-check.json", JSON.stringify({ ...report, problems, passed, page, console: consoleDir ?? null, video, presentation }, null, 2) + "\n");
    for (const p of problems) console.error(`site: ${p}`);
    console.log(`site check: ${report.pages.length} pages, ${report.assets.length} assets, ${video?.videos.length ?? 0} videos${manifest === undefined ? "" : " against the manifest"}, ${presentation?.files.length ?? 0} presentation files against provenance.json, ${report.external_links.length} external links, ${problems.length} problems; ${path}`);
    if (presentationDir === undefined) console.log("site check: no --presentation given; the overview and pitch were not checked");
    if (consoleDir === undefined) console.log("site check: no --console given; the console route was not checked");
    if (videoDir === undefined) console.log("site check: no --video given; the planned video URLs were not checked");
    return passed ? 0 : 1;
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
