# Public targets: test, check, demo, quick, lab, example, page, live, challenge, verify. Everything else is an implementation detail.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := test
.PHONY: test test-rust test-ts check demo quick lab example page live challenge verify

CONTRACT_CRATES := $(patsubst %/Cargo.toml,%,$(wildcard contract/Cargo.toml stubs/*/Cargo.toml baseline/*/Cargo.toml))
NPM_CI := cd tools && npm ci --no-audit --no-fund --ignore-scripts
TSX := cd tools && npx --no-install tsx
EXAMPLE_CI := cd examples/strategy-client && npm ci --no-audit --no-fund --ignore-scripts
# Browser tests need a pinned headless Chromium; install is idempotent and needs no credentials.
BROWSER := cd tools && npx --no-install playwright install chromium >/dev/null

# The fault-injection build is a separately named test WASM; --no-abi keeps production artifacts untouched.
define build_wasm
	for crate in $(CONTRACT_CRATES); do \
	  cargo near build non-reproducible-wasm --locked --manifest-path "$$crate/Cargo.toml" >/dev/null; \
	done
	cargo near build non-reproducible-wasm --locked --manifest-path contract/Cargo.toml --features fault-injection --no-abi --out-dir target/near/bounded_mandate_fault >/dev/null
	mv target/near/bounded_mandate_fault/bounded_mandate.wasm target/near/bounded_mandate_fault/bounded_mandate_fault.wasm
endef

# Every acceptance report is bound to this run: run.ts start records the run and clears old results.
RUN_ID = MANDATE_RUN_ID="$$(cat $(CURDIR)/out/run/run_id)"

test:
	$(NPM_CI)
	$(EXAMPLE_CI)
	$(BROWSER)
	$(TSX) src/checks/run.ts start
	$(TSX) src/checks/integrity.ts
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	cargo clippy -p bounded-mandate --all-targets --locked --features fault-injection -- -D warnings
	$(call build_wasm)
	$(TSX) src/checks/run.ts wasm
	cd tools && npm run lint && npm run typecheck && npm run build
	# The Rust and TypeScript suites run at the same time, four tests each, so their sandboxes stay within one machine's capacity.
	$(RUN_ID) $(MAKE) --no-print-directory -j2 test-rust test-ts
	$(TSX) src/release/main.ts links
	$(TSX) src/release/main.ts secrets
	$(TSX) src/release/main.ts licenses
	# The committed bundle must be internally consistent; `make verify` is the full checkout-bound check.
	node verify.mjs --no-checkout --rules bundle
	$(TSX) src/checks/gates.ts
	$(TSX) src/checks/acceptance.ts

# With cargo-nextest installed every Rust test runs in its own process, in parallel (the workspace has no doctests);
# without it, cargo test runs the test binaries one after another and is several times slower.
test-rust:
	if cargo nextest --version >/dev/null 2>&1; then cargo nextest run --workspace --locked --no-fail-fast --test-threads 4 --status-level fail --final-status-level slow; else cargo test --workspace --locked; fi
	cargo test -p bounded-mandate --lib --locked --features fault-injection

test-ts:
	cd tools && npm test -- --maxWorkers 4

# Fast checks while editing (about a minute): formatting, lint, types, the contract's unit tests and the TypeScript tests
# that need no sandbox or browser. Not an acceptance run; make test is.
QUICK_TS_EXCLUDE := live-sandbox live-handoff live-challenge lab-workflow lab-isolation lab-page lab-alternatives console-wallet-sandbox console-access-controls console-browser-sandbox verify-mainnet attacks-boundary example filler-sandbox model-gate checks-acceptance page-layout
check:
	$(NPM_CI)
	cargo fmt --all --check
	cd tools && npm run lint && npm run typecheck
	cargo test -p bounded-mandate --lib --locked
	cd tools && npx --no-install vitest run $(foreach t,$(QUICK_TS_EXCLUDE),--exclude test/$(t).test.ts)

demo:
	$(NPM_CI)
	$(BROWSER)
	$(call build_wasm)
	$(TSX) src/demo/main.ts

# The demo story without Rust: the deployment candidate and hash-pinned prebuilt test doubles (fixtures/prebuilt).
# Prebuilt and uncertified; writes only out/quick/. make test and make demo are the certified path.
quick:
	$(NPM_CI)
	$(BROWSER)
	$(TSX) src/quick/main.ts

# The sandbox lab: a local service a visitor operates in a browser (127.0.0.1:8791; LAB_* in tools/src/lab/config.ts).
# Deployment candidate + hash-pinned prebuilt test doubles; no Rust; sandbox only.
lab:
	$(NPM_CI)
	$(TSX) src/lab/main.ts

# The integration example: the independent strategy client (examples/strategy-client) against a local sandbox, no Rust.
# Sandbox with prebuilt test doubles, uncertified; writes only out/example/.
example:
	$(NPM_CI)
	$(EXAMPLE_CI)
	$(TSX) src/example/main.ts

# Checks the committed evidence bundle without a toolchain (Node 20+, no install); it does not rerun the tests.
verify:
	node verify.mjs

page:
	$(TSX) src/page/main.ts

live:
	@if [ "$${MANDATE_LIVE:-}" != "1" ]; then echo "live: set MANDATE_LIVE=1 and MANDATE_LIVE_MANIFEST=<approved manifest>; the flag is not spending approval" >&2; exit 2; fi
	$(NPM_CI)
	$(call build_wasm)
	$(TSX) src/live/main.ts

# The optional open challenge (open, or close after judging) against a separately approved challenge manifest.
challenge:
	@if [ "$${MANDATE_LIVE:-}" != "1" ]; then echo "challenge: set MANDATE_LIVE=1 and MANDATE_LIVE_MANIFEST=<approved challenge manifest>; the flag is not spending approval" >&2; exit 2; fi
	$(NPM_CI)
	$(call build_wasm)
	$(TSX) src/live/challenge.ts
