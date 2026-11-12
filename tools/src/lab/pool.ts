// Sandbox processes behind the lab. All sessions of one generation share one sandbox process, each under its own
// parent account; a generation is retired after it has served a fixed number of session worlds (or spent the sandbox
// root's balance) and stopped as soon as its last session ends, so chain state and disk use stay bounded. At most two
// processes exist: the current one and one that is still draining. Nothing here exposes the sandbox RPC, and nothing
// uses a shared time control.
import { actions, type KeyPair } from "near-api-js";
import { NEAR } from "../near/client.js";
import { LocalNetwork, requireSuccess, type SandboxAccount } from "../near/sandbox.js";

/** Runs callers one at a time, in arrival order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class LabUnavailable extends Error {}

/** The sandbox root starts with 10,000 NEAR (near-sandbox default); the rest stays as its own gas reserve. */
const ROOT_BUDGET_NEAR = 9_500n;

export type ParentAccount = SandboxAccount & { key: KeyPair };

/** One session world's place in a sandbox process. */
export interface Lease {
  generation: number;
  neardVersion: string;
  /** Creates `<name>.<sandbox root>` with `near` NEAR and returns the chain as seen from it. */
  open(name: string, near: bigint): Promise<LocalNetwork>;
  /** Sends `near` more NEAR from the sandbox root to an account of this lease. */
  topUp(accountId: string, near: bigint): Promise<void>;
  release(): Promise<void>;
}

interface Generation {
  index: number;
  net: LocalNetwork;
  /** Root-signed transactions share one access-key nonce, so they are serialized. */
  rootLock: Mutex;
  served: number;
  live: number;
  spentNear: bigint;
}

export interface PoolStats {
  /** Sandbox processes started since the lab started. */
  started: number;
  running: number;
  current: { generation: number; served: number; live: number } | null;
  draining: number;
}

export class SandboxPool {
  private current: Generation | null = null;
  private readonly draining = new Set<Generation>();
  private readonly lock = new Mutex();
  private started = 0;
  private closed = false;

  constructor(
    private readonly recycleAfter: number,
    /** NEAR a new session world draws from the root when it is created. */
    private readonly worldNear: bigint,
    /** NEAR one session world may draw over its life (creation plus top-ups). */
    private readonly leaseBudgetNear: bigint,
    private readonly start: () => Promise<LocalNetwork> = () => LocalNetwork.start(),
  ) {}

  private full(gen: Generation): boolean {
    return gen.served >= this.recycleAfter || gen.spentNear + this.worldNear > ROOT_BUDGET_NEAR;
  }

  acquire(): Promise<Lease> {
    return this.lock.run(async () => {
      if (this.closed) throw new LabUnavailable("the lab is shutting down");
      let gen = this.current;
      if (gen !== null && this.full(gen)) {
        if (this.draining.size > 0) throw new LabUnavailable("the sandbox is being recycled; try again shortly");
        this.current = null;
        if (gen.live === 0) await gen.net.stop();
        else this.draining.add(gen);
        gen = null;
      }
      if (gen === null) {
        gen = { index: this.started + 1, net: await this.start(), rootLock: new Mutex(), served: 0, live: 0, spentNear: 0n };
        this.started += 1;
        this.current = gen;
      }
      gen.served += 1;
      gen.live += 1;
      return this.lease(gen);
    });
  }

  private lease(gen: Generation): Lease {
    let spent = 0n;
    let released = false;
    const spend = (near: bigint): void => {
      if (spent + near > this.leaseBudgetNear || gen.spentNear + near > ROOT_BUDGET_NEAR) throw new LabUnavailable("this session has used its sandbox funding; reset it to continue");
      spent += near;
      gen.spentNear += near;
    };
    return {
      generation: gen.index,
      neardVersion: gen.net.version,
      open: (name, near) =>
        gen.rootLock.run(async () => {
          spend(near);
          const parent = await gen.net.createAccount(name, { balanceNear: near });
          if (parent.key === null) throw new Error("session parent account has no key");
          return gen.net.scoped({ ...parent, key: parent.key });
        }),
      topUp: (accountId, near) =>
        gen.rootLock.run(async () => {
          spend(near);
          requireSuccess(await gen.net.client.send(`fund ${accountId}`, gen.net.root.account, accountId, [actions.transfer(near * NEAR)], "transfer"));
        }),
      release: () =>
        this.lock.run(async () => {
          if (released) return;
          released = true;
          gen.live -= 1;
          if (gen.live > 0) return;
          if (this.draining.delete(gen)) {
            await gen.net.stop();
          } else if (this.current === gen && this.full(gen)) {
            // Idle and used up: stop now, the next session starts a fresh process.
            this.current = null;
            await gen.net.stop();
          }
        }),
    };
  }

  stats(): PoolStats {
    const c = this.current;
    return {
      started: this.started,
      running: (c === null ? 0 : 1) + this.draining.size,
      current: c === null ? null : { generation: c.index, served: c.served, live: c.live },
      draining: this.draining.size,
    };
  }

  /** RPC URLs of the running sandbox processes, for the operator's own measurements; never sent to a visitor. */
  rpcUrls(): string[] {
    return [...(this.current === null ? [] : [this.current]), ...this.draining].map((g) => g.net.client.rpcUrl);
  }

  close(): Promise<void> {
    return this.lock.run(async () => {
      this.closed = true;
      const all = [...(this.current === null ? [] : [this.current]), ...this.draining];
      this.current = null;
      this.draining.clear();
      await Promise.all(all.map((g) => g.net.stop().catch(() => undefined)));
    });
  }
}
