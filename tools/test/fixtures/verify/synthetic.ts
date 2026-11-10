// SYNTHETIC test data for verify.mjs. Nothing here was produced by a real test run or a real chain: the repository,
// the evidence bundle, the mainnet receipts and the RPC answers are invented so that every check has a known answer.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REQUIRED_CASES, SEPARATE_CASES } from "../../../src/evidence/required.js";

export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
export const VERIFY = join(REPO_ROOT, "verify.mjs");
export const SYNTHETIC_BUNDLE = "evidence/5e5e5e5";

const REVISION = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
const RUN_ID = "20990101T000000000Z-synthetic000";
const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function write(root: string, path: string, data: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
}

const SPEC = "# SYNTHETIC SPEC for verify.mjs tests\n";
const WASM = Buffer.from("\0asm SYNTHETIC deployment candidate");

export interface Result {
  code: number;
  out: string;
}

/** Runs verify.mjs in a child process; asynchronous so an in-process RPC stub can answer it. */
export function runVerify(args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) => {
    execFile(process.execPath, [VERIFY, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 99;
      done({ code, out: `${stdout}${stderr}` });
    });
  });
}

export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** A synthetic repository root: SPEC.md, two fixtures (one the deployment candidate), and one certified bundle. */
export function syntheticRepo(dir: string): void {
  const spec = SPEC;
  const wasm = WASM;
  const other = json({ synthetic: true });
  write(dir, "SPEC.md", spec);
  write(dir, "fixtures/deploy/candidate-synthetic.wasm", wasm);
  write(dir, "fixtures/vectors/synthetic.json", other);
  const fixtures = { "deploy/candidate-synthetic.wasm": sha256(wasm), "vectors/synthetic.json": sha256(other) };
  const manifest = json({
    schema_version: 1,
    files: {
      "deploy/candidate-synthetic.wasm": { sha256: fixtures["deploy/candidate-synthetic.wasm"], kind: "deployment-candidate", source: "SYNTHETIC" },
      "vectors/synthetic.json": { sha256: fixtures["vectors/synthetic.json"], kind: "generated-vectors", source: "SYNTHETIC" },
    },
  });
  write(dir, "fixtures/manifest.json", manifest);
  const run = { schema: "bounded-mandate/run/1", run_id: RUN_ID, revision: REVISION, dirty: false, spec_sha256: sha256(spec), fixture_manifest_sha256: sha256(manifest), started_at: "2099-01-01T00:00:00.000Z" };
  const built = { bounded_mandate: sha256("SYNTHETIC local build"), mock_mpc: sha256("SYNTHETIC mock mpc") };
  const ids = (registry: Record<string, readonly string[]>) => Object.entries(registry).flatMap(([gate, cases]) => cases.map((c) => ({ gate, c, id: `${gate}.${c}` })));
  const result = ({ gate, c, id }: { gate: string; c: string; id: string }) => ({ id, gate, case: c, files: [`${id}.json`], mode: "sandbox", status: "passed", reason: "present once, passed, matches the run" });
  write(
    dir,
    `${SYNTHETIC_BUNDLE}/acceptance.json`,
    json({
      schema: "bounded-mandate/acceptance/1",
      run_id: RUN_ID,
      revision: REVISION,
      dirty: false,
      certified: true,
      complete: true,
      hashes: { spec_sha256: run.spec_sha256, fixture_manifest_sha256: run.fixture_manifest_sha256, fixtures, wasm: built },
      cases: ids(REQUIRED_CASES).map(result),
      separate: ids(SEPARATE_CASES).map(result),
      problems: [],
      ignored: [],
    }),
  );
  write(dir, `${SYNTHETIC_BUNDLE}/run.json`, json(run));
  const candidate = { "candidate-synthetic": fixtures["deploy/candidate-synthetic.wasm"] };
  const codeHash = CANDIDATE_CODE_HASH;
  for (const { gate, c, id } of [...ids(REQUIRED_CASES), ...ids(SEPARATE_CASES)]) {
    const deploy = id === "DEPLOY.candidate";
    write(
      dir,
      `${SYNTHETIC_BUNDLE}/tests/${id}.json`,
      json({
        schema: "bounded-mandate/gate-report/2",
        gate,
        case: c,
        passed: true,
        mode: "sandbox",
        run_id: RUN_ID,
        source: { revision: REVISION, dirty: false },
        spec_sha256: run.spec_sha256,
        fixture_manifest_sha256: run.fixture_manifest_sha256,
        wasm_sha256: deploy ? { ...built, ...candidate } : built,
        command: "target/debug/deps/synthetic",
        data: deploy ? { candidate_sha256: candidate["candidate-synthetic"], deployed_code_hash: codeHash } : { synthetic: true },
      }),
    );
  }
  write(dir, `${SYNTHETIC_BUNDLE}/page/index.html`, "<!doctype html><title>SYNTHETIC</title>\n");
  write(dir, "evidence/index.json", json({ schema_version: 1, bundles: [{ path: SYNTHETIC_BUNDLE, revision: REVISION, status: "certified", run: `${SYNTHETIC_BUNDLE}/run.json` }] }));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = `${B58.charAt(Number(n % 58n))}${out}`;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** NEAR code hash of the synthetic deployment candidate: base58 of the sha256 of its bytes. */
export const CANDIDATE_CODE_HASH = base58(createHash("sha256").update(WASM).digest());

/** Copies the repository's current certified bundle and what the checkout comparison reads. */
export function copyRealRepo(dir: string, bundle: string): void {
  for (const path of ["SPEC.md", "fixtures", "evidence/index.json", bundle]) cpSync(join(REPO_ROOT, path), join(dir, path), { recursive: true });
}

// ------------------------------------------------------------------------------------------ synthetic mainnet run

export const MAINNET_GENESIS = "EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H";
const MANDATE = "mandate.synthetic.near";
const OWNER = "owner.synthetic.near";
const AGENT = "agent.synthetic.near";
const FILLER = "filler.synthetic.near";
const VERIFIER = "intents.near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR = "nep141:wrap.near";
export const GRANT_KEY = "ed25519:SyntheticGrantKey1111111111111111111111111111";
/** A key that was never a grant key of the synthetic mandate. */
export const STRANGER_KEY = "ed25519:SyntheticStrangerKey333333333333333333333333";
const CHALLENGE_KEY = "ed25519:SyntheticChallengeKey22222222222222222222222";
const ONE_NEAR = "1000000000000000000000000";
/** The run's last receipt executes here; the chain head is later. */
export const FINAL_BLOCK = 162;
const HEAD = 300;

interface TxModel {
  label: string;
  hash: string;
  signer: string;
  receiver: string;
  method: string;
  height: number;
  /** One receipt per block after inclusion, each a function call (default: the transaction's method, then a callback). */
  receipts: { executor: string; error?: string; method?: string; args?: Record<string, unknown> }[];
  detail: Record<string, unknown>;
}

const txHash = (label: string): string => base58(createHash("sha256").update(`SYNTHETIC ${label}`).digest());

/** What the synthetic run did. The chain and the evidence are both built from it, so they agree unless a test edits one. */
export interface RunOptions {
  /** The key the verifier's rejection of the withheld relay names (default: the grant key). */
  rejectedKey?: string;
  /** The revoke transaction fails on the mandate and never reaches the verifier. */
  revokeFails?: boolean;
  /** Where the revoke's key removal lands (default: the verifier). */
  removalReceiver?: string;
  /** Receiver of the revoke transaction (default: the mandate). */
  revokeReceiver?: string;
}

function txs(o: RunOptions = {}): TxModel[] {
  const panic = (text: string): string => `{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ${text}"}}}}`;
  const rejection = panic(`public key '${o.rejectedKey ?? GRANT_KEY}' doesn't exist for account '${MANDATE}'`);
  const removal = { executor: o.removalReceiver ?? VERIFIER, method: "remove_public_key", args: { public_key: GRANT_KEY } };
  const revoke = o.revokeFails === true ? [{ executor: MANDATE, error: panic("SYNTHETIC revoke failure") }] : [{ executor: MANDATE }, removal];
  // Labels as the live runner writes them: "step <n> <kind>".
  return [
    { label: "step 1 grant", hash: txHash("grant"), signer: OWNER, receiver: MANDATE, method: "grant", height: 100, receipts: [{ executor: MANDATE }, { executor: VERIFIER, method: "add_public_key", args: { public_key: GRANT_KEY } }], detail: { step: 1 } },
    { label: "step 2 propose", hash: txHash("propose"), signer: AGENT, receiver: MANDATE, method: "propose_order", height: 110, receipts: [{ executor: MANDATE }], detail: { step: 2 } },
    { label: "step 3 revoke", hash: txHash("revoke"), signer: OWNER, receiver: o.revokeReceiver ?? MANDATE, method: "revoke", height: 130, receipts: revoke, detail: { step: 3, imported: true } },
    { label: "step 4 relay_withheld", hash: txHash("relay"), signer: FILLER, receiver: VERIFIER, method: "execute_intents", height: 140, receipts: [{ executor: VERIFIER, error: rejection }], detail: { step: 4, withheld_relay: true } },
    { label: "step 5 recover", hash: txHash("recover-usdc"), signer: OWNER, receiver: MANDATE, method: "recover", height: 150, receipts: [{ executor: MANDATE }, { executor: VERIFIER }], detail: { step: 5, asset: "usdc" } },
    { label: "step 6 recover", hash: txHash("recover-wnear"), signer: OWNER, receiver: MANDATE, method: "recover", height: 160, receipts: [{ executor: MANDATE }, { executor: VERIFIER }], detail: { step: 6, asset: "wnear" } },
  ];
}

const receiptId = (t: TxModel, i: number): string => `${t.hash.slice(0, 8)}-r${String(i)}`;

/** The chain's answer for a transaction, in the shape of NEAR RPC `tx`; `full` adds the receipts of EXPERIMENTAL_tx_status. */
function rpcTx(t: TxModel, full = false): Record<string, unknown> {
  const failure = t.receipts.find((r) => r.error !== undefined);
  return {
    final_execution_status: "FINAL",
    status: failure === undefined ? { SuccessValue: "" } : { Failure: JSON.parse(failure.error ?? "{}") as unknown },
    transaction: { hash: t.hash, signer_id: t.signer, receiver_id: t.receiver, actions: [{ FunctionCall: { method_name: t.method, args: "e30=", gas: 1, deposit: "0" } }] },
    ...(full
      ? {
          receipts: t.receipts.map((r, i) => ({
            receipt_id: receiptId(t, i + 1),
            predecessor_id: i === 0 ? t.signer : t.receiver,
            receiver_id: r.executor,
            receipt: { Action: { actions: [{ FunctionCall: { method_name: r.method ?? (i === 0 ? t.method : "callback"), args: Buffer.from(JSON.stringify(r.args ?? {})).toString("base64"), gas: 1, deposit: "0" } }] } },
          })),
        }
      : {}),
    transaction_outcome: { id: receiptId(t, 0), block_hash: `block-${String(t.height)}`, outcome: { executor_id: t.signer, status: { SuccessReceiptId: receiptId(t, 1) } } },
    receipts_outcome: t.receipts.map((r, i) => ({
      id: receiptId(t, i + 1),
      block_hash: `block-${String(t.height + i + 1)}`,
      outcome: { executor_id: r.executor, status: r.error === undefined ? { SuccessValue: "" } : { Failure: JSON.parse(r.error) as unknown } },
    })),
  };
}

/** Synthetic live-mainnet.json in the runner's Evidence format (tools/src/types.ts, toEvidenceReceipt). */
export function syntheticLiveEvidence(o: RunOptions = {}): Record<string, unknown> {
  const receipts = txs(o).map((t) => {
    const failed = t.receipts.some((r) => r.error !== undefined);
    return {
      label: t.label,
      tx_hash: t.hash,
      block_height: t.height,
      outcome: failed ? "failure" : "success",
      detail: {
        signer_id: t.signer,
        receiver_id: t.receiver,
        method: t.method,
        submitted: true,
        ambiguous: false,
        final: true,
        any_receipt_failed: failed,
        fee_yocto: "1000",
        deposit_yocto: "0",
        receipts: [{ id: receiptId(t, 0), executor_id: t.signer, success: true }, ...t.receipts.map((r, i) => ({ id: receiptId(t, i + 1), executor_id: r.executor, success: r.error === undefined }))],
        ...t.detail,
      },
    };
  });
  const a = (id: string, observed: Record<string, unknown>) => ({ id, gate: "LIVE", description: `${id}: terminal verification (SYNTHETIC)`, passed: true, observed });
  return {
    schema_version: 1,
    generated_at: "2099-01-01T00:00:00.000Z",
    mode: "mainnet",
    // As the live runner records it: contract_wasm_sha256 carries the mandate's NEAR code hash from the manifest.
    source: { product_commit: REVISION, dirty: false, spec_sha256: sha256(SPEC), spec_commit: "SYNTHETIC", contract_wasm_sha256: CANDIDATE_CODE_HASH, fixtures: {} },
    environment: { chain_id: "mainnet", rpc_url: "SYNTHETIC", note: "SYNTHETIC test data, not a real mainnet run" },
    command: "SYNTHETIC",
    identifiers: { mandate: MANDATE, owner: OWNER, agent: AGENT, filler: FILLER, verifier: VERIFIER, signer: "v1.signer", oracle: "aggregate-oracle.near", mandate_code_hash: CANDIDATE_CODE_HASH },
    receipts,
    assertions: [
      a("preflight-network", {}),
      a("step-1-grant", { epoch: 1, public_key: GRANT_KEY }),
      a("step-3-revoke", { status: "revoked", key_absent: true }),
      a("step-4-relay_withheld", { classification: "rejected_revoked_key", revoked_key: o.rejectedKey ?? GRANT_KEY }),
      a("step-5-recover", { asset: "usdc", mandate_after: { usdc: "0", wnear: ONE_NEAR }, owner_after: { usdc: "5000000", wnear: "0" } }),
      a("step-6-recover", { asset: "wnear", mandate_after: { usdc: "0", wnear: "0" }, owner_after: { usdc: "5000000", wnear: ONE_NEAR } }),
    ],
    unknowns: [],
  };
}

export interface ChainOptions extends RunOptions {
  /** Code hash of the mandate account at the run's final block and now (default: the synthetic candidate's). */
  mandateCode?: string;
  /** Code hash of the mandate account now, if it changed after the run. */
  mandateCodeNow?: string;
  chainId?: string;
  /** Transaction hashes the node does not know. */
  missing?: string[];
  /** The grant key stays registered after revocation. */
  keyNeverRemoved?: boolean;
  /** The mandate still holds USDC at the run's final block. */
  usdcLeftInMandate?: boolean;
  /** Never answers (to test the timeout). */
  hang?: boolean;
}

/** State of the synthetic chain at a height. A later open challenge (block 200) adds a key and new funds. */
function view(method: string, args: Record<string, unknown>, h: number, o: ChainOptions): unknown {
  if (method === "has_public_key" && args.account_id === MANDATE) {
    if (args.public_key === GRANT_KEY) return h >= 102 && (o.keyNeverRemoved === true || h < 132);
    if (args.public_key === CHALLENGE_KEY) return h >= 200;
    return false;
  }
  if (method === "mt_balance_of") {
    const [account, token] = [args.account_id, args.token_id];
    if (account === MANDATE && token === USDC) return h >= 200 ? "1000000" : h >= 152 && o.usdcLeftInMandate !== true ? "0" : "5000000";
    if (account === MANDATE && token === WNEAR) return h >= 162 ? "0" : ONE_NEAR;
    if (account === OWNER && token === USDC) return h >= 152 ? "5000000" : "0";
    if (account === OWNER && token === WNEAR) return h >= 162 ? ONE_NEAR : "0";
    return "0";
  }
  throw new Error(`SYNTHETIC chain has no view ${method}`);
}

/** A local JSON-RPC stub of a NEAR archival node serving the synthetic chain. */
export async function startChain(o: ChainOptions = {}): Promise<{ url: string; server: Server; requests: string[] }> {
  const all = txs(o);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (o.hang === true) return;
      const { method, params } = JSON.parse(body) as { method: string; params: Record<string, unknown> };
      requests.push(method);
      const reply = (result: unknown, error?: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(error === undefined ? { jsonrpc: "2.0", id: "verify", result } : { jsonrpc: "2.0", id: "verify", error }));
      };
      if (method === "status") {
        reply({ chain_id: o.chainId ?? "mainnet", genesis_hash: MAINNET_GENESIS });
        return;
      }
      if (method === "tx" || method === "EXPERIMENTAL_tx_status") {
        const t = all.find((x) => x.hash === params.tx_hash && x.signer === params.sender_account_id);
        if (t === undefined || o.missing?.includes(String(params.tx_hash)) === true) reply(undefined, { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } });
        else reply(rpcTx(t, method === "EXPERIMENTAL_tx_status"));
        return;
      }
      if (method === "block") {
        const m = /^block-(\d+)$/.exec(String(params.block_id));
        if (m === null) reply(undefined, { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } });
        else reply({ header: { height: Number(m[1]) } });
        return;
      }
      if (method === "query" && params.request_type === "view_account" && params.account_id === MANDATE) {
        const now = params.finality === "final";
        reply({ code_hash: (now ? o.mandateCodeNow : undefined) ?? o.mandateCode ?? CANDIDATE_CODE_HASH, block_height: now ? HEAD : Number(params.block_id) });
        return;
      }
      if (method === "query" && params.request_type === "call_function") {
        const h = params.finality === "final" ? HEAD : Number(params.block_id);
        const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8")) as Record<string, unknown>;
        const value = view(String(params.method_name), args, h, o);
        reply({ result: [...Buffer.from(JSON.stringify(value))], block_height: h });
        return;
      }
      reply(undefined, { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND" } });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, server, requests };
}

export const stopChain = (server: Server): Promise<void> =>
  new Promise((done) => {
    server.closeAllConnections();
    server.close(() => {
      done();
    });
  });
