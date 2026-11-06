// Local routing and CSP check for the static site (evidence page and owner console) before any hosting.
// Serves the assembled directory from 127.0.0.1 under the planned project path, as a GitHub Pages project
// site would, then checks every route, crawled page, relative link, fragment, asset and the CSP of each page.
// It never requests anything except the local server.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

export const PLANNED_ORIGIN = "https://gryyny.github.io";
export const PLANNED_BASE = "/bounded-mandate/";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Copies the page and optional console into one site directory: `index.html` and `console/`. */
export function assembleSite(opts: { page: string; console?: string | undefined; out: string }): string {
  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });
  cpSync(opts.page, join(opts.out, "index.html"));
  if (opts.console !== undefined) cpSync(opts.console, join(opts.out, "console"), { recursive: true });
  // GitHub Pages runs Jekyll unless this file exists; Jekyll drops files and folders starting with _ or .
  writeFileSync(join(opts.out, ".nojekyll"), "");
  return opts.out;
}

/** Static server with GitHub Pages path semantics: `/dir/` serves `dir/index.html`, `/dir` redirects to `/dir/`. */
export function serveSite(root: string, base = PLANNED_BASE): Promise<{ server: Server; origin: string }> {
  const rootAbs = resolve(root);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (!url.pathname.startsWith(base)) {
      res.writeHead(404).end();
      return;
    }
    const rel = decodeURIComponent(url.pathname.slice(base.length));
    const file = normalize(join(rootAbs, rel));
    if (file !== rootAbs && !file.startsWith(rootAbs + sep)) {
      res.writeHead(404).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        res.writeHead(301, { location: `${url.pathname}/` }).end();
        return;
      }
      const index = join(file, "index.html");
      if (existsSync(index)) {
        res.writeHead(200, { "content-type": TYPES[".html"] }).end(readFileSync(index));
        return;
      }
      res.writeHead(404).end();
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      ok({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

export interface Reference {
  page: string;
  tag: string;
  attr: string;
  url: string;
  kind: "fragment" | "relative" | "root-absolute" | "planned-host" | "external" | "data" | "mailto" | "javascript" | "insecure" | "protocol-relative";
}

export interface PageCheck {
  route: string;
  status: number;
  content_type: string | null;
  csp: string | null;
  inline_scripts: number;
  script_hashes: string[];
  references: number;
}

export interface SiteReport {
  schema: "bounded-mandate/site-check/v1";
  base: string;
  routes: string[];
  pages: PageCheck[];
  assets: string[];
  external_links: string[];
  problems: string[];
  passed: boolean;
}

const ATTR = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const URL_ATTRS = new Set(["href", "src", "poster", "action", "data", "formaction", "srcset"]);

const attrs = (raw: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = (m[1] ?? "").toLowerCase();
    out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Strips script and style bodies and comments so tag scanning sees markup only. */
const markupOnly = (html: string): string =>
  html.replace(/<!--[\s\S]*?-->/g, "").replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2").replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2");

const JS_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);

export interface InlineBlocks {
  scripts: string[];
  styles: string[];
  externalScripts: string[];
  handlers: string[];
}

export function inlineBlocks(html: string): InlineBlocks {
  const scripts: string[] = [];
  const externalScripts: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const a = attrs(m[1] ?? "");
    if (!JS_TYPES.has((a.get("type") ?? "").toLowerCase())) continue;
    const src = a.get("src");
    if (src !== undefined) externalScripts.push(src);
    else scripts.push(m[2] ?? "");
  }
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? "");
  const handlers: string[] = [];
  for (const m of markupOnly(html).matchAll(ATTR)) for (const name of attrs(m[2] ?? "").keys()) if (/^on[a-z]+$/.test(name)) handlers.push(`<${m[1] ?? ""} ${name}>`);
  return { scripts, styles, externalScripts, handlers };
}

export const sha256Source = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

export function parseCsp(html: string): { count: number; policy: string | null; directives: Map<string, string[]> } {
  const metas = [...markupOnly(html).matchAll(ATTR)].filter((m) => (m[1] ?? "").toLowerCase() === "meta").map((m) => attrs(m[2] ?? ""));
  const csp = metas.filter((a) => (a.get("http-equiv") ?? "").toLowerCase() === "content-security-policy");
  const policy = csp[0]?.get("content") ?? null;
  const directives = new Map<string, string[]>();
  for (const part of (policy ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "") directives.set(name.toLowerCase(), values);
  }
  return { count: csp.length, policy, directives };
}

/** CSP problems for one page: every inline script hashed, every hash used, nothing loaded from elsewhere. */
export function checkCsp(route: string, html: string): string[] {
  const problems: string[] = [];
  const { count, policy, directives } = parseCsp(html);
  if (count !== 1 || policy === null) return [`${route}: expected exactly one Content-Security-Policy meta tag, found ${count}`];
  const blocks = inlineBlocks(html);
  const scriptSrc = directives.get("script-src") ?? directives.get("default-src") ?? [];
  if (!directives.has("default-src")) problems.push(`${route}: CSP has no default-src`);
  if (scriptSrc.includes("'unsafe-inline'")) problems.push(`${route}: script-src allows 'unsafe-inline'`);
  if (scriptSrc.includes("'unsafe-eval'")) problems.push(`${route}: script-src allows 'unsafe-eval'`);
  if (scriptSrc.some((s) => s === "*" || /^https?:$/.test(s))) problems.push(`${route}: script-src allows any host`);
  const hashes = scriptSrc.filter((s) => s.startsWith("'sha256-"));
  const wanted = blocks.scripts.map(sha256Source);
  for (const [i, h] of wanted.entries()) if (!hashes.includes(h)) problems.push(`${route}: inline script #${i} hash ${h} is not in script-src`);
  for (const h of hashes) if (!wanted.includes(h)) problems.push(`${route}: script-src hash ${h} matches no inline script (stale)`);
  for (const src of blocks.externalScripts) {
    if (/^(https?:)?\/\//i.test(src)) problems.push(`${route}: external script ${src} breaks the self-contained page`);
    else if (!scriptSrc.includes("'self'")) problems.push(`${route}: script ${src} needs 'self' in script-src`);
  }
  if (blocks.handlers.length > 0) problems.push(`${route}: inline event handlers are blocked by the CSP: ${blocks.handlers.join(", ")}`);
  const styleSrc = directives.get("style-src") ?? directives.get("default-src") ?? [];
  if (blocks.styles.length > 0 && !styleSrc.includes("'unsafe-inline'")) {
    const styleHashes = styleSrc.filter((s) => s.startsWith("'sha256-"));
    for (const [i, s] of blocks.styles.entries()) if (!styleHashes.includes(sha256Source(s))) problems.push(`${route}: inline style #${i} is not allowed by style-src`);
  }
  if (directives.has("frame-ancestors")) problems.push(`${route}: frame-ancestors is ignored in a meta CSP; set it as a header or remove it`);
  if (!directives.has("base-uri")) problems.push(`${route}: CSP has no base-uri`);
  if (!directives.has("form-action")) problems.push(`${route}: CSP has no form-action`);
  return problems;
}

export function references(pageUrl: string, html: string, base: string): Reference[] {
  const out: Reference[] = [];
  const add = (tag: string, attr: string, url: string): void => {
    const u = url.trim();
    if (u === "") return;
    let kind: Reference["kind"];
    if (u.startsWith("#")) kind = "fragment";
    else if (/^data:/i.test(u)) kind = "data";
    else if (/^mailto:/i.test(u)) kind = "mailto";
    else if (/^javascript:/i.test(u)) kind = "javascript";
    else if (u.startsWith("//")) kind = "protocol-relative";
    else if (/^http:\/\//i.test(u)) kind = "insecure";
    else if (u.toLowerCase().startsWith(`${PLANNED_ORIGIN}${base}`)) kind = "planned-host";
    else if (/^[a-z][a-z0-9+.-]*:/i.test(u)) kind = "external";
    else if (u.startsWith("/")) kind = "root-absolute";
    else kind = "relative";
    out.push({ page: pageUrl, tag, attr, url: u, kind });
  };
  for (const m of markupOnly(html).matchAll(ATTR)) {
    const tag = (m[1] ?? "").toLowerCase();
    for (const [name, value] of attrs(m[2] ?? "")) {
      if (!URL_ATTRS.has(name)) continue;
      if (name === "srcset") for (const part of value.split(",")) add(tag, name, part.trim().split(/\s+/)[0] ?? "");
      else add(tag, name, value);
    }
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) add("css", "url", m[1] ?? "");
  return out;
}

const ids = (html: string): Set<string> => {
  const out = new Set<string>();
  for (const m of markupOnly(html).matchAll(ATTR)) {
    const a = attrs(m[2] ?? "");
    const id = a.get("id");
    if (id !== undefined) out.add(id);
    if ((m[1] ?? "").toLowerCase() === "a" && a.has("name")) out.add(a.get("name") ?? "");
  }
  return out;
};

interface Fetched {
  status: number;
  type: string | null;
  body: string;
  location: string | null;
}

const get = async (url: string): Promise<Fetched> => {
  const r = await fetch(url, { redirect: "manual" });
  const body = r.status === 200 ? await r.text() : "";
  return { status: r.status, type: r.headers.get("content-type"), body, location: r.headers.get("location") };
};

/** Serves `root` locally and checks the given routes (relative to the base, for example `` and `console/`). */
export async function checkSite(root: string, routes: string[], base = PLANNED_BASE): Promise<SiteReport> {
  const { server, origin } = await serveSite(root, base);
  const problems: string[] = [];
  const pages: PageCheck[] = [];
  const assets = new Set<string>();
  const external = new Set<string>();
  const htmlCache = new Map<string, string>();
  try {
    const queue = routes.map((r) => new URL(r, `${origin}${base}`).href);
    const requested = new Set(queue);
    const visited = new Set<string>();
    const pending: Reference[] = [];
    while (queue.length > 0) {
      const url = queue.shift() ?? "";
      if (visited.has(url)) continue;
      visited.add(url);
      const route = url.slice(origin.length);
      let res = await get(url);
      if (res.status === 301 && res.location !== null) {
        problems.push(`${route}: redirects to ${res.location}; link to the trailing-slash form`);
        res = await get(new URL(res.location, url).href);
      }
      if (res.status !== 200) {
        // A crawled link that fails is reported once, with the page that links to it, below.
        if (requested.has(url)) problems.push(`${route}: HTTP ${res.status}`);
        continue;
      }
      if (!(res.type ?? "").startsWith("text/html")) {
        problems.push(`${route}: content type ${res.type ?? "none"}, expected text/html`);
        continue;
      }
      htmlCache.set(url.split("#")[0] ?? url, res.body);
      problems.push(...checkCsp(route, res.body));
      const { policy, directives } = parseCsp(res.body);
      const refs = references(url, res.body, base);
      pages.push({
        route,
        status: res.status,
        content_type: res.type,
        csp: policy,
        inline_scripts: inlineBlocks(res.body).scripts.length,
        script_hashes: (directives.get("script-src") ?? []).filter((s) => s.startsWith("'sha256-")),
        references: refs.length,
      });
      for (const ref of refs) {
        switch (ref.kind) {
          case "javascript":
          case "insecure":
          case "protocol-relative":
          case "root-absolute":
            problems.push(`${route}: <${ref.tag} ${ref.attr}="${ref.url}"> is ${ref.kind}${ref.kind === "root-absolute" ? `; it would escape ${base} on the project site` : ""}`);
            break;
          case "external":
            if (ref.tag === "a" || ref.tag === "css") external.add(ref.url);
            else problems.push(`${route}: <${ref.tag} ${ref.attr}> loads ${ref.url} from another origin`);
            if (ref.tag === "css") problems.push(`${route}: CSS url(${ref.url}) loads from another origin`);
            break;
          case "planned-host":
          case "relative":
          case "fragment":
            pending.push(ref);
            break;
          default:
            break;
        }
      }
      for (const ref of refs) {
        if (ref.tag !== "a" || (ref.kind !== "relative" && ref.kind !== "planned-host")) continue;
        const target = new URL(ref.kind === "planned-host" ? `${origin}${ref.url.slice(PLANNED_ORIGIN.length)}` : ref.url, url);
        target.hash = "";
        if (target.origin === origin && target.pathname.startsWith(base) && (target.pathname.endsWith("/") || target.pathname.endsWith(".html"))) queue.push(target.href);
      }
    }
    for (const ref of pending) {
      const pageUrl = ref.page;
      const target = new URL(ref.kind === "planned-host" ? `${origin}${ref.url.slice(PLANNED_ORIGIN.length)}` : ref.url, pageUrl);
      const from = pageUrl.slice(origin.length);
      if (target.origin !== origin || !target.pathname.startsWith(base)) {
        problems.push(`${from}: ${ref.url} resolves outside ${base}`);
        continue;
      }
      const frag = target.hash.slice(1);
      target.hash = "";
      let html = htmlCache.get(target.href);
      if (html === undefined) {
        let res = await get(target.href);
        if (res.status === 301 && res.location !== null) {
          problems.push(`${from}: <${ref.tag} ${ref.attr}="${ref.url}"> redirects to ${res.location}; link to the trailing-slash form`);
          res = await get(new URL(res.location, target).href);
        }
        if (res.status !== 200) {
          problems.push(`${from}: <${ref.tag} ${ref.attr}="${ref.url}"> is HTTP ${res.status}`);
          continue;
        }
        if (ref.tag !== "a" && ref.kind !== "fragment") assets.add(target.pathname);
        if ((res.type ?? "").startsWith("text/html")) html = res.body;
      } else if (ref.tag !== "a" && ref.kind !== "fragment") assets.add(target.pathname);
      if (frag !== "" && html !== undefined && !ids(html).has(decodeURIComponent(frag))) problems.push(`${from}: fragment #${frag} of ${target.pathname} does not exist`);
    }
  } finally {
    await new Promise<void>((ok) => server.close(() => { ok(); }));
  }
  return {
    schema: "bounded-mandate/site-check/v1",
    base,
    routes,
    pages,
    assets: [...assets].sort(),
    external_links: [...external].sort(),
    problems,
    passed: problems.length === 0 && pages.length >= routes.length,
  };
}
