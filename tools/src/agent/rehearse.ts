// CLI for the no-transaction provider rehearsal (rehearsal.ts). It reads given state from files and never reads
// or writes a chain. The default provider is a SYNTHETIC stub. A real NEAR AI Cloud call is paid inference: it
// refuses unless the owner's approval is given explicitly with --approve-paid-inference and --approval-reference.
//
//   npx tsx src/agent/rehearse.ts --state <state.json> [--manifest <manifest.json>] [--out <dir>]
//       [--planned-usdc-units <n> --planned-wnear-units <n> [--planned-source <text>]]
//       [--provider stub [--stub-answer <decision JSON text>]]
//       [--provider near-ai --model <id> --timeout-ms <n> --max-tokens <n> --approve-paid-inference --approval-reference <text>]
//
// state.json holds `observations`, `decimals` and `notes` (a live decision recording has all three; before the first
// grant, src/agent/observe.ts writes them from read-only RPC), plus optional `sale_budget`, `sale_budget_source`,
// `planned_inventory` and `planned_grant`. The planned inventory is the deposit the setup record approves (for
// the live-agent template, 5 USDC + 0.90 wNEAR in base units, the wNEAR units derived on setup day): give it with
// --planned-usdc-units and --planned-wnear-units, or as planned_inventory in the state file. It is never taken from
// the manifest's budget.owner_inventory_max, which is a ceiling, not the deposit (at the ceiling the template's
// inventory is balanced and the model would not be called); with --manifest, a planned inventory above that ceiling
// is refused. --manifest also supplies the sale budget (max_order_sell; max_total_sell with nothing sold yet) and,
// only when the observations hold no grant, the planned grant (the policy of the manifest's grant step, epoch 1
// assumed: a fresh mandate's first grant).
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { sha256Hex } from "./decision.js";
import { NearAiProvider } from "./providers.js";
import { PlannedGrant } from "./objective.js";
import { RehearsalInput, RehearsalRefusal, StubProvider, rehearse, verifyRehearsal, writeRehearsal, type PaidInferenceApproval, type RehearsalProvider } from "./rehearsal.js";
import { SaleBudget, remainingSaleBudget } from "./snapshot.js";

const Units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const PerAsset = z.object({ usdc: Units, wnear: Units }).strict();

const StateFile = z
  .object({
    observations: z.unknown(),
    decimals: z.unknown(),
    notes: z.unknown(),
    sale_budget: SaleBudget.nullable().optional(),
    sale_budget_source: z.string().optional(),
    planned_inventory: z.object({ source: z.string(), units: PerAsset }).strict().optional(),
    planned_grant: PlannedGrant.nullable().optional(),
    /** Written by observe.ts: the manifest the observations were read for. */
    observed_by: z.object({ manifest_sha256: z.string() }).loose().optional(),
  })
  .loose();

/** Only the approved caps and grant policy the rehearsal needs; the full manifest is validated by the live runner. */
const ManifestCaps = z
  .object({
    budget: z.object({ owner_inventory_max: PerAsset, max_order_sell: PerAsset, max_total_sell: PerAsset }).loose(),
    steps: z.array(z.object({ kind: z.string() }).loose()).optional(),
  })
  .loose();

/** The policy of the manifest's first grant step, if it has one. */
function grantStepPolicy(caps: z.infer<typeof ManifestCaps>): unknown {
  return caps.steps?.find((step) => step.kind === "grant")?.policy;
}

/** The planned deposit given on the command line (base units, from the approved setup record). */
export interface PlannedDeposit {
  units: { usdc: string; wnear: string };
  source: string;
}

export function rehearsalInput(state: unknown, manifest: { path: string; text: string } | null, deposit: PlannedDeposit | null = null): RehearsalInput {
  const s = StateFile.parse(state);
  const caps = manifest === null ? null : ManifestCaps.parse(JSON.parse(manifest.text));
  const manifestSha = manifest === null ? null : sha256Hex(manifest.text);
  if (s.observed_by !== undefined && s.observed_by.manifest_sha256 !== manifestSha) {
    throw new RehearsalRefusal(`rehearsal: the state was observed for manifest ${s.observed_by.manifest_sha256}, not ${manifestSha ?? "(no --manifest)"}; observe again with the manifest you rehearse with`);
  }
  const label = manifest === null ? "" : `manifest ${manifest.path} (sha256 ${sha256Hex(manifest.text)})`;
  if (s.planned_inventory !== undefined && deposit !== null) throw new RehearsalRefusal("rehearsal: the planned inventory is given twice (state file and command line); give it once");
  const planned = s.planned_inventory ?? (deposit === null ? undefined : { source: deposit.source, units: PerAsset.parse(deposit.units) });
  if (planned === undefined) {
    throw new RehearsalRefusal(
      "rehearsal: the planned deposit is required: --planned-usdc-units and --planned-wnear-units from the approved setup record (or planned_inventory in the state file). The manifest's owner_inventory_max is a ceiling, not the deposit.",
    );
  }
  if (caps !== null) {
    for (const a of ["usdc", "wnear"] as const) {
      if (BigInt(planned.units[a]) > BigInt(caps.budget.owner_inventory_max[a])) {
        throw new RehearsalRefusal(`rehearsal: planned ${a} ${planned.units[a]} is above the manifest's owner_inventory_max ${caps.budget.owner_inventory_max[a]}`);
      }
    }
  }
  let budget: SaleBudget | null = s.sale_budget ?? null;
  let budgetSource = s.sale_budget_source ?? (s.sale_budget === undefined ? "none" : "state file");
  if (s.sale_budget === undefined && caps !== null) {
    budget = remainingSaleBudget(caps.budget, { usdc: 0n, wnear: 0n });
    budgetSource = `${label} max_order_sell / max_total_sell, nothing sold yet (no ledger read)`;
  }
  const noGrant = (s.observations as { grant?: unknown } | null)?.grant === null;
  let plannedGrant = s.planned_grant ?? null;
  if (plannedGrant === null && noGrant && caps !== null) {
    const policy = grantStepPolicy(caps);
    if (policy === undefined) throw new RehearsalRefusal("rehearsal: the observations hold no grant and the manifest has no grant step to plan from");
    plannedGrant = PlannedGrant.parse({ source: `${label} grant step policy (epoch 1 assumed: the first grant of a fresh mandate)`, epoch: 1, policy });
  }
  return RehearsalInput.parse({
    observations: s.observations,
    decimals: s.decimals,
    notes: s.notes,
    sale_budget: budget,
    sale_budget_source: budgetSource,
    planned_inventory: planned,
    planned_grant: plannedGrant,
    manifest_sha256: manifestSha,
  });
}

interface Args {
  provider?: string | undefined;
  "stub-answer"?: string | undefined;
  model?: string | undefined;
  "timeout-ms"?: string | undefined;
  "max-tokens"?: string | undefined;
  "approve-paid-inference"?: boolean | undefined;
  "approval-reference"?: string | undefined;
}

/** The --planned-* flags: both units or neither. */
export function plannedDeposit(values: { "planned-usdc-units"?: string | undefined; "planned-wnear-units"?: string | undefined; "planned-source"?: string | undefined }): PlannedDeposit | null {
  const usdc = values["planned-usdc-units"];
  const wnear = values["planned-wnear-units"];
  if (usdc === undefined && wnear === undefined) return null;
  if (usdc === undefined || wnear === undefined) throw new RehearsalRefusal("rehearsal: give both --planned-usdc-units and --planned-wnear-units");
  const units = PerAsset.safeParse({ usdc, wnear });
  if (!units.success) throw new RehearsalRefusal("rehearsal: planned units must be non-negative integers in base units (USDC 6 decimals, wNEAR 24)");
  return { units: units.data, source: values["planned-source"] ?? "planned deposit given on the command line (operator-declared; check it against the approved setup record)" };
}

/** Builds the provider; a real provider is constructed (and its key read) only with explicit approval. */
export function rehearsalProvider(args: Args, env: NodeJS.ProcessEnv): { rp: RehearsalProvider; approval: PaidInferenceApproval } {
  const kind = args.provider ?? "stub";
  if (kind === "stub") {
    if (args["approve-paid-inference"] === true) throw new RehearsalRefusal("rehearsal: --approve-paid-inference applies only to a real provider");
    const stub = new StubProvider(args["stub-answer"]);
    return { rp: { provider: stub, class: "stub", requested_model: stub.model }, approval: { approved: false, reference: null } };
  }
  if (kind !== "near-ai") throw new RehearsalRefusal(`rehearsal: unknown provider ${kind} (stub or near-ai)`);
  const reference = args["approval-reference"]?.trim() ?? "";
  if (args["approve-paid-inference"] !== true || reference === "") {
    throw new RehearsalRefusal("rehearsal: provider near-ai is paid inference; it runs only with the owner's explicit --approve-paid-inference and --approval-reference. Nothing was sent.");
  }
  const model = z.string().min(1).parse(args.model);
  const opts = { model, timeoutMs: z.coerce.number().int().min(1_000).max(600_000).parse(args["timeout-ms"]), maxTokens: z.coerce.number().int().min(1).max(32_768).parse(args["max-tokens"]) };
  return { rp: { provider: NearAiProvider.fromEnv(env, opts), class: "real", requested_model: model }, approval: { approved: true, reference } };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      state: { type: "string" },
      manifest: { type: "string" },
      out: { type: "string" },
      provider: { type: "string" },
      "stub-answer": { type: "string" },
      model: { type: "string" },
      "timeout-ms": { type: "string" },
      "max-tokens": { type: "string" },
      "approve-paid-inference": { type: "boolean" },
      "approval-reference": { type: "string" },
      "planned-usdc-units": { type: "string" },
      "planned-wnear-units": { type: "string" },
      "planned-source": { type: "string" },
    },
  });
  // Inputs are checked before the provider is built, so a refused input never reads a provider key.
  const statePath = z.string().min(1).parse(values.state);
  const manifest = values.manifest === undefined ? null : { path: values.manifest, text: readFileSync(values.manifest, "utf8") };
  const input = rehearsalInput(JSON.parse(readFileSync(statePath, "utf8")), manifest, plannedDeposit(values));
  const { rp, approval } = rehearsalProvider(values, process.env);
  const rec = await rehearse(input, rp, approval);
  const dir = resolve(values.out ?? join(import.meta.dirname, "../../../out/agent-rehearsal"));
  mkdirSync(dir, { recursive: true });
  const written = writeRehearsal(dir, rec);
  verifyRehearsal(readFileSync(written.path, "utf8"));
  console.log(
    JSON.stringify(
      {
        path: written.path,
        integrity_sha256: rec.integrity.sha256,
        transaction: rec.transaction,
        provider: rec.provider,
        qualifies_live_provider: rec.qualifies_live_provider,
        qualification: rec.qualification,
        grant_basis: rec.grant_basis.kind,
        model_called: rec.model_called,
        verdict: rec.verdict,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof RehearsalRefusal ? 2 : 1;
  }
}
