# Bounded Mandate presentation QA

Date: 2026-11-12. Browser: Google Chrome through isolated playwright-cli session `bm-pqa`. Local loopback only. No transaction, paid inference, deployment or publication.

## Inputs and scope

Pre-certification inspection used the actual saved sandbox demo `out/evidence/demo.json` at `d4fcfa6bf0efb3919d04acaf3be27db2a57bba8d`, matching `out/make-demo.log` (setup 16057 ms, story 19947 ms, 59/59), current page renderer and current video renderer. These inputs are not the final implementation certification. The coordinator must regenerate and repeat the final artifact check from the final clean source and matching acceptance/demo/log inputs.

Checklist: `/tmp/bm-presentation-checklist.md`. Screenshots and logs: product `out/presentation-qa/` (ignored).

## Results

| Scenario | Result | Observed |
| --- | --- | --- |
| Actual page, desktop and 390 × 844 | PASS | Lead, actions, four paths and honest sandbox/no-mainnet status readable. Mobile horizontal overflow 0 px. |
| Navigation | PASS | All generated fragment links resolve by element id (including ids with dots); Watch opens actual short cut; longer cut and console resolve under `/bounded-mandate/`. |
| Recorded replay | PASS | Eight expandable recorded steps plus detailed state/receipt observations; clearly described as recorded sandbox, not interactive execution. |
| DAO preset | PASS | Current actual evidence renders pinned Sputnik, 2-of-3 threshold workflow and per-check details. Recorded sandbox/noninteractive and no DAO mainnet governance UI explicitly stated. Desktop/mobile readable; mobile overflow 0 px. |
| Owner console | PASS | Route loads. Five owner Review controls disabled without an owner account; read-only and connect controls available. No connection or signature attempted. |
| Invalid RPC | PASS | `http://127.0.0.1:18999` refused with `Enter an RPC URL that starts with https.` No mainnet proof substituted. |
| Unavailable lab | PASS | Local page configured for absent endpoint. Both Try and Compare remain on the page and say unreachable, `Nothing was run`, recorded replay or `make lab` offered. Expected failed-fetch console errors are not successful runs. |
| Mainnet absent | PASS | Actual page and both actual cuts explicitly say no mainnet transaction. Actual video manifest has no mainnet segment. |
| Mainnet incomplete / failed | PASS (synthetic presentation tests) | Clearly labelled local synthetic specimens show inconclusive/failed revocation. Video rule tests omit the mainnet segment for failed/incomplete/unbound evidence. Not mainnet evidence. |
| Mainnet future segment geometry | PASS (synthetic presentation tests) | Real Chromium rendered all short/walkthrough segment frames with invented receipts, using the production frame-fit assertions. Temporary test frames deleted; none enter release media. |
| Actual new short video | PASS | Chrome decodes 1920 × 1080, duration 85.866667 s; seek to 46 s inspected revocation frame. No mainnet segment; provenance remains sandbox/test signer. |
| Actual new walkthrough | PASS | Chrome decodes 1920 × 1080, duration 224.0 s. Repaired gate pages at 137 s and 144 s inspected; all 48 required cases retained and readable. All rendered frames passed clipping/overlap gate. |

Python SimpleHTTPServer does not serve byte ranges, so Chrome could play but could not seek beyond its initial buffer. For actual video inspection an isolated local range-capable server at port 8798 served the same files; decoded time was checked after seeking. This was QA infrastructure, not a product defect or hosting/deployment test.

## Reproducible finding fixed

The expanded 48-case gate inventory overflowed the walkthrough frame: rendering failed at `Acceptance gates per case: 48 of 48 passed`, body `873 > 690 px`. The renderer now paginates ten gate rows per slide, retains every case and keeps the emergency owner-key rescue separate. A unit regression checks that no case is omitted or repeated; real Chromium frame-fit tests cover the inventory and the future mainnet segment. No assertion was relaxed.

The DAO link adds a second anchor inside the fallback description; the existing layout test's ambiguous selector was narrowed to the replay anchor. User-visible links remain intact.

## Checks actually run

- `node node_modules/vitest/vitest.mjs run test/video-layout.test.ts test/video-short.test.ts test/page-layout.test.ts test/page-landing.test.ts`: 4 files, 80/80 passed, no skipped tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- `node --import tsx src/video/make.ts --log ../out/make-demo.log`: both cuts rendered; 85.9 s and 224.0 s. The first attempt reproduced and failed on clipping before the fix.
- `node --import tsx src/page/main.ts`: current page generated and inspected.

Initial sandboxed Chromium invocation failed due environment permissions and was not counted as pass. All reported browser checks ran successfully outside the sandbox against loopback services.

## Final artifact repeat

Pending coordinator's final implementation certification and matching demo inputs. No mainnet run exists; a synthetic completed segment is a layout test only and must never be labelled an actual funded run. Public-host behavior remains untested because hosting is not authorized.
