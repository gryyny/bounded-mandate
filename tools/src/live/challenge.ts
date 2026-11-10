// The optional open challenge (SPEC.md "Open challenge grant (optional)"): after a completed run, a new owner deposit
// and a fresh grant whose agent key is published outside every repository, so anyone can act as the agent. This module
// runs the challenge templates through the live runner into a separate output root, and writes the challenge record:
// chain reads presented apart from the completed run's receipts. The record carries the agent's public key only.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { NearClient } from "../near/client.js";
import { MandateClient, VerifierClient } from "../near/contracts.js";
import { REPO_ROOT } from "../near/sandbox.js";
import { Policy, type Receipt } from "../types.js";
import { runLive, type LiveDeps, type LiveResult } from "./main.js";
import { Refusal, loadManifest, type LiveManifest, type StepKind } from "./manifest.js";

export const CHALLENGE_RECORD_SCHEMA = "bounded-mandate/open-challenge@1";

/** Stated on every surface that presents the challenge (SPEC.md). */
export const CHALLENGE_DOES_NOT_SHOW = [
  "It does not show that the deposit is safe from poor trades. Whoever holds the agent key can make permitted trades at up to the concession bound on each order and up to the grant's turnover cap.",
  "Whoever holds the agent key can exhaust the agent's gas allowance and the grant's proposal budget; the challenge then accepts no further proposals.",
  "The cost is bounded by the challenge deposit and the agent's remaining gas allowance.",
  "An unknown contract defect could lose the deposit.",
] as const;

export const CHALLENGE_SHOWS =
  "Whoever holds the agent key cannot withdraw, transfer to another account, change keys or policy, or exceed the per-order and outstanding caps, the concession bound, the turnover cap and the loss breaker; the earlier grant's withheld order stays rejected while the challenge grant is live.";

export const KEY_PUBLICATION =
  "The agent's private key is published by the lead outside every repository and evidence bundle (the X thread and a pinned repository issue). Only its public key is recorded here.";

const OPEN_STEPS: readonly StepKind[] = ["check", "grant", "check"];
const CLOSE_STEPS: readonly StepKind[] = ["revoke_external", "recover_external", "recover_external", "register_storage", "register_storage", "withdraw_external", "withdraw_external", "check"];

export type ChallengePhase = "open" | "close";

/** The challenge phase of a manifest, or the reasons it is not a challenge manifest. */
export function challengePhase(m: LiveManifest): { phase: ChallengePhase } | { problems: string[] } {
  const p: string[] = [];
  if (m.agent_key_published !== true) p.push("agent_key_published must be true");
  const kinds = m.steps.map((s) => s.kind);
  const same = (want: readonly StepKind[]) => kinds.length === want.length && kinds.every((k, i) => k === want[i]);
  if (same(OPEN_STEPS)) {
    if (m.expect_existing_grant) p.push("the open phase starts with no active grant (expect_existing_grant false)");
    return p.length > 0 ? { problems: p } : { phase: "open" };
  }
  if (same(CLOSE_STEPS)) {
    if (!m.expect_existing_grant) p.push("the close phase needs expect_existing_grant true");
    return p.length > 0 ? { problems: p } : { phase: "close" };
  }
  return { problems: [...p, `steps must be ${OPEN_STEPS.join(", ")} (open) or ${CLOSE_STEPS.join(", ")} (close); got ${kinds.join(", ")}`] };
}

const Units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const PerAsset = z.object({ usdc: Units, wnear: Units }).strict();

export const ChallengeRecord = z
  .object({
    schema: z.literal(CHALLENGE_RECORD_SCHEMA),
    mode: z.enum(["sandbox", "mainnet"]),
    status: z.enum(["open", "closed", "not-opened"]),
    generated_at: z.string(),
    /** Challenge activity is not part of the completed run; verifying that run never counts it as a failure. */
    separate_from_completed_run: z.literal(true),
    network: z.object({ chain_id: z.string(), genesis_hash: z.string() }).strict(),
    /** Final block of the reads below. */
    read_at: z.object({ block_height: z.number().int(), block_hash: z.string(), timestamp_ns: z.string() }).strict(),
    accounts: z.object({ mandate: z.string(), owner: z.string(), agent: z.string(), verifier: z.string(), signer: z.string() }).strict(),
    mandate_code_hash: z.string(),
    agent_key: z
      .object({
        public_key: z.string(),
        /** Remaining function-call allowance (null: key absent or unlimited). */
        allowance_yocto: z.string().nullable(),
        nonce: z.string().nullable(),
        publication: z.literal(KEY_PUBLICATION),
        /** Link to the published key, outside every repository; null until the lead publishes it. */
        publication_url: z.string().nullable(),
      })
      .strict(),
    /** sha256 of the challenge manifests run so far. */
    manifests: z.object({ open: z.string().nullable(), close: z.string().nullable() }).strict(),
    /** The challenge grant's opening transaction; challenge activity on the mandate begins after this block. */
    opened: z.object({ tx_hash: z.string(), block_height: z.number().int().nullable() }).strict().nullable(),
    grant: z
      .object({
        epoch: z.number().int(),
        path: z.string(),
        public_key: z.string().nullable(),
        key_registered: z.boolean(),
        status: z.string(),
        policy: Policy,
        initial_value: z.string().nullable(),
        turnover_used: z.string(),
        outstanding: z.string(),
        breaker: z.unknown().nullable(),
        /** Informational upper bound of proposals in this grant: floor(turnover_cap_bps / proposal_charge_bps). */
        proposal_budget_upper_bound: z.number().int(),
      })
      .strict()
      .nullable(),
    /** Every earlier grant: its MPC-derived key (signer view) and whether the verifier lists it now. */
    earlier_grants: z.array(z.object({ epoch: z.number().int(), path: z.string(), derived_public_key: z.string().nullable(), registered: z.boolean().nullable() }).strict()),
    /** Signed orders of earlier grants that never executed (their nonce still unused), e.g. the completed run's withheld order. */
    earlier_unexecuted_orders: z.array(z.object({ id: z.string(), epoch: z.number().int(), state: z.string(), deadline_ns: z.string().nullable(), nonce_used: z.boolean() }).strict()),
    /** Orders of the challenge grant by state (key holders' proposals). */
    challenge_orders: z.object({ total: z.number().int(), by_state: z.record(z.string(), z.number().int()) }).strict(),
    mandate_balances: PerAsset,
    /** The close: the runner's result and receipts of the close manifest. */
    close: z
      .object({
        exit_code: z.number().int(),
        message: z.string(),
        receipts: z.array(z.object({ label: z.string(), tx_hash: z.string().nullable(), method: z.string().nullable(), outcome: z.enum(["success", "failure"]) }).strict()),
      })
      .strict()
      .nullable(),
    shows: z.literal(CHALLENGE_SHOWS),
    does_not_show: z.tuple([z.literal(CHALLENGE_DOES_NOT_SHOW[0]), z.literal(CHALLENGE_DOES_NOT_SHOW[1]), z.literal(CHALLENGE_DOES_NOT_SHOW[2]), z.literal(CHALLENGE_DOES_NOT_SHOW[3])]),
  })
  .strict();
export type ChallengeRecord = z.infer<typeof ChallengeRecord>;

const methodOf = (r: Receipt): string | null => {
  const d = r.detail as { method?: unknown } | null;
  return typeof d?.method === "string" ? d.method : null;
};

export interface RecordInput {
  client: NearClient;
  manifest: LiveManifest;
  manifestSha256: string;
  phase: ChallengePhase;
  result: LiveResult;
  /** The record of an earlier phase (its opening is carried over). */
  previous: ChallengeRecord | null;
  publicationUrl: string | null;
}

/** Builds the challenge record from chain reads at one final block and the runner's result. Never reads a secret. */
export async function challengeRecord(input: RecordInput): Promise<ChallengeRecord> {
  const { client, manifest: m, phase, result } = input;
  const mandate = new MandateClient(client, m.accounts.mandate);
  const verifier = new VerifierClient(client, m.accounts.verifier);
  const block = await client.provider.viewBlock({ finality: "final" });
  const status = await client.nodeStatus();
  const grant = await mandate.grant();
  const orders = await mandate.allOrders();
  const agentKey = (await client.accessKeys(m.accounts.agent)).find((k) => k.public_key === m.keys.agent.public_key);
  const earlier: ChallengeRecord["earlier_grants"] = [];
  for (let epoch = 1; epoch < (grant?.epoch ?? 0); epoch++) {
    const path = `mandate/v1/${epoch}`;
    const key = await client.tryView(m.accounts.signer, "derived_public_key", { path, predecessor: m.accounts.mandate, domain_id: 1 }, z.string());
    earlier.push({ epoch, path, derived_public_key: key.ok ? key.value : null, registered: key.ok ? await verifier.hasPublicKey(m.accounts.mandate, key.value) : null });
  }
  const unexecuted: ChallengeRecord["earlier_unexecuted_orders"] = [];
  for (const o of orders.filter((x) => x.epoch < (grant?.epoch ?? 0) && x.payload !== null && x.signature !== null)) {
    const used = await verifier.isNonceUsed(m.accounts.mandate, o.payload?.nonce ?? "");
    if (!used) unexecuted.push({ id: o.id, epoch: o.epoch, state: o.state.state === "released" || o.state.state === "rejected" ? `${o.state.state}:${o.state.reason}` : o.state.state, deadline_ns: o.deadline_ns, nonce_used: used });
  }
  const grantReceipt = phase === "open" ? result.evidence?.receipts.find((r) => methodOf(r) === "grant" && r.outcome === "success" && r.tx_hash !== undefined) : undefined;
  const opened = grantReceipt?.tx_hash !== undefined ? { tx_hash: grantReceipt.tx_hash, block_height: grantReceipt.block_height ?? null } : (input.previous?.opened ?? null);
  const challengeGrant = opened === null ? null : grant;
  const mine = challengeGrant === null ? [] : orders.filter((o) => o.epoch === challengeGrant.epoch);
  const byState: Record<string, number> = {};
  for (const o of mine) {
    const s = o.state.state === "released" || o.state.state === "rejected" ? `${o.state.state}:${o.state.reason}` : o.state.state;
    byState[s] = (byState[s] ?? 0) + 1;
  }
  const balance = async (asset: "usdc" | "wnear") => (await verifier.balance(m.accounts.mandate, m.mandate_config[asset].token)).toString();
  const record: ChallengeRecord = {
    schema: CHALLENGE_RECORD_SCHEMA,
    mode: m.network.name,
    status: opened === null ? "not-opened" : phase === "close" && result.exitCode === 0 && grant?.status === "revoked" ? "closed" : "open",
    generated_at: new Date().toISOString(),
    separate_from_completed_run: true,
    network: { chain_id: status.chain_id, genesis_hash: status.genesis_hash },
    read_at: { block_height: block.header.height, block_hash: block.header.hash, timestamp_ns: block.header.timestamp_nanosec },
    accounts: { mandate: m.accounts.mandate, owner: m.accounts.owner, agent: m.accounts.agent, verifier: m.accounts.verifier, signer: m.accounts.signer },
    mandate_code_hash: m.code_hashes.mandate,
    agent_key: {
      public_key: m.keys.agent.public_key,
      allowance_yocto: agentKey?.permission.kind === "function_call" ? (agentKey.permission.allowance?.toString() ?? null) : null,
      nonce: agentKey === undefined ? null : agentKey.nonce.toString(),
      publication: KEY_PUBLICATION,
      publication_url: input.publicationUrl ?? input.previous?.agent_key.publication_url ?? null,
    },
    manifests: { open: phase === "open" ? input.manifestSha256 : (input.previous?.manifests.open ?? null), close: phase === "close" ? input.manifestSha256 : null },
    opened,
    grant:
      challengeGrant === null
        ? null
        : {
            epoch: challengeGrant.epoch,
            path: challengeGrant.path,
            public_key: challengeGrant.public_key,
            key_registered: challengeGrant.public_key !== null && (await verifier.hasPublicKey(m.accounts.mandate, challengeGrant.public_key)),
            status: challengeGrant.status,
            policy: challengeGrant.policy,
            initial_value: challengeGrant.initial_value,
            turnover_used: challengeGrant.turnover_used,
            outstanding: challengeGrant.outstanding,
            breaker: challengeGrant.breaker,
            proposal_budget_upper_bound: Math.floor(challengeGrant.policy.turnover_cap_bps / challengeGrant.policy.proposal_charge_bps),
          },
    earlier_grants: earlier,
    earlier_unexecuted_orders: unexecuted,
    challenge_orders: { total: mine.length, by_state: byState },
    mandate_balances: { usdc: await balance("usdc"), wnear: await balance("wnear") },
    close:
      phase === "close"
        ? { exit_code: result.exitCode, message: result.message, receipts: (result.evidence?.receipts ?? []).map((r) => ({ label: r.label, tx_hash: r.tx_hash ?? null, method: methodOf(r), outcome: r.outcome })) }
        : null,
    shows: CHALLENGE_SHOWS,
    does_not_show: [...CHALLENGE_DOES_NOT_SHOW],
  };
  return ChallengeRecord.parse(record);
}

export interface ChallengeResult extends LiveResult {
  record?: ChallengeRecord;
  recordPath?: string;
}

/**
 * Runs a challenge manifest (open or close) through the live runner with ledger and evidence under `<outRoot>/..`
 * (default out/challenge/), apart from the completed run's out/live and out/evidence, then writes the challenge record.
 * MANDATE_CHALLENGE_KEY_URL optionally records the link to the published key.
 */
export async function runChallenge(env: NodeJS.ProcessEnv = process.env, deps: LiveDeps = {}): Promise<ChallengeResult> {
  let loaded: ReturnType<typeof loadManifest>;
  let phase: ChallengePhase;
  try {
    loaded = loadManifest(env);
    const shape = challengePhase(loaded.manifest);
    if ("problems" in shape) throw new Refusal(`challenge: not a challenge manifest: ${shape.problems.join("; ")}`);
    phase = shape.phase;
  } catch (error) {
    return { exitCode: 2, message: error instanceof Error ? error.message : String(error) };
  }
  const outRoot = deps.outRoot ?? join(REPO_ROOT, "out/challenge/live");
  const result = await runLive(env, { ...deps, outRoot });
  if (result.exitCode === 2 && result.evidence === undefined) return result;
  const m = loaded.manifest;
  const recordPath = join(outRoot, "..", "evidence", `challenge-${m.network.name}.json`);
  const previous = existsSync(recordPath) ? ChallengeRecord.parse(JSON.parse(readFileSync(recordPath, "utf8"))) : null;
  const client = (deps.client ?? new NearClient(m.network.rpc_url)).final();
  const url = env.MANDATE_CHALLENGE_KEY_URL;
  const record = await challengeRecord({ client, manifest: m, manifestSha256: loaded.sha256, phase, result, previous, publicationUrl: url === undefined || url === "" ? null : url });
  mkdirSync(join(outRoot, "..", "evidence"), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...result, record, recordPath };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runChallenge();
  for (const c of result.preflight ?? []) console.log(`preflight ${c.passed ? "PASS" : "FAIL"} ${c.id}${c.passed ? "" : `: ${JSON.stringify(c.observed)}`}`);
  console.log(result.message);
  if (result.recordPath !== undefined) console.log(`challenge record: ${result.recordPath} (status ${result.record?.status ?? "?"})`);
  process.exitCode = result.exitCode;
}
