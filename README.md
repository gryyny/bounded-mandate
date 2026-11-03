# Bounded mandate

A bounded trading mandate over USDC and wNEAR on NEAR Intents. An owner delegates trading to an AI agent; a contract owns the Intents account, builds every signed order itself and obtains its own MPC signatures. The agent can only propose trades within immutable limits. The owner can revoke outstanding signed authority and recover assets without the agent, oracle or MPC.

**Status: in development.** No acceptance gate has passed yet. See [SPEC.md](SPEC.md) for required behavior and acceptance tests.

## Layout

| Path | Contents |
| --- | --- |
| [SPEC.md](SPEC.md) | Pinned product specification; origin and hash in [spec-source.json](spec-source.json). |
| `contract/` | Rust mandate contract and its tests. |
| `stubs/` | Labelled test doubles for the MPC signer, oracle and tokens. |
| `tools/` | TypeScript model adapter, filler, replay, evidence and static page. |
| `fixtures/` | Pinned external inputs with provenance in `fixtures/manifest.json`. |

## Requirements

- Rust via rustup (toolchain pinned in `rust-toolchain.toml`) and `cargo-near` 0.22.0 (`cargo install cargo-near --version 0.22.0 --locked`).
- Node.js 24 and npm.
- Network access for dependency installation and the first download of the NEAR sandbox binary. No funds, model key or private repository access.

## Commands

```sh
make test   # all local gates
make demo   # unfunded sandbox scenario and static page
MANDATE_LIVE=1 MANDATE_LIVE_MANIFEST=<approved manifest> make live   # opt-in; not spending approval
```

## License

MIT. Third-party components and fixtures are listed in [NOTICE](NOTICE).
