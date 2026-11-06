# Bounded mandate

**Let an AI agent trade within limits that a contract enforces. Once a revocation is confirmed, the signed orders already issued fail too, and the owner takes the remaining assets back without the agent.**

An owner deposits USDC and wNEAR into a NEAR contract and lets an AI agent trade between them on NEAR Intents. The agent can only propose a trade: which asset to sell, how much, and a price concession of at most 0.5%. The contract checks the owner's fixed limits and signs each order itself, through NEAR's MPC signing network, so the agent never holds a key that can move funds. Every order of one grant is signed with one key. To revoke, the owner calls the contract, which removes that key from NEAR Intents; once the removal is confirmed, signed orders still in circulation fail, and a later grant signs with a different key, so they cannot come back. The owner then moves the remaining assets back without the agent, the price oracle or the signing network.

**Example: treasury rebalancing.** A treasury holds USDC and wNEAR and wants an AI agent to rebalance between them without handing it the funds or a signing key. The owner deposits both into the mandate and grants trading with caps on order size, open exposure and total turnover, and a price concession of at most 0.5% against the oracle reference. The agent can propose trades but cannot sign, withdraw or change limits; the contract checks the limits and signs each order itself. To stop, the owner calls `revoke`. Pausing an agent alone would stop new orders, but signatures already issued would stay valid until their deadline or until their nonces are used. Once removal of the grant's key is confirmed, every signed order of that grant fails, including orders the agent or a relayer withheld, and none comes back after a later regrant. The owner then calls `recover` to move the remaining USDC and wNEAR to the owner's Intents account, without the agent, oracle or MPC.

## Evaluate in 5 minutes

| Path | Do | See |
| --- | --- | --- |
| Video | Watch the short cut (about 65 s): `VIDEO_URL_PENDING`. A longer technical walkthrough (about 140 s) covers the same run plus the attack suite. | The revocation story from one sandbox run: balances, trading limits, a recorded model proposal traded, a signed order withheld, confirmed revocation, the withheld order rejected, balances recovered. |
| Evidence page | Open [evidence/f60f999/page/index.html](evidence/f60f999/page/index.html) in a browser (self-contained, no network); hosted copy `PAGE_URL_PENDING` | The outcome against the agent's 50/50 objective, the withheld order's identity and its rejection, the regrant and disclosed-signature sandbox cases, acceptance gates, matched baseline, claims and non-claims, policy and provenance. An opt-in panel (§V) runs read-only checks against a mainnet RPC from the browser; nothing is requested before you press its button. `make demo` regenerates the page at `out/page/index.html`. |
| Mainnet receipts (pending the approved mainnet run) | Run the read-only commands in [Verify on mainnet](#verify-on-mainnet-read-only) with `curl` and `jq`; no wallet, key or funds | Today: the verifier we test against is byte-identical to the code at `intents.near`. After the approved run: the withheld order's relay receipt failing for the removed key before its deadline, and the recovery receipts. |
| Local run | Install the [requirements](#requirements), then `make demo` | About a minute after a warm build (60 s in the certified fresh-clone run; a cold build takes longer). Ends with `56/56 assertions passed`, `out/evidence/demo.json` and `out/page/index.html`. On its own, `make demo` renders the gates as not certified; the page shows them certified only after `make test` passes on the same clean revision. |
| Full gates | `make test` | About 16 minutes after a warm build (20 minutes in the fresh-clone run). From a clean tree it ends with `CERTIFIED: run <id>` and writes `out/evidence/acceptance.json`. |

### Verify on mainnet (read-only)

**Pending the approved mainnet run; no mainnet transaction has been executed.** The code-hash check works today. The second block is a template: its placeholders are filled in only after the run, and these commands send no transaction.

```sh
RPC=https://archival-rpc.mainnet.fastnear.com   # archival: receipts stay readable after the run

# Works today: code hash of intents.near ...
curl -sS "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"intents.near"}}' \
  | jq -r .result.code_hash
# ... equals base58(sha256) of our verifier fixture (run in this repository)
python3 -c "import hashlib;n=int.from_bytes(hashlib.sha256(open('fixtures/verifier/defuse-0.4.5.wasm','rb').read()).digest(),'big');A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';s='';exec('while n:\n n,r=divmod(n,58)\n s=A[r]+s');print(s)"
```

Both print `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`, as recorded in [fixtures/manifest.json](fixtures/manifest.json) at block 222913804. A later upgrade of `intents.near` would change the live value.

```sh
# TEMPLATE until mainnet receipts exist. Placeholders: <...>.
MANDATE='<MANDATE_ACCOUNT>'; GRANT_KEY='<ed25519:GRANT_PUBLIC_KEY>'; NONCE='<WITHHELD_ORDER_NONCE_BASE64>'
view() {  # view <contract> <method> <json args>
  curl -sS "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf %s "$3" | base64 | tr -d '\n')\"}}" \
    | jq -r '.result.result | implode'
}
view intents.near has_public_key "{\"account_id\":\"$MANDATE\",\"public_key\":\"$GRANT_KEY\"}"  # current state only: false now, not when it was removed
view intents.near is_nonce_used "{\"account_id\":\"$MANDATE\",\"nonce\":\"$NONCE\"}"           # current state only: the verifier can clean up expired nonces
view "$MANDATE" get_grant '{}'                                                               # grant epoch and state
curl -sS "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"<TX_HASH>","sender_account_id":"<SENDER_ACCOUNT>","wait_until":"FINAL"}}' \
  | jq '.result.receipts_outcome[] | {executor: .outcome.executor_id, status: .outcome.status}'  # per-receipt outcomes
```

The two views above show current state only. The historical proof is the relay transaction's receipts: the verifier receipt fails with the removed-key error in a block before the order's deadline. `has_public_key` cannot say when a key was removed, and `is_nonce_used` can read `false` for a used nonce after the verifier's garbage collector cleans up expired nonces. The evidence page's opt-in panel checks the receipts this way.

## Status

Acceptance runs in a local NEAR sandbox. Our contract and the exact mainnet Intents verifier WASM execute there, with labelled test doubles for the MPC signer, oracle and tokens. The model gate replays a genuine recorded model interaction. **No mainnet transaction has been executed**; that integration needs separately approved accounts and budget.

Certified results are committed under [evidence/](evidence/) and indexed by source revision in [evidence/index.json](evidence/index.json). Each entry records:
- the acceptance verdict, with every required case of every gate bound to that revision and to the spec, fixture and WASM hashes;
- the environment, commands and exit results;
- an independent fresh-clone run without funds, model credentials or private-repository access.

`evidence/426914d` is an earlier bundle in the legacy report format, kept unchanged; current rules do not certify it. See [SPEC.md](SPEC.md) for the requirements.

## What it guarantees, and what it does not

The claim: after removal of the grant's signing key is confirmed, withheld signed orders fail, including after a regrant; the owner recovers the remaining assets without the agent, oracle or MPC.

Not guaranteed: principal, profit, execution availability or a maximum total loss. Market moves, stale references, fees and orders still executable when the loss breaker trips can lose more than the stated 0.5% execution concession. While revocation is pending, already-signed orders may still execute. The owner is trusted. The contract has no upgrade method: upgrade and emergency-rescue authority exist only if the deployment leaves the owner a full-access key on the mandate account (the demo deploys without one). NEAR, the Intents verifier and its admins, and the token contracts must keep working.

## How it works

- **Agent.** A separate account whose only key is a function-call key for `propose_order` with a finite allowance. A proposal names only the asset to sell, the amount and a concession of at most 50 bps. It cannot name recipients, payloads, keys, paths or token IDs.
- **Contract.** It reserves exposure and charges turnover before any external call, reads both oracle prices and its verifier balances, re-checks every cap and the loss breaker, then builds an exact NEP-413 `token_diff` with a versioned nonce and a short deadline. It signs through its own MPC derivation path `mandate/v1/<epoch>`, which is never reused.
- **Accounting.** A reservation is released exactly once, and only on trusted evidence: the verifier reports the nonce used, block time passes the deadline, or removal of the covering key is confirmed. A signature published by the MPC whose callback failed stays reserved. Every proposal permanently charges at least `proposal_charge_bps` of turnover, so a grant accepts at most `turnover_cap / proposal_charge` proposals. The charge consumes authorization capacity; no tokens move and no fee is paid. It bounds order records per grant, not storage across grants (each regrant is an owner decision). At most 32 orders are open at once, so confirmed removal releases them all within one callback's fixed gas.
- **Revocation.** Key registration and removal are serialized. Revocation stops new authorization at once (`revoking`); confirmed removal (`revoked`) releases every reservation of that grant. Failed removal can be retried.
- **Unresolved registration.** If the key-registration callback fails, the owner calls `reconcile_registration`. It resolves only on observing the grant key registered on the verifier; absence or elapsed time never resolves it, because a pending registration could still land. If both the registration and its callback failed, an emergency rescue is needed: confirm from final receipt outcomes that nothing can still register, re-add the key with an owner-held key on the mandate account, then reconcile and revoke. That rescue is reported separately from ordinary recovery and is impossible for a keyless deployment.
- **Recovery.** With the grant revoked, the owner moves each asset's verifier balance to the owner's Intents account with `mt_transfer`. No price read, signature or agent action is involved. This is not a withdrawal to an external wallet; moving funds out of Intents is the owner's own later action.
- **Filler.** Our own separately keyed account signs the matching side, pays the verifier fee, and submits both payloads through permissionless `execute_intents`. It never builds a replacement order after an ambiguous result.

Demo policy: per-order and outstanding caps 20% of the initial reference value, turnover cap 100%, concession at most 0.5%, oracle age at most 60 s, confidence at most 0.5%, loss breaker at 2% drawdown, deadline at most 60 s, and a per-proposal charge of 0.5%. These are demonstration settings, not proven production risk limits. With this policy, the measured storage requirement for a full grant (200 proposals of about 780 bytes each, plus grant state) is about 4.67 NEAR in total for the mandate account, including about 3.1 NEAR for the contract code.

## Matched baseline (T5)

We applied the same threat model to our own re-implementation of the [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) design (pinned 225d37d), adapted to the same USDC/wNEAR `token_diff` authority on the pinned Intents verifier. Results describe that re-implementation in a local sandbox, not the deployed Claw Guard product; the adaptations are recorded with the results. Executed in sandbox:

- its own revocation (pause and remove the agent) leaves withheld signed orders executable;
- removing the key on Intents stops them, but a regrant re-registers the same fixed-path key and revives them;
- a signature disclosed while the signer callback fails is released from accounting, so executed volume exceeded its daily cap.

Over-cap, injected-withdrawal and owner-recovery cases are blocked by both designs. The evidence page claims an increment only from a certified run in which the matching mandate gate passed.

## Comparison with related NEAR projects

What this repository demonstrates together, in the sandbox gates certified for revision f60f999 [1]:

1. **Bounded trading.** The agent only proposes; before signing, the contract enforces per-order, outstanding and turnover caps, a price bound against the oracle and a loss breaker (T2, T3, BOUNDARY).
2. **Grant-wide invalidation.** Once removal of the grant's key on `intents.near` is confirmed, every outstanding signed order of that grant fails, including orders someone withheld (T1).
3. **Fresh authority after regrant.** Each grant signs with a key on a new derivation path, so a regrant does not revive earlier orders (T1).
4. **Conservative accounting.** A reservation is released only on verifier evidence; a signature that was disclosed while the signing callback failed stays reserved (T2b).
5. **Owner recovery.** `recover` moves both assets to the owner's Intents account without the agent, oracle or MPC (T4).

None of it has run on mainnet yet.

**The official NEAR Intents Agent API** [2] is the closest product, and it is much broader. One owner-signed policy covers actions, assets, per-asset limits, a USD budget, destinations, a timelock, a schedule, owner approval and a freeze, for swaps, transfers and withdrawals to many chains. It is a hosted service in an attested Intel TDX VM with a signed transparency log for every execution; its source is not public yet, so the running images can be checked but not rebuilt. A partner backend acts with a grant token, a bearer credential the owner signs for. Revoking a grant or changing the policy refuses every action that has not reached its dispatch commitment, and a freeze refuses every action; actions past the dispatch commitment cannot be recalled. The documentation we read describes no step in which the backend receives a signed Intents order it could hold back. This project makes a narrower trade-off: one NEAR contract enforces the limits and signs every order, revocation is a key removal on `intents.near` that anyone can check with a view call, and the owner's recovery is a contract call that involves no agent, oracle, MPC or API. It covers one asset pair.

How to read the table. Each project was read at the pinned commit or on the dated documentation listed under Sources; later versions may differ. The projects solve different problems, and several are broader than this one; the table compares only how they handle delegated authority. Each cell names its basis: **D** documented in the project's README or docs, **S** read in its source at the pinned commit, **E** executed by us. "Not documented" means we found no statement, not that the feature is missing.

| Project | Where limits are enforced | What revocation invalidates | After regrant | Uncertain or disclosed signatures | Recovery: destination and dependencies | Public reproducibility |
| --- | --- | --- | --- | --- | --- | --- |
| **Bounded mandate** (this repository) [1]. Agent trading of USDC/wNEAR from a contract-owned Intents account. Sandbox only so far. | In the mandate contract, before it signs: caps, oracle price bound, loss breaker. E | New proposals at once. After confirmed removal of the grant's key on `intents.near`: every outstanding signed order of the grant, withheld ones included. E | A new key on a new path (`mandate/v1/<epoch>`); earlier orders stay invalid. E | Released only on verifier evidence; a signature disclosed while its callback failed stays reserved. E | Owner `recover`: `mt_transfer` to the owner's Intents account, with no agent, oracle or MPC; needs NEAR, `intents.near` and the token contracts. E | Gate tests and certified evidence in this repository; the DEPLOY gate deploys a pinned reproducible build of the contract. E |
| **NEAR Intents Agent API** (official, hosted) [2]. Agent wallets on NEAR Intents under an owner-signed policy: swaps, transfers, withdrawals, confidential balances. | Two layers: the API (destinations, USD budget, timelock, schedule; it also counts per-asset limits and the action rate) and the agent's wallet provider (actions, assets, limits, rate, owner approval, freeze). D | `grant_revoke` or a policy change refuses actions that have not reached their dispatch commitment; queued ones fail with `authorization_stale`. A freeze refuses every action. Dispatched actions cannot be recalled. Revoking a grant is an owner-signed message checked by the API, not a chain transaction. D | A new grant needs a new token; a reused one is refused. All grants share one policy and one budget. D | An `UNCERTAIN` action keeps its budget charge and limit count until its outcome is known; the charge is released only when the provider provably refused or never ran the action. D | Funds stay in the agent's wallet on NEAR Intents. Documented exits are `withdraw` and `transfer` actions under a grant, to policy destinations. An owner exit that does not use the API: not documented. D | Attested VM with published compose and image digests, and per-execution transparency proofs. Source not public yet: images can be checked, not rebuilt. D |
| [Veto](https://github.com/0xdopewilly/veto) @a784344 [3]. Payment vault in which an AI screen in a TEE can only veto. Pays on NEAR, on Base through Chain Signatures, from OutLayer wallets and from an Agent API wallet whose grant Veto holds. Testnet; the Agent API path on mainnet. | Vault contract: per-payment and weekly caps, and an enclave-signed verdict checked on-chain. Agent API path: the owner's API policy, with Veto screening before it uses the grant. D, S | `freeze` stops new payments and cancels pending overrides; it does not change EVM payouts the MPC already signed. How such a payout is stopped afterwards: not documented. The owner can also deactivate or remove a single agent (`set_agent_active`, `remove_agent`). Agent API path: Veto holds the wallet's only grant, so the owner's Agent API controls apply. S, D | Not documented. | Spend is recorded before the MPC request and released if the MPC call returns a failure. A signature disclosed while the callback fails: not documented. S | `withdraw_to_owner` at any time, only to the owner; needs the token contract. S | Public source and tests; a script compares a local build with the code hash deployed on testnet. D |
| [Allowance](https://github.com/soldanoandrea/allowance) @74edffe [4]. Payment vault in which each agent is a function-call key on the vault account. No NEAR Intents in this version; the testnet run is prepared, not run. | The protocol (method-scoped key, no deposits) and the vault contract on every `pay`. D | `kill` pauses, denies queued approvals and deletes every agent key, so the next transaction signed with one is rejected by the protocol. `remove_agent` does the same for one key. D, S | Not applicable in the same form: an agent signs its own NEAR transactions with its function-call key rather than holding standing signed orders. `add_agent` registers a key the owner supplies. S | Not documented. | Owner `withdraw` / `withdraw_ft`, to the owner or a named account. S | Public source, CI, unit tests and a sandbox end-to-end test. The hackathon build is not reproducible; a NEP-330 descriptor is kept. D, S |
| [Agent Treasury](https://github.com/iskander-kudashev-13/agent-treasury) @46116b1 [5]. USDC vault with per-agent mandates for payroll and cross-chain payouts via 1Click, plus an optional Hyperliquid spot trading agent. Mainnet vault with real payouts and a mainnet trading session. | Payments: in the vault contract. Trading rules: in the off-chain worker, as owner-signed rule sets. D, S | `pause_agent` and `revoke_agent` stop vault payments. The trading kill switch halts bots; open positions stay, and the full stop is revoking the API wallet on Hyperliquid. D, S | Vault: `revoke_agent` is terminal and a new agent is needed. Hyperliquid API wallet: not documented. S | Not documented. | Owner `withdraw` from the vault, which pause does not block. Funds already sent to Hyperliquid return manually. D, S | Public source and contract tests; the mainnet vault is a reproducible build. D |
| [NEAR Private OTC](https://github.com/Watchmeecryt/near-private-otc) @55d5b64 [6]. Private OTC deal board: sealed terms in an OutLayer TEE, atomic settlement through `execute_intents`. Hosted app on testnet. | No delegated trading limit. The enclave checks that the two intents mirror each other; for an agent, the limit is its account balance. D | Per deal: the maker burns the nonces of its live offers, so those signatures can never settle. D, S | No grant: each party signs with its own key. D | Not documented. | Assets stay in each user's own verifier balance; the user withdraws with a self-signed `ft_withdraw`. D, S | Public source; the verifier's code hash and the enclave's WASM hash are published. A test suite: not documented. D |
| [Near-LEASH](https://github.com/soze-ki/Near-LEASH) @b122410 [7]. Policy gate for agent spending: EVM transactions through Chain Signatures and funding of 1Click swaps. Testnet, with a live MPC-signed Base Sepolia payment. | In the contract: allowlists, caps, cooldown and on-chain 1Click quote verification. D, S | `pause` and `remove_agent_key` stop new requests. An EVM transaction that was already signed stays valid, subject to its EVM nonce. D, S | `add_agent_key` adds a NEAR key, which signs requests rather than standing orders. Already-signed EVM transactions are governed by their EVM nonce (see the previous column). S | Design spec: a failed or timed-out MPC callback refunds the window debit. D | Owner `withdraw` of NEAR or NEP-141 tokens. S | Public source with unit and sandbox tests; the Intents path has not run on mainnet. D |
| Claw Guard design, our adaptation (T5) [8]. Our re-implementation of the [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) authority model, adapted to Intents `token_diff`; not their deployed product. | In the guard contract: per-order and daily caps. E | Pause or remove-agent: new proposals only; a withheld order executed. Removing the key on Intents stopped it. E | The same fixed-path key is re-registered and the withheld order executed again. E | A signature disclosed while the signer callback failed was released, and executed volume exceeded the daily cap. E | Assets stay in the owner's own Intents account; the strand case was blocked. E | Claw Guard: CI reproducible build and a mainnet deployment (D). Our adaptation: [baseline/claw-guard-adapted](baseline/claw-guard-adapted) and the T5 evidence (E). |

Sources:
1. This repository; gates executed at source revision `f60f999`: [`propose_order`](contract/src/lib.rs#L419), [`revoke`](contract/src/lib.rs#L325), [`recover`](contract/src/lib.rs#L384), [per-grant path](contract/src/state.rs#L54); certified [acceptance](evidence/f60f999/acceptance.json), [T1 withheld/regrant](evidence/f60f999/tests/T1.withheld-regrant.json), [T2 interleavings](evidence/f60f999/tests/T2.sandbox-interleavings.json), [T2b](evidence/f60f999/tests/T2b.callback-failed-after-disclosure.json), [T3 concession](evidence/f60f999/tests/T3.concession.json), [T3 breaker](evidence/f60f999/tests/T3.breaker.json), [BOUNDARY](evidence/f60f999/tests/BOUNDARY.contract.json), [T4](evidence/f60f999/tests/T4.dependency-failure.json), [DEPLOY](evidence/f60f999/tests/DEPLOY.candidate.json).
2. NEAR Intents Agent API documentation, accessed 2026-11-05: [How it works](https://docs.agentsonintents.com/integration/agent-api/concepts) (pieces, two enforcement layers, owner powers), [Policies & Limits](https://docs.agentsonintents.com/integration/agent-api/policies-and-limits) (policy fields, which layer enforces what, freeze, policy change and `authorization_stale`, budget charge release), [Grants](https://docs.agentsonintents.com/integration/agent-api/grants) (bearer token, revocation, committed actions, token reuse), [Executions](https://docs.agentsonintents.com/integration/agent-api/executions) (dispatch commitment, timelock queue, the `recover` endpoint for undispatched uncertain actions), [Status & Errors](https://docs.agentsonintents.com/integration/agent-api/status-and-errors) (`UNCERTAIN`, charge release), [Signing Standards](https://docs.agentsonintents.com/integration/agent-api/signing-standards) (grant revocation is an off-chain message), [Owner Signing](https://docs.agentsonintents.com/integration/agent-api/owner-signing) (withdraw before delete), [TEE & Attestation](https://docs.agentsonintents.com/integration/agent-api/tee) (TDX VM, funds outside it, source not public yet), [Transparency](https://docs.agentsonintents.com/integration/agent-api/transparency) (per-execution proofs).
3. Veto at `a7843443e94fb6c98f42f9139c57e0a0deb3129e`: [README L3-L22](https://github.com/0xdopewilly/veto/blob/a7843443e94fb6c98f42f9139c57e0a0deb3129e/README.md#L3-L22), [tests and deployed-code check L28-L54](https://github.com/0xdopewilly/veto/blob/a7843443e94fb6c98f42f9139c57e0a0deb3129e/README.md#L28-L54), [Agent API path L175-L179](https://github.com/0xdopewilly/veto/blob/a7843443e94fb6c98f42f9139c57e0a0deb3129e/README.md#L175-L179), [status L193](https://github.com/0xdopewilly/veto/blob/a7843443e94fb6c98f42f9139c57e0a0deb3129e/README.md#L193), [`freeze`](https://github.com/0xdopewilly/veto/blob/a7843443e94fb6c98f42f9139c57e0a0deb3129e/contract/src/lib.rs#L685-L698), [`withdraw_to_owner`](https://github.com/0xdopewilly/veto/blob/a7843443e94fb6c98f42f9139c57e0a0deb3129e/contract/src/lib.rs#L869-L880), [`on_evm_signed`](https://github.com/0xdopewilly/veto/blob/a7843443e94fb6c98f42f9139c57e0a0deb3129e/contract/src/lib.rs#L904-L933), [`execute_evm`](https://github.com/0xdopewilly/veto/blob/a7843443e94fb6c98f42f9139c57e0a0deb3129e/contract/src/lib.rs#L1159-L1197).
4. Allowance at `74edffec98cbeffd88d31223802f088c2d0f10b8`: [README L3-L23](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/README.md#L3-L23), [not in this version L511-L513](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/README.md#L511-L513), [testnet L561](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/README.md#L561), [tests L569](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/README.md#L569), [`withdraw`](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/src/lib.rs#L232-L269), [`withdraw_ft`](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/src/lib.rs#L372-L419), [`add_agent`](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/src/lib.rs#L467-L507), [`remove_agent`](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/src/lib.rs#L569-L585), [`kill`](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/src/lib.rs#L657-L684), [build descriptor](https://github.com/soldanoandrea/allowance/blob/74edffec98cbeffd88d31223802f088c2d0f10b8/Cargo.toml#L20-L31).
5. Agent Treasury at `46116b1c88fc5d5068698dc73de348e62f428136`: [README L1-L9](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L1-L9), [reproducible mainnet vault L27](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L27), [limitations L72-L77, L84-L87, L92-L94, L98](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L72-L98), [contract tests L150](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L150), [API wallet L339-L341](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L339-L341), [mainnet demo L454-L470](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/README.md#L454-L470), [`request_payment`](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/contract/src/payment.rs#L51), [`pause_agent` / `resume_agent` / `revoke_agent`](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/contract/src/agent.rs#L126-L156), [`withdraw`](https://github.com/iskander-kudashev-13/agent-treasury/blob/46116b1c88fc5d5068698dc73de348e62f428136/contract/src/owner.rs#L285-L287).
6. NEAR Private OTC at `55d5b645bc6212cf975474cee12f1a63e9a37d55`: [README L3](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/README.md#L3), [verifier hash L43](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/README.md#L43), [settlement L47](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/README.md#L47), [cancel L99](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/README.md#L99), [enclave hash L201](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/README.md#L201), [keeper cancel L323-L334](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/keeper/index.mjs#L323-L334), [keeper withdraw L335-L339](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/keeper/index.mjs#L335-L339), [agent limits AGENTS.md L89-L99](https://github.com/Watchmeecryt/near-private-otc/blob/55d5b645bc6212cf975474cee12f1a63e9a37d55/AGENTS.md#L89-L99).
7. Near-LEASH at `b122410aac152d8a38aa36ebe064baf42c91fc10`: [README L3-L16](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/README.md#L3-L16), [tests L20-L23](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/README.md#L20-L23), [paths L65-L78](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/README.md#L65-L78), [`pause`](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/contract/src/lib.rs#L366-L370), [`add_agent_key`](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/contract/src/lib.rs#L381), [`remove_agent_key`](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/contract/src/lib.rs#L409-L415), [`withdraw`](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/contract/src/lib.rs#L476-L490), [signed EVM nonce, spec L182](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/docs/guardrail-spec.md#L182), [MPC callback failure, spec L183](https://github.com/soze-ki/Near-LEASH/blob/b122410aac152d8a38aa36ebe064baf42c91fc10/docs/guardrail-spec.md#L183).
8. Claw Guard at `225d37d3c1b04959947fa7c18544fa50e273dcd8` (the design T5 re-implements; the later `ff5fdcb` only adds a disclosure to its README): [issued signatures are not revoked by pause, THREAT_MODEL L233](https://github.com/metafrogmeme-droid/claw-guard-near/blob/225d37d3c1b04959947fa7c18544fa50e273dcd8/docs/THREAT_MODEL.md#L233), [DECISIONS L61](https://github.com/metafrogmeme-droid/claw-guard-near/blob/225d37d3c1b04959947fa7c18544fa50e273dcd8/docs/DECISIONS.md#L61), [reproducible mainnet build, README L71](https://github.com/metafrogmeme-droid/claw-guard-near/blob/225d37d3c1b04959947fa7c18544fa50e273dcd8/README.md#L71). Our adaptation: [fixed path](baseline/claw-guard-adapted/src/lib.rs#L27), [`remove_agent` / `pause`](baseline/claw-guard-adapted/src/lib.rs#L298-L310), [test](baseline/claw-guard-adapted/tests/t5_baseline.rs), [certified result](evidence/f60f999/tests/T5.baseline.json).

## Layout

| Path | Contents |
| --- | --- |
| [SPEC.md](SPEC.md) | Pinned product specification; origin and hash in [spec-source.json](spec-source.json). |
| `contract/` | Rust mandate contract; `contract/tests/` holds the sandbox and adversarial gate suites. |
| `stubs/` | Labelled test doubles for the MPC signer, oracle and tokens. |
| `baseline/` | Our re-implementation of the Claw Guard design, adapted for the matched comparison. |
| `tools/` | TypeScript model adapter, filler, attack suite, demo, live runner and evidence page. |
| `fixtures/` | Pinned external inputs and recorded model interactions, with provenance in `fixtures/manifest.json`. |
| `evidence/` | Curated gate and demo evidence, bound to a source revision. |

## Requirements

- Rust via rustup (toolchain pinned in `rust-toolchain.toml`) and `cargo-near` 0.22.0 (`cargo install cargo-near --version 0.22.0 --locked`; on Linux install `libudev-dev` and `pkg-config` first).
- Node.js 24 and npm.
- Network access for dependency installation and the first download of the NEAR sandbox binary. No funds, model key or private repository access.

## Commands

```sh
make test   # all local gates (about 16 minutes after a warm build)
make demo   # unfunded sandbox scenario, out/evidence/demo.json and out/page/index.html
MANDATE_LIVE=1 MANDATE_LIVE_MANIFEST=<approved manifest> make live   # opt-in; not spending approval
```

`make test` records a run id, clears earlier results and ends with `tools/src/checks/acceptance.ts`. That step writes `out/evidence/acceptance.json` and fails unless every required case of every gate passed in this run, bound to the revision and the spec, fixture and WASM hashes. A run from a tree with uncommitted changes is never certified. Demo checks are story checks, not acceptance results.

`make live` refuses a manifest that does not match the chain: network, the code hashes of the mandate, verifier, signer, oracle and both token contracts, the verifier, signer and oracle versions, the mandate configuration, keys and allowances. Token decimals are compared with the mandate's configuration, not read from `ft_metadata`; that comparison is a manual pre-approval check. It enforces fee, deposit, inventory and filler caps through a hash-chained ledger that survives restarts. It verifies each step's end state from state and receipts, and stops without any replacement order on an ambiguous outcome. Mainnet also requires `MANDATE_LIVE_CONFIRM=<manifest sha256>`.

The mainnet template ([tools/src/live/manifest.example.json](tools/src/live/manifest.example.json)) runs the whole revocation story with small amounts:
1. Grant, then one deliberately forbidden proposal that the mandate itself must refuse.
2. One valid trade, filled and settled.
3. A second signed order, withheld: the filler counter-signs a complete bundle, `simulate_intents` accepts it, and the exact bundle is kept in the ledger.
4. Revoke, then relay that bundle before its deadline.
5. Recover both assets to the owner's Intents account.

The relay is checked twice: before the bundle is prepared, and again after signing, immediately before the broadcast. Each check requires confirmed revocation (grant revoked, no key operation in flight, signing key absent) and at least `min_remaining_sec` (10 s) left before the order's deadline by the final block's time. Unconfirmed revocation stops the run; nothing is sent. Too little remaining time skips the relay and records it as inconclusive. A relay that is sent passes only if the verifier rejects it for the removed key, before the order's deadline, with both nonces unused and balances unchanged. An expired order, missing filler funds, a different signature error or an unreadable execution time is inconclusive, never a pass; execution counts as a revocation failure.

Classified terminal outcomes, whether passed, inconclusive, failed or skipped, are recorded and the run proceeds to recovery, exiting nonzero unless every step passed. Unresolved outcomes stop the run without resubmitting anything: a lost response, an outcome that is not final, or an RPC interruption. `MANDATE_LIVE_RESUME=1` reconciles the stopped run from chain state, then continues. The relay's evidence records the deadline-sensitive phases (withheld order proposed, propose confirmed by runner, bundle simulated, revoke sent, revoke confirmed by runner, relay pre-check, prepared, broadcast) with runner wall-clock times and, where read, the final block's time remaining before the deadline. "Confirmed by runner" is when the step's terminal verification was recorded; after a lost response it is the reconciling resume, never the ambiguous response.

Regrant resistance and broken-oracle or broken-MPC scenarios stay in the sandbox gates. On mainnet, recovery only shows that its receipts call no agent, oracle or MPC; it cannot show those shared services disabled. The template's RPC is `https://free.rpc.fastnear.com`, because `rpc.mainnet.near.org` is deprecated and heavily rate-limited. For lookups of older receipts, such as the verification commands above, use the archival endpoint `https://archival-rpc.mainnet.fastnear.com`.

`make demo` replays the recorded model output, so it needs no API key. To record a new model interaction, run `tools/src/agent/record.ts` with a model provider, then list the file in `fixtures/manifest.json`.

Optional live agent, implemented and tested locally only; it has not run against a real model or on mainnet. [tools/src/live/manifest.live-agent.example.json](tools/src/live/manifest.live-agent.example.json) is the mainnet template with one change: the trade is proposed by a model (`provider: "near-ai"`, NEAR AI Cloud, the only live provider, key in `NEAR_AI_API_KEY`; an explicit model id, timeout and token limit are required, with one attempt and no fallback). Before deciding, the runner reads fresh oracle prices and the mandate's balances at one final block and records them. If the USD split is within 2 percentage points of 50/50 it records no action without calling the model. Otherwise it accepts only a proposal that sells the overweight asset, no more than needed to reach 50/50 at current prices plus 1% of that amount, within the grant's limits. A decline sends nothing. Truncated or invalid output, a reply naming a different model or a timeout is rejected locally before submission: no proposal transaction is sent, and it is recorded as a failed finding. Immediately before signing, the runner reads the prices and balances again and repeats these checks, requiring each price to stay fresh for at least `min_remaining_sec` + 15 s more; a failure there is also a local rejection. If the proposal transaction is submitted and the mandate itself refuses it (its own receipt fails with the grant unchanged, or it rejects the order while pricing), that transaction can consume gas and no trade is filled; the refusal is recorded as a failed finding, and the run continues to revocation and recovery. When no order is made, the following fill and settle are recorded as skipped, never applied to an earlier order. An ambiguous outcome stops the run for reconciliation. The request and the exact response are written to the ledger before any signing. On resume, a recorded decision is reused; a request without a recorded response stops by default, and `MANDATE_LIVE_ALLOW_NEW_DECISION=1` explicitly permits a new, recorded decision, which may incur another inference charge. This 50/50 rule is the agent's objective, not a limit the contract enforces, and model quality, latency and any NEAR AI attestation are not verified here.

## Known limits

- A transient price reading below the breaker threshold stops new authorization for the rest of that grant.
- A transaction's top-level result can arrive before its detached key-registration or removal receipts finish; tools poll `get_grant` until no key operation is in flight.
- Registration presence is evidence of our registration or of a verifier-admin key addition; verifier admins can already lock or alter the account, so this adds no new trust.
- Sandbox timing does not represent mainnet latency.

## Disclosures

**Hackathon window.** This repository's history starts at commit `85cda4b` on 2026-11-03, inside the NEAR HACKATHON window. The project does not exist on another chain.

**AI tools** (rule Q-005):
<!-- AUTHOR: confirm whether any other AI tools were used -->
- The product code, tests and documentation were implemented with Claude Code (Anthropic Claude models) under the author's direction and review.
- OpenAI Codex was used for independent review of the design, code and evidence.
- The two model fixtures in [fixtures/model/](fixtures/model/) are genuine `claude-haiku-5-5` interactions, recorded through the headless Claude Code CLI by `tools/src/agent/record.ts`. The MODEL gate and `make demo` replay them. No gate or demo makes a live model call or needs a model key.

**Major libraries.** Exact resolved versions from [Cargo.lock](Cargo.lock) and [tools/package-lock.json](tools/package-lock.json), which hold the full dependency set. Licenses are taken from the resolved crate and package metadata.

| Library | Version | License | Used for |
| --- | --- | --- | --- |
| `near-sdk` | 5.29.1 | MIT OR Apache-2.0 | contract, baseline and stubs |
| `near-contract-standards` | 5.29.1 | MIT OR Apache-2.0 | NEP-141 token test double |
| `borsh` | 1.8.1 | MIT OR Apache-2.0 | NEP-413 encoding in the contract |
| `serde` / `serde_json` | 1.0.229 / 1.0.154 | MIT OR Apache-2.0 | JSON types |
| `hex` | 0.4.3 | MIT OR Apache-2.0 | payload and signature encoding |
| `near-workspaces` | 0.23.0 | MIT OR Apache-2.0 | Rust sandbox tests |
| `tokio` / `anyhow` | 1.54.1 / 1.0.104 | MIT / MIT OR Apache-2.0 | test runtime and errors |
| `ed25519-dalek` | 2.2.0 | BSD-3-Clause | MPC test double's test keys; signature checks in tests |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | hashing in tests |
| `rand` / `rand_chacha` | 0.9.5 / 0.9.0 | MIT OR Apache-2.0 | seeded randomized interleavings (T2) |
| `defuse-core` (git, [near/intents@16d04f6](https://github.com/near/intents/tree/16d04f6ec4401263f8914638710260da50bb46b0)) | 0.1.0 | MIT (repository license; the crate declares none) | test-only cross-check of our NEP-413 encoding |
| `near-api-js` | 7.3.1 | MIT AND Apache-2.0 | RPC and transactions in `tools/` |
| `near-sandbox` (npm) | 0.3.4 | MIT | local sandbox for the demo |
| `zod` | 4.6.7 | MIT | schema validation of model output and RPC results |
| `@anthropic-ai/sdk` | 0.136.0 | MIT | optional provider for recording new model interactions; unused by gates and demo |
| `typescript` / `tsx` | 6.0.3 / 4.23.15 | Apache-2.0 / MIT | build and script runner |
| `vitest` | 5.0.5 | MIT | TypeScript tests |
| `eslint` / `typescript-eslint` / `@eslint/js` / `@types/node` | 10.13.0 / 8.72.0 / 10.0.1 / 26.6.5 | MIT | lint and types |

**Upstream code and data in this repository**, also listed in [NOTICE](NOTICE):
- [fixtures/verifier/defuse-0.4.5.wasm](fixtures/verifier/defuse-0.4.5.wasm): the exact NEAR Intents verifier code deployed at `intents.near`, retrieved read-only and unmodified (MIT, NEAR Foundation). Provenance is in [fixtures/manifest.json](fixtures/manifest.json).
- [baseline/claw-guard-adapted](baseline/claw-guard-adapted): our re-implementation of the [Claw Guard](https://github.com/metafrogmeme-droid/claw-guard-near) design at commit 225d37d (MIT, Patrick Baur). The design is adapted and no code is copied; it serves T5 alone.
- [fixtures/vectors/oracle.json](fixtures/vectors/oracle.json): public read-only responses of `aggregate-oracle.near`.
- `stubs/`: our own labelled test doubles, written against the documented interfaces of `v1.signer`, `aggregate-oracle.near` and NEP-141.

**Tooling, not distributed:**
- Build: Rust 1.97.1, `cargo-near` 0.22.0 and the `sourcescan/cargo-near:0.22.0-rust-1.97.1` image for reproducible builds.
- Tests and demo: the NEAR sandbox binary (nearcore 2.13.4), which `near-workspaces` and `near-sandbox` download at test time. Node.js 24.
- Video only, in `tools/src/video/make.ts`: ffmpeg, Google Chrome and `playwright-core`.

## License

MIT. Third-party components and fixtures are listed in [NOTICE](NOTICE).
