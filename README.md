# Bounded mandate

A bounded trading mandate over USDC and wNEAR on NEAR Intents. An owner delegates trading to an AI agent; a contract owns the Intents account, builds every signed order itself and obtains its own MPC signatures. The agent can only propose trades within immutable limits. The owner can withdraw outstanding signed authority and recover assets without the agent, oracle or MPC.

## Status

All local acceptance gates (T1-T5, boundary and model) pass in sandbox at commit `426914d`: our contract and the exact mainnet Intents verifier WASM execute locally, with labelled test doubles for the MPC signer, oracle and tokens. The model gate replays a genuine recorded model interaction. **No mainnet transaction has been executed**; that integration needs separately approved accounts and budget. An independent fresh clone of that commit passed `make test` and `make demo` without funds, model credentials or private-repository access; its outputs are in [evidence/426914d](evidence/426914d/run.json). See [SPEC.md](SPEC.md) for the requirements.

## What it guarantees, and what it does not

The claim: after removal of the grant's signing key is confirmed, withheld signed orders fail, including after a regrant; the owner recovers the remaining assets without the agent, oracle or MPC.

Not guaranteed: principal, profit, execution availability or a maximum total loss. Market moves, stale references, fees and orders still executable when the loss breaker trips can lose more than the stated 0.5% execution concession. While revocation is pending, already-signed orders may still execute. The owner is trusted and keeps upgrade authority. NEAR, the Intents verifier and the token contracts must keep working.

## How it works

- **Agent.** A separate account whose only key is a function-call key for `propose_order` with a finite allowance. A proposal names only the asset to sell, the amount and a concession of at most 50 bps. It cannot name recipients, payloads, keys, paths or token IDs.
- **Contract.** It reserves exposure and charges turnover before any external call, reads both oracle prices and its verifier balances, re-checks every cap and the loss breaker, then builds an exact NEP-413 `token_diff` with a versioned nonce and a short deadline. It signs through its own MPC derivation path `mandate/v1/<epoch>`, which is never reused.
- **Accounting.** A reservation is released exactly once, and only on trusted evidence: the verifier reports the nonce used, block time passes the deadline, or removal of the covering key is confirmed. A signature published by the MPC whose callback failed stays reserved. Every proposal permanently charges at least `proposal_charge_bps` of turnover, so a grant accepts at most `turnover_cap / proposal_charge` proposals and storage stays bounded.
- **Revocation.** Key registration and removal are serialized. Revocation stops new authorization at once (`revoking`); confirmed removal (`revoked`) releases every reservation of that grant. Failed removal can be retried.
- **Recovery.** With the grant revoked, the owner moves each asset's verifier balance to the owner's Intents account with `mt_transfer`. No price read, signature or agent action is involved.
- **Filler.** Our own separately keyed account signs the matching side, pays the verifier fee, and submits both payloads through permissionless `execute_intents`. It never builds a replacement order after an ambiguous result.

Demo policy: per-order and outstanding caps 20% of the initial reference value, turnover cap 100%, concession at most 0.5%, oracle age at most 60 s, confidence at most 0.5%, loss breaker at 2% drawdown, deadline at most 60 s, and a per-proposal charge of 0.5%. These are demonstration settings, not proven production risk limits. With this policy the mandate account needs about 4.7 NEAR for order-record storage on top of its code storage.

## Matched baseline (T5)

We applied the same threat model to [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) (pinned 225d37d), adapted to the same USDC/wNEAR `token_diff` authority on the pinned Intents verifier. The adaptations are recorded with the results. Executed in sandbox:

- its own revocation (pause and remove the agent) leaves withheld signed orders executable;
- removing the key on Intents stops them, but a regrant re-registers the same fixed-path key and revives them;
- a signature disclosed while the signer callback fails is released from accounting, so executed volume exceeded its daily cap.

Over-cap, injected-withdrawal and owner-recovery cases are blocked by both designs. The evidence page claims an increment only where the matching mandate gate passed in the same revision.

## Layout

| Path | Contents |
| --- | --- |
| [SPEC.md](SPEC.md) | Pinned product specification; origin and hash in [spec-source.json](spec-source.json). |
| `contract/` | Rust mandate contract; `contract/tests/` holds the sandbox and adversarial gate suites. |
| `stubs/` | Labelled test doubles for the MPC signer, oracle and tokens. |
| `baseline/` | Claw Guard design adapted for the matched comparison. |
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

`make demo` replays the recorded model output, so it needs no API key. To record a new model interaction, run `tools/src/agent/record.ts` with a model provider, then list the file in `fixtures/manifest.json`.

## Known limits

- A transient price reading below the breaker threshold stops new authorization for the rest of that grant.
- Owner transactions return before the detached key-registration or removal receipts finish; tools poll `get_grant`.
- If the key-registration callback were lost (for example, out of gas), removal, regrant and recovery stay blocked. Clearing that needs a redeploy by whoever holds a key for the mandate account. The demo deploys without any key, so there it cannot be cleared. Callback gas is fixed and tested.
- Sandbox timing does not represent mainnet latency.

## License

MIT. Third-party components and fixtures are listed in [NOTICE](NOTICE).
