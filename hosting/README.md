# Hosting (prepared, not enabled)

Nothing here publishes. [pages.yml.disabled](pages.yml.disabled) is a GitHub Pages workflow kept outside `.github/workflows/`, so GitHub never runs it. Hosting needs the lead's separate approval, after the repository is public.

## Planned routes (unpublished)

| URL | Served file | Notes |
| --- | --- | --- |
| `https://gryyny.github.io/bounded-mandate/` | `evidence/<rev>/page/index.html` | The certified evidence page, byte for byte. |
| `https://gryyny.github.io/bounded-mandate/console/` | `evidence/<rev>/console/index.html` | The static owner console, once its certified copy is committed under the same revision. |

These URLs follow from GitHub's project-site rule (`<owner>.github.io/<repository>/`). They do not exist until the lead enables Pages.

- Project sites live under `/bounded-mandate/`, so a root-absolute link such as `/console/` would leave the site. Pages link relatively (`console/`, `../`), and the check rejects root-absolute links.
- `/console` redirects to `/console/`. Link to the trailing-slash form.
- The site carries `.nojekyll`, so Pages serves the files without Jekyll processing.
- GitHub Pages sends its own headers; the content security policy is the `<meta>` tag in each page. The check requires exactly one per page, a hash in `script-src` for every inline script and no stale hash, no `'unsafe-inline'` scripts, no inline event handlers, no script or stylesheet from another origin, and `base-uri` and `form-action`. `frame-ancestors` has no effect in a `<meta>` policy.
- The page makes no request before the reader presses its verification button. The console makes requests only on a button press or to resume an action already pending in that browser.

## Check locally (no network)

```sh
cd tools
npx tsx src/release/main.ts site --page ../evidence/<rev>/page/index.html --console ../evidence/<rev>/console
# with the final cuts: add --video ../evidence/<rev>/video --video-manifest ../evidence/<rev>/video.json
```

It assembles `out/release/site/`, serves it from `127.0.0.1` under `/bounded-mandate/`, requests every route and every linked page, asset and fragment, checks each page's CSP, and writes `out/release/site-check.json`. External links are listed and never requested. It exits 1 on any problem.

At f01b496 the only problem was the then-pending video link; the page now shows the planned video URLs (`/video/bounded-mandate-short.mp4`, `/video/bounded-mandate-demo.mp4`) as plain text labelled unpublished. Before hosting, the release commit adds the final cuts under `evidence/<rev>/video/` and the check is run with `--video ../evidence/<rev>/video --video-manifest ../evidence/<rev>/video.json`. It then requests both planned video URLs from the local server, requires `video/mp4`, and compares each file's sha256 with the certified cut of the same name in `video.json`; a missing, retyped or different file fails the check. Without `--video` the report says `"video": null` and the video URLs are not checked.

The served page is the certified bytes, so its wording is the state when it was rendered: the planned URLs keep their "planned, unpublished" chips and the sentence "Nothing was hosted there when this page was rendered." The status register records when hosting began and the served hashes.

## Order of release steps

1. Final evidence certified and committed.
2. Release checks: the site check above, `npx tsx src/release/main.ts secrets --repo bounded-mandate=<path> --repo near-hackathon=<path>` (full history, redacted report) and `npx tsx src/release/main.ts licenses`.
3. Lead approves and makes the repository public.
4. Lead approves hosting: Settings, Pages, Source "GitHub Actions"; `git mv hosting/pages.yml.disabled .github/workflows/pages.yml` in a reviewed commit; run it once by hand with the certified revision.
5. Verify the served bytes: `curl -sS <url> | sha256sum` for each route equals the sha256 in `out/release/site-sha256.txt` of that run and the certified file. Record URLs and hashes in the status register. Keep the site up until at least 2026-11-18, ideally 2026-11-25.
6. Only then the post and the submission.
