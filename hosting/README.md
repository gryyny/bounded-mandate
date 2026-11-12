# Hosting (prepared, not enabled)

Nothing here publishes. [pages.yml.disabled](pages.yml.disabled) is a GitHub Pages workflow kept outside `.github/workflows/`, so GitHub never runs it. Pages hosting needs the lead's separate approval, after the repository is public. The sandbox lab proposal below is separate and does not require making its source public.

## Sandbox lab proposal (12 November 2026; not deployed)

Recommend one **DigitalOcean Basic bundled Droplet, 2 shared vCPU, 4 GiB RAM, 80 GiB SSD**, with six sessions and two session starts at once. This is a proposed starting size, not a measured capacity guarantee for that VM. The page and videos stay on the separate static host; they consume no lab session capacity. There is no paid model call, public-network signer, wallet custody or public-network RPC in the lab.

### Local measurements

Measured with the lab at implementation `2095d00152e43a2c0fffcd6583d6cbc7ce1bfdc5`, Node 24.22.1, near-sandbox 2.13.4, macOS 26.6.2 arm64. The measurement clone reported dirty because of an untracked `.playwright-cli/` directory; its tracked lab source was unchanged. This is resource measurement, not acceptance certification. Other reviewers were active on the host, so timings include contention.

| Observation | Measured result |
| --- | --- |
| HTTP server ready, excluding module loading/process launch and dependency installation | 0.047 s |
| Three pairs of simultaneous session starts, six sessions total | Each pair completed in 11.55–12.32 s; individual starts 11.14–12.29 s |
| Six grants submitted concurrently | All six active; 1.62 s |
| Six allowed proposals submitted concurrently | All six signed; 1.91 s |
| Recycle after six worlds; end one and start its replacement while five remain | Exactly two sandbox processes: one draining generation and one current generation; replacement 11.72 s |
| Peak sum of probe, runtime and descendant sandbox RSS | 1,080.7 MiB during recycling; first run without overlapping generations 816.5 MiB |
| Peak sampled sum of process CPU | 167.5%, where one core is 100%; first run 173.5% |
| Peak apparent bytes under both sandbox home directories | 477.3 MiB |
| End all sessions, then close service | All sandbox processes stopped and their home directories removed |

The probe sampled `ps -axo pid=,ppid=,rss=,%cpu=,command=` once per second, selected only its own PID and descendants, summed RSS and CPU, and walked only those sandboxes' `--home` directories for apparent bytes. Shared pages can be counted more than once in RSS; short peaks may be missed. The measured operations used preinstalled dependencies and a cached sandbox binary. Peak RSS plus the measured chain files is about 1.52 GiB; the proposed 3 GiB container cap leaves margin for the tmpfs-backed files and runtime growth, with about 1 GiB reserved for the OS and proxy. This is a sizing inference. It has not been load-tested on a DigitalOcean VM or against a distributed flood.

Raw measurements and the local container smoke result are retained with the expanded batch's evidence under `hosting/`; the first measurement and failed container builds are preserved in local `out/hosting/` and logs. The first probe's `neard: 2.10.6` metadata was a hard-coded reporting mistake; the recycling measurement corrects it to the installed 2.13.4. No measured values or earlier result identities were replaced.

### Limits, isolation and cleanup

- **Admission:** six sessions globally, one per client address, two concurrent starts globally and one start per client, six starts/resets per client per hour, 120 requests per minute, 120 listed actions per session, 4,096-byte bodies. One action may run per session. A comparison is an action and has its own bounded run count.
- **Session expiry:** 10 minutes idle or 30 minutes total; the sweep runs at most every five seconds. Busy work is bounded by the 120-second action timeout, after which the session ends. Browser polling keeps a session active until its absolute limit; closing a tab alone does not immediately delete it. Visitors can end a session explicitly.
- **Chain isolation:** sessions have different mandate, verifier, token, oracle, signer and actor accounts and keys. They share the block producer within a generation, so CPU and chain liveness are shared availability dependencies. The lab uses no shared time-control action. Generation recycling occurs after six worlds; at most two processes exist, and an additional rollover is refused until the old generation drains. Ending a session removes its local scenario files; on-chain sandbox state remains until its generation is stopped. Shutdown kills every generation and removes its home directory.
- **Host isolation:** the lab container runs as an unprivileged user, with a read-only filesystem, no added capabilities, no privilege escalation, no host mount or Docker socket, at most 256 processes, 2 CPU and 3 GiB RAM. Its writable `/tmp` is capped at 2 GiB and also counts against memory. Runtime networking is an internal Docker network: the proxy can reach the listed HTTP API, but the lab has no external-network route. The sandbox RPC listens only on container loopback, and has no published port or proxy route.
- **Proxy boundary:** Caddy is the only public listener and overwrites `X-Forwarded-For` with its direct client's address; only that boundary enables `LAB_TRUST_PROXY=1`. An IP is an abuse limit, not user identity: NAT users share a slot, and multiple client addresses can fill all slots. The browser receives a labelled busy/unavailable response, never a simulated successful run. The evidence page's recorded fallback remains usable independently.
- **Operational bounds:** log rotation caps each service at two 5 MiB files, and no access log is enabled. Health probes do not create a sandbox. There is no durable session storage, backup, autoscaling or replica; restart intentionally loses sessions. Monitor memory, disk, container restarts and busy responses. A target-host smoke check with the approved limits precedes opening access; lower concurrency if its timing or memory is worse. TLS and public reachability cannot be certified without the separately approved domain and deployment.

### Reviewable local deployment configuration

[lab.Dockerfile](lab.Dockerfile) pins Node 24.22.1 and its image digest, installs the locked package set with the existing 14-day npm age policy, downloads and exercises near-sandbox 2.13.4 at build time, and makes fixtures readable by the runtime user. [lab.Dockerfile.dockerignore](lab.Dockerfile.dockerignore) admits only source, locked dependencies and curated fixtures into the build context, excluding Git history, credentials, generated files and local browser state. [lab.compose.yml](lab.compose.yml) contains the limits above; [lab.Caddyfile](lab.Caddyfile) is the proxy configuration. Caddy is pinned by an immutable image digest. No CI job deploys them.

Local validation used Docker Desktop's Linux arm64 engine and a separate **linux/amd64 build and runtime under local emulation**, matching the proposed VM's instruction set. Both images built successfully; both labs ran with `--network none`, no published ports, a read-only filesystem, 2 GiB tmpfs, 3 GiB memory, 2 CPU, 256 PIDs, no capabilities and no privilege escalation. Both smoke tests passed all seven checks: health, declared source identity, a session, grant, signed proposal, raw-RPC refusal and cleanup (16.70 s arm64; 17.81 s emulated amd64, after observed HTTP readiness). Compose explicitly selects linux/amd64. Its interpolation and Caddy configuration validation also pass. Two useful failures were fixed before this result: Debian bookworm's libc was too old for the sandbox binary (trixie works), and locally restrictive WASM permissions prevented the unprivileged user reading a fixture (explicit read permissions fix it). An initial amd64 smoke call raced HTTP startup and got connection refused; that failed log is retained separately, and the successful run began after the server reported ready. This validates the local Linux containers, not native target-host performance or public TLS.

From a **clean checkout of the approved revision**, these commands prepare an image locally. Set `LAB_SOURCE_REVISION` to its full Git revision; the image deliberately has no Git database, so its reported identity is labelled as deployment-declared. Keep the built image digest with the revision and build log. These commands create no service:

```sh
export LAB_SOURCE_REVISION="$(git rev-parse HEAD)"
export LAB_DOMAIN=lab.example.invalid
export LAB_ALLOWED_ORIGIN=https://gryyny.github.io
docker compose -f hosting/lab.compose.yml config --quiet
docker compose -f hosting/lab.compose.yml build lab
```

The example hostname is deliberately unresolvable. After separate approval, the operator supplies the actual lab domain, points its DNS to the approved VM, allows only TCP 80/443 and UDP 443 publicly (SSH restricted to the operator), and uses the reviewed compose file there. The source-only lab image needs no private repository token at runtime. Approving the VM does not approve making either repository public. After a successful target-host smoke check, regenerate the evidence page with `MANDATE_LAB_URL=https://<approved domain>` and `LAB_ALLOWED_ORIGIN` set to the evidence page's origin. The health endpoint alone is readable cross-origin; the lab's action API serves its own origin. Stop and remove containers and ephemeral state after judging; preserve the recorded evidence first. Destroy the VM to stop its compute bill.

### Current cost and required decision

Official prices checked **12 November 2026**: [DigitalOcean Basic pricing](https://www.digitalocean.com/pricing/droplets) lists this bundled 2 vCPU/4 GiB/80 GiB plan at **US$0.03571/hour, capped at US$24/month**, including 4,000 GiB outbound transfer. The [billing documentation](https://docs.digitalocean.com/products/droplets/details/pricing/) says bundled plans are billed per second with a 60-second/US$0.01 minimum, capped at 672 hours; powering off still bills, and excess outbound transfer is **US$0.01/GiB**. The transfer allowance accrues with time and is pooled at team level; do not assume a short-lived VM immediately receives a full month's quota.

At that listed hourly rate, continuous operation for seven days is **US$6.00**, and fourteen days **US$12.00**, before applicable tax and any transfer overage. Proposed approval ceiling: **US$15 before tax for fourteen days**, with deletion at the approved end date and a billing alert. This is a budget proposal, not a hard provider-enforced spending cap. Use an existing domain; a new domain's registration fee is excluded and would require a separate quote. No load balancer, managed database, backup, snapshot, extra volume, paid inference or paid monitoring is proposed. The static page/video hosting cost is separate. VM capacity/region availability, the owner's tax treatment and any existing account-wide transfer usage must be checked at purchase; no account or resource has been created.

Owner inputs genuinely needed for hosting: approve the selected provider/size, maximum bill and end date; name an account/operator with access to create/delete the VM; supply an approved domain/DNS route and the final evidence-page origin. Public deployment and spend remain unapproved.

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
