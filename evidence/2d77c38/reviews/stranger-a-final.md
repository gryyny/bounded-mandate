# Stranger A: final finding closure

Reviewed the assembled product working tree on 12 November 2026 at `$CHECKOUT`, using only judge-facing README, linked documentation, evidence index and verifier commands. No implementation source inspection, npm install, source edit or Git write. This is a follow-up to `/tmp/bm-stranger-a.md`; the earlier lab/comparison/example observations remain separately scoped.

**Assembly state matters:** HEAD is `2d77c38b17da3f2611dbf9f4fb11f7952acb199c`, but README, three linked docs and evidence/index.json are modified, and `evidence/2d77c38/` is untracked. The results below apply to this assembled working tree. They do not claim the new bundle/docs are already present in HEAD, a pushed commit, or a fresh public clone.

## Reproduced commands

All commands ran from the later product reader's checkout above. Logs are in its ignored `out/stranger-a/`.

| Command | Exit | Result |
|---|---:|---|
| `make verify` | 0 | `VERIFIED: evidence/2d77c38 (28 passed, 0 failed, 0 not verified, 1 skipped). Recorded evidence only; the tests were not rerun.` |
| `node verify.mjs --root /tmp/bounded-mandate-original --bundle evidence/b480057 --rules bundle` | 0 | `VERIFIED under the bundle's own required list (37 of 48 current cases; it lacks 11 of the currently required cases): evidence/b480057 (25 passed, 0 failed, 0 not verified, 4 skipped).` |
| `node verify.mjs --mainnet` | 1 | No `evidence/2d77c38/live-mainnet.json`; 28 passed, 0 failed, 1 not verified, 0 skipped. No mainnet verified. |
| `node verify.mjs --root /tmp/bounded-mandate-original --bundle evidence/b480057 --rules bundle --mainnet` | 1 | No original `evidence/b480057/live-mainnet.json`; 25 passed, 0 failed, 1 not verified, 3 skipped. No mainnet verified. |

The original-root compatibility command checks the original spec hash `f75c6f31613a480a2dbc7951552e14f2f60af1f6d499439ce7f6385825da34f5`, original fixtures and deployment candidate rather than skipping them. It does not assign the eleven expanded cases to the original certification. The original clone at `/tmp/bounded-mandate-original` was supplied ready at its original evidence commit `1b9d2ea`; I ran the documented final reader command without changing that clone.

Logs: `verify-final.log`, `verify-original-root-final.log`, `verify-mainnet-final.log`, `verify-original-mainnet-final.log`.

## Documentation and scope closure

The earlier concrete finding is closed in the assembled tree: README's `make verify` promise now matches its actual successful output, and docs/reviewers.md quotes the exact final line I observed. The new index identifies 2d77c38 as the 48-case/20-gate certification and records fresh-clone and CI run 43234752930 evidence. I inspected these records, but did not independently rerun the heavy gates or query CI in this follow-up.

README clearly separates the certified implementation from individual uncertified sandbox lab/example runs. It states test doubles, no live model-provider call, no mainnet transaction, no hosted lab, planned unpublished public links and no adoption. The spec snapshot's older status wording is explicitly placed in its pinned-source-date context, while evidence/index.json owns current execution status.

README and docs/live-runner.md preserve b480057 as the funded-run candidate; the latter explicitly requires a clean checkout at exactly b480057 for `make live`, along with the separate approvals. The command examples are templates rather than authorization. The compatibility section now directly documents the later reader, original input root, `--rules bundle`, and why `--no-checkout` cannot establish a historical replay. For a future mainnet run it requires a new hash-covered `evidence/mainnet/b480057/` bundle without rewriting the original evidence or substituting the later reader/demo's source identity.

The absent-mainnet negative behaves as documented for both current and original bundles. Nothing about a passing offline check establishes mainnet signing, settlement, revocation timing, recovery or an archival replay. The documented archival proof still requires identical bundle acceptance before removal and missing-key rejection after it, before deadlines and with matched code identities; unavailable historical state is inconclusive.

**Remaining judge-facing command inconsistency found: none in the commands and scope reviewed.** Completion of the bundle/doc assembly commit remains necessary before claiming these exact artifacts are available from the repository's HEAD or a fresh clone. No further functional claim is made about the earlier optional export/replay uncertainty; it was not repeated in this bounded closure review.
