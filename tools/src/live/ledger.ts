// Append-only, hash-chained run ledger under out/live/<manifest sha256>/. Spent budget and progress are
// derived by replaying it, so a restart cannot reset them. A missing, tampered or truncated ledger
// refuses a resume instead of starting fresh.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Refusal } from "./manifest.js";

export const GENESIS_PREV = "0".repeat(64);

const Entry = z
  .object({
    seq: z.number().int().nonnegative(),
    at: z.string(),
    prev: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["start", "tx-intent", "tx-result", "step-done", "stopped", "reconciled", "decision-request", "decision"]),
    data: z.record(z.string(), z.unknown()),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type LedgerEntry = z.infer<typeof Entry>;
export type EntryKind = LedgerEntry["kind"];

const Head = z.object({ manifest_sha256: z.string(), seq: z.number().int(), hash: z.string() }).strict();

/** Canonical JSON with sorted keys, so hashes do not depend on key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const entryHash = (e: Omit<LedgerEntry, "hash">): string =>
  createHash("sha256").update(`${e.prev}\n${canonical({ seq: e.seq, at: e.at, kind: e.kind, data: e.data })}`).digest("hex");

export class Ledger {
  private constructor(
    readonly dir: string,
    readonly manifestSha256: string,
    private readonly list: LedgerEntry[],
  ) {}

  static dirFor(outRoot: string, manifestSha256: string): string {
    return join(outRoot, manifestSha256);
  }

  static exists(dir: string): boolean {
    return existsSync(join(dir, "ledger.jsonl")) || existsSync(join(dir, "head.json"));
  }

  static create(dir: string, manifestSha256: string): Ledger {
    if (Ledger.exists(dir)) throw new Refusal(`ledger already exists at ${dir}; set MANDATE_LIVE_RESUME=1 to resume it`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.jsonl"), "");
    return new Ledger(dir, manifestSha256, []);
  }

  /** Loads and verifies the whole chain and its head. Any defect refuses. */
  static load(dir: string, manifestSha256: string): Ledger {
    const file = join(dir, "ledger.jsonl");
    const headFile = join(dir, "head.json");
    if (!existsSync(file) || !existsSync(headFile)) throw new Refusal(`cannot resume: ledger missing at ${dir}`);
    const entries: LedgerEntry[] = [];
    let prev = GENESIS_PREV;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    for (const [i, line] of lines.entries()) {
      let entry: LedgerEntry;
      try {
        entry = Entry.parse(JSON.parse(line));
      } catch {
        throw new Refusal(`cannot resume: ledger entry ${i} is malformed`);
      }
      if (entry.seq !== i || entry.prev !== prev || entryHash(entry) !== entry.hash) throw new Refusal(`cannot resume: ledger entry ${i} fails its hash chain`);
      prev = entry.hash;
      entries.push(entry);
    }
    let head: z.infer<typeof Head>;
    try {
      head = Head.parse(JSON.parse(readFileSync(headFile, "utf8")));
    } catch {
      throw new Refusal("cannot resume: ledger head is malformed");
    }
    const last = entries.at(-1);
    if (head.manifest_sha256 !== manifestSha256) throw new Refusal("cannot resume: ledger belongs to another manifest");
    if (last === undefined || head.seq !== last.seq || head.hash !== last.hash) throw new Refusal("cannot resume: ledger head does not match its last entry (truncated or edited)");
    if (entries[0]?.kind !== "start" || entries[0].data.manifest_sha256 !== manifestSha256) throw new Refusal("cannot resume: ledger does not start with this manifest");
    return new Ledger(dir, manifestSha256, entries);
  }

  get entries(): readonly LedgerEntry[] {
    return this.list;
  }

  append(kind: EntryKind, data: Record<string, unknown>): LedgerEntry {
    const last = this.list.at(-1);
    const base = { seq: this.list.length, at: new Date().toISOString(), prev: last?.hash ?? GENESIS_PREV, kind, data };
    const entry: LedgerEntry = { ...base, hash: entryHash(base) };
    appendFileSync(join(this.dir, "ledger.jsonl"), `${JSON.stringify(entry)}\n`);
    const tmp = join(this.dir, "head.json.tmp");
    writeFileSync(tmp, JSON.stringify({ manifest_sha256: this.manifestSha256, seq: entry.seq, hash: entry.hash }));
    renameSync(tmp, join(this.dir, "head.json"));
    this.list.push(entry);
    return entry;
  }

  ofKind(kind: EntryKind): LedgerEntry[] {
    return this.list.filter((e) => e.kind === kind);
  }
}
