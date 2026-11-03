# Repository instructions

Read [README.md](README.md) and [SPEC.md](SPEC.md) first. This repository is self-contained: build, test and demo must work from a fresh clone without funds, model credentials or any private repository.

## Scope

- [SPEC.md](SPEC.md) owns required behavior. It is a pinned snapshot; [spec-source.json](spec-source.json) records its origin and hash. Do not edit it here; requirement changes arrive as a deliberate snapshot update with matching tests.
- `contract/` is the only production contract crate. `stubs/` holds explicitly labelled test doubles for external protocols (MPC signer, oracle, fungible tokens). Never present a stub result as a mainnet result.
- `tools/` is the TypeScript package for the model adapter, filler, replay, evidence and static page.
- `fixtures/` holds curated external inputs with hashes and provenance in `fixtures/manifest.json`. Generated output goes to ignored `out/`.

## Rules

- Rust owns contract semantics. Do not duplicate policy logic in TypeScript or tests and call that verification.
- Checked integer arithmetic only; JSON amounts are decimal strings.
- The agent role may only call `propose_order`. No agent-reachable path may sign arbitrary bytes, choose recipients, mutate keys or policy, or disable predecessor authorization.
- Missing or mocked checks are not passes. Never weaken an assertion to turn a gate green. Tests carry `gate: <ID>` tags; skipped tests do not count.
- Expected values in tests come from execution or independent derivation, not hard-coded results copied from a run.
- Keep credentials, generated builds and local agent state untracked. No hook or CI job may transact on a public network, deploy or publish.

## Parallel work

- One coordinator owns shared interfaces (`contract/src/types.rs`, `tools/src/types.ts`), manifests, lockfiles, CI, Makefile, fixture manifest and Git writes.
- Workers edit only their assigned files, run scoped checks, and hand off changed paths, commands/results, interface changes and remaining uncertainty. Workers do not stage, commit, push or switch branches.

## Verification

- `make test`: integrity, Rust fmt/clippy/build/tests (unit, property, sandbox), TypeScript lint/typecheck/build/tests, gate inventory.
- `make demo`: complete unfunded scenario and generated static page.
- `MANDATE_LIVE=1 make live`: opt-in against a separately approved manifest. The flag is not spending approval.
- Evidence records the source revision, dirty state, spec and fixture hashes, environment, command, mode and result. Label sandbox execution, recorded model output and mainnet receipts distinctly.

`CLAUDE.md` imports this file. Keep shared rules here.
