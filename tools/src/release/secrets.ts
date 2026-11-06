// Full-history secret scan for release preparation. Scans every blob reachable from every ref, every commit
// and tag message, and the files a next commit would include. Findings carry a location, a rule and a short
// fingerprint; the matched value itself is never stored, printed or written.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface Rule {
  id: string;
  description: string;
}

export interface Match {
  rule: string;
  line: number;
  /** Fixed, non-secret prefix kept for orientation (for example `ed25519:` or `ghp_`). */
  prefix: string;
  length: number;
  /** First 12 hex characters of sha256(value): lets duplicates be grouped without revealing the value. */
  fingerprint: string;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decoded byte length of a base58 string, or null if it is not base58. */
export function base58Length(text: string): number | null {
  let n = 0n;
  for (const c of text) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  let bytes = 0;
  while (n > 0n) {
    n >>= 8n;
    bytes += 1;
  }
  let zeros = 0;
  while (text[zeros] === "1") zeros += 1;
  return bytes + zeros;
}

const fingerprint = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);

interface ContentRule extends Rule {
  pattern: RegExp;
  /** Index of the capture group holding the secret value; 0 is the whole match. */
  group: number;
  prefix: (value: string) => string;
  /** `before` is the previous line plus the text of this line up to the match. */
  accept?: (value: string, line: string, before: string) => boolean;
}

/** An Ed25519 signature is also 64 bytes; a value under a signature field is reported as a signature, not a key. */
const SIGNATURE_FIELD = /sig(?:nature)?s?(?:&quot;|["'\\\s:=[,])*$/i;

const PLACEHOLDER = /<[^>]*>|\$\{|\$\(|process\.env|REDACTED|example|placeholder|x{6,}|\*{4,}|\.\.\./i;

const mixed = (v: string): boolean => /[0-9]/.test(v) && /[A-Za-z]/.test(v);

const entropy = (v: string): number => {
  const counts = new Map<string, number>();
  for (const c of v) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / v.length) * Math.log2(n / v.length);
  return h;
};

const literal = (p: string) => (): string => p;

export const CONTENT_RULES: readonly ContentRule[] = [
  {
    id: "near-ed25519-secret-key",
    description: "NEAR ed25519 secret key: `ed25519:` and base58 decoding to 64 bytes (public keys are 32 bytes and ignored)",
    pattern: /ed25519:([1-9A-HJ-NP-Za-km-z]{80,100})/g,
    group: 1,
    prefix: literal("ed25519:"),
    accept: (v, _line, before) => base58Length(v) === 64 && !SIGNATURE_FIELD.test(before),
  },
  {
    id: "near-secp256k1-secret-key",
    description: "NEAR secp256k1 secret key: `secp256k1:` and base58 decoding to 32 bytes (public keys are 64 bytes and ignored)",
    pattern: /secp256k1:([1-9A-HJ-NP-Za-km-z]{40,50})(?![1-9A-HJ-NP-Za-km-z])/g,
    group: 1,
    prefix: literal("secp256k1:"),
    accept: (v) => base58Length(v) === 32,
  },
  {
    id: "seed-phrase",
    description: "seed or recovery phrase: a seed_phrase/mnemonic/recovery phrase field holding 12 to 24 lowercase words",
    pattern: /(?:seed[_ -]?phrase|mnemonic|recovery[_ -]?phrase)["']?\s*[:=]\s*["'`]?((?:[a-z]{3,8}[ ,]+){11,23}[a-z]{3,8})["'`]?/gi,
    group: 1,
    prefix: literal("seed phrase"),
    accept: (v) => {
      const words = v.trim().split(/[ ,]+/);
      return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]+$/.test(w));
    },
  },
  {
    id: "pem-private-key",
    description: "PEM private key block",
    pattern: /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----/g,
    group: 0,
    prefix: (v) => v,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key id",
    pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
    group: 1,
    prefix: (v) => v.slice(0, 4),
  },
  {
    id: "aws-secret-access-key",
    description: "AWS secret access key assignment",
    pattern: /aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
    prefix: literal("aws_secret_access_key"),
  },
  {
    id: "github-token",
    description: "GitHub token (classic, fine-grained, OAuth, app or refresh)",
    pattern: /\b((?:gh[pousr]_[A-Za-z0-9]{36,255})|(?:github_pat_[A-Za-z0-9_]{22,255}))\b/g,
    group: 1,
    prefix: (v) => (v.startsWith("github_pat_") ? "github_pat_" : v.slice(0, 4)),
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API key",
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})/g,
    group: 1,
    prefix: literal("sk-ant-"),
  },
  {
    id: "openai-style-api-key",
    description: "OpenAI-style `sk-` key, also used by OpenAI-compatible providers such as NEAR AI Cloud",
    pattern: /\b(sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,})/g,
    group: 1,
    prefix: literal("sk-"),
    accept: (v) => mixed(v) && entropy(v) > 3.5,
  },
  {
    id: "slack-token",
    description: "Slack token",
    pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g,
    group: 1,
    prefix: (v) => v.slice(0, 5),
  },
  {
    id: "secret-assignment",
    description: "value assigned to a key, token, secret or password name (generic; triaged by hand)",
    pattern: /([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*["'`]?([A-Za-z0-9_\-./+=]{24,})["'`]?/gi,
    group: 2,
    prefix: literal("assignment"),
    accept: (v, line) => mixed(v) && entropy(v) > 3.8 && !PLACEHOLDER.test(line) && !/^(?:ed25519|secp256k1):/.test(v) && !/^[0-9a-f]+$/.test(v),
  },
];

export const PATH_RULES: readonly Rule[] = [
  { id: "env-file", description: "dotenv file (.env or .env.*, except .env.example)" },
  { id: "key-file", description: "private key or credential file name (id_rsa, id_ed25519, *.pem, *.p12, *.key, .near-credentials/)" },
];

export const RULES: readonly Rule[] = [...CONTENT_RULES.map(({ id, description }) => ({ id, description })), ...PATH_RULES];

export function scanPath(path: string): string[] {
  const name = basename(path);
  const hits: string[] = [];
  if (/^\.env(\..+)?$/.test(name) && name !== ".env.example") hits.push("env-file");
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(name) || /\.(pem|p12|pfx|key)$/i.test(name) || /(^|\/)\.near-credentials\//.test(path)) hits.push("key-file");
  return hits;
}

export interface ScanStats {
  /** 64-byte `ed25519:` values under a signature field: counted, not reported as keys. */
  signature_values: number;
}

/** Scans text and returns redacted matches. */
export function scanText(text: string, stats: ScanStats = { signature_values: 0 }): Match[] {
  const out: Match[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > 20_000) return;
    const previous = i > 0 ? (lines[i - 1] ?? "").slice(-200) : "";
    for (const rule of CONTENT_RULES) {
      for (const m of line.matchAll(rule.pattern)) {
        const value = m[rule.group];
        if (value === undefined) continue;
        const before = `${previous}\n${line.slice(Math.max(0, (m.index) - 200), m.index)}`;
        if (rule.accept !== undefined && !rule.accept(value, line, before)) {
          if (rule.id === "near-ed25519-secret-key" && base58Length(value) === 64) stats.signature_values += 1;
          continue;
        }
        out.push({ rule: rule.id, line: i + 1, prefix: rule.prefix(value), length: value.length, fingerprint: fingerprint(value) });
      }
    }
  });
  return out;
}

export type Source = "history" | "commit-message" | "worktree";

export interface Finding extends Match {
  repo: string;
  source: Source;
  path: string;
  /** Short blob id (history) or commit id (commit message); null for the working tree. */
  object: string | null;
  /** Commits that add or remove the blob (at most five), for history findings. */
  commits: string[];
  triage: string | null;
}

export interface AllowEntry {
  repo: string;
  rule: string;
  path: string;
  fingerprint: string;
  reason: string;
}

export interface RepoSummary {
  repo: string;
  head: string;
  refs: number;
  commits: number;
  blobs: number;
  binary_blobs: number;
  text_bytes: number;
  worktree_files: number;
  /** Occurrences of 64-byte `ed25519:` values under signature fields (history blobs), skipped as signatures. */
  signature_values_skipped: number;
}

export interface ScanReport {
  schema: "bounded-mandate/secret-scan/v1";
  generated_at: string;
  scope: string;
  rules: readonly Rule[];
  repos: RepoSummary[];
  findings: Finding[];
  untriaged: number;
}

const git = (repo: string, args: string[], input?: Buffer): Buffer => {
  const r = spawnSync("git", ["-C", repo, ...args], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${repo}: ${r.stderr.toString()}`);
  return r.stdout;
};

const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0);

/** Reads many blobs through one `git cat-file --batch`. */
function readBlobs(repo: string, ids: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (ids.length === 0) return out;
  const raw = git(repo, ["cat-file", "--batch"], Buffer.from(ids.join("\n") + "\n"));
  let pos = 0;
  while (pos < raw.length) {
    const nl = raw.indexOf(0x0a, pos);
    const header = raw.subarray(pos, nl).toString();
    const [id, type, size] = header.split(" ");
    if (id === undefined || type === undefined || size === undefined) throw new Error(`unexpected cat-file header: ${header}`);
    const start = nl + 1;
    const end = start + Number(size);
    out.set(id, raw.subarray(start, end));
    pos = end + 1;
  }
  return out;
}

export function scanRepo(repoPath: string, name: string, allow: readonly AllowEntry[] = []): { summary: RepoSummary; findings: Finding[] } {
  const repo = resolve(repoPath);
  const findings: Finding[] = [];
  const triage = (f: Omit<Finding, "triage">): Finding => {
    const hit = allow.find((a) => a.repo === name && a.rule === f.rule && a.path === f.path && a.fingerprint === f.fingerprint);
    return { ...f, triage: hit?.reason ?? null };
  };

  // Every object reachable from every ref (branches, tags, remotes, stash); first path seen per blob.
  const objects = git(repo, ["rev-list", "--objects", "--all"]).toString().split("\n").filter(Boolean);
  const paths = new Map<string, string[]>();
  for (const line of objects) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const id = line.slice(0, sp);
    paths.set(id, [...(paths.get(id) ?? []), line.slice(sp + 1)]);
  }
  const types = git(repo, ["cat-file", "--batch-check"], Buffer.from([...paths.keys()].join("\n") + "\n")).toString().split("\n");
  const blobIds = types.filter((l) => l.split(" ")[1] === "blob").map((l) => l.split(" ")[0] ?? "");
  const blobs = readBlobs(repo, blobIds);
  const introducing = (blob: string): string[] =>
    git(repo, ["log", "--all", "--format=%h", `--find-object=${blob}`]).toString().split("\n").filter(Boolean).slice(0, 5);

  let binary = 0;
  let textBytes = 0;
  const stats: ScanStats = { signature_values: 0 };
  for (const [id, buf] of blobs) {
    const blobPaths = [...new Set(paths.get(id) ?? [])];
    const base = { repo: name, source: "history" as const, object: id.slice(0, 12) };
    for (const p of blobPaths)
      for (const rule of scanPath(p)) findings.push(triage({ ...base, rule, line: 0, prefix: basename(p), length: buf.length, fingerprint: fingerprint(buf.toString("latin1")), path: p, commits: introducing(id) }));
    if (isBinary(buf)) {
      binary += 1;
      continue;
    }
    textBytes += buf.length;
    const matches = scanText(buf.toString("utf8"), stats);
    if (matches.length === 0) continue;
    const commits = introducing(id);
    for (const m of matches) findings.push(triage({ ...base, ...m, path: blobPaths[0] ?? "?", commits }));
  }

  // Commit and annotated-tag messages.
  const log = git(repo, ["log", "--all", "--format=%H%x00%B%x00"]).toString().split("\0");
  let commits = 0;
  for (let i = 0; i + 1 < log.length; i += 2) {
    const id = (log[i] ?? "").trim();
    commits += 1;
    for (const m of scanText(log[i + 1] ?? "")) findings.push(triage({ ...m, repo: name, source: "commit-message", path: "<commit message>", object: id.slice(0, 12), commits: [id.slice(0, 7)] }));
  }
  for (const tag of git(repo, ["for-each-ref", "--format=%(objectname) %(objecttype) %(refname)", "refs/tags"]).toString().split("\n").filter(Boolean)) {
    const [id, type, ref] = tag.split(" ");
    if (type !== "tag" || id === undefined) continue;
    for (const m of scanText(git(repo, ["cat-file", "tag", id]).toString())) findings.push(triage({ ...m, repo: name, source: "commit-message", path: `<tag ${ref ?? id}>`, object: id.slice(0, 12), commits: [] }));
  }

  // Files the next commit would include: tracked plus untracked-but-not-ignored, read from disk.
  const files = git(repo, ["ls-files", "-co", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean);
  let worktree = 0;
  for (const f of files) {
    const full = join(repo, f);
    // Deleted paths and symlinks (e.g. a linked node_modules) are not file content the next commit would carry.
    if (!existsSync(full) || !lstatSync(full).isFile()) continue;
    worktree += 1;
    for (const rule of scanPath(f)) findings.push(triage({ repo: name, source: "worktree", rule, line: 0, prefix: basename(f), length: 0, fingerprint: "", path: f, object: null, commits: [] }));
    const buf = readFileSync(full);
    if (isBinary(buf)) continue;
    for (const m of scanText(buf.toString("utf8"))) findings.push(triage({ ...m, repo: name, source: "worktree", path: f, object: null, commits: [] }));
  }

  const summary: RepoSummary = {
    repo: name,
    head: git(repo, ["rev-parse", "HEAD"]).toString().trim(),
    refs: git(repo, ["for-each-ref"]).toString().split("\n").filter(Boolean).length,
    commits,
    blobs: blobs.size,
    binary_blobs: binary,
    text_bytes: textBytes,
    worktree_files: worktree,
    signature_values_skipped: stats.signature_values,
  };
  // A working-tree match already present in history at the same path adds nothing.
  const inHistory = new Set(findings.filter((f) => f.source === "history").map((f) => `${f.path}|${f.rule}|${f.fingerprint}`));
  const fresh = findings.filter((f) => f.source !== "worktree" || !inHistory.has(`${f.path}|${f.rule}|${f.fingerprint}`));
  return { summary, findings: dedupe(fresh) };
}

/** One finding per repo, source, path, line, rule and fingerprint (a blob seen at several paths is reported once). */
const dedupe = (findings: Finding[]): Finding[] => {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = [f.repo, f.source, f.path, f.line, f.rule, f.fingerprint, f.object].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function scanRepos(repos: { path: string; name: string }[], allow: readonly AllowEntry[] = []): ScanReport {
  const results = repos.map((r) => scanRepo(r.path, r.name, allow));
  const findings = results.flatMap((r) => r.findings);
  return {
    schema: "bounded-mandate/secret-scan/v1",
    generated_at: new Date().toISOString(),
    scope: "all blobs reachable from every ref (git rev-list --objects --all), every commit and annotated-tag message, and tracked plus untracked-unignored working-tree files",
    rules: RULES,
    repos: results.map((r) => r.summary),
    findings,
    untriaged: findings.filter((f) => f.triage === null).length,
  };
}

export function renderMarkdown(report: ScanReport): string {
  const rows = report.findings.map(
    (f) =>
      `| ${f.repo} | ${f.source} | ${f.rule} | \`${f.path}\`${f.line > 0 ? `:${f.line}` : ""} | ${f.object ?? "-"} | ${f.commits.join(" ") || "-"} | \`${f.prefix}\` <redacted ${f.length} chars> fp ${f.fingerprint || "-"} | ${f.triage ?? "**untriaged**"} |`,
  );
  return [
    `# Secret scan (${report.generated_at})`,
    "",
    `Scope: ${report.scope}. Values are never shown; the fingerprint is the first 12 hex characters of sha256(value).`,
    "",
    "| Repo | HEAD | Refs | Commits | Blobs (binary) | Text bytes | Working-tree files | Signature values skipped |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.repos.map((r) => `| ${r.repo} | ${r.head.slice(0, 12)} | ${r.refs} | ${r.commits} | ${r.blobs} (${r.binary_blobs}) | ${r.text_bytes} | ${r.worktree_files} | ${r.signature_values_skipped} |`),
    "",
    `Findings: ${report.findings.length}; untriaged: ${report.untriaged}.`,
    "",
    ...(rows.length === 0 ? [] : ["| Repo | Source | Rule | Location | Object | Commits | Redacted | Triage |", "| --- | --- | --- | --- | --- | --- | --- | --- |", ...rows]),
    "",
  ].join("\n");
}
