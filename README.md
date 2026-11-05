# Bounded mandate

**Delegate trading within on-chain limits. Revoke the entire grant—including outstanding signed orders—and recover the remaining assets.**

A bounded trading mandate over USDC and wNEAR on NEAR Intents. An owner delegates trading to an AI agent; a contract owns the Intents account, builds every signed order itself and obtains its own MPC signatures. The agent can only propose trades within immutable limits. The owner can withdraw outstanding signed authority and recover assets without the agent, oracle or MPC.

**Example: treasury rebalancing.** A treasury holds USDC and wNEAR and wants an AI agent to rebalance between them without handing it the funds or a signing key. The owner deposits both into the mandate and grants trading with caps on order size, open exposure and total turnover, and a price concession of at most 0.5% against the oracle reference. The agent can propose trades but cannot sign, withdraw or change limits; the contract checks the limits and signs each order itself. To stop, the owner calls `revoke`. Pausing an agent alone would stop new orders, but signatures already issued would stay valid until their deadline or until their nonces are used. Once removal of the grant's key is confirmed, every signed order of that grant fails, including orders the agent or a relayer withheld, and none comes back after a later regrant. The owner then calls `recover` to move the remaining USDC and wNEAR to the owner's Intents account, without the agent, oracle or MPC.

## Evaluate in 5 minutes

| Path | Do | See |
| --- | --- | --- |
| Video | Watch the short cut (about 65 s): `VIDEO_URL_PENDING`. A longer technical walkthrough (about 140 s) covers the same run plus the attack suite. | The revocation story from one sandbox run: balances, trading limits, a recorded model proposal traded, a signed order withheld, confirmed revocation, the withheld order rejected, balances recovered. |
| Evidence page | Open [evidence/7f280ca/page/index.html](evidence/7f280ca/page/index.html) in a browser (self-contained, no network); hosted copy `PAGE_URL_PENDING` | The demonstration, acceptance gates, matched baseline, claims and non-claims, policy and provenance for certified revision 7f280ca. `make demo` regenerates it at `out/page/index.html`. |
| Mainnet receipts (pending the approved mainnet run) | Run the read-only commands in [Verify on mainnet](#verify-on-mainnet-read-only) with `curl` and `jq`; no wallet, key or funds | Today: the verifier we test against is byte-identical to the code at `intents.near`. After the approved run: the grant key absent, the withheld order's nonce unused, the recovery receipts. |
| Local run | Install the [requirements](#requirements), then `make demo` | About a minute after a warm build (60 s in the certified fresh-clone run; a cold build takes longer). Ends with `56/56 assertions passed`, `out/evidence/demo.json` and `out/page/index.html`. |
| Full gates | `make test` | About 16 minutes after a warm build (20 minutes in the fresh-clone run). From a clean tree it ends with `CERTIFIED: run <id>` and writes `out/evidence/acceptance.json`. |

### Verify on mainnet (read-only)

**Pending the approved mainnet run; no mainnet transaction has been executed.** The code-hash check works today. The second block is a template: its placeholders are filled in only after the run, and these commands send no transaction.

```sh
RPC=https://archival-rpc.mainnet.fastnear.com   # archival: receipts stay readable after the run

# Works today: code hash of intents.near ...
curl -sS "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"intents.near"}}' \
  | jq -r .result.code_hash
# ... equals base58(sha256) of our verifier fixture (run in this repository)
python3 -c "import hashlib;n=int.from_bytes(hashlib.sha256(open('fixtures/verifier/defuse-0.4.5.wasm','rb').read()).digest(),'big');A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';s='';exec('while n:\n n,r=divmod(n,58)\n s=A[r]+s');print(s)"
```

Both print `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`, as recorded in [fixtures/manifest.json](fixtures/manifest.json) at block 222913804. A later upgrade of `intents.near` would change the live value.

```sh
# TEMPLATE until mainnet receipts exist. Placeholders: <...>.
MANDATE='<MANDATE_ACCOUNT>'; GRANT_KEY='<ed25519:GRANT_PUBLIC_KEY>'; NONCE='<WITHHELD_ORDER_NONCE_BASE64>'
view() {  # view <contract> <method> <json args>
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf %s "$3" | base64 | tr -d '\n')\"}}" \
    | jq -r '.result.result | implode'
}
view intents.near has_public_key "{\"account_id\":\"$MANDATE\",\"public_key\":\"$GRANT_KEY\"}"  # false after confirmed revocation
view intents.near is_nonce_used "{\"account_id\":\"$MANDATE\",\"nonce\":\"$NONCE\"}"           # false: the withheld order never executed
view "$MANDATE" get_grant '{}'                                                               # grant epoch and state
curl -sS "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"<TX_HASH>","sender_account_id":"<SENDER_ACCOUNT>","wait_until":"FINAL"}}' \
  | jq '.result.receipts_outcome[] | {executor: .outcome.executor_id, status: .outcome.status}'  # per-receipt outcomes
```

## Status

Acceptance runs in a local NEAR sandbox. Our contract and the exact mainnet Intents verifier WASM execute there, with labelled test doubles for the MPC signer, oracle and tokens. The model gate replays a genuine recorded model interaction. **No mainnet transaction has been executed**; that integration needs separately approved accounts and budget.

Certified results are committed under [evidence/](evidence/) and indexed by source revision in [evidence/index.json](evidence/index.json). Each entry records:
- the acceptance verdict, with every required case of every gate bound to that revision and to the spec, fixture and WASM hashes;
- the environment, commands and exit results;
- an independent fresh-clone run without funds, model credentials or private-repository access.

`evidence/426914d` is an earlier bundle in the legacy report format, kept unchanged; current rules do not certify it. See [SPEC.md](SPEC.md) for the requirements.

## What it guarantees, and what it does not

The claim: after removal of the grant's signing key is confirmed, withheld signed orders fail, including after a regrant; the owner recovers the remaining assets without the agent, oracle or MPC.

Not guaranteed: principal, profit, execution availability or a maximum total loss. Market moves, stale references, fees and orders still executable when the loss breaker trips can lose more than the stated 0.5% execution concession. While revocation is pending, already-signed orders may still execute. The owner is trusted. The contract has no upgrade method: upgrade and emergency-rescue authority exist only if the deployment leaves the owner a full-access key on the mandate account (the demo deploys without one). NEAR, the Intents verifier and its admins, and the token contracts must keep working.

## How it works

- **Agent.** A separate account whose only key is a function-call key for `propose_order` with a finite allowance. A proposal names only the asset to sell, the amount and a concession of at most 50 bps. It cannot name recipients, payloads, keys, paths or token IDs.
- **Contract.** It reserves exposure and charges turnover before any external call, reads both oracle prices and its verifier balances, re-checks every cap and the loss breaker, then builds an exact NEP-413 `token_diff` with a versioned nonce and a short deadline. It signs through its own MPC derivation path `mandate/v1/<epoch>`, which is never reused.
- **Accounting.** A reservation is released exactly once, and only on trusted evidence: the verifier reports the nonce used, block time passes the deadline, or removal of the covering key is confirmed. A signature published by the MPC whose callback failed stays reserved. Every proposal permanently charges at least `proposal_charge_bps` of turnover, so a grant accepts at most `turnover_cap / proposal_charge` proposals. The charge consumes authorization capacity; no tokens move and no fee is paid. It bounds order records per grant, not storage across grants (each regrant is an owner decision). At most 32 orders are open at once, so confirmed removal releases them all within one callback's fixed gas.
- **Revocation.** Key registration and removal are serialized. Revocation stops new authorization at once (`revoking`); confirmed removal (`revoked`) releases every reservation of that grant. Failed removal can be retried.
- **Unresolved registration.** If the key-registration callback fails, the owner calls `reconcile_registration`. It resolves only on observing the grant key registered on the verifier; absence or elapsed time never resolves it, because a pending registration could still land. If both the registration and its callback failed, an emergency rescue is needed: confirm from final receipt outcomes that nothing can still register, re-add the key with an owner-held key on the mandate account, then reconcile and revoke. That rescue is reported separately from ordinary recovery and is impossible for a keyless deployment.
- **Recovery.** With the grant revoked, the owner moves each asset's verifier balance to the owner's Intents account with `mt_transfer`. No price read, signature or agent action is involved. This is not a withdrawal to an external wallet; moving funds out of Intents is the owner's own later action.
- **Filler.** Our own separately keyed account signs the matching side, pays the verifier fee, and submits both payloads through permissionless `execute_intents`. It never builds a replacement order after an ambiguous result.

Demo policy: per-order and outstanding caps 20% of the initial reference value, turnover cap 100%, concession at most 0.5%, oracle age at most 60 s, confidence at most 0.5%, loss breaker at 2% drawdown, deadline at most 60 s, and a per-proposal charge of 0.5%. These are demonstration settings, not proven production risk limits. With this policy, the measured storage requirement for a full grant (200 proposals of about 780 bytes each, plus grant state) is about 4.67 NEAR in total for the mandate account, including about 3.1 NEAR for the contract code.

## Matched baseline (T5)

We applied the same threat model to our own re-implementation of the [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) design (pinned 225d37d), adapted to the same USDC/wNEAR `token_diff` authority on the pinned Intents verifier. Results describe that re-implementation in a local sandbox, not the deployed Claw Guard product; the adaptations are recorded with the results. Executed in sandbox:

- its own revocation (pause and remove the agent) leaves withheld signed orders executable;
- removing the key on Intents stops them, but a regrant re-registers the same fixed-path key and revives them;
- a signature disclosed while the signer callback fails is released from accounting, so executed volume exceeded its daily cap.

Over-cap, injected-withdrawal and owner-recovery cases are blocked by both designs. The evidence page claims an increment only from a certified run in which the matching mandate gate passed.

## Comparison with related NEAR projects

Each project was read at the pinned commit linked below; later commits may differ. The projects solve different problems, and several are broader than this one. This table compares only how they handle delegated authority.

| | Bounded mandate (this repository) | [Agent Treasury](https://github.com/iskander-kudashev-13/agent-treasury) @46116b1 | [NEAR Private OTC](https://github.com/Watchmeecryt/near-private-otc) @55d5b64 | [Near-LEASH](https://github.com/soze-ki/Near-LEASH) @b122410 | Claw Guard design, our adaptation (T5) |
| --- | --- | --- | --- | --- | --- |
| Product | Agent trading of USDC/wNEAR from a contract-owned Intents account. Sandbox only so far. | USDC vault with per-agent mandates for payroll and cross-chain payouts via 1Click, plus an optional Hyperliquid spot trading agent. Has a dashboard, SDK and MCP server, a mainnet vault with real payouts and a mainnet trading session. [1] | Private OTC deal board: sealed terms in an OutLayer TEE, atomic settlement through `execute_intents`. Hosted app on testnet. [2] | Policy gate for agent spending: EVM transactions through Chain Signatures and funding of 1Click swaps. Deployed on testnet with a live MPC-signed Base Sepolia payment. [3] | Our re-implementation of the [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) authority model, adapted to Intents `token_diff`. Used for T5, not their deployed product. [4] |
| Where limits are enforced | In the mandate contract, before signing. [5] | Payments: in the vault contract. Trading rules: in the off-chain worker, as owner-signed rule sets. [1] | No delegated trading limit. The enclave checks that the two intents mirror each other; for an agent, the limit is its account balance. [2] | In the contract: allowlists, caps, cooldown and on-chain 1Click quote verification. [3] | In the guard contract: per-order and daily caps. [4] |
| Who signs orders | The contract, through MPC, on a new derivation path for each grant (`mandate/v1/<epoch>`). [5] | The worker's Hyperliquid API wallet. [1] | Each party, with its own key. [2] | MPC signs EVM transactions the contract builds. On the Intents path no order is signed; the contract funds a verified deposit address. [3] | MPC on one fixed derivation path. [4] |
| What revocation stops | New proposals at once. After confirmed key removal, every outstanding signed order of the grant, including after regrant. A signature disclosed while its callback failed stays reserved. [5] | `pause_agent` and `revoke_agent` stop vault payments. The trading kill switch halts bots, open positions stay, and the full stop is revoking the API wallet on Hyperliquid. [1] | Per deal: the maker burns the nonces of its live offers, so those signatures can never settle. [2] | `pause` and `remove_agent_key` stop new requests. An EVM transaction that was already signed stays valid, subject to its EVM nonce. [3] | Pause or remove-agent: new proposals only; a withheld order executed. Removing the key on Intents: stopped. Regrant: same key, the order executed again. [4] |
| Recovery | Owner `recover` sends `mt_transfer` to the owner's Intents account, with no agent, oracle or MPC. [5] | Owner `withdraw` from the vault, which pause does not block. Funds already sent to Hyperliquid return manually. [1] | Assets stay in each user's own verifier balance; the user withdraws with a self-signed `ft_withdraw`. [2] | Owner `withdraw` of NEAR or NEP-141 tokens. [3] | Assets stay in the owner's own Intents account; the strand case was blocked. [4] |

Sources:
1. Agent Treasury at `46116b1c88fc5d5068698dc73de348e62f428136`: [README L1-L9](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L1-L9), [limitations L72-L77, L84-L87, L92-L94, L98](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L72-L98), [API wallet L339-L341](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L339-L341), [mainnet demo L454-L470](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L454-L470), [`request_payment`](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/contract/src/payment.rs#L51), [`pause_agent` / `revoke_agent`](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/contract/src/agent.rs#L126-L156), [`withdraw`](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/contract/src/owner.rs#L285-L287).
2. NEAR Private OTC at `55d5b645bc6212cf975474cee12f1a63e9a37d55`: [README L3](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/README.md#L3), [settlement L47](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/README.md#L47), [cancel L99](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/README.md#L99), [keeper cancel L323-L334](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/keeper/index.mjs#L323-L334), [keeper withdraw L335-L339](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/keeper/index.mjs#L335-L339), [agent limits AGENTS.md L89-L99](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/AGENTS.md#L89-L99).
3. Near-LEASH at `b122410aac152d8a38aa36ebe064baf42c91fc10`: [README L3-L16](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/README.md#L3-L16), [paths L65-L78](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/README.md#L65-L78), [`pause`](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/contract/src/lib.rs#L366-L370), [`remove_agent_key`](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/contract/src/lib.rs#L409-L415), [`withdraw`](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/contract/src/lib.rs#L476-L490), [signed EVM nonce, spec L182](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/docs/guardrail-spec.md#L182).
4. Claw Guard at `225d37d3c1b04959947fa7c18544fa50e273dcd8`: [issued signatures are not revoked by pause, THREAT_MODEL L233](https://github.com/metafrogmeme-droid/claw-guard-near/blob/225d37d3c1b04959947fa7c18544fa50e273dcd8/docs/THREAT_MODEL.md#L233), [DECISIONS L61](https://github.com/metafrogmeme-droid/claw-guard-near/blob/225d37d3c1b04959947fa7c18544fa50e273dcd8/docs/DECISIONS.md#L61). Our adaptation: [fixed path](baseline/claw-guard-adapted/src/lib.rs#L27), [`remove_agent` / `pause`](baseline/claw-guard-adapted/src/lib.rs#L298-L310), [test](baseline/claw-guard-adapted/tests/t5_baseline.rs), [certified result](evidence/7f280ca/tests/T5.baseline.json).
5. This repository: [`propose_order`](contract/src/lib.rs#L419), [`revoke`](contract/src/lib.rs#L325), [`recover`](contract/src/lib.rs#L384), [per-grant path](contract/src/state.rs#L54); certified [T1 withheld/regrant](evidence/7f280ca/tests/T1.withheld-regrant.json), [T2b](evidence/7f280ca/tests/T2b.callback-failed-after-disclosure.json) and [T4](evidence/7f280ca/tests/T4.dependency-failure.json).

## Layout

| Path | Contents |
| --- | --- |
| [SPEC.md](SPEC.md) | Pinned product specification; origin and hash in [spec-source.json](spec-source.json). |
| `contract/` | Rust mandate contract; `contract/tests/` holds the sandbox and adversarial gate suites. |
| `stubs/` | Labelled test doubles for the MPC signer, oracle and tokens. |
| `baseline/` | Our re-implementation of the Claw Guard design, adapted for the matched comparison. |
| `tools/` | TypeScript model adapter, filler, attack suite, demo, live runner and evidence page. |
| `fixtures/` | Pinned external inputs and recorded model interactions, with provenance in `fixtures/manifest.json`. |
| `evidence/` | Curated gate and demo evidence, bound to a source revision. |

## Requirements

- Rust via rustup (toolchain pinned in `rust-toolchain.toml`) and `cargo-near` 0.22.0 (`cargo install cargo-near --version 0.22.0 --locked`; on Linux install `libudev-dev` and `pkg-config` first).
- Node.js 24 and npm.
- Network access for dependency installation and the first download of the NEAR sandbox binary. No funds, model key or private repository access.

## Commands

```sh
make test   # all local gates (about 16 minutes after a warm build)
make demo   # unfunded sandbox scenario, out/evidence/demo.json and out/page/index.html
MANDATE_LIVE=1 MANDATE_LIVE_MANIFEST=<approved manifest> make live   # opt-in; not spending approval
```

`make test` records a run id, clears earlier results and ends with `tools/src/checks/acceptance.ts`. That step writes `out/evidence/acceptance.json` and fails unless every required case of every gate passed in this run, bound to the revision and the spec, fixture and WASM hashes. A run from a tree with uncommitted changes is never certified. Demo checks are story checks, not acceptance results.

`make live` refuses a manifest that does not match the chain: network, the code hashes of the mandate, verifier, signer, oracle and both token contracts, the verifier, signer and oracle versions, the mandate configuration, keys and allowances. Token decimals are compared with the mandate's configuration, not read from `ft_metadata`; that comparison is a manual pre-approval check. It enforces fee, deposit, inventory and filler caps through a hash-chained ledger that survives restarts. It verifies each step's end state from state and receipts, and stops without any replacement order on an ambiguous outcome. Mainnet also requires `MANDATE_LIVE_CONFIRM=<manifest sha256>`.

The mainnet template ([tools/src/live/manifest.example.json](tools/src/live/manifest.example.json)) runs the whole revocation story with small amounts:
1. Grant, then one deliberately forbidden proposal that the mandate itself must refuse.
2. One valid trade, filled and settled.
3. A second signed order, withheld: the filler counter-signs a complete bundle, `simulate_intents` accepts it, and the exact bundle is kept in the ledger.
4. Revoke, then relay that bundle before its deadline.
5. Recover both assets to the owner's Intents account.

The relay is checked twice: before the bundle is prepared, and again after signing, immediately before the broadcast. Each check requires confirmed revocation (grant revoked, no key operation in flight, signing key absent) and at least `min_remaining_sec` (10 s) left before the order's deadline by the final block's time. Unconfirmed revocation stops the run; nothing is sent. Too little remaining time skips the relay and records it as inconclusive. A relay that is sent passes only if the verifier rejects it for the removed key, before the order's deadline, with both nonces unused and balances unchanged. An expired order, missing filler funds, a different signature error or an unreadable execution time is inconclusive, never a pass; execution counts as a revocation failure.

Classified terminal outcomes, whether passed, inconclusive, failed or skipped, are recorded and the run proceeds to recovery, exiting nonzero unless every step passed. Unresolved outcomes stop the run without resubmitting anything: a lost response, an outcome that is not final, or an RPC interruption. `MANDATE_LIVE_RESUME=1` reconciles the stopped run from chain state, then continues. The relay's evidence records the deadline-sensitive phases (withheld order proposed, propose confirmed by runner, bundle simulated, revoke sent, revoke confirmed by runner, relay pre-check, prepared, broadcast) with runner wall-clock times and, where read, the final block's time remaining before the deadline. "Confirmed by runner" is when the step's terminal verification was recorded; after a lost response it is the reconciling resume, never the ambiguous response.

Regrant resistance and broken-oracle or broken-MPC scenarios stay in the sandbox gates. On mainnet, recovery only shows that its receipts call no agent, oracle or MPC; it cannot show those shared services disabled. The template's RPC is `https://free.rpc.fastnear.com`, because `rpc.mainnet.near.org` is deprecated and heavily rate-limited. For lookups of older receipts, such as the verification commands above, use the archival endpoint `https://archival-rpc.mainnet.fastnear.com`.

`make demo` replays the recorded model output, so it needs no API key. To record a new model interaction, run `tools/src/agent/record.ts` with a model provider, then list the file in `fixtures/manifest.json`.

## Known limits

- A transient price reading below the breaker threshold stops new authorization for the rest of that grant.
- A transaction's top-level result can arrive before its detached key-registration or removal receipts finish; tools poll `get_grant` until no key operation is in flight.
- Registration presence is evidence of our registration or of a verifier-admin key addition; verifier admins can already lock or alter the account, so this adds no new trust.
- Sandbox timing does not represent mainnet latency.

## Disclosures

**Hackathon window.** This repository's history starts at commit `85cda4b` on 2026-11-03, inside the NEAR HACKATHON window. The project does not exist on another chain.

**AI tools** (rule Q-005):
<!-- AUTHOR: confirm whether any other AI tools were used -->
- The product code, tests and documentation were implemented with Claude Code (Anthropic Claude models) under the author's direction and review.
- OpenAI Codex was used for independent review of the design, code and evidence.
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

**Upstream code and data in this repository**, also listed in [NOTICE](NOTICE):
- [fixtures/verifier/defuse-0.4.5.wasm](fixtures/verifier/defuse-0.4.5.wasm): the exact NEAR Intents verifier code deployed at `intents.near`, retrieved read-only and unmodified (MIT, NEAR Foundation). Provenance is in [fixtures/manifest.json](fixtures/manifest.json).
- [baseline/claw-guard-adapted](baseline/claw-guard-adapted): our re-implementation of the [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) design at commit 225d37d (MIT, Patrick Baur). The design is adapted and no code is copied; it serves T5 alone.
- [fixtures/vectors/oracle.json](fixtures/vectors/oracle.json): public read-only responses of `aggregate-oracle.near`.
- `stubs/`: our own labelled test doubles, written against the documented interfaces of `v1.signer`, `aggregate-oracle.near` and NEP-141.

**Tooling, not distributed:**
- Build: Rust 1.97.1, `cargo-near` 0.22.0 and the `sourcescan/cargo-near:0.22.0-rust-1.97.1` image for reproducible builds.
- Tests and demo: the NEAR sandbox binary (nearcore 2.13.4), which `near-workspaces` and `near-sandbox` download at test time. Node.js 24.
- Video only, in `tools/src/video/make.ts`: ffmpeg, Google Chrome and `playwright-core`.

## License

MIT. Third-party components and fixtures are listed in [NOTICE](NOTICE).
