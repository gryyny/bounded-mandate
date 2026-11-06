// Release secret scanner. Every secret-shaped value is generated at run time, so this file holds none.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { base58Length, renderMarkdown, scanPath, scanRepos, scanText } from "../src/release/secrets.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes: Buffer): string => {
  let n = BigInt(`0x${bytes.toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) {
    s = (B58[Number(n % 58n)] ?? "") + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
};
const alnum = (n: number): string => base58(randomBytes(n * 2)).slice(0, n);
const ED = "ed25519" + ":";
/** A non-zero leading byte keeps the decoded length exact. */
const bytes = (n: number): Buffer => Buffer.concat([Buffer.from([0x80]), randomBytes(n - 1)]);
const secretKey = (): string => ED + base58(bytes(64));
const publicKey = (): string => ED + base58(bytes(32));
const PEM = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("secret patterns", () => {
  it("decodes base58 lengths exactly", () => {
    expect(base58Length(base58(bytes(64)))).toBe(64);
    expect(base58Length(base58(bytes(32)))).toBe(32);
    expect(base58Length("0OIl")).toBeNull();
  });

  it("flags each supported secret format and keeps no value", () => {
    const values = {
      key: secretKey(),
      aws: `AKIA${alnum(16).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`,
      gh: `ghp_${alnum(36)}`,
      pat: `github_pat_${alnum(40)}`,
      ant: `sk-ant-api03-${alnum(40)}`,
      oai: `sk-proj-${alnum(24)}7${alnum(24)}`,
      generic: `${alnum(20)}9${alnum(19)}`,
    };
    const text = [
      `{"private_key": "${values.key}"}`,
      PEM,
      `aws_access_key_id = ${values.aws}`,
      `token: ${values.gh}`,
      values.pat,
      `ANTHROPIC_API_KEY=${values.ant}`,
      `NEAR_AI_API_KEY=${values.oai}`,
      `"seed_phrase": "${Array.from({ length: 12 }, (_, i) => ["alpha", "bravo", "charlie", "delta"][i % 4] ?? "x").join(" ")}"`,
      `client_secret = "${values.generic}"`,
    ].join("\n");
    const found = scanText(text);
    const rules = new Set(found.map((m) => m.rule));
    for (const rule of ["near-ed25519-secret-key", "pem-private-key", "aws-access-key-id", "github-token", "anthropic-api-key", "openai-style-api-key", "seed-phrase", "secret-assignment"])
      expect(rules, rule).toContain(rule);
    expect(found.filter((m) => m.rule === "github-token")).toHaveLength(2);
    const serialized = JSON.stringify(found);
    for (const v of Object.values(values)) expect(serialized).not.toContain(v);
    expect(found.find((m) => m.rule === "near-ed25519-secret-key")).toMatchObject({ line: 1, prefix: ED, length: values.key.length - ED.length });
  });

  it("ignores public keys, signatures, hashes and placeholders", () => {
    const sig = base58(bytes(64));
    const text = [
      `"public_key": "${publicKey()}"`,
      `"signature": "${ED}${sig}"`,
      `"multi_payload": "{\\"signature\\":\\"${ED}${sig}\\"}"`,
      `&quot;signature&quot;: &quot;${ED}${sig}&quot;`,
      `"signatures": [`,
      `  "${ED}${sig}"`,
      `"sha256": "${randomBytes(32).toString("hex")}"`,
      `NEAR_AI_API_KEY=<your key>`,
      `api_key: process.env.NEAR_AI_API_KEY_${alnum(20)}`,
      `const API_KEY_ENV = "NEAR_AI_API_KEY";`,
    ].join("\n");
    const stats = { signature_values: 0 };
    expect(scanText(text, stats)).toEqual([]);
    expect(stats.signature_values).toBe(4);
  });

  it("flags dotenv and key files by name only", () => {
    expect(scanPath(".env")).toEqual(["env-file"]);
    expect(scanPath("tools/.env.local")).toEqual(["env-file"]);
    expect(scanPath(".env.example")).toEqual([]);
    expect(scanPath("keys/id_ed25519")).toEqual(["key-file"]);
    expect(scanPath("home/.near-credentials/mainnet/a.json")).toEqual(["key-file"]);
    expect(scanPath("README.md")).toEqual([]);
  });
});

describe("history scan", () => {
  const sh = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd }).toString();

  it("finds secrets in deleted files, other branches, messages and the working tree without printing them", () => {
    const repo = mkdtempSync(join(tmpdir(), "bm-secret-scan-"));
    dirs.push(repo);
    sh(repo, "init", "-q", "-b", "main");
    const key = secretKey();
    const token = `ghp_${alnum(36)}`;
    const branchToken = `sk-ant-api03-${alnum(40)}`;
    const untracked = secretKey();
    writeFileSync(join(repo, "creds.json"), `{"private_key": "${key}"}\n`);
    writeFileSync(join(repo, ".env"), "X=1\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "add creds");
    sh(repo, "rm", "-q", "creds.json", ".env");
    sh(repo, "commit", "-q", "-m", `remove creds, rotate ${token}`);
    sh(repo, "checkout", "-q", "-b", "side");
    mkdirSync(join(repo, "cfg"));
    writeFileSync(join(repo, "cfg/app.txt"), `key=${branchToken}\n`);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "side");
    sh(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "notes.txt"), `${untracked}\n`);

    const report = scanRepos([{ path: repo, name: "fixture" }]);
    const where = report.findings.map((f) => `${f.source}:${f.rule}:${f.path}`).sort();
    expect(where).toEqual([
      "commit-message:github-token:<commit message>",
      "history:anthropic-api-key:cfg/app.txt",
      "history:env-file:.env",
      "history:near-ed25519-secret-key:creds.json",
      "worktree:near-ed25519-secret-key:notes.txt",
    ]);
    expect(report.repos[0]).toMatchObject({ repo: "fixture", commits: 3, refs: 2 });
    expect(report.untriaged).toBe(5);
    expect(report.findings.find((f) => f.path === "creds.json")?.commits).toHaveLength(2);
    const out = JSON.stringify(report) + renderMarkdown(report);
    for (const v of [key, token, branchToken, untracked]) expect(out).not.toContain(v);
  });

  it("marks findings triaged only by an exact allowlist entry", () => {
    const repo = mkdtempSync(join(tmpdir(), "bm-secret-allow-"));
    dirs.push(repo);
    sh(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), `${secretKey()}\n`);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "a");
    const first = scanRepos([{ path: repo, name: "r" }]);
    const f = first.findings[0];
    expect(f).toBeDefined();
    if (f === undefined) return;
    const entry = { repo: "r", rule: f.rule, path: f.path, fingerprint: f.fingerprint, reason: "test key of a local sandbox" };
    expect(scanRepos([{ path: repo, name: "r" }], [entry]).untriaged).toBe(0);
    expect(scanRepos([{ path: repo, name: "r" }], [{ ...entry, fingerprint: "000000000000" }]).untriaged).toBe(1);
  });
});
