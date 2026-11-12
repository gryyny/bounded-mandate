// The lab's HTTP transport. Visitors reach the page, the read-only views and the listed actions below, and nothing
// else: there is no route to the sandbox RPC (which listens on loopback only and whose address is never sent), and a
// JSON-RPC shaped request is refused whatever its path. Every JSON response states that the lab is a sandbox with
// test doubles.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { Lab, LabError } from "./lab.js";
import { renderLabPage } from "./page.js";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const SESSION_ID = "[0-9a-f]{32}";

const ActionRequest = z.object({ action: z.string().min(1).max(64), input: z.unknown().optional() }).strict();

class BodyTooLarge extends Error {}

/** Reads at most `limit` bytes; a longer body is abandoned as soon as that is known. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      reject(new BodyTooLarge());
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        reject(new BodyTooLarge());
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

const looksLikeJsonRpc = (body: unknown): boolean =>
  Array.isArray(body) ? body.some(looksLikeJsonRpc) : typeof body === "object" && body !== null && ("jsonrpc" in body || ("method" in body && "params" in body));

export interface LabServer {
  origin: string;
  port: number;
  close(): Promise<void>;
}

export async function serveLab(lab: Lab): Promise<LabServer> {
  const { config } = lab;
  const page = renderLabPage({ source: lab.source, wasm: lab.prebuilt.wasm, testDoubles: lab.testDoubles() });
  const pageHeaders = { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `${page.csp}; frame-ancestors 'none'` };

  const send = (res: ServerResponse, status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json", "Content-Security-Policy": API_CSP, ...extra });
    res.end(JSON.stringify({ ...lab.labels, ...body }));
  };

  /** The peer address, or behind a trusted proxy the address that proxy appended to X-Forwarded-For. */
  const clientOf = (req: IncomingMessage): string => {
    const peer = req.socket.remoteAddress ?? "unknown";
    if (!config.trustProxy) return peer;
    const forwarded = req.headers["x-forwarded-for"];
    const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").at(-1)?.trim();
    return last === undefined || last === "" ? peer : last.slice(0, 64);
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "";
    const path = URL.parse(req.url ?? "/", "http://lab.invalid")?.pathname ?? "";
    lab.admit(clientOf(req));
    if (!["GET", "POST", "DELETE"].includes(method)) throw new LabError(405, "method_not_allowed", `${method.slice(0, 16)} is not offered`);
    // Another site's page may read the health of the lab (from the allowed origin) and nothing else: without this a
    // page open in the same browser could start sessions on a lab running on this machine.
    const origin = req.headers.origin;
    const own = [`http://${req.headers.host ?? ""}`, `https://${req.headers.host ?? ""}`, config.publicOrigin];
    if (origin !== undefined && !own.includes(origin) && !(method === "GET" && path === "/api/health")) {
      throw new LabError(403, "cross_origin_refused", "the lab's API serves its own page only");
    }

    let body: unknown = undefined;
    if (method === "POST") {
      const text = await readBody(req, config.maxBodyBytes);
      if (text.trim() !== "") {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new LabError(400, "invalid_json", "the request body is not JSON");
        }
      }
      if (looksLikeJsonRpc(body)) throw new LabError(400, "raw_rpc_refused", "the sandbox RPC is not available through the lab; use the listed actions and views");
    }

    if (method === "GET" && path === "/") {
      res.writeHead(200, pageHeaders);
      res.end(page.html);
      return;
    }
    if (method === "GET" && path === "/api/health") {
      const cors: Record<string, string> = config.allowedOrigin !== null && origin === config.allowedOrigin ? { "Access-Control-Allow-Origin": origin } : {};
      send(res, 200, lab.health(), { Vary: "Origin", ...cors });
      return;
    }
    if (method === "GET" && path === "/api/actions") {
      send(res, 200, lab.describe());
      return;
    }
    if (method === "POST" && path === "/api/sessions") {
      send(res, 201, { session: await lab.createSession(clientOf(req)) });
      return;
    }
    const m = new RegExp(`^/api/sessions/(${SESSION_ID})(/actions|/reset|/export|/log)?$`).exec(path);
    const id = m?.[1];
    if (m === null || id === undefined) throw new LabError(404, "not_found", "no such route; GET /api/actions lists what the lab offers");
    const sub = m[2] ?? "";
    const key = `${method} ${sub}`;
    if (key === "GET ") send(res, 200, { session: await lab.sessionView(id) });
    else if (key === "GET /log") send(res, 200, { log: lab.log(id) });
    else if (key === "GET /export") send(res, 200, { scenario: lab.export(id) });
    else if (key === "POST /reset") send(res, 200, { session: await lab.reset(id) });
    else if (key === "DELETE ") {
      await lab.end(id);
      send(res, 200, { ended: true });
    } else if (key === "POST /actions") {
      const parsed = ActionRequest.safeParse(body);
      if (!parsed.success) throw new LabError(400, "invalid_request", 'expected {"action": "<listed action>", "input": {...}}');
      send(res, 200, { record: await lab.act(id, parsed.data.action, parsed.data.input ?? {}) });
    } else throw new LabError(405, "method_not_allowed", `${method} is not offered on this route`);
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof LabError) {
        const retry = typeof error.extra.retry_after_sec === "number" ? { "Retry-After": String(error.extra.retry_after_sec) } : undefined;
        send(res, error.status, { error: error.code, message: error.message, ...error.extra }, retry);
      } else if (error instanceof BodyTooLarge) {
        // The rest of an oversized body is not read.
        send(res, 413, { error: "body_too_large", message: `request bodies are limited to ${config.maxBodyBytes} bytes` }, { Connection: "close" });
      } else {
        console.error("lab: unexpected error", error);
        send(res, 500, { error: "internal", message: "unexpected error" });
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return {
    origin: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
