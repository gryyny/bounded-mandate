// Local routing and CSP check for the hosted page and console. Serves temporary sites on 127.0.0.1 only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLANNED_URLS, REPO_URL, SITE_PATHS } from "../src/evidence/journey.js";
import { assembleSite, checkCsp, checkSite, checkVideos, EVIDENCE_PAGE_LINKS, inlineBlocks, PLANNED_BASE, PLANNED_ORIGIN, references, serveSite } from "../src/release/site.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hash = (s: string): string => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

const page = (body: string, scripts: string[] = [], opts: { csp?: string | null } = {}): string => {
  const csp = opts.csp === undefined ? `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src ${scripts.map(hash).join(" ") || "'none'"}; connect-src https:; form-action 'none'; base-uri 'none'` : opts.csp;
  return [
    "<!doctype html><html><head><meta charset=utf-8>",
    csp === null ? "" : `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    "<style>body{color:#111}</style></head><body>",
    body,
    ...scripts.map((s) => `<script>${s}</script>`),
    "</body></html>",
  ].join("\n");
};

const site = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "bm-site-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const consoleJs = "document.body.dataset.ready = '1';";
const goodSite = (): Record<string, string> => ({
  "index.html": page(
    `<h1 id="top">Evidence</h1><a href="#top">top</a> <a href="console/">Console</a> <a href="console/#orders">orders</a>
     <a href="video/bounded-mandate-short.mp4">Watch</a> <a href="video/bounded-mandate-demo.mp4">walkthrough</a>
     <a href="https://github.com/gryyny/bounded-mandate">source</a> <a href="https://gryyny.github.io/bounded-mandate/console/">hosted console</a>
     <img src="data:image/png;base64,AAAA" alt="">`,
    ["console.log('page')"],
  ),
  "console/index.html": page(`<h2 id="orders">Orders</h2><a href="../">Evidence</a><img src="assets/logo.svg" alt="">`, [consoleJs]),
  "console/assets/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  "video/bounded-mandate-short.mp4": "SYNTHETIC short cut",
  "video/bounded-mandate-demo.mp4": "SYNTHETIC walkthrough",
});
/** The same site as a release without --video would assemble it: the page links to cuts that are not there. */
const withoutCuts = (): Record<string, string> => Object.fromEntries(Object.entries(goodSite()).filter(([path]) => !path.startsWith("video/")));

describe("CSP", () => {
  it("accepts a policy whose script hashes match the inline scripts exactly", () => {
    expect(checkCsp("/", page("<p>x</p>", ["a()", "b()"]))).toEqual([]);
  });

  it("rejects missing, stale, unsafe and incomplete policies", () => {
    expect(checkCsp("/", page("", ["a()"], { csp: null }))).toEqual(["/: expected exactly one Content-Security-Policy meta tag, found 0"]);
    const stale = page("", ["a()"]).replace("a()", "a(1)");
    expect(checkCsp("/", stale).join("\n")).toMatch(/inline script #0 hash .* is not in script-src[\s\S]*matches no inline script \(stale\)/);
    expect(checkCsp("/", page("", [], { csp: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'" }))).toEqual(["/: script-src allows 'unsafe-inline'"]);
    expect(checkCsp("/", page('<script src="https://cdn.example/x.js"></script>'))).toContain("/: external script https://cdn.example/x.js breaks the self-contained page");
    expect(checkCsp("/", page('<button onclick="go()">go</button>'))).toContain("/: inline event handlers are blocked by the CSP: <button onclick>");
    expect(checkCsp("/", page("", [], { csp: "default-src 'none'; style-src 'self'" })).join("\n")).toMatch(/inline style #0 is not allowed[\s\S]*no base-uri[\s\S]*no form-action/);
  });

  it("hashes only executable inline scripts", () => {
    const html = page('<script type="application/json">{"a":1}</script>', ["x()"]);
    expect(inlineBlocks(html).scripts).toEqual(["x()"]);
    expect(checkCsp("/", html)).toEqual([]);
  });

  it("accepts the certified f60f999 evidence page as committed", () => {
    const certified = resolve(import.meta.dirname, "../../evidence/f60f999/page/index.html");
    expect(existsSync(certified)).toBe(true);
    expect(checkCsp("/", readFileSync(certified, "utf8"))).toEqual([]);
  });
});

describe("references", () => {
  it("classifies every reference kind", () => {
    const html = '<a href="#a">x</a><a href="b/">b</a><a href="/c">c</a><a href="//d">d</a><a href="http://e">e</a><a href="https://f">f</a><a href="javascript:void 0">g</a><img srcset="i.png 1x, j.png 2x"><div style="background:url(k.png)"></div>';
    const kinds = references("http://x/bounded-mandate/", html, "/bounded-mandate/").map((r) => `${r.kind}:${r.url}`);
    expect(kinds).toEqual([
      "fragment:#a",
      "relative:b/",
      "root-absolute:/c",
      "protocol-relative://d",
      "insecure:http://e",
      "external:https://f",
      "javascript:javascript:void 0",
      "relative:i.png",
      "relative:j.png",
      "relative:k.png",
    ]);
  });
});

describe("site check over a local server", () => {
  it("passes a complete site with page, console, assets and fragments", async () => {
    const report = await checkSite(site(goodSite()), ["", "console/"]);
    expect(report.problems).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.pages.map((p) => p.route)).toEqual(["/bounded-mandate/", "/bounded-mandate/console/"]);
    expect(report.pages[1]?.script_hashes).toEqual([hash(consoleJs)]);
    expect(report.assets).toEqual(["/bounded-mandate/console/assets/logo.svg"]);
    expect(report.external_links).toEqual(["https://github.com/gryyny/bounded-mandate"]);
  });

  it("reports each broken route, link, asset and fragment", async () => {
    const files = goodSite();
    files["index.html"] = page('<a href="console">no slash</a> <a href="/console/">root</a> <a href="missing.html">gone</a> <a href="console/#nope">frag</a>', ["1"]);
    files["console/index.html"] = page('<img src="assets/missing.svg" alt=""><a href="../../outside/">up</a>', [consoleJs]);
    // required: null, so this case counts only the broken references it plants.
    const report = await checkSite(site(files), ["", "console/", "absent/"], PLANNED_BASE, null);
    expect(report.passed).toBe(false);
    expect(report.problems).toHaveLength(7);
    expect(report.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/<a href="\/console\/"> is root-absolute; it would escape \/bounded-mandate\//),
        "/bounded-mandate/absent/: HTTP 404",
        expect.stringMatching(/missing\.html"> is HTTP 404/),
        expect.stringMatching(/fragment #nope of \/bounded-mandate\/console\/ does not exist/),
        expect.stringMatching(/assets\/missing\.svg"> is HTTP 404/),
        expect.stringMatching(/\.\.\/\.\.\/outside\/ resolves outside \/bounded-mandate\//),
        expect.stringMatching(/<a href="console"> redirects to \/bounded-mandate\/console\/; link to the trailing-slash form/),
      ]),
    );
  });

  it("assembles the page and console into one directory for GitHub Pages", async () => {
    const src = site(goodSite());
    const out = join(src, "assembled");
    assembleSite({ page: join(src, "index.html"), console: join(src, "console"), video: join(src, "video"), out });
    expect(existsSync(join(out, ".nojekyll"))).toBe(true);
    expect(readFileSync(join(out, "index.html"), "utf8")).toBe(readFileSync(join(src, "index.html"), "utf8"));
    const report = await checkSite(out, ["", "console/"]);
    expect(report.problems).toEqual([]);
  });

  it("serves the cuts under video/ only when a video directory is given; without it the page's own video links are problems", async () => {
    const src = site(withoutCuts());
    const videos = join(src, "videos");
    mkdirSync(videos, { recursive: true });
    writeFileSync(join(videos, "bounded-mandate-short.mp4"), "SYNTHETIC short cut");
    writeFileSync(join(videos, "bounded-mandate-demo.mp4"), "SYNTHETIC walkthrough");
    const without = assembleSite({ page: join(src, "index.html"), console: join(src, "console"), out: join(src, "without") });
    expect(existsSync(join(without, "video"))).toBe(false);
    const missing = await checkSite(without, ["", "console/"]);
    expect(missing.passed).toBe(false);
    expect(missing.problems).toEqual([
      '/bounded-mandate/: <a href="video/bounded-mandate-short.mp4"> is HTTP 404; assemble the site with the certified cuts (--video <dir> --video-manifest <video.json>)',
      '/bounded-mandate/: <a href="video/bounded-mandate-demo.mp4"> is HTTP 404; assemble the site with the certified cuts (--video <dir> --video-manifest <video.json>)',
    ]);
    const out = assembleSite({ page: join(src, "index.html"), console: join(src, "console"), video: videos, out: join(src, "with") });
    expect(readFileSync(join(out, "video/bounded-mandate-short.mp4"), "utf8")).toBe("SYNTHETIC short cut");
    expect((await checkSite(out, ["", "console/"])).problems).toEqual([]);
    const { server, origin } = await serveSite(out);
    try {
      const res = await fetch(`${origin}/bounded-mandate/video/bounded-mandate-short.mp4`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp4");
      expect(await res.text()).toBe("SYNTHETIC short cut");
    } finally {
      server.close();
    }
  });

  it("requires the evidence page to link the console, both cuts and the source, and a cut to be served as video/mp4", async () => {
    expect(EVIDENCE_PAGE_LINKS).toEqual({ internal: [SITE_PATHS.console, SITE_PATHS.video, SITE_PATHS.walkthrough], external: [REPO_URL] });
    // The paths the page links are the ones the release check compares with the certified cuts (src/release/main.ts).
    expect([PLANNED_URLS.console, PLANNED_URLS.video, PLANNED_URLS.walkthrough]).toEqual(EVIDENCE_PAGE_LINKS.internal.map((p) => `${PLANNED_ORIGIN}${PLANNED_BASE}${p}`));
    const bare = goodSite();
    bare["index.html"] = page('<h1 id="top">Evidence</h1><a href="video/bounded-mandate-short.mp4">Watch</a>', ["1"]);
    expect((await checkSite(site(bare), [""])).problems).toEqual([
      "/bounded-mandate/: the evidence page has no link to console/",
      "/bounded-mandate/: the evidence page has no link to video/bounded-mandate-demo.mp4",
      "/bounded-mandate/: the evidence page has no link to https://github.com/gryyny/bounded-mandate",
    ]);
    const retyped = goodSite();
    delete retyped["video/bounded-mandate-short.mp4"];
    retyped["video/bounded-mandate-short.mp4/index.html"] = page("<p>not a video</p>");
    const report = await checkSite(site(retyped), [""]);
    expect(report.problems.join("\n")).toMatch(/video\/bounded-mandate-short\.mp4"> (redirects|is served as text\/html)/);
    expect(report.passed).toBe(false);
  });

  it("checks every planned video URL: served as video/mp4 and, with a manifest, equal to the certified bytes", async () => {
    const sha = (b: string): string => createHash("sha256").update(b, "utf8").digest("hex");
    for (const url of [PLANNED_URLS.video, PLANNED_URLS.walkthrough]) expect(url.startsWith(`${PLANNED_ORIGIN}${PLANNED_BASE}video/`)).toBe(true);
    const src = site(goodSite());
    const videos = join(src, "videos");
    mkdirSync(videos, { recursive: true });
    writeFileSync(join(videos, "short.mp4"), "SYNTHETIC short cut");
    writeFileSync(join(videos, "notes.txt"), "not a video");
    const out = assembleSite({ page: join(src, "index.html"), console: join(src, "console"), video: videos, out: join(src, "with") });

    const ok = await checkVideos(out, [{ path: "video/short.mp4", sha256: sha("SYNTHETIC short cut") }]);
    expect(ok.problems).toEqual([]);
    expect(ok.videos[0]).toMatchObject({ status: 200, content_type: "video/mp4", bytes: 19, sha256: sha("SYNTHETIC short cut") });

    const bad = await checkVideos(out, [
      { path: "video/absent.mp4", sha256: null },
      { path: "video/short.mp4", sha256: sha("the certified cut") },
      { path: "video/notes.txt", sha256: null },
    ]);
    expect(bad.problems).toEqual([
      "/bounded-mandate/video/absent.mp4: HTTP 404",
      `/bounded-mandate/video/short.mp4: sha256 ${sha("SYNTHETIC short cut")} differs from the certified ${sha("the certified cut")}`,
      "/bounded-mandate/video/notes.txt: content type text/plain; charset=utf-8, expected video/mp4",
    ]);
  });
});
