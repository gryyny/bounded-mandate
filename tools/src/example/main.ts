// `make example`: the integration example (SPEC.md "Integration example"). The strategy is the independent client in
// examples/strategy-client, a separate package that imports nothing from here. This harness plays everything else on a
// local sandbox: it deploys the hash-pinned prebuilt set (as `make quick` does, so no Rust), grants a mandate as the
// owner, starts the client as a child process with only an RPC URL, two account names and a key file, fills the
// client's accepted order with our filler, and revokes as the owner once the client has reported its refusal. It then
// compares each of the client's three observations with chain state it reads itself.
// SANDBOX WITH TEST DOUBLES: nothing here touches a public network, and no result is a mainnet result.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { grantDemo } from "../demo/story.js";
import { balances, fillerKey, postPrices, setupWorld, type World } from "../demo/world.js";
import { portableCommand, treeState } from "../evidence/report.js";
import { Filler } from "../filler/filler.js";
import { LocalNetwork, REPO_ROOT } from "../near/sandbox.js";
import { PROVENANCE, QUICK_WASM, loadPrebuilt, type PrebuiltSet } from "../quick/prebuilt.js";
import { Proposal, type GrantView, type OrderView } from "../types.js";

export const EXAMPLE_LABEL = "SANDBOX WITH TEST DOUBLES (PREBUILT, UNCERTIFIED)";
export const EXAMPLE_OUT = "out/example";
export const CLIENT_DIR = "examples/strategy-client";
export const CLIENT_ENTRY = `${CLIENT_DIR}/client.js`;
export const OBSERVATIONS = ["accepted", "refused", "revoked"] as const;
export type Observation = (typeof OBSERVATIONS)[number];

/** Longer than the client's own wait for revocation, so the client reports its timeout before it is stopped. */
const CLIENT_TIMEOUT_MS = 240_000;

const TxHash = z.string().min(32);
const Accepted = z.object({ observation: z.literal("accepted"), order_id: z.string().regex(/^[0-9]+$/), tx_hash: TxHash, proposal: Proposal, state: z.string() }).loose();
const Refused = z.object({ observation: z.literal("refused"), tx_hash: TxHash, proposal: Proposal, reason: z.string().min(1) }).loose();
const Revoked = z.object({ observation: z.literal("revoked"), grant_status: z.string(), epoch: z.number().int(), tx_hash: TxHash, proposal: Proposal, reason: z.string().min(1) }).loose();
/** One line of the client's output: the only channel from the client to this harness besides the chain. */
export const ClientLine = z.discriminatedUnion("observation", [Accepted, Refused, Revoked]);
export type ClientLine = z.infer<typeof ClientLine>;

export interface ExampleCheck {
  id: Observation;
  description: string;
  passed: boolean;
  /** Differences between the client's report and the chain as read here; empty when they agree. */
  problems: string[];
  client: ClientLine | null;
  chain: unknown;
}

export interface ExampleResult {
  schema: "bounded-mandate/example/1";
  label: string;
  statement: string;
  mode: "sandbox";
  command: string;
  generated_at: string;
  source: { revision: string | null; dirty: boolean };
  wasm: Record<string, { path: string; sha256: string }>;
  prebuilt_provenance_sha256: string;
  accounts: { mandate: string; agent: string; owner: string; verifier: string };
  client: { entry: string; sha256: string; near_api_js: string; inputs: string[]; exit_code: number | null; lines: unknown[]; stderr: string };
  checks: ExampleCheck[];
  /** Problems outside the three observations (client exit status, unreadable or unexpected lines). */
  problems: string[];
  passed: boolean;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const str = (b: Record<string, bigint>): Record<string, string> => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toString()]));
const sameProposal = (a: Proposal, b: Proposal): boolean => a.sell === b.sell && a.sell_amount === b.sell_amount && a.max_concession_bps === b.max_concession_bps;

export const exampleStatement = (set: PrebuiltSet): string =>
  `${EXAMPLE_LABEL}: make example ran the independent strategy client (${CLIENT_ENTRY}) against a local sandbox with the deployment candidate fixtures/${QUICK_WASM.mandate}, the pinned verifier and prebuilt test doubles for the MPC signer, the oracle and both tokens (fixtures/${PROVENANCE}, built at revision ${set.provenance.source.revision.slice(0, 12)}). No public network, funds or model credential are involved; this is not a mainnet result and is not bound to an acceptance run.`;

/** The disposable sandbox agent key as a NEAR CLI credential file, owner-only, never outside an ignored path. */
function writeAgentKey(world: World, path: string): void {
  const key = world.agent.key;
  if (key === null) throw new Error("the sandbox agent has no key");
  // Exit status 1 means git knows the path and does not ignore it; outside a git checkout there is nothing to commit to.
  if (spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", path]).status === 1) throw new Error(`refusing to write the sandbox agent key to ${path}: the path is not ignored by git`);
  rmSync(path, { force: true });
  writeFileSync(path, `${JSON.stringify({ account_id: world.agent.id, public_key: key.getPublicKey().toString(), private_key: key.toString() })}\n`, { mode: 0o600, flag: "wx" });
}

interface Fill {
  /** The order as read when the client reported it, before the filler acted. */
  order: OrderView | null;
  fill_state: string | null;
  fill_tx_hash: string | null;
  before: Record<string, string>;
  after: Record<string, string>;
  settle_success: boolean;
  final_state: OrderView["state"] | null;
}

/** Fills the order the client reported with our filler (an actual trade on the pinned verifier) and settles it. */
async function fillAccepted(world: World, orderId: string, statePath: string): Promise<Fill> {
  const { mandate } = world;
  const order = await mandate.order(orderId);
  const before = str(await balances(world, mandate.id));
  if (order?.state.state !== "signed") return { order, fill_state: null, fill_tx_hash: null, before, after: before, settle_success: false, final_state: order?.state ?? null };
  rmSync(statePath, { force: true }); // fresh sandbox chain: previous runs' order ids are unrelated
  const filler = new Filler({ client: world.client, mandate, verifier: world.verifier, account: world.filler.account, key: fillerKey(world), statePath });
  const fill = await filler.fill(orderId);
  const after = str(await balances(world, mandate.id));
  const settle = await mandate.settle(world.relayer.account, orderId);
  return { order, fill_state: fill.record.state, fill_tx_hash: fill.record.tx_hash ?? null, before, after, settle_success: settle.success, final_state: (await mandate.order(orderId))?.state ?? null };
}

const ProposeCall = z.tuple([z.object({ FunctionCall: z.object({ method_name: z.literal("propose_order"), args: z.string() }).loose() })]);
const ProposeArgs = z.object({ proposal: Proposal }).strict();

export interface ProposeTx {
  tx_hash: string;
  signer_id: string;
  public_key: string | null;
  receiver_id: string;
  /** The proposal in the signed transaction; null when it is not a single `propose_order` call. */
  proposal: Proposal | null;
  success: boolean;
  return_value: unknown;
  /** The failure of a receipt executed by the mandate contract, when there is one. */
  mandate_error: string | null;
  block_height: number | null;
}

/** A transaction the client named, as the node reports it: who signed what, and what the mandate did with it. */
async function readProposeTx(world: World, txHash: string): Promise<ProposeTx | null> {
  const outcome = await world.client.resolve("client propose_order", world.agent.id, txHash, "propose_order");
  if (outcome?.transaction === undefined) return null;
  const call = ProposeCall.safeParse(outcome.transaction.actions);
  let proposal: Proposal | null = null;
  if (call.success) {
    try {
      proposal = ProposeArgs.parse(JSON.parse(Buffer.from(call.data[0].FunctionCall.args, "base64").toString("utf8"))).proposal;
    } catch {
      proposal = null;
    }
  }
  return {
    tx_hash: outcome.transaction.hash,
    signer_id: outcome.transaction.signer_id,
    public_key: outcome.transaction.public_key,
    receiver_id: outcome.transaction.receiver_id,
    proposal,
    success: outcome.success && !outcome.any_receipt_failed,
    return_value: outcome.return_value,
    mandate_error: outcome.receipts.find((r) => r.executor_id === world.mandate.id && r.error !== undefined)?.error ?? null,
    block_height: outcome.block_height ?? null,
  };
}

/** The identities a client transaction must carry, taken from the sandbox world, never from the client's output. */
export interface Expected {
  agent: string;
  agentKey: string;
  mandate: string;
}

/** Problems with a transaction the client named: it must be the agent's own `propose_order` of the reported proposal. */
export function txProblems(expected: Expected, tx: ProposeTx | null, line: { tx_hash: string; proposal: Proposal }): string[] {
  if (tx === null) return [`transaction ${line.tx_hash} is unknown to the node`];
  const out: string[] = [];
  if (tx.signer_id !== expected.agent) out.push(`signed by ${tx.signer_id}, not the agent ${expected.agent}`);
  if (tx.public_key !== expected.agentKey) out.push("not signed with the agent's function-call key");
  if (tx.receiver_id !== expected.mandate) out.push(`sent to ${tx.receiver_id}, not the mandate ${expected.mandate}`);
  if (tx.proposal === null) out.push("not a single propose_order call with a proposal");
  else if (!sameProposal(tx.proposal, line.proposal)) out.push(`the signed proposal ${JSON.stringify(tx.proposal)} is not the reported ${JSON.stringify(line.proposal)}`);
  return out;
}

/** Problems with a refusal the client reported: the mandate itself failed the call, for the reported reason. */
export function refusalProblems(tx: ProposeTx | null, reason: string): string[] {
  if (tx === null) return [];
  if (tx.success) return ["the transaction succeeded on chain; nothing was refused"];
  if (tx.mandate_error === null) return ["no receipt executed by the mandate failed; the refusal is not the contract's"];
  return tx.mandate_error.includes(reason) ? [] : [`the reported reason "${reason}" is not in the mandate's failure: ${tx.mandate_error.slice(0, 300)}`];
}

const MISSING = ["the client did not report this observation"];

export interface ExampleOptions {
  /** Output directory relative to the repository; it holds the key file while the client runs, and result.json. */
  outRoot?: string;
  command?: string;
}

export async function runExample(opts: ExampleOptions = {}): Promise<ExampleResult> {
  const outDir = join(REPO_ROOT, opts.outRoot ?? EXAMPLE_OUT);
  const clientEntry = join(REPO_ROOT, CLIENT_ENTRY);
  const dependency = join(REPO_ROOT, CLIENT_DIR, "node_modules/near-api-js/package.json");
  if (!existsSync(dependency)) throw new Error(`${CLIENT_DIR} has no installed dependencies: run \`make example\`, or \`npm ci --no-audit --no-fund --ignore-scripts\` in ${CLIENT_DIR}`);
  const set = loadPrebuilt(REPO_ROOT);
  const statement = exampleStatement(set);
  console.log(`bounded-mandate integration example, ${EXAMPLE_LABEL}`);
  mkdirSync(outDir, { recursive: true });
  const keyPath = join(outDir, "agent-key.json");

  const net = await LocalNetwork.start();
  try {
    const world = await setupWorld(net, { wasm: set.wasm });
    const { mandate, verifier } = world;
    await grantDemo(world);
    const granted = await mandate.grant();
    if (granted === null) throw new Error("no grant");
    writeAgentKey(world, keyPath);
    // The oracle keeper's job: the client's first proposal needs fresh reference prices.
    await postPrices(world);

    const inputs = ["--rpc", world.client.rpcUrl, "--mandate", mandate.id, "--agent", world.agent.id, "--key-file", keyPath];
    // An empty environment: the client gets its four inputs and nothing else from this process.
    const child = spawn(process.execPath, [clientEntry, ...inputs], { cwd: join(REPO_ROOT, CLIENT_DIR), env: {}, stdio: ["ignore", "pipe", "pipe"] });
    const problems: string[] = [];
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-4000)));
    child.on("error", (error) => problems.push(`the client could not be started: ${error.message}`));
    const exited = new Promise<number | null>((done) => child.on("close", (code) => { done(code); }));
    const timer = setTimeout(() => {
      problems.push(`the client did not finish within ${CLIENT_TIMEOUT_MS / 1000}s and was stopped`);
      child.kill();
    }, CLIENT_TIMEOUT_MS);

    const raw: unknown[] = [];
    const lines: ClientLine[] = [];
    let fill: Fill | null = null;
    let revoke: { success: boolean; tx_hash: string | null; block_height: number | null; error: string | null } | null = null;
    let exitCode: number | null;
    try {
      for await (const text of createInterface({ input: child.stdout })) {
        console.log(`client> ${text}`);
        let parsed: ReturnType<typeof ClientLine.safeParse>;
        try {
          const json: unknown = JSON.parse(text);
          raw.push(json);
          parsed = ClientLine.safeParse(json);
        } catch {
          raw.push(text);
          problems.push(`client line ${raw.length} is not JSON`);
          continue;
        }
        if (!parsed.success) {
          problems.push(`client line ${raw.length} is not an observation: ${parsed.error.issues[0]?.path.join(".") ?? "?"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
          continue;
        }
        const line = parsed.data;
        lines.push(line);
        // The harness's two reactions, each once: the filler trades against the accepted order, and the owner revokes
        // only after the client has met its refusal under the live grant.
        if (line.observation === "accepted" && fill === null) fill = await fillAccepted(world, line.order_id, join(outDir, "filler-state.json"));
        if (line.observation === "refused" && revoke === null) {
          const outcome = await mandate.revoke(world.owner.account);
          revoke = { success: outcome.success && !outcome.any_receipt_failed, tx_hash: outcome.tx_hash ?? null, block_height: outcome.block_height ?? null, error: outcome.error ?? null };
        }
      }
      exitCode = await exited;
    } finally {
      clearTimeout(timer);
      child.kill();
      rmSync(keyPath, { force: true });
    }
    if (exitCode !== 0) problems.push(`the client exited with status ${String(exitCode)}`);
    const reported = lines.map((l) => l.observation);
    if (JSON.stringify(reported) !== JSON.stringify(OBSERVATIONS)) problems.push(`the client reported [${reported.join(", ")}], expected exactly [${OBSERVATIONS.join(", ")}] in that order`);

    // Everything below is read from the chain by this process, independently of what the client printed.
    const accepted = lines.find((l) => l.observation === "accepted") ?? null;
    const refused = lines.find((l) => l.observation === "refused") ?? null;
    const revoked = lines.find((l) => l.observation === "revoked") ?? null;
    const grant: GrantView | null = await mandate.grant();
    const orders = await mandate.allOrders();
    const orderIds = orders.map((o) => o.id);
    const keyRegistered = granted.public_key === null ? null : await verifier.hasPublicKey(mandate.id, granted.public_key);
    const onlyAccepted = (): string[] =>
      accepted !== null && JSON.stringify(orderIds) === JSON.stringify([accepted.order_id]) ? [] : [`the mandate holds orders [${orderIds.join(", ")}], expected only the accepted order`];

    const expected: Expected = { agent: world.agent.id, agentKey: world.agent.key?.getPublicKey().toString() ?? "", mandate: mandate.id };

    const checks: ExampleCheck[] = [];
    const check = (id: Observation, description: string, client: ClientLine | null, found: string[], chain: unknown): void => {
      checks.push({ id, description, passed: found.length === 0, problems: found, client, chain });
      console.log(`  ${found.length === 0 ? "ok  " : "FAIL"} [EXAMPLE] ${description}`);
      for (const p of found) console.log(`       ${p}`);
    };

    {
      const tx = accepted === null ? null : await readProposeTx(world, accepted.tx_hash);
      const found: string[] = accepted === null ? [...MISSING] : txProblems(expected, tx, accepted);
      if (accepted !== null && tx !== null && fill !== null) {
        const order = fill.order;
        if (!tx.success) found.push(`the transaction failed on chain: ${tx.mandate_error ?? "no mandate error"}`);
        if (String(tx.return_value) !== accepted.order_id) found.push(`the transaction returned order ${String(tx.return_value)}, the client reported ${accepted.order_id}`);
        if (accepted.state !== "signed") found.push(`the client reported state ${accepted.state}, not signed`);
        if (order === null) found.push(`the mandate has no order ${accepted.order_id}`);
        else {
          if (order.state.state !== "signed" || order.signature === null) found.push(`order ${order.id} was ${order.state.state} when the client reported it, not signed`);
          if (!sameProposal({ sell: order.sell, sell_amount: order.sell_amount, max_concession_bps: order.concession_bps }, accepted.proposal)) found.push("the order on chain is not the reported proposal");
          if (order.epoch !== granted.epoch) found.push(`the order belongs to grant epoch ${order.epoch}, not ${granted.epoch}`);
          // The accepted order is real authority: our filler executed exactly the signed amounts on the verifier.
          const sold = BigInt(fill.before[order.sell] ?? "0") - BigInt(fill.after[order.sell] ?? "0");
          const bought = BigInt(fill.after[order.buy] ?? "0") - BigInt(fill.before[order.buy] ?? "0");
          if (fill.fill_state !== "filled") found.push(`the filler did not fill the order (${fill.fill_state ?? "not attempted"})`);
          else if (sold.toString() !== order.sell_amount || bought.toString() !== (order.buy_amount ?? "")) found.push(`the fill moved ${sold} ${order.sell} for ${bought} ${order.buy}, not the signed ${order.sell_amount} for ${order.buy_amount ?? "?"}`);
          if (!fill.settle_success || fill.final_state?.state !== "released" || fill.final_state.reason !== "settled") found.push(`the filled order did not settle: ${JSON.stringify(fill.final_state)}`);
        }
      }
      check("accepted", "the client's allowed proposal is the agent's own propose_order, signed by the mandate and filled for exactly the signed amounts on the pinned verifier", accepted, found, { tx, fill });
    }
    {
      const tx = refused === null ? null : await readProposeTx(world, refused.tx_hash);
      const found: string[] = refused === null ? [...MISSING] : [...txProblems(expected, tx, refused), ...refusalProblems(tx, refused.reason), ...onlyAccepted()];
      // Under the live grant: otherwise the refusal would show revocation, not a limit.
      if (tx !== null && (tx.block_height === null || revoke?.block_height == null || tx.block_height >= revoke.block_height)) found.push("the refused proposal is not in a block before the owner's revoke");
      check("refused", "the client's proposal outside the limits was refused by the mandate contract, under the live grant, for the reason the client reported, and left no order", refused, found, { tx, orders: orderIds });
    }
    {
      const tx = revoked === null ? null : await readProposeTx(world, revoked.tx_hash);
      const found: string[] = revoked === null ? [...MISSING] : [...txProblems(expected, tx, revoked), ...refusalProblems(tx, revoked.reason), ...onlyAccepted()];
      if (revoke?.success !== true) found.push(`the owner's revoke did not succeed: ${revoke?.error ?? "not sent"}`);
      if (grant?.status !== "revoked") found.push(`the grant is ${grant?.status ?? "missing"} on chain, not revoked`);
      if (keyRegistered !== false) found.push("the grant key is still registered on the verifier");
      if (revoked !== null && (revoked.grant_status !== grant?.status || revoked.epoch !== grant.epoch)) found.push(`the client reported grant ${revoked.grant_status} epoch ${revoked.epoch}, the chain shows ${grant?.status ?? "none"} epoch ${String(grant?.epoch)}`);
      if (tx !== null && (tx.block_height === null || revoke?.block_height == null || tx.block_height <= revoke.block_height)) found.push("the proposal refused after revocation is not in a block after the owner's revoke");
      check("revoked", "the client saw the grant revoked as the chain shows it (grant key removed from the verifier), and its further proposal was refused by the mandate contract", revoked, found, { tx, revoke, grant_status: grant?.status ?? null, grant_epoch: grant?.epoch ?? null, grant_key_registered: keyRegistered, orders: orderIds });
    }
    for (const p of problems) console.log(`  FAIL [EXAMPLE] ${p}`);

    const result: ExampleResult = {
      schema: "bounded-mandate/example/1",
      label: EXAMPLE_LABEL,
      statement,
      mode: "sandbox",
      command: opts.command ?? portableCommand(process.argv, REPO_ROOT),
      generated_at: new Date().toISOString(),
      source: treeState(REPO_ROOT),
      wasm: Object.fromEntries(Object.entries(world.wasm).map(([role, w]) => [role, { path: w.path, sha256: w.sha256 }])),
      prebuilt_provenance_sha256: set.provenance_sha256,
      accounts: { mandate: mandate.id, agent: world.agent.id, owner: world.owner.id, verifier: verifier.id },
      client: {
        entry: CLIENT_ENTRY,
        sha256: sha256(readFileSync(clientEntry)),
        near_api_js: z.object({ version: z.string() }).loose().parse(JSON.parse(readFileSync(dependency, "utf8"))).version,
        // The key file's location is machine-local and the file is gone; the other three inputs are sandbox names.
        inputs: inputs.map((v) => (v === keyPath ? "<owner-only key file under the ignored output directory, deleted after the run>" : v)),
        exit_code: exitCode,
        lines: raw,
        stderr,
      },
      checks,
      problems,
      passed: problems.length === 0 && checks.length === OBSERVATIONS.length && checks.every((c) => c.passed),
    };
    const path = join(outDir, "result.json");
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`${result.passed ? "all three observations match the chain" : "the example did not reach its three observations"}; ${join(opts.outRoot ?? EXAMPLE_OUT, "result.json")}`);
    console.log(statement);
    return result;
  } finally {
    await net.stop();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = (await runExample({ command: "make example" })).passed ? 0 : 1;
  } catch (error) {
    console.error(`make example: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
