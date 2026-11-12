# Independent stranger review B

Reviewed 2026-11-12. Product checkout: `$CHECKOUT`; starting clean HEAD `2095d00152e43a2c0fffcd6583d6cbc7ce1bfdc5`. Node observed `v26.12.0` (docs request Node 24), macOS. Read only AGENTS, README, SPEC, linked reviewer/comparison docs, committed evidence, and generated `out/page/index.html` through the browser. No implementation source inspection, edits, staging, commits, pushes, heavy gate or model calls. Browser session `bm-b`, lab `LAB_PORT=8793`, static page port 8894. Artifacts under ignored `out/stranger-b/`.

## What I independently understood

This is a narrow treasury control system for trading USDC/wNEAR through Intents. The agent can propose trades but cannot choose arbitrary signing bytes or a withdrawal recipient. The contract owns the limits and signing path. Its useful extra control is that the owner can invalidate already-issued, still-unexpired orders together by removing the grant's verifier key, then resume using a fresh key without restoring old authority. Recovery transfers the remaining balances to the owner's Intents account, which is different from withdrawing them to the owner's NEAR account.

This is a useful authority/control claim, not a profitable-strategy claim or a bound on total losses. Poor permitted trades remain possible. The gain over expiry is bounded by the order lifetime, and only begins after confirmed removal. The docs clearly disclose these limits, no customers/adoption, sandbox test doubles, the self-defined meaning of certified, and no mainnet run. I would not read it as a unique cryptographic primitive: the complete control/accounting/lifecycle combination is the offered product.

## Confirmed issue

**P2: the advertised default verification command fails on the supplied checkout.** README's Run it table promises `make verify` ends in `VERIFIED: evidence/b480057`; reviewers.md repeats the old 25-pass expected line. Actual `make verify` ends `NOT VERIFIED: evidence/b480057 (23 passed, 5 failed, 0 not verified, 1 skipped)` and Make exits Error 1. Current requirements contain 48 cases, while the bundle has 37; REPLAY, LAB and EXAMPLE reports are absent from that bundle, and current SPEC hash differs. This is honest verifier behavior, but a reproducible judge-facing command/expectation mismatch. Raw output: `out/stranger-b/verify.log`.

`node verify.mjs --rules bundle --no-checkout` exits 0 and explicitly says verified under the bundle's own 37-of-48 list, lacking 11 current cases, with checkout checks skipped. That is an appropriate historical-bundle result and does not repair the default-command claim. Log: `verify-bundle.log`. Parent coordinator said this observed gap would be addressed by final certification; I did not retest a later snapshot.

No confirmed defect in the exercised treasury workflow or comparison outcomes.

## Commands and observed outcomes

- `LAB_PORT=8793 make lab`: initial sandboxed execution was blocked by the tool environment's tsx IPC socket `EPERM`, not attributed to the product. Same command outside that local restriction starts successfully, prints TEST DOUBLES/no-mainnet label and revision 2095d001. Log `lab-server.log`.
- `make example`: same local socket restriction initially; rerun outside it exits successfully. The independent client reports accepted order 0 (`38003600` USDC units, signed), refused proposal `760072014` units with `per-order cap exceeded`, and revoked with `grant is not active`; harness says all three observations match the chain. `example.log`, plus generated `out/example/result.json`. It is explicitly prebuilt sandbox uncertified, not mainnet.
- `node verify.mjs --mainnet`: exits 1, no `evidence/b480057/live-mainnet.json`, no mainnet receipts, nothing on mainnet verified. `verify-mainnet.log`.
- `cd tools && npx --no-install tsx src/lab/replay.ts ../out/stranger-b/scenario.json --fast`: exits 0, all 14 actions `same`, ends `replay matches: 14 actions with the same outcomes`. The replay reports current tree dirty (other work was active after the initial clean read), not certified. `replay.log`.
- Operated browser through semantic Playwright locators, not internal application state or source. Exact actions/code and returned UI text are retained in the corresponding logs.

## Operate workflow, my own sandbox treasury

Started at 1,000 USDC and 300 wNEAR. Granted the default policy, with 120 s sandbox price age and order TTL (clearly distinguished from demo's 60 s).

1. Permitted trade: sold 50 USDC at 20 bps concession; contract signed minimum `16.630006` wNEAR (UI precision), filler filled and settlement released reservation.
2. Unsafe size: sold 600 USDC, refused `per-order cap exceeded`.
3. Unsafe price: 50 USDC at 500 bps, refused `concession above policy maximum`.
4. Poor but permitted: 50 USDC at maximum 50 bps, signed minimum `16.580016` wNEAR and filled. This demonstrates that policy compliance is not economic goodness.
5. Proposed a third 50 USDC/20 bps order (id 2); Withhold reports the verifier dry-run accepts the complete bundle.
6. Revoked: grant revoked, key absent, outstanding 0. Relayed that withheld order: verifier refused before deadline because `ed25519:CiTakSc116UQUARhS9VTSbHH98bVFF3KPGU7N9jigW1Y` did not exist for `mandate.s308edf2772.sandbox`. Revoke tx `BHupmtoiqTEAfXB4MbYQQ4dVBg34GvaCaGfgaP12bqr3`; relay tx `9R3xRVCRuYpTDbBFpN6ZubBRo4iWhXRAVHEhspJAoKu4`.
7. Made the oracle fail and MPC signer fail, then Recover: mandate 0/0; owner's Intents account 900 USDC + 333.210023 wNEAR, same remaining treasury assets. Turnover stayed 7.89%, not refunded by releasing reservations.

Logs: `operate-trades.log`, `withheld-revoke-relay.log`, `recovery.log`. Screenshot `recovered.png`. Export required clicking Export scenario then its displayed Download the file link (normal UI behavior, not a defect); saved `scenario.json`, which includes revision, binaries, test doubles, actions and results. All 14 actions replayed as above.

## All six alternatives reproduced independently

Each run displays equal starting conditions: 10 USDC, three 1 USDC signed orders withheld, two in the owner's external ledger and one absent. These are verifier-level experiments with a labelled test key, not the mandate's full owner lifecycle or mainnet latency.

| Action | My observed outcome |
| --- | --- |
| Complete nonce list | 3 account-key signatures, 0/3 orders executed (`nonce was already used`); a new same-key order executed after resumption. |
| Incomplete nonce list | 2 signatures, 1/3 executed: the missing order; listed two refused used nonce. New same-key order executed. |
| Signer unavailable | Complete list with a different, unregistered key did not cancel; 3/3 orders executed. |
| Remove key, fresh key | 0/3 old orders executed before deadline, all missing-key errors; fresh-key new order executed; old order still refused after resumption. |
| Remove and re-add same key | 0/3 executed while removed, then 3/3 executed after re-add. |
| Stop issuing / wait expiry | 3/3 outstanding orders executed before deadline; a separate withheld 10 s order refused after expiry (`deadline has expired`). |

Logs `compare-complete.log`, `compare-five.log`; screenshot `comparison.png`. No outcome discrepancy. Full cancellation is a valid alternative when signer and full list are available. Key rotation avoids both dependencies but needs an owner transaction, confirmed removal and new key setup. The small TTL window limits the practical increment; the docs acknowledge this.

## Evidence trust and historical proof challenge

The generated `out/page/index.html` I opened was a saved d4fcfa6 demo with 20/20 gates certified for that demo, while README/committed index still pointed at b480057. Its provenance shows the demo and acceptance binding, and its wording distinguishes this saved revision from the live checkout. Screenshot `evidence.png`; UI text `evidence-page.log`.

I opted into its read-only panel. Against `https://archival-rpc.mainnet.fastnear.com` at `2026-11-12T13:57:59.903Z`, network/genesis check passed and current `intents.near` code hash equaled pinned `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`. It correctly states no mainnet receipts exist and keeps recorded sandbox facts separate. `mainnet-result.log`. This validates only the RPC's current-code answer, not our own signing, removal, recovery, latency or historical replay.

The historical proof rules are suitably specific in the judge docs: exact on-chain relay bundle bound to an earlier signed order; snapshot before the actual remove-key receipt block versus that receipt block; key present/absent; exact bundle simulated at both; both times and rejected relay before deadline; code hashes pinned. Failure/inconclusive must not become verified. Current-state key absence alone cannot establish historical timing. However, there is no real archival mainnet instance to challenge today: current REPLAY describes synthetic RPC-stub rule tests, and none were rerun in this review. I cannot independently establish genuine-mainnet replay functionality from the documentation and absence of receipts.

Unsigned SHA256SUMS establishes consistency against a recorded manifest, not authentic origin against an author who can rewrite reports and hashes together. Committed clean source/revision/run bindings and a personal rerun increase confidence; no heavy test rerun was authorized for this stranger review. Genuine recorded model output is different from a model live in the loop. A pinned mainnet verifier executed locally is different from a transaction on mainnet. These boundaries were legible, and I found no accidental mainnet-success implication in the exercised panels.

## Cleanup

Clicked End session and observed `Session ended; its sandbox world is gone.` Closed only browser session `bm-b`, stopped my lab process (8793) and static server (8894). No other reviewer's session/process was intentionally touched. All review artifacts remain ignored under `out/stranger-b/`; report is `/tmp/bm-stranger-b.md`.
