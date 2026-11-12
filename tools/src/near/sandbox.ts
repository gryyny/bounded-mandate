// Local sandbox lifecycle via the near-sandbox npm package (downloads its pinned neard binary on first use).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_ACCOUNT_ID, DEFAULT_NEAR_SANDBOX_VERSION, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { KeyPair, actions, type Account, type Action } from "near-api-js";
import { MAX_GAS, NEAR, NearClient, type Outcome } from "./client.js";
import { sandboxKey } from "./keys.js";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export interface SandboxAccount {
  id: string;
  key: KeyPair | null;
  account: Account;
}

export type KeySpec = "full" | "none" | { receiver: string; methods: string[]; allowance: bigint };

export interface CreateOptions {
  balanceNear?: bigint;
  wasm?: Uint8Array;
  init?: { method: string; args: Record<string, unknown> };
  key?: KeySpec;
}

export class LocalNetwork {
  private constructor(
    private readonly sandbox: Sandbox,
    readonly client: NearClient,
    readonly root: SandboxAccount & { key: KeyPair },
    readonly version: string,
  ) {}

  static async start(): Promise<LocalNetwork> {
    const sandbox = await Sandbox.start({});
    const client = new NearClient(sandbox.rpcUrl);
    const key = KeyPair.fromString(DEFAULT_PRIVATE_KEY);
    const root = { id: DEFAULT_ACCOUNT_ID, key, account: client.account(DEFAULT_ACCOUNT_ID, key) };
    return new LocalNetwork(sandbox, client, root, DEFAULT_NEAR_SANDBOX_VERSION);
  }

  async stop(): Promise<void> {
    await this.sandbox.tearDown();
  }

  /**
   * The same chain with `parent` as the creating account and its own RPC client: `createAccount(name)` then makes
   * `<name>.<parent>`, signed by the parent. Independent worlds can share one sandbox process without sharing an
   * account, a signing key or a nonce. `stop()` on any view stops the shared process.
   */
  scoped(parent: SandboxAccount & { key: KeyPair }): LocalNetwork {
    const client = new NearClient(this.client.rpcUrl);
    return new LocalNetwork(this.sandbox, client, { ...parent, account: client.account(parent.id, parent.key) }, this.version);
  }

  /**
   * Creates `<name>.<root>` in one root-signed transaction: optional code, initializer and exactly one key
   * (full access, a restricted function-call key, or none so that only the contract controls the account).
   */
  async createAccount(name: string, opts: CreateOptions = {}): Promise<SandboxAccount> {
    const id = `${name}.${this.root.id}`;
    const spec = opts.key ?? "full";
    const key = spec === "none" ? null : sandboxKey(id);
    const txActions: Action[] = [actions.createAccount(), actions.transfer((opts.balanceNear ?? 20n) * NEAR)];
    if (key !== null) {
      txActions.push(
        typeof spec === "object"
          ? actions.addFunctionCallAccessKey(key.getPublicKey(), spec.receiver, spec.methods, spec.allowance)
          : actions.addFullAccessKey(key.getPublicKey()),
      );
    }
    if (opts.wasm !== undefined) txActions.push(actions.deployContract(opts.wasm));
    if (opts.init !== undefined) txActions.push(actions.functionCall(opts.init.method, opts.init.args, MAX_GAS, 0n));
    requireSuccess(await this.client.send(`create ${id}`, this.root.account, id, txActions, "create_account"));
    return { id, key, account: key === null ? this.client.account(id) : this.client.account(id, key) };
  }

  /** Advances the sandbox chain by `blocks` without waiting (sandbox-only RPC). */
  async fastForward(blocks: number): Promise<void> {
    const res = await fetch(this.client.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "ff", method: "sandbox_fast_forward", params: { delta_height: blocks } }),
    });
    const body = (await res.json());
    if (typeof body === "object" && body !== null && "error" in body) throw new Error(`fast forward failed: ${JSON.stringify(body.error)}`);
  }
}

export function requireSuccess(outcome: Outcome): Outcome {
  if (!outcome.submitted || !outcome.success || outcome.any_receipt_failed) {
    const failed = outcome.receipts.find((r) => !r.success);
    throw new Error(`${outcome.label} failed: ${outcome.error ?? failed?.error ?? "receipt failure"}`);
  }
  return outcome;
}

export interface Wasm {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export function loadWasm(relativePath: string): Wasm {
  const path = join(REPO_ROOT, relativePath);
  if (!existsSync(path)) {
    throw new Error(
      `missing WASM ${relativePath}: build the contracts first (make test / make demo run cargo near build non-reproducible-wasm for contract/ and stubs/*)`,
    );
  }
  const bytes = readFileSync(path);
  return { path: relativePath, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Path of a crate's cargo-near build output. */
export const crateWasm = (crate: string): string => {
  const name = crate.replaceAll("-", "_");
  return `target/near/${name}/${name}.wasm`;
};
