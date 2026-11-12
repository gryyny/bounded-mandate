// Replays an exported lab scenario on a fresh local sandbox and reports whether every outcome matches:
//   cd tools && npx tsx src/lab/replay.ts <scenario.json> [--fast]
// The scenario must name exactly the binaries this checkout pins. Actions are spaced as they were recorded, so
// outcomes that depend on a deadline having passed repeat; --fast runs them back to back.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../near/sandbox.js";
import { loadPrebuilt } from "../quick/prebuilt.js";
import { LAB_LABEL } from "./config.js";
import { SandboxPool } from "./pool.js";
import { Scenario, replayScenario, sourceRevision, type ReplayResult } from "./scenario.js";
import { LEASE_BUDGET_NEAR, WORLD_NEAR, createLabWorld } from "./world.js";

export async function replayFile(path: string, options: { paced?: boolean; root?: string } = {}): Promise<ReplayResult> {
  const root = options.root ?? REPO_ROOT;
  const scenario = Scenario.parse(JSON.parse(readFileSync(path, "utf8")));
  const set = loadPrebuilt(root);
  const pool = new SandboxPool(1, WORLD_NEAR, LEASE_BUDGET_NEAR);
  const tmp = mkdtempSync(join(tmpdir(), "bm-lab-replay-"));
  try {
    return await replayScenario(scenario, {
      wasm: set.wasm,
      source: sourceRevision(root, undefined),
      world: async () => createLabWorld(await pool.acquire(), set.wasm, tmp),
      paced: options.paced ?? true,
    });
  } finally {
    await pool.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (file === undefined) {
    console.error("usage: npx tsx src/lab/replay.ts <scenario.json> [--fast]");
    process.exit(2);
  }
  console.log(LAB_LABEL);
  const result = await replayFile(resolve(file), { paced: !args.includes("--fast") });
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const a of result.actions) console.log(`${a.matches ? "same     " : "DIFFERENT"} ${String(a.seq).padStart(3)} ${a.action}`);
  for (const p of result.problems) console.log(`  ${p}`);
  console.log(result.matches ? `replay matches: ${result.actions.length} actions with the same outcomes` : `replay DOES NOT match (differences: ${result.problems.length})`);
  process.exit(result.matches ? 0 : 1);
}
