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
import { Policy, type Evidence, type GrantView, type Receipt } from "../types.js";
import { runLive, writeNew, type LiveDeps, type LiveResult } from "./main.js";
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
    /**
     * open: the challenge grant is active on chain. closed: the close manifest completed and the grant is revoked.
     * inactive: the challenge was opened, its grant is on chain but not active, and no completed close is recorded here.
     * not-opened: no opening of the grant now on chain is known to this record.
     */
    status: z.enum(["open", "closed", "inactive", "not-opened"]),
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
    /** Present when a record with an opening was already on disk and nothing was carried forward from it: the reasons. */
    previous_record_ignored: z.array(z.string()).min(1).optional(),
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
  /** The record already on disk. Carried forward only when it is this challenge's (previousProblems), else ignored. */
  previous: ChallengeRecord | null;
  publicationUrl: string | null;
}

/**
 * Why an earlier record is not the record of this manifest's challenge: another network, mandate, mandate code or
 * agent key, or an opening of a grant that is not the grant now on chain. Empty when it may be carried forward.
 */
export function previousProblems(previous: ChallengeRecord, m: LiveManifest, grant: GrantView | null): string[] {
  const differs = (what: string, was: string, now: string): string[] => (was === now ? [] : [`${what} was ${was}, this manifest's is ${now}`]);
  const p = [
    ...differs("chain id", previous.network.chain_id, m.network.chain_id),
    ...differs("genesis hash", previous.network.genesis_hash, m.network.genesis_hash),
    ...differs("mandate account", previous.accounts.mandate, m.accounts.mandate),
    ...differs("mandate code hash", previous.mandate_code_hash, m.code_hashes.mandate),
    ...differs("agent key", previous.agent_key.public_key, m.keys.agent.public_key),
  ];
  const g = previous.grant;
  if (previous.opened === null || g === null) p.push("it records no opened grant");
  else if (grant === null) p.push(`it opened grant epoch ${String(g.epoch)}, and the mandate has no grant now`);
  else if (g.epoch !== grant.epoch || g.path !== grant.path || (g.public_key !== null && grant.public_key !== null && g.public_key !== grant.public_key)) {
    p.push(`it opened grant epoch ${String(g.epoch)} (${g.path}, key ${g.public_key ?? "none"}), the grant on chain is epoch ${String(grant.epoch)} (${grant.path}, key ${grant.public_key ?? "none"})`);
  }
  return p;
}

/** The grant this run's open phase made: a successful grant transaction whose terminal verification passed. */
function openedByRun(evidence: Evidence | undefined): { tx_hash: string; block_height: number | null; epoch: number } | null {
  const receipt = evidence?.receipts.find((r) => methodOf(r) === "grant" && r.outcome === "success" && r.tx_hash !== undefined);
  const verified = evidence?.assertions.find((a) => /^step-\d+-grant$/.test(a.id) && a.passed);
  const epoch = z.object({ epoch: z.number().int() }).loose().safeParse(verified?.observed);
  if (receipt?.tx_hash === undefined || !epoch.success) return null;
  return { tx_hash: receipt.tx_hash, block_height: receipt.block_height ?? null, epoch: epoch.data.epoch };
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
  // An opening counts only for the grant now on chain: this run's verified grant, else a previous record bound to it.
  const run = phase === "open" ? openedByRun(result.evidence) : null;
  const ignored = input.previous === null ? [] : previousProblems(input.previous, m, grant);
  const previous = ignored.length === 0 ? input.previous : null;
  const opened = run !== null && run.epoch === grant?.epoch ? { tx_hash: run.tx_hash, block_height: run.block_height } : (previous?.opened ?? null);
  const challengeGrant = opened === null ? null : grant;
  const mine = challengeGrant === null ? [] : orders.filter((o) => o.epoch === challengeGrant.epoch);
  const byState: Record<string, number> = {};
  for (const o of mine) {
    const s = o.state.state === "released" || o.state.state === "rejected" ? `${o.state.state}:${o.state.reason}` : o.state.state;
    byState[s] = (byState[s] ?? 0) + 1;
  }
  // A completed close stays recorded: a later refresh or a close re-run that did not complete (a failure, or nothing
  // left to do) keeps the earlier record's close while the same grant is still revoked on chain.
  const closedNow = phase === "close" && result.exitCode === 0 && challengeGrant?.status === "revoked";
  const closedBefore = !closedNow && previous?.status === "closed" && previous.close !== null && challengeGrant?.status === "revoked" ? previous : null;
  const balance = async (asset: "usdc" | "wnear") => (await verifier.balance(m.accounts.mandate, m.mandate_config[asset].token)).toString();
  const record: ChallengeRecord = {
    schema: CHALLENGE_RECORD_SCHEMA,
    mode: m.network.name,
    status: challengeGrant === null ? "not-opened" : closedNow || closedBefore !== null ? "closed" : challengeGrant.status === "active" ? "open" : "inactive",
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
      publication_url: input.publicationUrl ?? previous?.agent_key.publication_url ?? null,
    },
    manifests: { open: phase === "open" ? input.manifestSha256 : (previous?.manifests.open ?? null), close: closedBefore !== null ? closedBefore.manifests.close : phase === "close" ? input.manifestSha256 : null },
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
      closedBefore !== null
        ? closedBefore.close
        : phase === "close"
          ? { exit_code: result.exitCode, message: result.message, receipts: (result.evidence?.receipts ?? []).map((r) => ({ label: r.label, tx_hash: r.tx_hash ?? null, method: methodOf(r), outcome: r.outcome })) }
        : null,
    ...(input.previous !== null && input.previous.opened !== null && ignored.length > 0 ? { previous_record_ignored: ignored } : {}),
    shows: CHALLENGE_SHOWS,
    does_not_show: [...CHALLENGE_DOES_NOT_SHOW],
  };
  return ChallengeRecord.parse(record);
}

export interface ChallengeResult extends LiveResult {
  record?: ChallengeRecord;
  recordPath?: string;
}

/** The link to the published key from MANDATE_CHALLENGE_KEY_URL: null when unset, else an https URL. */
export function publicationUrl(env: NodeJS.ProcessEnv): string | null {
  const url = env.MANDATE_CHALLENGE_KEY_URL;
  if (url === undefined || url === "") return null;
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") throw new Refusal("challenge: MANDATE_CHALLENGE_KEY_URL must be an https URL");
  return url;
}

/**
 * Runs a challenge manifest (open or close) through the live runner with ledger and evidence under `<outRoot>/..`
 * (default out/challenge/), apart from the completed run's out/live and out/evidence, then writes the challenge record.
 * The runner's evidence of each phase is its own file (live-<network>-challenge-<phase>.json).
 *
 * A record already on disk is carried forward (its opening, the open manifest's hash, the publication link) only when
 * it is this challenge's: same network, mandate, mandate code and agent key, and an opening of the grant now on chain.
 * Otherwise nothing is taken from it; the new record and the message say why, and the old file is kept under
 * evidence/replaced/ before the new record takes its place.
 *
 * The key is published only after the open phase completed and the record shows the grant active. The link is then
 * recorded by running the open manifest again with MANDATE_LIVE_RESUME=1 and MANDATE_CHALLENGE_KEY_URL=<https link>:
 * the resume sends nothing and rewrites the record with `agent_key.publication_url` set. Until then it is null.
 */
export async function runChallenge(env: NodeJS.ProcessEnv = process.env, deps: LiveDeps = {}): Promise<ChallengeResult> {
  let loaded: ReturnType<typeof loadManifest>;
  let phase: ChallengePhase;
  let url: string | null;
  try {
    loaded = loadManifest(env);
    const shape = challengePhase(loaded.manifest);
    if ("problems" in shape) throw new Refusal(`challenge: not a challenge manifest: ${shape.problems.join("; ")}`);
    phase = shape.phase;
    url = publicationUrl(env);
  } catch (error) {
    return { exitCode: 2, message: error instanceof Error ? error.message : String(error) };
  }
  const outRoot = deps.outRoot ?? join(REPO_ROOT, "out/challenge/live");
  const result = await runLive(env, { ...deps, outRoot, challenge: phase });
  if (result.exitCode === 2 && result.evidence === undefined) return result;
  const m = loaded.manifest;
  const recordPath = join(outRoot, "..", "evidence", `challenge-${m.network.name}.json`);
  const previousText = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : null;
  const previous = previousText === null ? null : ChallengeRecord.parse(JSON.parse(previousText));
  const client = (deps.client ?? new NearClient(m.network.rpc_url)).final();
  const record = await challengeRecord({ client, manifest: m, manifestSha256: loaded.sha256, phase, result, previous, publicationUrl: url });
  const evidenceDir = join(outRoot, "..", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  // A record of an opening that is not this challenge's is neither carried forward nor lost: it is kept beside the new one.
  const ignored = record.previous_record_ignored;
  let note = "";
  if (previousText !== null && ignored !== undefined) {
    const kept = writeNew(join(evidenceDir, "replaced"), (n) => `challenge-${m.network.name}-${String(n)}.json`, previousText);
    note = ` | challenge: the earlier record was not carried forward (${ignored.join("; ")}); it is kept as ${kept}`;
  }
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...result, message: `${result.message}${note}`, record, recordPath };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runChallenge();
  for (const c of result.preflight ?? []) console.log(`preflight ${c.passed ? "PASS" : "FAIL"} ${c.id}${c.passed ? "" : `: ${JSON.stringify(c.observed)}`}`);
  console.log(result.message);
  if (result.recordPath !== undefined) console.log(`challenge record: ${result.recordPath} (status ${result.record?.status ?? "?"})`);
  process.exitCode = result.exitCode;
}
