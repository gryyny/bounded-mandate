// Checks a Markdown file's local references before release: linked files and directories exist, `#Ln` and
// `#Ln-Lm` line anchors fall inside the file, and `#heading` anchors match a heading (GitHub slug rules).
// External URLs are listed, never requested.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface LinkReport {
  file: string;
  local: number;
  line_anchors: number;
  external: string[];
  problems: string[];
}

/** GitHub's heading anchor: lowercase, punctuation dropped (hyphens and underscores kept), spaces to hyphens. */
export const slug = (heading: string): string =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");

const headings = (md: string): Set<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of withoutFences(md).split("\n")) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m === null) continue;
    const base = slug(m[1] ?? "");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
};

/** Blanks fenced code blocks, keeping line numbers. */
const withoutFences = (md: string): string => md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, " "));

/** Also blanks inline code, so its contents are not read as links. */
const withoutCode = (md: string): string => withoutFences(md).replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));

export function checkLinks(path: string, root = dirname(path)): LinkReport {
  const md = readFileSync(path, "utf8");
  const own = headings(md);
  const problems: string[] = [];
  const external = new Set<string>();
  let local = 0;
  let lineAnchors = 0;
  const lines = withoutCode(md).split("\n");
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1] ?? "";
      const at = `${relative(root, path)}:${i + 1}`;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        external.add(target);
        continue;
      }
      const [file = "", anchor] = target.split("#", 2);
      if (file === "") {
        if (anchor !== undefined && !own.has(anchor)) problems.push(`${at}: #${anchor} matches no heading`);
        continue;
      }
      local += 1;
      const full = resolve(dirname(path), decodeURIComponent(file));
      if (!existsSync(full)) {
        problems.push(`${at}: ${file} does not exist`);
        continue;
      }
      if (anchor === undefined || anchor === "") continue;
      const range = /^L(\d+)(?:-L(\d+))?$/.exec(anchor);
      if (range !== null) {
        lineAnchors += 1;
        if (statSync(full).isDirectory()) {
          problems.push(`${at}: ${target} puts a line anchor on a directory`);
          continue;
        }
        const body = readFileSync(full, "utf8");
        const count = body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
        const from = Number(range[1]);
        const to = Number(range[2] ?? range[1]);
        if (from < 1 || to < from || to > count) problems.push(`${at}: ${target} is outside ${file} (${count} lines)`);
        continue;
      }
      if (full.endsWith(".md") && !headings(readFileSync(full, "utf8")).has(anchor)) problems.push(`${at}: #${anchor} matches no heading in ${file}`);
    }
  });
  return { file: relative(root, path) || path, local, line_anchors: lineAnchors, external: [...external].sort(), problems };
}

export const checkReadme = (root: string): LinkReport => checkLinks(join(root, "README.md"), root);
