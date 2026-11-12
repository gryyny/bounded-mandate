# Bounded Mandate presentation checklist

Date: 2026-11-12. Local only; no public-network transactions or live inference.

1. Actual generated sandbox page at desktop and 390 × 844: readable first screen, no horizontal overflow, navigation targets resolve, recorded replay advances and labels provenance.
2. Watch and walkthrough links open both actual newly rendered MP4s in Chrome. Decode, seek and inspect opening, revocation, acceptance and closing frames; no clipped frame or false mainnet footage.
3. Unavailable lab: page configured for a local unreachable endpoint; clicking Try and Compare opens nothing, says nothing ran and offers labelled recorded replay. No network requests before interaction.
4. Mainnet states: absent evidence, incomplete evidence, failed revocation, and incomplete successful-looking evidence do not generate a success segment. Synthetic test specimens are visibly labelled synthetic outside any release output.
5. Verify panel: invalid RPC input and unavailable endpoint produce failure/inconclusive state without claiming verified mainnet execution.
6. Owner console navigation works and read-only state disables owner actions without connected account.

Inputs: current out/evidence/demo.json and matching out/make-demo.log; new videos rendered from these. These preliminary assets predate the final implementation certification and must be regenerated afterwards.
