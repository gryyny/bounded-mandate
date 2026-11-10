# Bounded Mandate: keyless AI trading on NEAR Intents

Give an AI agent trading power. Keep the power to stop it.

An AI agent trades your treasury on NEAR Intents without holding a signing key. A contract signs each order inside your limits; one owner call voids every signed order that has not executed, and recovery returns the funds without the agent.

**The problem.** Pausing a trading agent stops new orders, but orders it already signed stay valid until they expire or are cancelled, and how they can be cancelled depends on the venue: on the NEAR Intents verifier, each cancellation names one order's nonce and is signed by the same key. Here the owner's `revoke` removes the grant's signing key from the verifier. Once that removal is confirmed, every outstanding order of the grant fails, including one someone held back; orders that executed before it are not reversed.

**What NEAR provides.**
- **Chain Signatures.** The mandate contract owns its account on `intents.near` and gets every order signature from `v1.signer` on its own path `mandate/v1/<epoch>`, after checking the limits. No single person or server holds that key; the MPC network's nodes hold only key shares.
- **The verifier's key registry.** `intents.near` keeps each account's signing keys (`add_public_key`, `remove_public_key`) and checks the key when it executes a signed intent. Revocation is a key removal anyone can check with a view call.
- **Function-call keys.** The agent's only NEAR key can call `propose_order` on the mandate and nothing else; the protocol refuses other calls, deposits and transfers before the contract runs.

| Evidence | State |
| --- | --- |
| Sandbox execution | **Certified at 51d2532**: all 35 required cases in one clean run, in a fresh clone and in CI ([acceptance](evidence/51d2532/acceptance.json)). Our contract and the exact mainnet verifier WASM execute; the MPC signer, oracle and tokens are labelled test doubles ([stubs/](stubs/)). |
| Model output | A genuine recorded `claude-haiku-5-5` interaction, replayed into the contract ([MODEL](evidence/51d2532/tests/MODEL.recorded-proposal.json)). No gate or demo calls a model or needs a model key. |
| Verifier code | The pinned verifier WASM hashes to the code deployed at `intents.near` ([fixtures/manifest.json](fixtures/manifest.json), [read-only check](docs/reviewers.md#verify-on-mainnet-read-only)). |
| MPC signer response | A real mainnet `v1.signer` EdDSA response, recorded read-only from a third party's request, decodes with the contract's own decoder and verifies under the derived key; altered copies fail ([fixture](fixtures/signer/v1-signer-eddsa-sign.json), [test](contract/tests/signer_conformance.rs)). This is not our own signing on mainnet. |
| Mainnet | **Not run.** No mainnet transaction has been executed. |
| Public links | **Planned, unpublished.** The repository is private pending publication approval; the hosted page and videos are not published. |

**Try it.** No funds, model key or private repository needed. Clone, then:

| Do | Needs | See |
| --- | --- | --- |
| `make verify` (same as `node verify.mjs`) | Node 20 or later; no install; offline by default | Checks the bundle marked certified in [evidence/index.json](evidence/index.json): every file against its `SHA256SUMS`, each required case from its own report, and this checkout's `SPEC.md`, fixtures and deployment candidate. One line per gate, ending `VERIFIED: …` or `NOT VERIFIED: …`, non-zero exit on any mismatch. It checks recorded evidence and does not rerun the tests. `--mainnet` reads a run's receipts from a public archival RPC; none exist yet, so it says so and exits 1. <!-- REFRESH: exact final line and time after certification --> |
| `make quick` | Node 24; network for npm, the NEAR sandbox binary and Chromium; no Rust. On Linux, Chromium's system libraries: `cd tools && npm ci --ignore-scripts && npx --no-install playwright install-deps chromium` (root) | The demo story on the exact deployment candidate with prebuilt test doubles pinned in [fixtures/prebuilt](fixtures/prebuilt/provenance.json) with provenance (built twice in the pinned cargo-near image with identical bytes; `make quick` checks their hashes and never rebuilds them). Writes only `out/quick/`; labelled prebuilt and uncertified. 60/60 checks (59 demo checks and the prebuilt pin check). Cold 138 s in a fresh linux/amd64 `ubuntu:24.04` container under emulation on an arm64 Mac (apt, Node 24, `npm ci`, Chromium libraries, sandbox and story); 44 s warm on macOS. |
| `make test && make demo` | Rust, `cargo-near` 0.22.0, Node 24, Chromium ([platform needs](docs/reviewers.md#platform-needs)) | `CERTIFIED: run …`, then `… 59/59 assertions passed …`. At 51d2532 on macOS arm64: `make test` 1500 s cold, `make demo` 60 s warm. <!-- REFRESH: times at the new certified revision --> |

Or open the [committed evidence page](evidence/51d2532/page/index.html) offline. Outputs and timings: [reviewer guide](docs/reviewers.md#running-the-demo-and-the-gates).

## Three checkable facts

Sandbox results at 51d2532 with labelled test doubles; selected samples, not a statistical rate.

1. **No key.** The agent's only key is a function-call key for `propose_order`; ten agent-key attacks (other methods, deposits, `mt_transfer`, key changes) were refused by the protocol ([BOUNDARY.attacks](evidence/51d2532/tests/BOUNDARY.attacks.json)). The order-signing key is derived by the MPC network (a test double in sandbox), and the contract requests each signature only after its checks ([`propose_order`](contract/src/lib.rs#L419)).
2. **Limits at the signature.** Of a selected sample of 15 valid scripted trades, 15 settled with no authorization refusal and every fill within the 0.5% concession ([T3.concession](evidence/51d2532/tests/T3.concession.json)). 39 of 39 hostile requests were refused at five layers: 10 local validation, 14 contract method checks, 4 policy checks, 10 agent key permission checks, 1 verifier check ([BOUNDARY.attacks](evidence/51d2532/tests/BOUNDARY.attacks.json), [attack log](docs/reviewers.md#attack-log)).
3. **Stop and exit.** After confirmed removal of the grant key at the verifier, a withheld signed order was rejected with the verifier's missing-key error while at least 45 s of its lifetime remained in every post-removal relay, and again after a regrant, which signs with a key on a new path ([T1.withheld-regrant](evidence/51d2532/tests/T1.withheld-regrant.json)). `recover` returned both assets to the owner's Intents account with the agent stopped, the oracle failing and the MPC on hold ([T4.dependency-failure](evidence/51d2532/tests/T4.dependency-failure.json)).

At the open-order limit, 32 open orders (20 signed, 12 awaiting their signature), one confirmed key removal released all 32 reservations in one callback, a withheld signed order relayed afterwards did not execute, a 33rd proposal was refused, and recovery returned every unit. The case first forces a failed removal, then retries it ([T4.open-order-limit](evidence/51d2532/tests/T4.open-order-limit.json)).

## Why not just…

Three withheld 1 USDC orders per strategy on the pinned verifier, relayed unexpired by an unrelated account; one of them is missing from the owner's ledger ([COMPARE](evidence/51d2532/tests/COMPARE.revocation-alternatives.json), [T5](evidence/51d2532/tests/T5.baseline.json)).

| Instead of key removal | Measured result | Remove the key, resume with a fresh key (the mandate's mechanism) |
| --- | --- | --- |
| Wait for expiry | 3 of 3 withheld orders executed; protection starts at each order's deadline | 0 of 3 executed after confirmed removal |
| Cancel nonces (an empty intent signed per order) | Needs the account's signer for each one. With the ledger's two nonces, 1 of 3 still executed; with a complete list, 0 of 3 | No list and no signature by the grant's key; the owner signs `revoke` |
| Pause the agent | In our re-implementation of the Claw Guard design (not their deployed product), a withheld order executed after pause and agent removal; a regrant revived a second one that removing the key had blocked | Rejected after confirmed removal and after regrant (T1) |

The advantage over waiting is bounded by the order lifetime: 120 s in this experiment, 60 s in the demo and 120 s proposed for mainnet. Cancellation is venue-specific, other products can also remove and rotate keys, and the mainnet window is not yet measured. Details and limits: [comparison](docs/comparison.md).

## Where to check each criterion

| Criterion | Where to check it |
| --- | --- |
| Technical implementation | [contract/src/lib.rs](contract/src/lib.rs), gate suites in [contract/tests/](contract/tests/) and [tools/test/](tools/test/), [acceptance](evidence/51d2532/acceptance.json), [required gates](docs/reviewers.md#required-gates); `make verify`, `make test` |
| Design | [How it works](docs/reviewers.md#how-it-works), [mechanism](docs/reviewers.md#mechanism-in-detail), the [owner journey](docs/reviewers.md#what-the-owner-does) and the [evidence page](evidence/51d2532/page/index.html) and [owner console](evidence/51d2532/console/index.html) of the certified run |
| Impact | [Who needs this](#who-needs-this-and-what-is-next). There are no users, customers, revenue or adoption today |
| Originality | [Comparison](docs/comparison.md): the tested combination of limits, accounting, key-removal revocation and recovery, set against expiry, nonce cancellation, a guard design and related NEAR projects |
| Sustainability | MIT; a fresh clone works without funds or keys; [CI-certified](evidence/index.json); reproducible deployment build ([DEPLOY](evidence/51d2532/tests/DEPLOY.candidate.json)); [libraries](#disclosures); next steps below |

## Who needs this and what is next

- **DAO treasuries** that want an agent to rebalance within limits the DAO votes on, and to revoke and recover by proposal (Sputnik DAO as owner is certified in sandbox).
- **Funds running agents** that need trading limits and revocation they can check on chain rather than take on trust.
- **Agent builders** who want to offer their users a mandate with a verifiable off switch.

These are the users we are building for; there are no customers, revenue or adoption today. Next, in order: an independent security review → one treasury pilot → integrations validated against real callers (for example the Agent API, see [Complementary architecture](docs/comparison.md#complementary-architecture)).

## What is claimed, and what is not

The claim, certified in sandbox (T1, T4): after removal of the grant's signing key is confirmed, withheld signed orders fail, including after a regrant; the owner recovers the remaining assets without the agent, oracle or MPC.

- **Revocation takes effect after confirmed key removal**, not when the owner asks. While revocation is pending, already-signed orders may still execute, and executed trades are not reversed. Removing the key needs no list of outstanding orders and no signature from the grant's MPC key; the owner still authorizes `revoke`.
- **Not guaranteed:** principal, profit, execution availability or a maximum total loss. Market moves, stale references, fees and orders still executable when the loss breaker trips can lose more than the stated 0.5% execution concession. An adversarial agent can make economically poor permitted trades.
- **Trusted:** the owner. The contract has no upgrade method: upgrade and emergency-rescue authority exist only if the deployment leaves the owner a full-access key on the mandate account (the demo deploys without one). NEAR, the Intents verifier and its admins, and the token contracts must keep working.
- **Evidence so far:** sandbox execution only, with labelled test doubles for the MPC signer, oracle and tokens, and recorded model output. No mainnet run.
- **Recovery and withdrawal.** `recover` moves assets to the owner's Intents account; withdrawing to the owner's NEAR account is the owner's own later step, outside every recovery claim. In the demo the console's Revoke is signed by the labelled local sandbox test signer, not a wallet.

More: [known limits](docs/reviewers.md#known-limits), [status by area](docs/reviewers.md#status), [review findings fixed](docs/reviewers.md#found-and-fixed).

## Open challenge (optional, not run)

After a mainnet run, and only with a separate owner approval, a fresh grant could let anyone act as the agent against a small deposit (`make challenge`, sandbox case LIVE.open-challenge). The agent's private key is never committed. What it shows and does not show: [open challenge](docs/live-runner.md#open-challenge-optional-not-run).

## Mainnet runner (opt-in, not run)

`MANDATE_LIVE=1 MANDATE_LIVE_MANIFEST=<approved manifest> make live` runs an approved manifest; the flag is not spending approval, and both mainnet templates are unapproved ([live runner](docs/live-runner.md)). Before the first grant, the provider path is rehearsed without any transaction; a real provider call is paid inference and needs the owner's explicit approval:

```bash
cd tools
npx tsx src/agent/observe.ts --manifest <approved manifest> --out ../out/rehearsal-state.json
npx tsx src/agent/rehearse.ts --state ../out/rehearsal-state.json --manifest <approved manifest> \
  --planned-usdc-units <setup record's USDC deposit> --planned-wnear-units <setup record's wNEAR deposit> \
  --provider near-ai --model <model id> --timeout-ms <ms> --max-tokens <n> \
  --approve-paid-inference --approval-reference "<owner approval>"
```

## Disclosures

**Hackathon window.** This repository's history starts at commit `85cda4b` on 2026-11-03, inside the NEAR HACKATHON window. The project does not exist on another chain.

**AI tools** (rule Q-005):
- Claude Code (Anthropic Claude models) helped implement the product code, tests and documentation under the author's direction and review.
- OpenAI Codex implemented and tested presentation and provenance fixes, independently reviewed the design, code and evidence, and helped with research, documentation and release verification.
- The two model fixtures in [fixtures/model/](fixtures/model/) are genuine `claude-haiku-5-5` interactions, recorded through the headless Claude Code CLI by `tools/src/agent/record.ts`. The MODEL gate and `make demo` replay them. No gate or demo makes a live model call or needs a model key.

**Major libraries.** Exact resolved versions from [Cargo.lock](Cargo.lock) and [tools/package-lock.json](tools/package-lock.json), which hold the full dependency set. Licenses are taken from the resolved crate and package metadata.

| Library | Version | License | Used for |
| --- | --- | --- | --- |
| `near-sdk` | 5.29.1 | MIT OR Apache-2.0 | contract, baseline and stubs |
| `near-contract-standards` | 5.29.1 | MIT OR Apache-2.0 | NEP-141 token test double |
| `borsh` | 1.8.1 | MIT OR Apache-2.0 | NEP-413 encoding in the contract |
| `serde` / `serde_json` | 1.0.229 / 1.0.154 | MIT OR Apache-2.0 | JSON types |
| `hex` | 0.4.3 | MIT OR Apache-2.0 | payload and signature encoding |
| `near-workspaces` | 0.23.0 | MIT OR Apache-2.0 | Rust sandbox tests |
| `tokio` / `anyhow` | 1.54.1 / 1.0.104 | MIT / MIT OR Apache-2.0 | test runtime and errors |
| `ed25519-dalek` | 2.2.0 | BSD-3-Clause | MPC test double's test keys; signature checks in tests |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | hashing in tests |
| `rand` / `rand_chacha` | 0.9.5 / 0.9.0 | MIT OR Apache-2.0 | seeded randomized interleavings (T2) |
| `defuse-core` (git, [near/intents@16d04f6](https://github.com/near/intents/tree/16d04f6ec4401263f8914638710260da50bb46b0)) | 0.1.0 | MIT (repository license; the crate declares none) | test-only cross-check of our NEP-413 encoding |
| `near-api-js` | 7.3.1 | MIT AND Apache-2.0 | RPC and transactions in `tools/` |
| `near-sandbox` (npm) | 0.3.4 | MIT | local sandbox for the demo |
| `zod` | 4.6.7 | MIT | schema validation of model output and RPC results |
| `@anthropic-ai/sdk` | 0.136.0 | MIT | optional provider for recording new model interactions; unused by gates and demo |
| `typescript` / `tsx` | 6.0.3 / 4.23.15 | Apache-2.0 / MIT | build and script runner |
| `vitest` | 5.0.5 | MIT | TypeScript tests |
| `eslint` / `typescript-eslint` / `@eslint/js` / `@types/node` | 10.13.0 / 8.72.0 / 10.0.1 / 26.6.5 | MIT | lint and types |
| `playwright` | 1.64.1 | Apache-2.0 | drives the owner console in headless Chromium in `make test` and `make demo` (dev only) |
| `wee_alloc` / `memory_units` | 0.4.5 / 0.4.0 | MPL-2.0 | WASM allocator that `near-sdk` enables by default; compiled unmodified into the contract WASM (source on crates.io) |

**Upstream code and data in this repository**, also listed in [NOTICE](NOTICE):
- [fixtures/verifier/defuse-0.4.5.wasm](fixtures/verifier/defuse-0.4.5.wasm): the exact NEAR Intents verifier code deployed at `intents.near`, retrieved read-only and unmodified (MIT, NEAR Foundation). Provenance is in [fixtures/manifest.json](fixtures/manifest.json).
- [baseline/claw-guard-adapted](baseline/claw-guard-adapted): our re-implementation of the [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) design at commit 225d37d (MIT, Patrick Baur). The design is adapted and no code is copied; it serves T5 alone.
- [fixtures/sputnik/sputnikdao2-2.3.1.wasm](fixtures/sputnik/sputnikdao2-2.3.1.wasm): the Sputnik DAO v2 code that the mainnet factory `sputnik-dao.near` deploys, retrieved read-only and unmodified (MIT, near-daos), used only as the DAO owner in sandbox tests. Provenance is in [fixtures/manifest.json](fixtures/manifest.json).
- [fixtures/vectors/oracle.json](fixtures/vectors/oracle.json): public read-only responses of `aggregate-oracle.near`.
- `stubs/`: our own labelled test doubles, written against the documented interfaces of `v1.signer`, `aggregate-oracle.near` and NEP-141.

**Tooling, not distributed:**
- Build: Rust 1.97.1, `cargo-near` 0.22.0 and the `sourcescan/cargo-near:0.22.0-rust-1.97.1` image for reproducible builds.
- Tests and demo: the NEAR sandbox binary (nearcore 2.13.4), which `near-workspaces` and `near-sandbox` download at test time, and Playwright's pinned headless Chromium, which `make test` and `make demo` install on first run. Node.js 24.
- Video only, in `tools/src/video/make.ts`: ffmpeg, Google Chrome and `playwright-core`.

## License

MIT. Third-party components and fixtures are listed in [NOTICE](NOTICE).
