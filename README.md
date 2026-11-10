# Bounded Mandate: AI trading on NEAR Intents without a signing key

Give an AI agent trading power. Keep the power to stop it.

An AI agent trades your treasury on NEAR Intents without holding a signing key. A contract signs each order inside your limits; one owner call voids every signed order that has not executed, and recovery returns the funds without the agent.

**The problem.** Pausing an agent stops new orders, but orders it already signed stay valid until they expire or are cancelled one by one. Here `revoke` removes the grant's signing key at the verifier; once removal is confirmed, every outstanding order fails. The gain over waiting is at most the order lifetime: 60 s in the demo, 120 s proposed for mainnet (not approved or run).

**What NEAR provides.**
- **Chain Signatures.** The contract gets each signature from `v1.signer` after checking the limits; no single person or server holds that key. In the sandbox evidence the signer is a single labelled test double, and our own mainnet signing is unexercised.
- **Verifier key registry.** `intents.near` checks the registered key on every signed intent, so revoking is a key removal.
- **Function-call keys.** The agent's key can call only `propose_order`.

| Evidence | State |
| --- | --- |
| Sandbox execution | **Certified at 173942f**: 37 of 37 required cases ([acceptance](evidence/173942f/acceptance.json)). Certified means this project's own gate (all required cases passing in one run of one clean revision, in a fresh clone and in CI), not an external audit ([definition](docs/reviewers.md#what-certified-means)). Signer, oracle and tokens are labelled test doubles. |
| Model output | Genuine recorded `claude-haiku-5-5` output, replayed ([MODEL](evidence/173942f/tests/MODEL.recorded-proposal.json)); no gate or demo calls a model. |
| Verifier code | The pinned WASM hashes to the code at `intents.near` ([check](docs/reviewers.md#verify-on-mainnet-read-only)). |
| MPC signer response | A real mainnet `v1.signer` response, recorded read-only, verifies in the contract's decoder ([test](contract/tests/signer_conformance.rs)); not our own signing. |
| Mainnet | **Not run**: no mainnet transaction. |
| Public links | **Planned, unpublished**; after publication: [page](https://gryyny.github.io/bounded-mandate/), [console](https://gryyny.github.io/bounded-mandate/console/), [short video](https://gryyny.github.io/bounded-mandate/video/bounded-mandate-short.mp4). |

**Try it** from a clone; no funds or model key:

| Do | Needs | See |
| --- | --- | --- |
| `make verify` | Node 20+; offline | Last line starts `VERIFIED: evidence/173942f` |
| `make quick` | Node 24, network; no Rust | `60/60 assertions passed`, labelled uncertified |
| `make test && make demo` | Rust, `cargo-near`, Node 24 | `CERTIFIED: run …`, then `59/59 assertions passed` |

`make verify` checks committed evidence and reruns nothing. `SHA256SUMS` is unsigned: it detects accidental or partial change, not a self-consistent rewrite, so trust rests on the commit history and on rerunning `make test`. [Setup, timings, outputs](docs/reviewers.md#running-the-demo-and-the-gates); [evidence page](evidence/173942f/page/index.html).

## Three checkable facts

Sandbox results at 173942f with labelled test doubles; selected samples, not a statistical rate.

1. **No signing key.** The agent's only key is a function-call key for `propose_order`; ten agent-key attacks (other methods, deposits, `mt_transfer`, key changes) were refused by the protocol ([BOUNDARY.attacks](evidence/173942f/tests/BOUNDARY.attacks.json)). The order-signing key is derived by the MPC network (a test double in sandbox), and the contract requests each signature only after its checks ([`propose_order`](contract/src/lib.rs#L419)).
2. **Limits at the signature.** Of a selected sample of 15 valid scripted trades, 15 settled with no authorization refusal and every fill within the 0.5% concession ([T3.concession](evidence/173942f/tests/T3.concession.json)). 39 of 39 hostile requests were refused at five layers: 10 local validation, 14 contract method checks, 4 policy checks, 10 agent key permission checks, 1 verifier check ([BOUNDARY.attacks](evidence/173942f/tests/BOUNDARY.attacks.json), [attack log](docs/reviewers.md#attack-log)).
3. **Stop and exit.** After confirmed removal of the grant key at the verifier, a withheld signed order was rejected with the verifier's missing-key error while at least 46 s of its lifetime remained in every post-removal relay, and again after a regrant, which signs with a key on a new path ([T1.withheld-regrant](evidence/173942f/tests/T1.withheld-regrant.json)). `recover` returned both assets to the owner's Intents account with the agent stopped, the oracle failing and the MPC on hold ([T4.dependency-failure](evidence/173942f/tests/T4.dependency-failure.json)).

At the open-order limit, 32 open orders (20 signed, 12 awaiting their signature), one confirmed key removal released all 32 reservations in one callback, a withheld signed order relayed afterwards did not execute, a 33rd proposal was refused, and recovery returned every unit. The case first forces a failed removal, then retries it ([T4.open-order-limit](evidence/173942f/tests/T4.open-order-limit.json)).

## Why not just…

Three withheld 1 USDC orders per strategy on the pinned verifier, relayed unexpired by an unrelated account; one of them is missing from the owner's ledger. The first two rows were measured at verifier level on a plain account whose key is a labelled test key standing in for the MPC-derived key (COMPARE); the third compares the two contracts (T5, T1) ([COMPARE](evidence/173942f/tests/COMPARE.revocation-alternatives.json), [T5](evidence/173942f/tests/T5.baseline.json)).

| Instead of key removal | Measured result | Remove the key, resume with a fresh key (the mechanism the mandate uses) |
| --- | --- | --- |
| Wait for expiry | 3 of 3 withheld orders executed; protection starts at each order's deadline | 0 of 3 executed after confirmed removal |
| Cancel nonces (an empty intent signed per order) | Needs the account's signer for each one. With the ledger's two nonces, 1 of 3 still executed; with a complete list, 0 of 3 | No list and no signature by the grant's key; the owner signs `revoke` |
| Pause the agent | In our re-implementation of the Claw Guard design (not their deployed product), a withheld order executed after pause and agent removal; a regrant revived a second one that removing the key had blocked | Rejected after confirmed removal and after regrant (T1) |

The advantage over waiting is bounded by the order lifetime: 120 s in this experiment, 60 s in the demo and 120 s proposed for mainnet. The 120 s is a proposed deviation from the spec's 60 s oracle maximum age, pending the owner's decision; it is not approved and has not run. Cancellation is venue-specific, other products can also remove and rotate keys, and the mainnet window is not yet measured. Details and limits: [comparison](docs/comparison.md).

## Where to check each criterion

| Criterion | Where to check it |
| --- | --- |
| Technical implementation | [contract/src/lib.rs](contract/src/lib.rs), gate suites in [contract/tests/](contract/tests/) and [tools/test/](tools/test/), [acceptance](evidence/173942f/acceptance.json), [required gates](docs/reviewers.md#required-gates); `make verify`, `make test` |
| Design | [How it works](docs/reviewers.md#how-it-works), [mechanism](docs/reviewers.md#mechanism-in-detail), the [owner journey](docs/reviewers.md#what-the-owner-does) and the [evidence page](evidence/173942f/page/index.html) and [owner console](evidence/173942f/console/index.html) of the certified run |
| Impact | [Who needs this](#who-needs-this-and-what-is-next). There are no users, customers, revenue or adoption today |
| Originality | [Comparison](docs/comparison.md): the tested combination of limits, accounting, key-removal revocation and recovery, set against expiry, nonce cancellation, a guard design and related NEAR projects |
| Sustainability | MIT; a fresh clone works without funds or keys; [CI-certified](evidence/index.json); reproducible deployment build ([DEPLOY](evidence/173942f/tests/DEPLOY.candidate.json)); [libraries](#disclosures); next steps below |

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

Optional and not run. After a mainnet run, and only with the owner's separate approval of the deposit and of publishing the key, a fresh grant could let anyone act as the agent against a small deposit (`make challenge`, sandbox case LIVE.open-challenge). The agent's private key is never committed. Its limits, with the policy proposed in the unapproved [template](tools/src/live/manifest.open-challenge.example.json):

- **A holder of the published agent key cannot** withdraw, transfer to another account, change keys or policy, or exceed the limits: per-order and outstanding caps of 20%, a 0.5% concession bound, a 100% turnover cap and the 2% loss breaker.
- **They can** make permitted but poor trades at up to the 0.5% concession on each order, up to the turnover cap, and exhaust the agent's gas allowance (at most 0.25 NEAR) and the grant's proposal budget (at most 10 proposals).
- **Loss bound.** By design the concession given up is at most the turnover cap times the concession bound, 100% × 0.5% = 0.5% of the challenge deposit's initial value, plus the gas allowance. The loss breaker stops new authorizations and is not a loss cap; market moves, stale references and fees are outside this bound, and an unknown contract defect could lose the deposit.

More: [open challenge](docs/live-runner.md#open-challenge-optional-not-run).

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
| `@hot-labs/near-connect` | 0.11.4 | MIT (npm metadata; the repository has no LICENSE file) | NEAR Connect wallet connector, inlined into the shipped owner console page |
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
- [fixtures/signer/v1-signer-eddsa-sign.json](fixtures/signer/v1-signer-eddsa-sign.json): read-only records of a third party's mainnet `v1.signer` sign request, its response and the derived public key (public chain data), used by the SIGNER gate. Provenance is in [its provenance file](fixtures/signer/v1-signer-eddsa-sign.provenance.json).
- [fixtures/wallets/near-connect.json](fixtures/wallets/near-connect.json): wallet entries from the NEAR Connect wallet manifest ([hot-dao/near-selector@9cee11c](https://github.com/hot-dao/near-selector/tree/9cee11c04cfd42f5a420688f808d4aca612b5fde); MIT per npm metadata), with each adapter URL pinned by commit and sha256. The adapters themselves are not in this repository; the console fetches a chosen wallet's pinned adapter at run time.
- [fixtures/prebuilt/](fixtures/prebuilt/provenance.json): our own `stubs/` compiled for `make quick`; each WASM contains third-party crates compiled unmodified, listed with their licenses in [NOTICE](NOTICE) (including BSD-3-Clause `curve25519-dalek` 4.1.3, `ed25519-dalek` 2.2.0 and `subtle` 2.6.1, and MPL-2.0 `wee_alloc`).
- `stubs/`: our own labelled test doubles, written against the documented interfaces of `v1.signer`, `aggregate-oracle.near` and NEP-141.

**Tooling, not distributed:**
- Build: Rust 1.97.1, `cargo-near` 0.22.0 and the `sourcescan/cargo-near:0.22.0-rust-1.97.1` image for reproducible builds.
- Tests and demo: the NEAR sandbox binary (nearcore 2.13.4), which `near-workspaces` and `near-sandbox` download at test time, and Playwright's pinned headless Chromium, which `make test` and `make demo` install on first run. Node.js 24.
- Video only, in `tools/src/video/make.ts`: ffmpeg, Google Chrome and `playwright-core`.

## License

MIT. Third-party components and fixtures are listed in [NOTICE](NOTICE).
