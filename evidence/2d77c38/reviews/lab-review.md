# Focused lab correctness review — 12 November 2026

Scope: source at product 2095d00 plus review fixes. Read both AGENTS.md files, README/SPEC context, lab transport, sessions, pool, actions, replay, client and existing acceptance tests. Used the code-review skill. No transactions, inference, hosting or publication.

## Reproduced and fixed

- End session ignored the DELETE response status. A synthetic HTTP 429 in a real browser against a real sandbox session caused the UI to claim the session ended and forget its identifier while the backend session remained. Regression before fix failed waiting for the truthful refusal message; original log /tmp/bm-lab-page-before.log is preserved. Fix: inspect status, show refusal and preserve session until successful deletion.
- Reconnecting after reload treated any non-200 as an expired session and cleared its identifier. Fix: retain the recalled capability and route failures through the existing refusal handler, which clears it only for no_session. The browser regression supplies one explicitly synthetic HTTP 503, requires the live session and identifier to survive, then refreshes and reloads successfully.

Owned changed paths: tools/src/lab/client.ts and tools/test/lab-page.test.ts. The existing LAB.page case now checks both refusal states. Assertions were added; no acceptance requirement was removed. Expected browser console errors from the two injected HTTP responses are checked exactly and removed from the separate unexpected-error list only after assertion.

## Checks

- npm run lint: pass.
- npm run typecheck: pass.
- git diff --check -- tools/src/lab/client.ts tools/test/lab-page.test.ts: pass.
- Node 24.22.1 vitest run test/lab-page.test.ts after fix: PASS, 5/5 tests, 48.39 s; /tmp/bm-lab-page-after.log.

## Review bounds

The lab uses candidate/fixture hash checks, isolated session accounts/contracts, restricted listed actions, same-origin API guards, session and request limits, and a maximum of two sandbox generations with cleanup. I found no demonstrated cross-session authority, balance, oracle or signer leak from source review; these paths retain their existing acceptance cases and need the coordinator integrated gate. No independent security audit or deployed-container qualification is claimed. Mainnet runner, contract and original evidence untouched.
