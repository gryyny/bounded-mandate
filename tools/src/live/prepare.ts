// Runner-manifest preparation after setup (R1-R3 of the approval package). It never loads a credential, signs or
// sends: it reads the post-setup state with view calls at final finality, checks it against the approved setup
// record (R1), fills the certified template with that record, the runner inputs and the post-setup key nonces
// (R2-R3), and writes the exact bytes whose sha256 the owner approves and passes as MANDATE_LIVE_CONFIRM (R4).
//
//   npx tsx src/live/prepare.ts --template src/live/manifest.live-agent.example.json --input <prepare-input.json> \
//       --out <manifest.json> [--report <r1-report.json>] [--rpc <url>]
//
// Any R1 difference writes no manifest and exits 1: nothing is fixed silently. Approved deviations from SPEC.md
// (a smaller storage record bound, grant timing other than 60 s) are listed in the report and on stdout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { NearClient, errorMessage, type AccessKeyInfo, type AccountInfo } from "../near/client.js";
import { tokenId } from "../near/contracts.js";
import { REPO_ROOT } from "../near/sandbox.js";
import { canonical } from "./ledger.js";
import { LiveManifest, isExternal, ownerKeyDeclarationProblems, sequenceProblems, type StepKind } from "./manifest.js";
import { networkProblems } from "./network.js";
import { ownerKeySnapshot } from "./preflight.js";

const Units = z.string().regex(/^(0|[1-9][0-9]*)$/, "decimal integer string");
const AccountId = z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "NEAR account id");
const PublicKey = z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/, "ed25519 public key");
const PerAsset = z.object({ usdc: Units, wnear: Units }).strict();
const Approval = z.object({ approved_by: z.string().min(1), reference: z.string().min(1) }).strict();
const AbsolutePath = z.string().startsWith("/", "absolute path (keep credentials outside both repositories)");

/** The approved setup record (A) and the runner inputs (B1-B3, C) in machine-readable form. */
export const PrepareInput = z
  .object({
    schema: z.literal("bounded-mandate/prepare-input@1"),
    setup: z
      .object({
        approval: Approval,
        accounts: z.object({ owner: AccountId, mandate: AccountId, agent: AccountId, filler: AccountId }).strict(),
        keys: z
          .object({
            owner: PublicKey,
            /** The owner's external-action key, when distinct from `owner`. */
            owner_external: PublicKey.optional(),
            agent: PublicKey,
            filler: PublicKey,
            filler_intents: PublicKey,
            /** The mandate key policy: the owner's rescue key, or [] for keyless. */
            mandate_full_access: z.array(PublicKey),
          })
          .strict(),
        agent_allowance_yocto: Units,
        /** Intents balances deposited at setup (S6-S9), in base units. */
        deposits: z.object({ mandate: PerAsset, filler: PerAsset }).strict(),
        /**
         * Only for an approved deviation from SPEC.md's storage rule: the mandate is funded for fewer order records
         * than the grant's bound (turnover cap / proposal charge). Without it, R1 requires the full bound.
         */
        storage_deviation: z.object({ records: z.number().int().positive(), approved_reference: z.string().min(1) }).strict().optional(),
      })
      .strict(),
    runner: z
      .object({
        approval: Approval,
        grant_timing: z.object({ order_ttl_sec: z.number().int().min(1).max(3600), oracle_max_age_sec: z.number().int().min(1).max(3600) }).strict(),
        credentials: z.object({ owner: AbsolutePath, agent: AbsolutePath, filler: AbsolutePath, filler_intents: AbsolutePath }).strict(),
        /** Only for a template with a model-sourced propose step (paid inference, approval C). */
        model: z.object({ id: z.string().min(1), timeout_ms: z.number().int(), max_tokens: z.number().int() }).strict().optional(),
      })
      .strict(),
  })
  .strict();
export type PrepareInput = z.infer<typeof PrepareInput>;

type Role = "owner" | "mandate" | "agent" | "filler";
const ROLES: readonly Role[] = ["owner", "mandate", "agent", "filler"];

/** What R1 reads, at final finality. */
export interface PostSetupState {
  block_before: { height: number; timestamp_ns: string };
  block_after: { height: number; timestamp_ns: string };
  chain: { chain_id: string; genesis_hash: string };
  storage_amount_per_byte: string;
  accounts: Record<Role, AccountInfo | null>;
  keys: Record<Role, AccessKeyInfo[]>;
  mandate_config: unknown;
  grant: unknown;
  /** null when list_orders could not be read. */
  orders: unknown[] | null;
  mandate_verifier_keys: string[];
  filler_intents_key_registered: boolean;
  intents_balances: Record<"mandate" | "filler", { usdc: string; wnear: string }>;
  owner_registered: { usdc: boolean; wnear: boolean };
}

/** View calls only: there is no signer, account or transaction in this interface. */
export interface ReadOnlyChain {
  nodeStatus(): Promise<{ chain_id: string; genesis_hash: string }>;
  finalBlock(): Promise<{ height: number; timestamp_ns: string }>;
  storageAmountPerByte(): Promise<string>;
  accountView(accountId: string): Promise<AccountInfo>;
  accessKeys(accountId: string): Promise<AccessKeyInfo[]>;
  view<T>(contractId: string, method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T>;
}

export function readOnlyChain(client: NearClient): ReadOnlyChain {
  const c = client.final();
  return {
    nodeStatus: () => c.nodeStatus(),
    finalBlock: async () => {
      const b = await c.provider.viewBlock({ finality: "final" });
      return { height: b.header.height, timestamp_ns: b.header.timestamp_nanosec };
    },
    storageAmountPerByte: async () =>
      z.object({ runtime_config: z.object({ storage_amount_per_byte: Units }).loose() }).loose().parse(await c.provider.experimental_protocolConfig({ finality: "final" })).runtime_config
        .storage_amount_per_byte,
    accountView: (id) => c.accountView(id),
    accessKeys: (id) => c.accessKeys(id),
    view: (contractId, method, args, schema) => c.view(contractId, method, args, schema),
  };
}

const Template = z
  .object({
    accounts: z.object({ verifier: AccountId }).loose(),
    /** Pinned initialization except owner_id and agent_id. */
    mandate_config: z.object({ usdc: z.object({ token: AccountId }).loose(), wnear: z.object({ token: AccountId }).loose() }).loose(),
    keys: z.object({ agent: z.object({ max_allowance_yocto: Units }).loose() }).loose(),
    budget: z.object({ owner_inventory_max: PerAsset, filler_spend_max: PerAsset }).loose(),
    storage: z.object({ grant_state_bytes: z.number().int().positive(), order_record_bytes: z.number().int().positive() }).loose(),
    steps: z.array(z.object({ kind: z.string() }).loose()),
  })
  .loose();
type Template = z.infer<typeof Template>;
const parseTemplate = (template: unknown): Template => Template.parse(template);

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only the RPC's "no such account" error for this account; any other failure is rethrown, never read as absence. */
export function unknownAccount(error: unknown, accountId: string): boolean {
  const message = errorMessage(error);
  return /\b(UNKNOWN_ACCOUNT|AccountDoesNotExist)\b/.test(message) || new RegExp(`account ${escapeRe(accountId)} does not exist while viewing`, "i").test(message);
}

export async function readPostSetup(chain: ReadOnlyChain, input: PrepareInput, templateJson: unknown): Promise<PostSetupState> {
  const template = parseTemplate(templateJson);
  const a = input.setup.accounts;
  const tokens = { usdc: template.mandate_config.usdc.token, wnear: template.mandate_config.wnear.token };
  const verifier = template.accounts.verifier;
  const blockBefore = await chain.finalBlock();
  const accounts = {} as Record<Role, AccountInfo | null>;
  const keys = {} as Record<Role, AccessKeyInfo[]>;
  for (const r of ROLES) {
    accounts[r] = await chain.accountView(a[r]).catch((error: unknown) => {
      if (unknownAccount(error, a[r])) return null;
      throw error;
    });
    keys[r] = accounts[r] === null ? [] : await chain.accessKeys(a[r]);
  }
  const deployed = accounts.mandate !== null;
  const balance = async (account: string, token: string) => chain.view(verifier, "mt_balance_of", { account_id: account, token_id: tokenId(token) }, Units);
  const registered = async (token: string) => (await chain.view(token, "storage_balance_of", { account_id: a.owner }, z.unknown())) !== null;
  return {
    block_before: blockBefore,
    chain: await chain.nodeStatus(),
    storage_amount_per_byte: await chain.storageAmountPerByte(),
    accounts,
    keys,
    mandate_config: deployed ? await chain.view(a.mandate, "get_config", {}, z.unknown()).catch(() => null) : null,
    grant: deployed ? await chain.view(a.mandate, "get_grant", {}, z.unknown()).catch(() => "unreadable") : null,
    orders: deployed ? await chain.view(a.mandate, "list_orders", { from_index: "0", limit: 100 }, z.array(z.unknown())).catch(() => null) : [],
    mandate_verifier_keys: await chain.view(verifier, "public_keys_of", { account_id: a.mandate }, z.array(z.string())),
    filler_intents_key_registered: await chain.view(verifier, "has_public_key", { account_id: a.filler, public_key: input.setup.keys.filler_intents }, z.boolean()),
    intents_balances: {
      mandate: { usdc: await balance(a.mandate, tokens.usdc), wnear: await balance(a.mandate, tokens.wnear) },
      filler: { usdc: await balance(a.filler, tokens.usdc), wnear: await balance(a.filler, tokens.wnear) },
    },
    owner_registered: { usdc: await registered(tokens.usdc), wnear: await registered(tokens.wnear) },
    block_after: await chain.finalBlock(),
  };
}

const modelStep = (t: Template) => t.steps.some((s) => s.kind === "propose" && z.object({ source: z.object({ from: z.literal("model") }).loose() }).loose().safeParse(s).success);
const externalSteps = (t: Template) => t.steps.some((s) => isExternal(s.kind as StepKind));
const distinctExternal = (input: PrepareInput) => input.setup.keys.owner_external !== undefined && input.setup.keys.owner_external !== input.setup.keys.owner;

/** R1: every difference between the chain and the approved setup record (and the template's runner limits). */
export function setupProblems(input: PrepareInput, templateJson: unknown, state: PostSetupState, chainPins: { chain_id: string; genesis_hash: string; mandate_code_hash: string }): string[] {
  const t = parseTemplate(templateJson);
  const s = input.setup;
  const p: string[] = [];
  if (state.chain.chain_id !== chainPins.chain_id || state.chain.genesis_hash !== chainPins.genesis_hash) p.push(`chain ${state.chain.chain_id} (genesis ${state.chain.genesis_hash}) is not the template's ${chainPins.chain_id}`);
  for (const r of ROLES) if (state.accounts[r] === null) p.push(`account ${s.accounts[r]} (${r}) does not exist`);
  const mandate = state.accounts.mandate;
  if (mandate !== null && mandate.code_hash !== chainPins.mandate_code_hash) p.push(`mandate code hash ${mandate.code_hash} is not the approved ${chainPins.mandate_code_hash}`);
  const expectedConfig = { ...t.mandate_config, owner_id: s.accounts.owner, agent_id: s.accounts.agent };
  if (canonical(state.mandate_config) !== canonical(expectedConfig)) p.push(`mandate get_config ${canonical(state.mandate_config)} differs from the approved initialization ${canonical(expectedConfig)}`);

  const fullKeys = (r: Role) => state.keys[r].filter((k) => k.permission.kind === "full").map((k) => k.public_key).sort();
  if (state.keys.mandate.length !== fullKeys("mandate").length || canonical(fullKeys("mandate")) !== canonical([...s.keys.mandate_full_access].sort())) {
    p.push(`mandate access keys ${canonical(ownerKeySnapshot(state.keys.mandate).map((k) => k.public_key))} differ from the key policy ${canonical(s.keys.mandate_full_access)}`);
  }
  const [agentKey, ...extraAgent] = state.keys.agent;
  const agentOk =
    agentKey !== undefined &&
    extraAgent.length === 0 &&
    agentKey.public_key === s.keys.agent &&
    agentKey.permission.kind === "function_call" &&
    agentKey.permission.receiver_id === s.accounts.mandate &&
    canonical(agentKey.permission.method_names) === canonical(["propose_order"]) &&
    agentKey.permission.allowance === BigInt(s.agent_allowance_yocto);
  if (!agentOk) p.push(`agent keys ${canonical(ownerKeySnapshot(state.keys.agent))} are not exactly ${s.keys.agent} (function call: ${s.accounts.mandate}, propose_order, allowance ${s.agent_allowance_yocto})`);
  if (BigInt(s.agent_allowance_yocto) > BigInt(t.keys.agent.max_allowance_yocto)) p.push(`agent allowance ${s.agent_allowance_yocto} is above the template's ${t.keys.agent.max_allowance_yocto}`);
  if (canonical(fullKeys("filler")) !== canonical([s.keys.filler]) || state.keys.filler.length !== 1) p.push(`filler keys ${canonical(ownerKeySnapshot(state.keys.filler).map((k) => k.public_key))} are not exactly the full-access key ${s.keys.filler}`);
  for (const [name, key] of [["owner", s.keys.owner], ["owner_external", s.keys.owner_external]] as const) {
    if (key !== undefined && !fullKeys("owner").includes(key)) p.push(`owner ${s.accounts.owner} has no full-access key ${key} (${name})`);
  }
  if (distinctExternal(input) && !externalSteps(t)) p.push("the setup record names a distinct external owner key, but the template has no external steps");
  if (!state.filler_intents_key_registered) p.push(`filler Intents key ${s.keys.filler_intents} is not registered on ${t.accounts.verifier}`);
  if (state.mandate_verifier_keys.length > 0) p.push(`the mandate already has verifier keys ${canonical(state.mandate_verifier_keys)}`);
  if (state.grant !== null) p.push(`the mandate has a grant: ${canonical(state.grant)}`);
  if (state.orders === null) p.push("the mandate's list_orders could not be read");
  else if (state.orders.length > 0) p.push(`the mandate has ${state.orders.length} order record(s)`);

  for (const holder of ["mandate", "filler"] as const) {
    for (const asset of ["usdc", "wnear"] as const) {
      if (state.intents_balances[holder][asset] !== s.deposits[holder][asset]) p.push(`${holder} Intents ${asset} balance ${state.intents_balances[holder][asset]} is not the approved deposit ${s.deposits[holder][asset]}`);
    }
  }
  for (const asset of ["usdc", "wnear"] as const) {
    if (BigInt(s.deposits.mandate[asset]) > BigInt(t.budget.owner_inventory_max[asset])) p.push(`mandate ${asset} deposit ${s.deposits.mandate[asset]} is above owner_inventory_max ${t.budget.owner_inventory_max[asset]}`);
    if (BigInt(s.deposits.filler[asset]) < BigInt(t.budget.filler_spend_max[asset])) p.push(`filler ${asset} deposit ${s.deposits.filler[asset]} is below filler_spend_max ${t.budget.filler_spend_max[asset]}`);
    if (!state.owner_registered[asset]) p.push(`owner ${s.accounts.owner} is not registered on the ${asset} token (S10/S12); the runner would stop at withdrawal`);
  }
  const bound = storageBound(input, t);
  p.push(...bound.problems);
  if (mandate !== null) {
    const perByte = BigInt(state.storage_amount_per_byte);
    const free = BigInt(mandate.amount) - BigInt(mandate.storage_usage) * perByte;
    const need = BigInt(bound.bytes) * perByte;
    if (free < need) {
      p.push(
        `mandate free NEAR ${free.toString()} yocto is below the funding rule for ${bound.records} records: (${t.storage.grant_state_bytes} grant + ${bound.records} x ${bound.record_bytes} + ${MARGIN_BYTES}) bytes = ${need.toString()} yocto`,
      );
    }
  }
  return p;
}

/** SPEC.md funding rule margin, as in the T4 record-bound case. */
const MARGIN_BYTES = 4096;
/** SPEC.md's grant timing: oracle maximum age 60 s, deadline no later than 60 s after authorization. */
const SPEC_TIMING_SEC = 60;
const GrantPolicyBound = z.object({ kind: z.literal("grant"), policy: z.object({ turnover_cap_bps: z.number().int().positive(), proposal_charge_bps: z.number().int().positive() }).loose() }).loose();

/**
 * The storage the mandate's free NEAR must cover before its first grant: the grant state plus the grant's order-record
 * bound (ceil(turnover_cap_bps / proposal_charge_bps), 200 for the template) plus the margin. Record bytes are the
 * template's storage.order_record_bytes (1000), not the 779 bytes measured in evidence/958d411/tests/T4.record-bound.json:
 * that sandbox run used short test token ids, while every mainnet record stores a payload message naming the 64-character
 * USDC token id, so the measurement understates mainnet records; 1000 is the runner's own per-record figure and the
 * larger of the two. A smaller record count is accepted only as an explicit, referenced storage_deviation.
 */
function storageBound(input: PrepareInput, t: Template): { records: number; required_records: number; record_bytes: number; bytes: number; problems: string[] } {
  const grant = t.steps.map((s) => GrantPolicyBound.safeParse(s)).find((r) => r.success)?.data;
  const problems: string[] = [];
  const required = grant === undefined ? 0 : Math.ceil(grant.policy.turnover_cap_bps / grant.policy.proposal_charge_bps);
  if (grant === undefined) problems.push("the template has no grant step to derive the order-record bound from");
  const proposals = t.steps.filter((s) => s.kind === "propose" || s.kind === "refused_proposal").length;
  const deviation = input.setup.storage_deviation;
  if (deviation !== undefined && deviation.records >= required) problems.push(`storage_deviation.records ${deviation.records} is not below the bound ${required}; remove the deviation`);
  if (deviation !== undefined && deviation.records < proposals) problems.push(`storage_deviation.records ${deviation.records} is below the ${proposals} proposals this run makes`);
  const records = deviation?.records ?? required;
  const recordBytes = t.storage.order_record_bytes;
  return { records, required_records: required, record_bytes: recordBytes, bytes: t.storage.grant_state_bytes + records * recordBytes + MARGIN_BYTES, problems };
}

/** Approved deviations from SPEC.md that the manifest will carry; printed and reported, never silent. */
export function specDeviations(input: PrepareInput, templateJson: unknown): string[] {
  const t = parseTemplate(templateJson);
  const d: string[] = [];
  const bound = storageBound(input, t);
  const dev = input.setup.storage_deviation;
  if (dev !== undefined) {
    d.push(`STORAGE DEVIATION (${dev.approved_reference}): the mandate is funded for ${dev.records} order records, below the grant's bound of ${bound.required_records} required by SPEC.md`);
  }
  const g = input.runner.grant_timing;
  if (g.order_ttl_sec !== SPEC_TIMING_SEC || g.oracle_max_age_sec !== SPEC_TIMING_SEC) {
    d.push(`TIMING DEVIATION: order_ttl_sec ${g.order_ttl_sec} s and oracle_max_age_sec ${g.oracle_max_age_sec} s; SPEC.md requires ${SPEC_TIMING_SEC} s (approved at B2 by ${input.runner.approval.reference})`);
  }
  return d;
}

const nonceOf = (keys: readonly AccessKeyInfo[], publicKey: string): string => {
  const k = keys.find((x) => x.public_key === publicKey);
  if (k === undefined) throw new Error(`key ${publicKey} not found on chain`);
  return k.nonce.toString();
};

/** Paths of string values still starting with REPLACE_ME (notes excluded: they only describe the placeholders). */
export function placeholders(value: unknown, path = ""): string[] {
  if (typeof value === "string") return value.startsWith("REPLACE_ME") ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => placeholders(v, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => (path === "" && k === "notes" ? [] : placeholders(v, path === "" ? k : `${path}.${k}`)));
  }
  return [];
}

/**
 * R2-R3: the filled manifest object, keeping the template's own fields (the runner applies schema defaults when it
 * parses). Throws unless it is complete and valid for the runner.
 */
export function fillManifest(templateJson: unknown, input: PrepareInput, state: PostSetupState): Record<string, unknown> {
  const t = parseTemplate(templateJson);
  const raw = templateJson as Record<string, unknown> & { accounts: object; mandate_config: object; keys: Record<string, unknown> & { agent: object }; steps: Record<string, unknown>[] };
  const s = input.setup;
  const r = input.runner;
  if (modelStep(t) !== (r.model !== undefined)) throw new Error(modelStep(t) ? "the template has a model step: runner.model (id, timeout_ms, max_tokens) is required" : "runner.model is given, but the template has no model step");
  const external = distinctExternal(input) ? s.keys.owner_external : undefined;
  const templateKeys = Object.fromEntries(Object.entries(raw.keys).filter(([k]) => k !== "owner_external"));
  const keys = {
    ...templateKeys,
    mandate_full_access: s.keys.mandate_full_access,
    agent: { ...raw.keys.agent, public_key: s.keys.agent },
    owner: { public_key: s.keys.owner },
    ...(external === undefined ? {} : { owner_external: { public_key: external } }),
    filler: { public_key: s.keys.filler, intents_public_key: s.keys.filler_intents },
  };
  const steps = raw.steps.map((step) => {
    if (step.kind === "grant") return { ...step, policy: { ...(step.policy as object), order_ttl_sec: r.grant_timing.order_ttl_sec, oracle_max_age_sec: r.grant_timing.oracle_max_age_sec } };
    const source = step.source as { from?: unknown } | undefined;
    if (step.kind === "propose" && source?.from === "model" && r.model !== undefined) return { ...step, source: { ...source, model: r.model.id, timeout_ms: r.model.timeout_ms, max_tokens: r.model.max_tokens } };
    return step;
  });
  const filled: Record<string, unknown> = {
    ...raw,
    approval: r.approval,
    accounts: { ...raw.accounts, mandate: s.accounts.mandate, owner: s.accounts.owner, agent: s.accounts.agent, filler: s.accounts.filler },
    mandate_config: { ...raw.mandate_config, owner_id: s.accounts.owner, agent_id: s.accounts.agent },
    keys,
    credentials: r.credentials,
    expected_nonces: {
      owner: nonceOf(state.keys.owner, s.keys.owner),
      agent: nonceOf(state.keys.agent, s.keys.agent),
      filler: nonceOf(state.keys.filler, s.keys.filler),
      ...(external === undefined ? {} : { owner_external: nonceOf(state.keys.owner, external) }),
    },
    expected_owner_keys: ownerKeySnapshot(state.keys.owner),
    steps,
  };
  const left = placeholders(filled);
  if (left.length > 0) throw new Error(`unfilled template values: ${left.join(", ")}`);
  const parsed = LiveManifest.safeParse(filled);
  if (!parsed.success) throw new Error(`filled manifest is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const problems = [...sequenceProblems(parsed.data.steps), ...ownerKeyDeclarationProblems(parsed.data), ...networkProblems(parsed.data)];
  if (problems.length > 0) throw new Error(`filled manifest refused: ${problems.join("; ")}`);
  return filled;
}

/** The exact bytes to write and their sha256: the runner hashes the manifest file's raw bytes. */
export function manifestBytes(manifest: unknown): { text: string; sha256: string } {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

const jsonSafe = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The product revision and dirty state this helper runs from; null when git is unavailable. */
export function productRevision(root = REPO_ROOT): { revision: string; dirty: boolean } | null {
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { revision: run(["rev-parse", "HEAD"]), dirty: run(["status", "--porcelain"]) !== "" };
  } catch {
    return null;
  }
}

export interface PrepareArgs {
  template: string;
  input: string;
  out: string;
  report?: string | undefined;
  rpc?: string | undefined;
}

export interface PrepareDeps {
  chainFor(rpcUrl: string): ReadOnlyChain;
  revision(): { revision: string; dirty: boolean } | null;
  argv: readonly string[];
}

export interface PrepareResult {
  exitCode: 0 | 1;
  /** Everything the report binds; also printed. */
  summary: Record<string, unknown>;
}

/** The whole CLI path: R1, then (only without a problem) R2-R3 and the written manifest. Never signs or sends. */
export async function prepare(args: PrepareArgs, deps: PrepareDeps): Promise<PrepareResult> {
  const templateBytes = readFileSync(args.template);
  const inputBytes = readFileSync(args.input);
  const templateJson: unknown = JSON.parse(templateBytes.toString("utf8"));
  const input = PrepareInput.parse(JSON.parse(inputBytes.toString("utf8")));
  const pins = z
    .object({ network: z.object({ chain_id: z.string(), genesis_hash: z.string(), rpc_url: z.url() }).loose(), code_hashes: z.object({ mandate: z.string() }).loose() })
    .loose()
    .parse(templateJson);
  const rpcUrl = args.rpc ?? pins.network.rpc_url;
  const state = await readPostSetup(deps.chainFor(rpcUrl), input, templateJson);
  const problems = setupProblems(input, templateJson, state, { chain_id: pins.network.chain_id, genesis_hash: pins.network.genesis_hash, mandate_code_hash: pins.code_hashes.mandate });
  const deviations = specDeviations(input, templateJson);
  const binding = {
    command: deps.argv.join(" "),
    product: deps.revision(),
    template: { path: resolve(args.template), sha256: sha256Hex(templateBytes) },
    input: { path: resolve(args.input), sha256: sha256Hex(inputBytes) },
    rpc_url: rpcUrl,
    chain_read: state.chain,
    blocks: { before: state.block_before, after: state.block_after },
  };
  let manifest: { path: string; sha256: string } | null = null;
  if (problems.length === 0) {
    const { text, sha256 } = manifestBytes(fillManifest(templateJson, input, state));
    const out = resolve(args.out);
    writeFileSync(out, text, { flag: "wx", mode: 0o600 });
    manifest = { path: out, sha256 };
  }
  const summary = {
    schema: "bounded-mandate/r1-report@1",
    ...binding,
    r1_passed: problems.length === 0,
    problems,
    deviations,
    manifest,
    ...(manifest === null ? {} : { confirm: `MANDATE_LIVE_CONFIRM=${manifest.sha256}` }),
  };
  if (args.report !== undefined) writeFileSync(resolve(args.report), `${JSON.stringify(jsonSafe({ ...summary, state }), null, 2)}\n`, { flag: "wx" });
  return { exitCode: problems.length === 0 ? 0 : 1, summary };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { template: { type: "string" }, input: { type: "string" }, out: { type: "string" }, report: { type: "string" }, rpc: { type: "string" } } });
  const args: PrepareArgs = { template: z.string().min(1).parse(values.template), input: z.string().min(1).parse(values.input), out: z.string().min(1).parse(values.out), report: values.report, rpc: values.rpc };
  const result = await prepare(args, { chainFor: (url) => readOnlyChain(new NearClient(url)), revision: () => productRevision(), argv: process.argv });
  const deviations = z.array(z.string()).parse(result.summary.deviations);
  for (const d of deviations) console.error(`*** ${d} ***`);
  if (result.exitCode !== 0) console.error(`R1 failed; no manifest written:\n- ${z.array(z.string()).parse(result.summary.problems).join("\n- ")}`);
  console.log(JSON.stringify(result.summary, null, 2));
  process.exitCode = result.exitCode;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
