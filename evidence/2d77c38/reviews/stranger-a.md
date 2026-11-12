# Independent stranger review A

Reviewed 12 November 2026. Product location: `$CHECKOUT`. Operating runs used isolated local clone `/private/tmp/bm-stranger-a-clone` at revision `2095d00152e43a2c0fffcd6583d6cbc7ce1bfdc5`. No implementation source was inspected. Inputs were AGENTS.md, README.md, SPEC.md (required by AGENTS), linked reviewers/comparison documentation, the generated evidence page, CLI help, and public lab UI. No coaching on answers. No tracked edits or Git writes.

## Benefit, in my words

This separates deciding a trade from being able to spend a treasury arbitrarily. A strategy agent requests trades, but the contract constrains the signed authority to the owner's fixed limits. The useful difference is reaching authority that has already escaped as signed orders: after the verifier confirms removal of the grant's key, someone holding an unexpired order cannot execute it. Resuming with a different key keeps old orders dead. Recovery gives the remaining balances to the owner's Intents account without involving the agent or its signing and pricing dependencies.

This is operational control, not profitability or principal protection. Permitted poor trades still pass. The advantage over expiry lasts only as long as the remaining order lifetime, and an order that settles before removal remains settled. Withdrawal from Intents to the owner's NEAR account is a separate action.

## Commands and observed results

1. `make verify` in the shared product checkout: exit 2 from make (verifier exit 1). Files and 37 historical cases pass, but current list has 48 cases and SPEC hash changed. Final verifier line: `NOT VERIFIED: evidence/b480057 (23 passed, 5 failed, 0 not verified, 1 skipped).` This is a real documented happy-path mismatch at the reviewed snapshot: README and reviewers guide say the ordinary command ends VERIFIED. The command correctly refuses to inflate the old certification. It needs either new evidence before release or clearer instructions for the old bundle.
2. `node verify.mjs --bundle evidence/b480057 --rules bundle --no-checkout`: exit 0. Final line explicitly says `VERIFIED under the bundle's own required list (37 of 48 current cases; it lacks 11 of the currently required cases)` and `22 passed ... 7 skipped`. This verifies the historical bundle internally under its recorded list, and deliberately does not compare current SPEC, fixtures or candidate. It does not certify the new lab, example or historical-reader behavior. The help documents these flags, but the reviewers guide's main verification section does not explain this later-reader recipe.
3. `node verify.mjs --mainnet`: verifier exit 1. `NOT VERIFIED mainnet` because `evidence/b480057/live-mainnet.json` does not exist. No mainnet receipt or historical replay was claimed as verified.
4. `make example > out/stranger-a/example.log 2>&1` in isolated clone: exit 0. Allowed order 0 signed; oversized request refused with `per-order cap exceeded`; post-revoke proposal refused with `grant is not active`; all three observations checked against chain and reported matching. Final label SANDBOX WITH TEST DOUBLES (PREBUILT, UNCERTIFIED). No funds/model key needed. Exact local amounts: accepted sale 38003600 USDC units, buy 12633669760600000000000000 wNEAR units; oversized sale 760072014 USDC units.
5. `LAB_PORT=8792 make lab > out/stranger-a/lab.log 2>&1` in isolated clone: served http://127.0.0.1:8792. UI prominently labels sandbox/test doubles and shows hashes. Used independent Playwright Chrome session `bm-sa`, no global browser cleanup.

## Operated workflow

Started session, granted displayed default limits (20% order/open caps, 50 bps maximum concession, 100% turnover, 120-second lab lifetimes). Proposed permitted 50 USDC trade and filled it. Treasury became 950 USDC and 316.630006 wNEAR.

The preset 600 USDC proposal was refused `per-order cap exceeded`. The preset 5% concession proposal was refused `concession above policy maximum`. The poor-but-permitted 50 USDC sale at 50 bps was signed for at least 16.580016 wNEAR. I withheld that signed order rather than filling it. The dry run said the exact bundle was executable. I revoked, then relayed it: verifier refused before deadline because the old signing key did not exist. Finally recovered: treasury zero, owner's Intents account 950 USDC and 316.630006 wNEAR. This run did not separately disable oracle/MPC before recovery, so dependency-failure coverage remains the historical evidence claim rather than my own fresh observation.

Receipt snapshot includes revoke transaction `Ars3m8yYz9VQUtLZVTU8FrYNiLG4mK9vaTq3VXnRdqaH`, refused relay `D7XwsT8vha1rWziWDkpHD43iVayhtQ6jDZ1PQagPF4fd`, recovery USDC `8BAfS4Zyj7B7xGiZkBnsfKVXSjuZabJ4TDAm7f1na9dR`, recovery wNEAR `6LDGbphjw9YB54JBYtyvb1FvmJiS5zzkYFNWR3pbypwt`. These are sandbox identifiers.

## Reproduced Compare alternatives

Used all six buttons. Each displayed a fresh treasury with 10 USDC and three withheld 1 USDC orders, including one missing from the owner's record.

| Alternative | My observed withheld orders executed | Additional observation |
|---|---:|---|
| Stop issuing / wait expiry | 3/3 before expiry | Separate fourth order relayed after its 10 s deadline was rejected for expiry. |
| Complete nonce list | 0/3 | Three account-key signatures; new same-key order worked after cancellation. |
| Incomplete nonce list | 1/3 | Two signatures; unrecorded nonce's order executed. |
| Signer unavailable | 3/3 | Attempted cancellation with another unregistered key did not cancel them. |
| Remove key / fresh key | 0/3 | New-key order executed; old order retried after resuming still failed for missing old key. |
| Remove / re-add same key | 0/3 while absent, 3/3 after re-add | Reusing the key resurrected the unexpired orders. |

The presentation makes the mechanism clear. These comparisons use a plain verifier account and a labelled test key standing in for its signer, rather than claiming every alternative is the complete mandate lifecycle. Full cancellation is effective when the list and signer are available; key removal's difference is not needing those, plus never restoring the old key. These observations do not establish uniqueness across all products or mainnet speed.

## Historical proof challenge

Absent mainnet evidence means actual MPC signing by this deployment, real token/oracle behavior, public-network latency and the mainnet revoke/relay/recovery story remain unproven. The pinned verifier and recorded third-party signer response are useful compatibility evidence but are not a transaction by this product. `--mainnet` correctly fails rather than using sandbox proof as mainnet proof.

For a future historical replay, I would require the exact relayed bundle from chain; linkage to a previously signed mandate order; the successful removal receipt's execution block and its predecessor (not just the revoke transaction's inclusion block); key present and exact bundle accepted at the predecessor; key absent and identical bundle refused specifically for missing key after removal; all relevant block times before every deadline; relay's own receipt failing on that same missing key before expiry; and mandate/verifier code hashes matching the recorded run and candidate at both snapshots. Archival-state unavailability is inconclusive, contradictions fail. This still cannot prove when the counterparty created its signature. These are documented rules, not a replay I ran on mainnet.

For old b480057, a later reader must preserve its 37-case scope. The explicit flags above do that, while saying 11 new cases are missing. Unsigned SHA256SUMS detects partial/accidental changes, not a coherent rewrite. History and rerunning gates supply stronger trust; I did not run make test or independently audit CI. To compare old inputs rather than skip them, use the historical input checkout with the later reader's documented `--root` option; that extra historical checkout comparison was not performed here.

## Evidence page and limitations

Opened existing `out/page/index.html` via local static HTTP server; no generation was required. It identified a newer d4fcfa6 demo, a certified local acceptance run, and no mainnet; README still pointed to b480057 as the committed certified bundle. I treated the current generated page and old committed bundle as different evidence scopes. The four paths were discoverable. Try/Compare explicitly say no lab is linked and instruct `make lab`; no inaccessible hosted lab looked like a successful interactive run.

There was an environment mistake at the beginning: I launched make lab and make example together in the shared checkout, colliding in npm ci (ENOTEMPTY/tsx missing). Those are not product failures; both worked when serialized in the isolated clone. Sandbox network binding required normal sandbox escalation. Optional scenario export/replay was not completed: Playwright did not capture a download within 30 seconds after Export scenario, and the CLI session was subsequently unavailable. The replay attempt found no exported file. This leaves export behavior unconfirmed; I did not isolate whether it was browser tooling, session loss, or a product issue, and count neither a functional failure nor a passed replay. No structured code/security audit, mainnet call, live model call, heavy test suite, publication, spending, or adoption validation was performed.

Artifacts copied to product ignored `out/stranger-a/`: `verify.log`, `verify-historical.log`, `verify-mainnet.log`, `example-isolated.log`, `lab-initial.yml`, `lab-workflow.yml`, `lab-workflow.png`, `compare-final.yml`, `compare-final.png`, `evidence-page.png`. Isolated clone retains lab/example logs. No confirmed functional bug in operated lab, comparison, or example was found. The verification documentation's promised happy-path output is the concrete review finding at this snapshot.
