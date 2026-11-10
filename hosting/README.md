# Hosting (prepared, not enabled)

Nothing here publishes. [pages.yml.disabled](pages.yml.disabled) is a GitHub Pages workflow kept outside `.github/workflows/`, so GitHub never runs it. Hosting needs the lead's separate approval, after the repository is public.

## Routes

| URL | Served file | Notes |
| --- | --- | --- |
| `https://gryyny.github.io/bounded-mandate/` | `evidence/<rev>/page/index.html` | The certified evidence page, byte for byte. |
| `https://gryyny.github.io/bounded-mandate/console/` | `evidence/<rev>/console/index.html` | The static owner console of the same revision. The page links to it as `console/`. |
| `https://gryyny.github.io/bounded-mandate/video/bounded-mandate-short.mp4` | `evidence/<rev>/video/bounded-mandate-short.mp4` | The short cut. The page's Watch action links to it as `video/bounded-mandate-short.mp4`. |
| `https://gryyny.github.io/bounded-mandate/video/bounded-mandate-demo.mp4` | `evidence/<rev>/video/bounded-mandate-demo.mp4` | The longer walkthrough, linked as `video/bounded-mandate-demo.mp4`. |

These URLs follow from GitHub's project-site rule (`<owner>.github.io/<repository>/`). They exist only once the lead enables Pages.

- **One set of bytes, two places.** The page is the certified file, so the same bytes are opened from a clone (`evidence/<rev>/page/index.html`) and served at the site root. The site layout differs from the repository layout, so the page's links to the console and the cuts are relative to the site root and resolve there; in a clone they do not resolve, and the page names the clone paths beside each link (`evidence/<rev>/console/index.html`, `evidence/<rev>/video/…`). The page never says whether the site is published: no "planned", "unpublished" or "nothing was hosted" wording, which would stay on the public site for as long as it is served. It also links the source repository (`https://github.com/gryyny/bounded-mandate`), the one external link besides explorer links.
- Project sites live under `/bounded-mandate/`, so a root-absolute link such as `/console/` would leave the site. Pages link relatively (`console/`, `video/…`, `../`), and the check rejects root-absolute links.
- `/console` redirects to `/console/`. Link to the trailing-slash form.
- The site carries `.nojekyll`, so Pages serves the files without Jekyll processing.
- GitHub Pages sends its own headers; the content security policy is the `<meta>` tag in each page. The check requires exactly one per page, a hash in `script-src` for every inline script and no stale hash, no `'unsafe-inline'` scripts, no inline event handlers, no script or stylesheet from another origin, and `base-uri` and `form-action`. `frame-ancestors` has no effect in a `<meta>` policy. The console's policy additionally carries one fixed nonce (static page, so fixed per build) and `img-src https:`: NEAR Connect runs a chosen wallet's adapter in a sandboxed `srcdoc` frame, which inherits the page's policy, and marks that frame's scripts with the nonce; wallet icons are https images. The adapter itself is fetched from its commit-pinned URL only when the owner chooses that wallet (`fixtures/wallets/near-connect.json`).
- The page makes no request before the reader acts: it embeds no video, image or frame (the cuts are plain links, so a cut is requested only when the reader follows one), and its one script requests nothing until the verification button is pressed. `tools/test/page-layout.test.ts` loads the page in Chromium and asserts that the document is the only request. The console makes requests only on a button press or to resume an action already pending in that browser.

## Check locally (no network)

```sh
cd tools
npx tsx src/release/main.ts site --page ../evidence/<rev>/page/index.html --console ../evidence/<rev>/console \
  --video ../evidence/<rev>/video --video-manifest ../evidence/<rev>/video.json
```

It assembles `out/release/site/`, serves it from `127.0.0.1` under `/bounded-mandate/`, requests every route and every linked page, asset, cut and fragment, checks each page's CSP, and writes `out/release/site-check.json`. External links are listed and never requested. It exits 1 on any problem.

The check also requires the evidence page itself to link the console (`console/`), both cuts and the source repository; a page without one of them is a problem. Because every link is requested, the console and the cuts must be in the assembled site:

- Without `--console`, the page's `console/` link is HTTP 404: a problem.
- Without `--video`, both video links are HTTP 404: a problem (the message names `--video` and `--video-manifest`). The report then says `"video": null`; that state is never a pass for a release.
- With `--video` and `--video-manifest`, each linked cut must be served as `video/mp4` and its sha256 must equal the certified cut of the same name in `video.json`; a missing, retyped or different file fails. `--video` without `--video-manifest` is itself a problem.

The Pages workflow requires `evidence/<rev>/console/index.html` and requires `evidence/<rev>/video/` to hold exactly the two cuts.

## Order of release steps

1. Final evidence certified at one clean revision: `make test`, `make demo`, then the two cuts from that demo and its log (`out/video/`, with `video.json`).
2. Assemble the bundle `evidence/<rev>/` with the page, the console and **the two cuts under `evidence/<rev>/video/`**, and only then write `SHA256SUMS`. The cuts are in the bundle before the sums are written, so `SHA256SUMS` covers them, `node verify.mjs` checks the same files that are served, and `video.json` and the bundle agree. Commit the bundle.
3. Release checks on the committed bundle: `node verify.mjs`, the site check above with `--console`, `--video` and `--video-manifest`, `npx tsx src/release/main.ts secrets --repo bounded-mandate=<path> --repo near-hackathon=<path>` (full history, redacted report) and `npx tsx src/release/main.ts licenses`.
4. Lead approves and makes the repository public.
5. Lead approves hosting: Settings, Pages, Source "GitHub Actions"; `git mv hosting/pages.yml.disabled .github/workflows/pages.yml` in a reviewed commit; run it once by hand with the certified revision.
6. Verify the served bytes: `curl -sS <url> | sha256sum` for each route (page, console and both cuts) equals the sha256 in `out/release/site-sha256.txt` of that run and the certified file. Record URLs and hashes in the status register, which is where the date hosting began is recorded (the page itself does not say). Keep the site up until at least 2026-11-18, ideally 2026-11-25.
7. Only then the post and the submission.
