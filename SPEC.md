# Bounded trading mandate: current product spec

This is the canonical product specification for one competition-ready bounded trading mandate.

Status: selected and in implementation. Execution results belong in the status register, not here. The source-verified primitives below are inputs, not proof that our code works.

## Product and claim

One owner delegates a bounded trading mandate over USDC and wNEAR inside NEAR Intents. The mandate contract owns its Intents account, constructs only policy-approved trade intents and obtains its own derived MPC signatures. The agent cannot authorize withdrawals, transfers to another account, arbitrary payloads, key changes or policy changes.

The differentiator to prove is control over the lifetime of outstanding signed trading authority: after key removal succeeds, withheld orders fail, including after regrant. The owner can recover remaining assets without the agent, oracle or MPC. NEAR and the Intents contract must still function.

This does not guarantee principal, profit, execution availability or a maximum total loss. The owner remains trusted for contract deployment/upgrade authority. An adversarial agent can make economically poor permitted trades.

## Scope

Required:
- One owner; exactly USDC on NEAR and wNEAR, identified by exact token IDs and decimals.
- One Rust production contract crate; one TypeScript package for agent, filler, replay, evidence and static-page generation.
- The contract's current grant-derived Ed25519 key is the only registered signing key on its Intents account. Predecessor authorization remains enabled.
- The agent uses a restricted function-call key whose only allowed method is `propose_order`, with a finite gas allowance. The contract independently enforces its role checks.
- Contract-built NEP-413 `token_diff` orders; the agent never supplies arbitrary signing bytes.
- Our own separately keyed filler counter-signs the matching side and uses permissionless `execute_intents`.
- A real LLM-to-proposal adapter, a recorded genuine model interaction, and deterministic malicious-request replay. A model need not accept an injection for the policy to be tested.
- A complete unfunded fresh-clone demo, real integration evidence after authorization, and a polished generated static page.
- Predecessor-authorized recovery to the fixed owner, independent of oracle, agent, breaker and MPC.

Excluded: pooled shares, fees on third-party money, DAO grantor, cross-chain entry/exit, public solver relay, taker-pays-first, generic execution, a backend/UI application, a second hackathon entry, or deprecated/unverified primitives.

## Authority lifecycle

A grant has a monotonically increasing epoch and a never-reused derivation path, recommended `mandate/v1/<epoch>`, domain 1. Activate only after the correct key registration is confirmed.

Treat registration, revocation and their receipts as one lifecycle. Discarding a stale callback is insufficient if a previously issued registration can still restore a key. Serialize the relevant operations; test revocation during activation, delayed registration, failed removal and retry. No new grant may overlap unresolved old authority.

Distinguish:
- `revoking`: the owner requested removal; new authorization is stopped, but already-signed orders may still execute.
- `revoked`: removal of the relevant key succeeded; covered orders cannot execute.

Every continuation checks its epoch, order identity, state and deadline. No agent-reachable route may disable predecessor authorization. Owner actions remain available after the agent exhausts its allowed gas budget.

If a registration callback fails, the registration stays unresolved until positive evidence arrives. The owner may reconcile on observing the grant key registered on the verifier: only the contract's own registration can add that derived key, so presence proves the registration executed. Absence, a timeout or elapsed time never resolves it, because a pending registration could still complete. When registration and its callback both failed, resolution needs the trusted owner's deployment authority (a key on the mandate account) after confirming from final receipt outcomes that no registration can still execute. Report this emergency procedure separately from ordinary revocation and recovery. A deployment without that key cannot perform it.

## Authorization and accounting

1. Validate the agent and proposed asset direction/amounts. Allocate an order identity and reserve exposure at `propose_order`, before a signature can be requested. Pending proposals also consume the relevant capacity.
2. Read the approved reference feeds and relevant account state. Before requesting signing, check the current grant, policy, cumulative turnover, reservations and remaining deadline against the returned data.
3. Construct exact trade amounts, signer/recipient domain, versioned nonce and deadline in the contract. Hash through the pinned NEP-413 implementation and request the signature.
4. The MPC response can disclose a valid signature before `on_sign` runs. The callback is a publication/recording step, never the security boundary.
5. Failed, delayed or ambiguous callbacks keep their reservations. An external relayer can submit a disclosed signature.
6. Release a specific reservation exactly once, only on trusted evidence that it cannot execute again: an authenticated verifier response for that exact used nonce, block time beyond the deadline, or confirmed removal of the covering key.
7. Restore usable trading capacity after confirmed settlement; do not intentionally wait until expiry. Never release on a filler's assertion or a balance change.
8. Cumulative authorized turnover is separate from outstanding reservations. Freeing a reservation must not refund the turnover budget and enable unlimited churning. Charge issued authority conservatively; document how unsigned rejections are handled.
9. Every proposal permanently consumes at least a fixed share of turnover (the proposal charge), even when rejected before signing. It consumes authorization capacity; no tokens move and no fee is paid. It bounds the order records one grant can create to turnover cap / proposal charge, so the agent cannot exhaust contract storage within a grant. It does not bound storage across grants; each regrant is an owner decision. The owner funds storage for that bound.
10. At most 32 orders may be open per grant, so that releasing every reservation on confirmed removal fits in one callback's fixed gas. Test revocation, failed removal and retry, and recovery at that limit.

Use integer token units and checked arithmetic; amounts in JSON are decimal strings. Account for asset decimals, exponent scaling, rounding and verifier fees. Do not duplicate the contract's policy in the CLI and call that independent verification.

## Policy

The grant's parameters are immutable. A policy change requires confirmed revocation and a fresh grant. The trusted owner can reset a grant; the agent cannot.

Required demonstration thresholds:
- Per-order size cap: 20% of the grant's initial reference value.
- Aggregate outstanding cap: 20% of that initial reference value, with the valuation basis explicit.
- Maximum signed execution-price concession: 0.5% against the recorded authorization reference.
- Oracle maximum age: 60 seconds. Reject missing, invalid or stale prices. Check confidence and both asset feeds; do not assume USDC always equals one dollar.
- Loss breaker: stop new authorizations on observing 2% drawdown from the grant's initial reference value. Report the observation time and still-executable orders. It is not a total-loss cap.
- A finite cumulative turnover cap and finite order deadlines, chosen and recorded before acceptance tests.
- A proposal charge (`proposal_charge_bps`) greater than zero and at most both the per-order and turnover caps.

Proposed defaults, subject to local validation: cumulative authorized turnover 100% of initial value per grant; proposal charge 0.5% of initial value (at most 200 proposals per grant); confidence/price at most 0.5%; deadline no later than 60 seconds after authorization and no later than the references' validity window, refusing insufficient remaining time. These are demo choices, not proven production risk settings. Do not loosen the 0.5% price-concession test to accommodate fees or a failing implementation.

Record the reference price/time/age at authorization, signature response time, fill time and fees separately. Market moves, stale-reference exploitation, fees and outstanding orders at the breaker can cause losses beyond any stated execution concession.

## Recovery

Stop new authorization and confirm removal before recovering. The destination is the fixed owner, never agent input. Recovery uses `mt_transfer` of each asset's full verifier balance to the owner's Intents account. That account is owner-controlled, but it is not an external wallet: moving funds out of Intents is the owner's own later withdrawal and is not part of recovery claims. The complete demo ends with assets in the owner's Intents account and states that destination explicitly.

Handle each asset's failed receipt and retry without double payment or stranded accounting. Recovery must not read a price or request a signature. Its success still depends on NEAR, Intents, token contracts and sufficient owner/recovery gas.

## Acceptance tests

`make test` runs all local gates; none may be replaced by a recorded pass string. Mock external dependencies explicitly, while executing actual contract logic and the pinned verifier WASM. Retain seeds and replayable failures. A gate passes only when every one of its required cases passed in one run of a clean source revision, with spec, fixture and WASM hashes bound to that run. Missing cases leave the gate incomplete. Demo checks are not acceptance results.

| ID | Attempt | Required result |
| --- | --- | --- |
| T1 | Withhold a signed order; revoke; relay it from another account. Repeat after regrant, during pending signing/registration callbacks, failed removal and retry. | Zero executions after confirmed removal. Old authority never returns. Executions before removal are recorded honestly. |
| T2 | At least 200 seeded randomized interleavings of proposals, price/sign callbacks, nonce checks, fills, expiry and revocation; include duplicate callbacks and stale epochs. | Zero per-order, outstanding or turnover cap violations; no executable authority omitted from accounting; release at most once; legitimate capacity returns on trusted settlement evidence. |
| T2b | Publish a signature, fail the mandate's callback, then relay the order independently. | The order remains fully accounted for or is unusable. No dependence on whether our filler or page observed it. |
| T3 | Adversarial but permitted trading, rounding boundaries, price shocks, stale feeds and delayed signatures. | Execution concession at most 0.5% on every fill against the declared reference. Report mark-to-market drawdown, fees and count/value of still-executable orders when the breaker trips. Unknown valuation is not zero. |
| T4 | Stop agent and MPC; make oracle fail/stale; exhaust agent allowance; exercise partial withdrawal failure and retry. Repeat at the open-order limit and after a failed registration callback whose key is present. | All recoverable remaining asset units reach owner control, without oracle/signature/agent dependence, and no duplicate withdrawal. |
| T5 | Apply the same threat model to a pinned baseline with comparable trading authority, such as an explicitly adapted [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) pattern. | Executed outcomes and unsupported cases distinguished; adaptation disclosed. Establish a meaningful demonstrated increment or mark differentiation unproven. Do not invent a fixed number of baseline failures. Describe the baseline as our reimplementation of a pinned design, not as evidence about its deployed product. |

Also require:
- Forbidden asset, recipient, raw payload, transfer/withdrawal intent, key mutation and over-cap requests fail at the relevant boundary.
- A genuine recorded model proposal reaches the real application interface. Injected malicious requests are labelled separately.
- An independent fresh clone runs `make test` and `make demo` with no funds, model key or private-meta access.
- Changed fixtures fail verification; expected output is derived from execution, not hard-coded.
- A separately authorized small mainnet trade covers our encoding, key registration, actual signer, settlement and recovery with receipts. One trade proves integration only.
- A clear static evidence page and video complete the competition entry; they are not optional leftovers.

T1/T4 failure blocks the corresponding claim; T2/T2b failure blocks signing safety; T3 failure blocks the stated policy; T5 failure leaves competitive differentiation unresolved. Keep independent corrective work moving without claiming these gates passed.

## Demonstration

Show grant and limits; an actual permitted proposal/trade; another signed order withheld; malicious requests rejected; owner revocation confirmed; the withheld order rejected on submission; recovery with agent/oracle/MPC unavailable.

The deterministic replay tells this complete story in under a minute after documented setup. Cold installation/build time is measured separately. Clearly label sandbox execution, recorded mainnet receipts and any actual live run. Never guarantee that network delays fit the replay's duration.

## Supplied verified primitives and remaining uncertainty

These were verified in the prior research and supplied by the user. Reuse them; do not repeat broad research. Before a funded run, check for deployment drift and record the exact binaries/configuration used.

| Primitive | Recorded evidence |
| --- | --- |
| Intents verifier | v0.4.5, source commit 16d04f6ec4401263f8914638710260da50bb46b0 in [near/intents](https://github.com/near/intents/tree/16d04f6ec4401263f8914638710260da50bb46b0). Pin actual WASM/hash separately; declared source metadata is not a reproduced build. |
| Authority and settlement | add/remove_public_key use predecessor authorization and one yocto; execution checks has_public_key; execute_intents has no caller allowlist; versioned nonces/deadlines are verified by the contract. |
| Encoding | NEP-413 prehash is sha256(borsh(2147484061u32, payload)); use the pinned defuse-nep413 crate. Both verifier and signer use NEAR's Ed25519 host verifier over the same bytes. |
| MPC | Recorded v1.signer 3.17.0: domain 1; sign needs one yocto and at least 15 TGas; payload_v2.Eddsa accepts hex up to 1232 bytes. derived_public_key is a view. The signature is public before our callback. [Source repository](https://github.com/near/mpc). |
| Reference oracle | aggregate-oracle.near, get_price_no_older_than with price_id and age; returns price/conf/exponent/publish_time or no fresh result. Exact USDC/NEAR identifiers still need pinning. |
| Latency | Previously measured median 4.2 seconds with one 117-second timeout. Not measurements of this implementation and not an SLA. |
| Recovery | Predecessor-authorized mt_transfer/ft_withdraw; no MPC or oracle required by that authority path. Our receiver handling, gas and retries remain untested. |

Protocol composition is supported by source; our payload bytes, gas, lifecycle and mainnet execution remain implementation gates. No production fixture bundle, successful run or real model trace currently exists.
