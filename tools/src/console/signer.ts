// LOCAL SANDBOX TEST SIGNER: a localhost-only Node helper that stands in for a wallet when the console is exercised
// against a local sandbox. It holds a sandbox owner key in this process (never in the browser), serves the console
// page from its own origin and signs exactly the one function call the page's intent describes. It refuses to start
// or sign for anything but its own sandbox chain (chain id and genesis pinned at start, loopback RPC only), accepts
// requests only from its own origin and Host, refuses to be framed, and signs only the owner calls the console offers,
// each bound to its receiver in the served deployment (mandate, verifier, the mandate's two token contracts) and to
// this signer's own account as beneficiary. It is not a wallet and its use proves nothing about any external wallet.
//
// It also serves the adapter of the labelled SANDBOX TEST WALLET (connector.ts), which the console loads through NEAR
// Connect exactly as it loads a real wallet's. NEAR Connect runs adapters in sandboxed frames with an opaque origin,
// so the adapter's sign requests arrive with Origin "null"; they are accepted only with this process's random token,
// which only this origin's page can read (the adapter is served same-origin only), and pass the same checks.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { JsonRpcProvider, actions, baseEncode, encodeTransaction, type KeyPair } from "near-api-js";
import { z } from "zod";
import { NearClient } from "../near/client.js";
import { MAINNET_GENESIS_HASH } from "../page/verify.js";
import { TEST_WALLET_EXECUTOR_PATH, testWalletExecutor } from "./connector.js";
import { intentSha256, signableOf, type Signable } from "./intent.js";

export const TEST_SIGNER_LABEL = "LOCAL SANDBOX TEST SIGNER (not a wallet)";

/** The only calls the console offers; anything else is refused. */
const ALLOWED_METHODS = new Set(["revoke", "recover", "ft_withdraw", "storage_deposit"]);
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MandateTokens = z.object({ usdc: z.object({ token: z.string() }).loose(), wnear: z.object({ token: z.string() }).loose() }).loose();
/** Sent with every response: the page and the signer's answers may not be framed by another origin. */
const SECURITY_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" };
const MAX_DEPOSIT = 10n ** 22n; // 0.01 NEAR: one storage registration at most
const MAX_BODY = 64 * 1024;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?\/?$/;
const REJECTED = /InvalidTx|InvalidNonce|InvalidAccessKey|NotEnoughBalance|Expired|does not exist|DoesNotExist|must be larger|InvalidSignature|NotEnoughAllowance/i;

export type Decision = "approve" | "cancel";

export interface SignerOptions {
  rpcUrl: string;
  accountId: string;
  key: KeyPair;
  /**
   * The served deployment every call is bound to: revoke/recover go only to the mandate, ft_withdraw only to the
   * verifier, storage_deposit only to the mandate's two token contracts (read from its get_config when signing).
   */
  deployment: { mandate_id: string; verifier_id: string };
  /** The console page served at GET /; receives this helper's origin. */
  page?: (origin: string) => string;
  port?: number;
  /** Stands in for the wallet's confirmation prompt; default approve. */
  decide?: (intent: Signable) => Decision | Promise<Decision>;
  /**
   * Test hook: answer with the transaction hash first and broadcast it this many ms later, as a wallet that returns
   * before broadcasting would. A rejection after the answer is then only logged.
   */
  broadcastDelayMs?: number;
}

export interface SignRequestLog {
  at: number;
  /** "console": the page's own request (local adapter); "wallet": the sandbox test wallet's adapter via NEAR Connect. */
  via: "console" | "wallet";
  intent_sha256: string | null;
  status: string;
  tx_hash: string | null;
}

const json = (res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void => {
  res.writeHead(code, { "Content-Type": "application/json", ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
};

/** CORS for the sandboxed (opaque-origin) wallet adapter frame only. */
const WALLET_CORS = { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type, x-test-wallet-token", "Access-Control-Max-Age": "0", Vary: "Origin" };

const WalletRequest = z
  .object({
    signerId: z.string().min(2),
    receiverId: z.string().min(2),
    network: z.literal("testnet"),
    actions: z
      .array(
        z
          .object({
            type: z.literal("FunctionCall"),
            params: z.object({ methodName: z.string().min(1), args: z.record(z.string(), z.unknown()), gas: z.string().regex(DECIMAL), deposit: z.string().regex(DECIMAL) }).strict(),
          })
          .strict(),
      )
      .length(1),
  })
  .loose();

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class LocalSandboxSigner {
  /** Every sign request received, in order, whatever its result. Tests count these. */
  readonly requests: SignRequestLog[] = [];
  private readonly signed = new Map<string, { tx_hash: string; public_key: string }>();
  private readonly client: NearClient;
  /** Authenticates the sandbox test wallet's adapter; one per process, readable only by this origin's page. */
  private readonly walletToken = randomBytes(32).toString("hex");

  private constructor(
    private readonly opts: SignerOptions,
    private readonly server: Server,
    readonly origin: string,
    readonly chain: { chain_id: string; genesis_hash: string },
  ) {
    this.client = new NearClient(opts.rpcUrl, new JsonRpcProvider({ url: opts.rpcUrl }), "final", "FINAL");
  }

  static async chainOf(rpcUrl: string): Promise<{ chain_id: string; genesis_hash: string }> {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "s", method: "status", params: [] }) });
    const body = (await res.json()) as { result?: { chain_id?: unknown; genesis_hash?: unknown } };
    const chain_id = body.result?.chain_id;
    const genesis_hash = body.result?.genesis_hash;
    if (typeof chain_id !== "string" || typeof genesis_hash !== "string") throw new Error("the RPC reported no chain id or genesis hash");
    return { chain_id, genesis_hash };
  }

  /** Refuses any RPC that is not loopback and any chain that looks public. */
  static async start(opts: SignerOptions): Promise<LocalSandboxSigner> {
    if (!LOOPBACK.test(opts.rpcUrl)) throw new Error(`the test signer only talks to a loopback sandbox RPC, not ${opts.rpcUrl}`);
    const chain = await LocalSandboxSigner.chainOf(opts.rpcUrl);
    if (["mainnet", "testnet", "betanet", "statelessnet"].includes(chain.chain_id) || chain.genesis_hash === MAINNET_GENESIS_HASH) {
      throw new Error(`refusing chain ${chain.chain_id}: the test signer is for a local sandbox only`);
    }
    let self: LocalSandboxSigner | null = null;
    const server = createServer((req, res) => {
      if (self === null) {
        json(res, 503, { error: "starting" });
        return;
      }
      void self.handle(req, res).catch((e: unknown) => {
        json(res, 500, { status: "error", error: e instanceof Error ? e.message : String(e) });
      });
    });
    await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    self = new LocalSandboxSigner(opts, server, `http://127.0.0.1:${String(port)}`, chain);
    return self;
  }

  get signRequests(): number {
    return this.requests.length;
  }

  info(): Record<string, string> {
    return {
      label: TEST_SIGNER_LABEL,
      account_id: this.opts.accountId,
      public_key: this.opts.key.getPublicKey().toString(),
      chain_id: this.chain.chain_id,
      genesis_hash: this.chain.genesis_hash,
    };
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    if (req.headers.host !== new URL(this.origin).host) {
      json(res, 403, { status: "refused", error: "wrong Host header" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      if (this.opts.page === undefined) {
        json(res, 404, { error: "no page" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
      res.end(this.opts.page(this.origin));
      return;
    }
    if (req.method === "GET" && url.pathname === "/signer/info") {
      json(res, 200, this.info());
      return;
    }
    if (req.method === "GET" && url.pathname === "/signer/record") {
      const found = this.signed.get(url.searchParams.get("intent_sha256") ?? "");
      json(res, found === undefined ? 404 : 200, found ?? { error: "no transaction signed for this intent" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/signer/sign") {
      json(res, 200, await this.sign(req));
      return;
    }
    if (req.method === "GET" && url.pathname === TEST_WALLET_EXECUTOR_PATH) {
      // Fetched by NEAR Connect from this origin's page; never served to another site (no cross-site script include).
      if (req.headers["sec-fetch-site"] !== "same-origin") {
        json(res, 403, { error: "the test wallet adapter is served to this origin only" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cross-Origin-Resource-Policy": "same-origin", ...SECURITY_HEADERS });
      res.end(testWalletExecutor(this.origin, this.opts.accountId, this.walletToken));
      return;
    }
    if (url.pathname === "/wallet/sign" && req.method === "OPTIONS") {
      if (req.headers.origin !== "null") {
        json(res, 403, { error: "wallet requests come only from the sandboxed adapter frame" });
        return;
      }
      res.writeHead(204, { ...SECURITY_HEADERS, ...WALLET_CORS });
      res.end();
      return;
    }
    if (url.pathname === "/wallet/sign" && req.method === "POST") {
      json(res, 200, await this.walletSign(req), WALLET_CORS);
      return;
    }
    json(res, 404, { error: "not found" });
  }

  private async sign(req: IncomingMessage): Promise<Record<string, unknown>> {
    const log: SignRequestLog = { at: Date.now(), via: "console", intent_sha256: null, status: "refused", tx_hash: null };
    this.requests.push(log);
    const refuse = (error: string) => ({ status: "refused", error });
    if (req.headers.origin !== this.origin) return refuse(`requests are accepted only from ${this.origin}`);
    if (req.headers["content-type"]?.startsWith("application/json") !== true) return refuse("content type must be application/json");
    let body: { intent?: unknown; intent_sha256?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (e) {
      return refuse(`unreadable request: ${e instanceof Error ? e.message : String(e)}`);
    }
    const intent = signableOf(body.intent);
    if ("error" in intent) return refuse(intent.error);
    const sha = intent.sha256;
    log.intent_sha256 = sha;
    if (body.intent_sha256 !== sha) return refuse("intent_sha256 does not match the intent");
    return this.signChecked(intent, log);
  }

  /** The sandbox test wallet's request: NEAR Connect's signAndSendTransaction parameters, one function call. */
  private async walletSign(req: IncomingMessage): Promise<Record<string, unknown>> {
    const log: SignRequestLog = { at: Date.now(), via: "wallet", intent_sha256: null, status: "refused", tx_hash: null };
    this.requests.push(log);
    const refuse = (error: string) => ({ status: "refused", error });
    if (req.headers.origin !== "null") return refuse("wallet requests come only from the sandboxed adapter frame");
    if (req.headers["x-test-wallet-token"] !== this.walletToken) return refuse("missing or wrong test wallet token");
    if (req.headers["content-type"]?.startsWith("application/json") !== true) return refuse("content type must be application/json");
    let parsed: z.infer<typeof WalletRequest>;
    try {
      parsed = WalletRequest.parse(JSON.parse(await readBody(req)));
    } catch (e) {
      return refuse(`unreadable wallet request: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    }
    const intent: Signable = {
      sha256: intentSha256(parsed),
      source: "console",
      network: this.chain,
      signer_id: parsed.signerId,
      public_key: null,
      receiver_id: parsed.receiverId,
      actions: parsed.actions.map((a) => ({ method: a.params.methodName, args: a.params.args, gas: a.params.gas, deposit: a.params.deposit })),
    };
    log.intent_sha256 = intent.sha256;
    return this.signChecked(intent, log);
  }

  /** Every check shared by both entry points, then the confirmation, signing and broadcast. */
  private async signChecked(intent: Signable, log: SignRequestLog): Promise<Record<string, unknown>> {
    const refuse = (error: string) => ({ status: "refused", error });
    const sha = intent.sha256;
    const chain = await LocalSandboxSigner.chainOf(this.opts.rpcUrl);
    if (chain.chain_id !== this.chain.chain_id || chain.genesis_hash !== this.chain.genesis_hash) return refuse("the sandbox RPC now reports another chain");
    if (intent.network.chain_id !== this.chain.chain_id || intent.network.genesis_hash !== this.chain.genesis_hash) return refuse(`the intent is for chain ${intent.network.chain_id}, not this sandbox`);
    if (intent.signer_id !== this.opts.accountId) return refuse(`the intent's signer ${intent.signer_id} is not this signer's account ${this.opts.accountId}`);
    const pk = this.opts.key.getPublicKey().toString();
    if (intent.public_key !== null && intent.public_key !== pk) return refuse(`the intent names key ${intent.public_key}, this signer holds ${pk}`);
    const a = intent.actions[0];
    if (intent.actions.length !== 1 || a === undefined || !ALLOWED_METHODS.has(a.method)) return refuse("the test signer signs only revoke, recover, ft_withdraw and storage_deposit");
    if (BigInt(a.deposit) > MAX_DEPOSIT) return refuse("deposit above the test signer's 0.01 NEAR bound");
    const unbound = await this.bindingProblem(intent.receiver_id, a.method, a.args);
    if (unbound !== null) return refuse(unbound);
    const decision = (await this.opts.decide?.(intent)) ?? "approve";
    if (decision === "cancel") {
      log.status = "cancelled";
      return { status: "cancelled", reason: "the signer's confirmation was declined" };
    }
    const account = this.client.account(this.opts.accountId, this.opts.key);
    let signed: Awaited<ReturnType<typeof account.createSignedTransaction>>;
    try {
      signed = await account.createSignedTransaction({ receiverId: intent.receiver_id, actions: [actions.functionCall(a.method, a.args, BigInt(a.gas), BigInt(a.deposit))] });
    } catch (e) {
      log.status = "rejected";
      return { status: "rejected", error: `not signed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
    const record = { tx_hash: txHash, public_key: signed.transaction.publicKey.toString() };
    this.signed.set(sha, record);
    log.tx_hash = txHash;
    const send = () => this.client.provider.sendTransactionUntil(signed, "NONE");
    if (this.opts.broadcastDelayMs !== undefined) {
      const delay = this.opts.broadcastDelayMs;
      setTimeout(() => {
        send().catch((e: unknown) => {
          console.error(`test signer: delayed broadcast of ${txHash} failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }, delay);
      log.status = "submitted";
      return { status: "submitted", ...record, broadcast: `after ${String(delay)} ms` };
    }
    try {
      await send();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (REJECTED.test(message)) {
        this.signed.delete(sha);
        log.status = "rejected";
        return { status: "rejected", error: message };
      }
      log.status = "submitted";
      return { status: "submitted", ...record, ambiguous: `the broadcast response was lost (${message}); poll the hash` };
    }
    log.status = "submitted";
    return { status: "submitted", ...record };
  }

  /** Why this call is not one the console offers on the served deployment for this account; null when it is. */
  private async bindingProblem(receiver: string, method: string, args: Record<string, unknown>): Promise<string | null> {
    const { mandate_id: mandate, verifier_id: verifier } = this.opts.deployment;
    const self = this.opts.accountId;
    if (method === "revoke" || method === "recover") return receiver === mandate ? null : `${method} is signed only for the mandate ${mandate}, not ${receiver}`;
    if (method === "ft_withdraw" && receiver !== verifier) return `ft_withdraw is signed only for the verifier ${verifier}, not ${receiver}`;
    if (method === "storage_deposit" && args.account_id !== self) return `storage_deposit registers only this signer's account ${self}, not ${JSON.stringify(args.account_id ?? null)}`;
    if (method === "ft_withdraw") {
      if (args.receiver_id !== self) return `ft_withdraw pays only this signer's account ${self}, not ${JSON.stringify(args.receiver_id ?? null)}`;
      if ("account_id" in args && args.account_id !== self) return `ft_withdraw names account ${JSON.stringify(args.account_id)}, not this signer's account ${self}`;
      if (typeof args.amount !== "string" || !DECIMAL.test(args.amount)) return `ft_withdraw amount ${JSON.stringify(args.amount ?? null)} is not an integer`;
    }
    const cfg = await this.client.tryView(mandate, "get_config", {}, MandateTokens);
    if (!cfg.ok) return `the mandate's token contracts could not be read: ${cfg.error}`;
    const tokens = [cfg.value.usdc.token, cfg.value.wnear.token];
    if (method === "storage_deposit") return tokens.includes(receiver) ? null : `storage_deposit is signed only for the mandate's token contracts ${tokens.join(", ")}, not ${receiver}`;
    return typeof args.token === "string" && tokens.includes(args.token) ? null : `ft_withdraw is signed only for the mandate's tokens ${tokens.join(", ")}, not ${JSON.stringify(args.token ?? null)}`;
  }
}
