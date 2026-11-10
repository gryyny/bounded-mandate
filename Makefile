# Public targets: test, demo, quick, page, live, challenge, verify. Everything else is an implementation detail.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := test
.PHONY: test demo quick page live challenge verify

CONTRACT_CRATES := $(patsubst %/Cargo.toml,%,$(wildcard contract/Cargo.toml stubs/*/Cargo.toml baseline/*/Cargo.toml))
NPM_CI := cd tools && npm ci --no-audit --no-fund --ignore-scripts
TSX := cd tools && npx --no-install tsx
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
	$(BROWSER)
	$(TSX) src/checks/run.ts start
	$(TSX) src/checks/integrity.ts
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	cargo clippy -p bounded-mandate --all-targets --locked --features fault-injection -- -D warnings
	$(call build_wasm)
	$(TSX) src/checks/run.ts wasm
	$(RUN_ID) cargo test --workspace --locked
	$(RUN_ID) cargo test -p bounded-mandate --lib --locked --features fault-injection
	cd tools && npm run lint && npm run typecheck && npm run build && $(RUN_ID) npm test
	$(TSX) src/release/main.ts links
	$(TSX) src/release/main.ts secrets
	$(TSX) src/release/main.ts licenses
	# The committed bundle must be internally consistent; `make verify` is the full checkout-bound check.
	node verify.mjs --no-checkout --rules bundle
	$(TSX) src/checks/gates.ts
	$(TSX) src/checks/acceptance.ts

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
