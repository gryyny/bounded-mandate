# Public targets: test, demo, live. Everything else is an implementation detail.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := test
.PHONY: test demo live

CONTRACT_CRATES := $(patsubst %/Cargo.toml,%,$(wildcard contract/Cargo.toml stubs/*/Cargo.toml))
NPM_CI := cd tools && npm ci --no-audit --no-fund --ignore-scripts
TSX := cd tools && npx --no-install tsx

define build_wasm
	for crate in $(CONTRACT_CRATES); do \
	  cargo near build non-reproducible-wasm --locked --manifest-path "$$crate/Cargo.toml" >/dev/null; \
	done
endef

test:
	$(NPM_CI)
	$(TSX) src/checks/integrity.ts
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	$(call build_wasm)
	cargo test --workspace --locked
	cd tools && npm run lint && npm run typecheck && npm run build && npm test
	$(TSX) src/checks/gates.ts

demo:
	$(NPM_CI)
	$(call build_wasm)
	$(TSX) src/demo/main.ts

live:
	@if [ "$${MANDATE_LIVE:-}" != "1" ]; then echo "live: set MANDATE_LIVE=1 and MANDATE_LIVE_MANIFEST=<approved manifest>; the flag is not spending approval" >&2; exit 2; fi
	$(NPM_CI)
	$(call build_wasm)
	$(TSX) src/live/main.ts
