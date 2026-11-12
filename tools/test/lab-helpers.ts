// Shared by the lab tests: an HTTP client for one served lab that checks the sandbox labelling of every JSON
// response, and the binding of gate reports to the pinned fixtures the lab deployed.
import { basename } from "node:path";
import { expect } from "vitest";
import type { ActionRecord } from "../src/lab/actions.js";
import { LAB_LABEL, LAB_MODE, LAB_SERVICE, configFromEnv, type LabConfig } from "../src/lab/config.js";
import { Lab, type SessionView } from "../src/lab/lab.js";
import { serveLab, type LabServer } from "../src/lab/server.js";
import type { OrderView } from "../src/types.js";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  text: string;
}

export interface Served {
  lab: Lab;
  server: LabServer;
  /** `client` becomes the X-Forwarded-For address; labs in tests trust it so that one process can act as several clients. */
  api(method: string, path: string, body?: unknown, client?: string, headers?: Record<string, string>): Promise<Reply>;
  close(): Promise<void>;
}

export async function serve(overrides: Partial<LabConfig> = {}, actionTimeoutMs?: number): Promise<Served> {
  const lab = Lab.start({ config: { ...configFromEnv({ LAB_PORT: "0", LAB_TRUST_PROXY: "1" }), ...overrides }, ...(actionTimeoutMs === undefined ? {} : { actionTimeoutMs }) });
  const server = await serveLab(lab);
  const api: Served["api"] = async (method, path, body, client = "198.51.100.1", headers = {}) => {
    const res = await fetch(`${server.origin}${path}`, {
      method,
      headers: { "x-forwarded-for": client, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // Every API response, refusals included, says what it is.
    expect({ service: parsed.service, mode: parsed.mode, label: parsed.label }).toEqual({ service: LAB_SERVICE, mode: LAB_MODE, label: LAB_LABEL });
    return { status: res.status, body: parsed, headers: res.headers, text };
  };
  return {
    lab,
    server,
    api,
    close: async () => {
      await server.close();
      await lab.close();
    },
  };
}

export async function startSession(s: Served, client?: string): Promise<SessionView> {
  const r = await s.api("POST", "/api/sessions", undefined, client);
  expect(r.status, r.text).toBe(201);
  return r.body.session as SessionView;
}

export async function act(s: Served, sessionId: string, action: string, input: unknown = {}, client?: string): Promise<ActionRecord> {
  const r = await s.api("POST", `/api/sessions/${sessionId}/actions`, { action, input }, client);
  expect(r.status, r.text).toBe(200);
  return r.body.record as ActionRecord;
}

export async function view(s: Served, sessionId: string, client?: string): Promise<SessionView> {
  const r = await s.api("GET", `/api/sessions/${sessionId}`, undefined, client);
  expect(r.status, r.text).toBe(200);
  return r.body.session as SessionView;
}

/**
 * The binaries a lab report is bound to. The mandate and the verifier are fixtures whose file stems the acceptance
 * check resolves through fixtures/manifest.json; the prebuilt doubles share their stems with the target/near builds of
 * a `make test` run (other bytes), so their hashes are recorded as data instead.
 */
export function labWasm(lab: Lab): { wasm: Record<string, string>; data: Record<string, unknown> } {
  const { mandate, verifier, ft, oracle, mpc } = lab.prebuilt.wasm;
  return {
    wasm: Object.fromEntries([mandate, verifier].map((w) => [basename(w.path, ".wasm"), w.sha256])),
    data: {
      deployment_binary: mandate.path,
      verifier: verifier.path,
      prebuilt_test_doubles: Object.fromEntries([ft, oracle, mpc].map((w) => [w.path, w.sha256])),
      labels: LAB_LABEL,
    },
  };
}

/** The contract's own panic message inside a NEAR execution error. */
export const panicOf = (error: string | null): string => /Smart contract panicked: ([^"\\]+)/.exec(error ?? "")?.[1] ?? "";

export const orderOf = (record: ActionRecord): OrderView | null => (record.result as { order?: OrderView | null }).order ?? null;

/** The order a proposal produced, which must exist. */
export function proposed(record: ActionRecord): OrderView {
  const o = orderOf(record);
  if (o === null) throw new Error(`the proposal produced no order: ${JSON.stringify(record.transactions.map((t) => t.error))}`);
  return o;
}
