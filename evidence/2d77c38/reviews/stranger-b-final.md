# Stranger reviewer B: final closure

Reviewed the locally assembled judge-facing material on 2026-11-12. Product checkout HEAD is `2d77c38b17da3f2611dbf9f4fb11f7952acb199c`. At review time README, docs/comparison.md, docs/live-runner.md, docs/reviewers.md and evidence/index.json were modified, and evidence/2d77c38/ was untracked. **These bundle and documentation changes are an uncommitted assembly at review time.** That does not change the source identity of the recorded clean acceptance run: 2d77c38.

Scope: judge entry points and recorded evidence only. No implementation source inspection, npm install, Git mutation, full gate, lab, example or model rerun. Original review preserved at `/tmp/bm-stranger-b.md`.

## Outcome

**The original default-verification finding is closed for this assembled snapshot. No remaining reproducible command/documentation inconsistency found within this closure scope.**

Exact advertised command, executed from the product root:

```text
make verify
exit 0
VERIFIED: evidence/2d77c38 (28 passed, 0 failed, 0 not verified, 1 skipped). Recorded evidence only; the tests were not rerun.
```

This matches README and the exact expected line in docs/reviewers.md. It checks 131 files against SHA256SUMS, exactly 48 required cases, every gate report bound to acceptance run `20261112T141251978Z-dc337e7cb4de`, the current spec, fixtures and deployment candidate. REPLAY, LAB and EXAMPLE are now present rather than missing. It skips mainnet explicitly. Log: `out/stranger-b/final-verify.log`.

## New and original certification identities

The README, reviewer guide and index consistently identify **2d77c38 as the later 48-case / 20-gate sandbox certification**, including the lab, alternatives view, historical-proof reader rules and independent example. They keep standalone visitor lab sessions and example runs labelled uncertified. The final page's displayed labels identify 2d77c38, 20/20 certified for that demo, self-defined certification rather than external audit, labelled test doubles, and no mainnet execution.

The acceptance record is complete/certified, dirty=false, 48 cases, revision 2d77c38. Recorded CI summary and CI job data name run `43234752930`, head 2d77c38, successful test/demo, no-Rust quick/example and Node20-reader jobs. I inspected these recorded records; I did not query GitHub again or rerun heavy gates in this closure.

README's Mainnet runner section, docs/live-runner.md and the compatibility section clearly preserve **b480057 as the funded-run candidate** with the original 37-case certification. The new certification is not assigned retroactively to that runner. New REPLAY tests are explicitly synthetic archival-RPC cases, not a mainnet replay. The docs continue to say no own mainnet signing, trade, key removal, rejection or recovery has run.

Independently compared every file of `evidence/b480057/` with the GitHub original checkout at detached `1b9d2ea9e5fcbe282e86743a96513f63582e4b0c`: 62 files, zero byte differences, zero extras. The original-root checkout was clean. The old bundle was preserved, not rewritten.

## Documented compatibility command

Used the supplied ready clone at the documented detached original evidence commit, and ran the exact final command from the later-reader checkout:

```text
node verify.mjs --root /tmp/bounded-mandate-original --bundle evidence/b480057 --rules bundle
exit 0
VERIFIED under the bundle's own required list (37 of 48 current cases; it lacks 11 of the currently required cases): evidence/b480057 (25 passed, 0 failed, 0 not verified, 4 skipped). Recorded evidence only; the tests were not rerun.
```

It names all eleven missing later cases and skips only their gates plus mainnet. Importantly, original SPEC.md, fixture manifest/files and deployment candidate all pass; this is not a `--no-checkout` shortcut. This matches the compatibility instructions. Log: `out/stranger-b/final-original.log`.

The future mainnet procedure explicitly requires a new hash-covered bundle preserving the original source identity; it does not tell a judge to use an unhashed external `--live` file as certified evidence. That future procedure cannot be positively exercised without the separately approved run and its receipts.

## Required absent-mainnet negatives

```text
node verify.mjs --mainnet
exit 1
NOT VERIFIED mainnet: evidence/2d77c38/live-mainnet.json does not exist
NOT VERIFIED: evidence/2d77c38 (28 passed, 0 failed, 1 not verified, 0 skipped).

node verify.mjs --root /tmp/bounded-mandate-original --bundle evidence/b480057 --rules bundle --mainnet
exit 1
NOT VERIFIED mainnet: evidence/b480057/live-mainnet.json does not exist
NOT VERIFIED under the bundle's own required list (37 of 48 current cases; it lacks 11 of the currently required cases): evidence/b480057 (25 passed, 0 failed, 1 not verified, 3 skipped).
```

Both fail closed for absent receipts as documented. Logs: `out/stranger-b/final-mainnet.log`, `out/stranger-b/final-original-mainnet.log`.

Trust limits remain appropriately stated: verification checks recorded consistency and does not rerun tests; unsigned SHA256SUMS cannot detect a self-consistent rewrite; current verifier code matching is not proof of historical execution. `git diff --check` passed for the assembled documentation/index changes. No product or Git edits were made by this reviewer.
