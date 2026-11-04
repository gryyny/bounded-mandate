// Run protocol for `make test`:
//   run.ts start  new run id -> out/run/run.json (+ out/run/run_id); clears out/evidence/tests and acceptance.json
//   run.ts wasm   sha256 of every target/near/*/*.wasm -> out/run/wasm.json
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, reportsDir, treeState } from "../evidence/report.js";
import { RUN_SCHEMA, RunRecord, type WasmRecord } from "../evidence/schema.js";
import { sha256File } from "./integrity.js";

export const runDir = (root: string): string => join(root, "out/run");
export const acceptancePath = (root: string): string => join(root, "out/evidence/acceptance.json");

export function startRun(root: string, now = new Date()): RunRecord {
  const { revision, dirty } = treeState(root);
  const record: RunRecord = {
    schema: RUN_SCHEMA,
    run_id: `${now.toISOString().replace(/[-:.]/g, "")}-${randomBytes(6).toString("hex")}`,
    revision,
    dirty,
    spec_sha256: sha256File(join(root, "SPEC.md")),
    fixture_manifest_sha256: sha256File(join(root, "fixtures/manifest.json")),
    started_at: now.toISOString(),
  };
  // Reports and verdicts from earlier runs must not survive into this one.
  rmSync(reportsDir(root), { recursive: true, force: true });
  rmSync(acceptancePath(root), { force: true });
  rmSync(runDir(root), { recursive: true, force: true });
  mkdirSync(runDir(root), { recursive: true });
  writeFileSync(join(runDir(root), "run.json"), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(runDir(root), "run_id"), record.run_id);
  return record;
}

export function readRun(root: string): RunRecord | null {
  const path = join(runDir(root), "run.json");
  return existsSync(path) ? RunRecord.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
}

export function recordWasm(root: string, now = new Date()): WasmRecord {
  const run = readRun(root);
  if (run === null) throw new Error("no out/run/run.json: run `run.ts start` first");
  const nearDir = join(root, "target/near");
  const wasm: Record<string, string> = {};
  for (const crate of existsSync(nearDir) ? readdirSync(nearDir).sort() : []) {
    const dir = join(nearDir, crate);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".wasm")).sort()) {
      wasm[file.slice(0, -".wasm".length)] = sha256File(join(dir, file));
    }
  }
  if (Object.keys(wasm).length === 0) throw new Error("no target/near/*/*.wasm found: build the contracts first");
  const record: WasmRecord = { run_id: run.run_id, recorded_at: now.toISOString(), wasm_sha256: wasm };
  writeFileSync(join(runDir(root), "wasm.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const command = process.argv[2];
  if (command === "start") {
    const run = startRun(REPO_ROOT);
    console.error(`run ${run.run_id} at ${run.revision ?? "unknown revision"}${run.dirty ? " (dirty: results will be uncertified)" : ""}`);
    console.log(run.run_id);
  } else if (command === "wasm") {
    const rec = recordWasm(REPO_ROOT);
    for (const [stem, hash] of Object.entries(rec.wasm_sha256)) console.log(`wasm ${stem} ${hash}`);
  } else {
    console.error("usage: run.ts start|wasm");
    process.exit(2);
  }
}
