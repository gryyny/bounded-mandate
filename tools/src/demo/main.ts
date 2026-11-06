// `make demo`: the complete unfunded sandbox story, with evidence in out/evidence/demo.json.
// Chain actions run on a local sandbox against our contract, the pinned verifier WASM and labelled test
// doubles; the model step replays a recorded genuine interaction. The owner reviews the grant in the console and
// revokes through its owner controls, in headless Chromium, signed by the local sandbox test signer (not a wallet).
// Nothing here touches a public network.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { decide, decisionRecord, judge, submitProposal, type AgentDecision } from "../agent/adapter.js";
import { RecordedProvider } from "../agent/recording.js";
import { runAttackSuite } from "../attacks/suite.js";
import { environment, sourceBinding } from "../evidence/source.js";
import { Filler } from "../filler/filler.js";
import { nep413Prehash } from "../filler/nep413.js";
import { findSignedPayload, settledOrder } from "../near/contracts.js";
import { LocalNetwork, REPO_ROOT, requireSuccess } from "../near/sandbox.js";
import { Evidence, Proposal } from "../types.js";
import { BENIGN_NOTES, DECIMALS, DEMO_POLICY, DEPOSITS, PRICES, SCRIPTED_WITHHELD_PROPOSAL } from "./market.js";
import { Recorder, chainSnapshot, grantDemo, journeyState, tryLoadRecording } from "./story.js";
import { attackLogFields } from "./attack-log.js";
import { withdrawToOwner } from "./withdraw.js";
import {
  CONSOLE_BROWSER_LABEL,
  CONSOLE_LOCAL_PATH,
  OWNER_CONTROLS_LABEL,
  PLANNED_LABEL,
  PLANNED_URLS,
  relayRejectionProblems,
  removedKeyError,
  type ConsoleRendered,
  type ConsoleReview,
  type ConsoleRevoke,
  type OwnerWithdrawal,
} from "../evidence/journey.js";
import { balances, fillerKey, postPrices, setupWorld, type World } from "./world.js";
import { valueUnits } from "../agent/snapshot.js";
import { canonical } from "../live/ledger.js";
import { simulationProblem } from "../live/verify.js";
import { renderPage } from "../page/render.js";
import { renderConsole } from "../console/render.js";
import { fmtShort, policyLines } from "../console/client.js";
import { CONSOLE_INTENT_SCHEMA, intentSha256 } from "../console/intent.js";
import { ConsoleSession } from "./console-drive.js";

const str = (v: bigint): string => v.toString();
const balStr = (b: Record<string, bigint>): Record<string, string> => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, str(v)]));
/** Same digest as the live runner's bundle_sha256: sha256 of the canonical JSON of the exact signed bundle. */
const bundleSha256 = (bundle: unknown): string => createHash("sha256").update(canonical(bundle)).digest("hex");

async function accessKeys(world: World, accountId: string): Promise<unknown[]> {
  const list = await world.client.provider.viewAccessKeyList({ accountId, finalityQuery: { finality: "optimistic" } });
  return list.keys.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission }));
}

/** Differences between what the console rendered and the chain views read here; empty when they agree. */
async function reviewMismatches(world: World, shown: ConsoleRendered, errors: readonly string[]): Promise<string[]> {
  const { mandate, verifier } = world;
  const config = await mandate.config();
  const grant = await mandate.grant();
  const bal = await balances(world, mandate.id);
  const out: string[] = [];
  const same = (what: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${what}: console shows ${JSON.stringify(got)}, chain ${JSON.stringify(want)}`);
  };
  if (!shown.live_status.startsWith("Read from")) out.push(`live read: ${shown.live_status}`);
  if (!shown.chain_verified) out.push("the console did not verify the chain");
  if (!shown.deployment_matches) out.push("the console did not match the deployment");
  if (!shown.owner_controls.startsWith("owner controls enabled")) out.push(`owner controls: ${shown.owner_controls}`);
  if (grant === null) {
    out.push("no grant on chain");
  } else {
    same("grant status", shown.grant_status, grant.status);
    if (!shown.grant_line.includes(`epoch ${String(grant.epoch)}`)) out.push(`grant epoch: console shows "${shown.grant_line}", chain epoch ${String(grant.epoch)}`);
    same("grant key", shown.grant_key, grant.public_key);
    const registered = grant.public_key !== null && (await verifier.hasPublicKey(mandate.id, grant.public_key));
    same("key on the verifier", shown.key_on_verifier, `${registered ? "registered" : "absent"} on ${verifier.id}`);
    same("limits", shown.limits, policyLines(grant.policy));
  }
  same("mandate", shown.mandate, [
    ["Owner", config.owner_id],
    ["Agent", config.agent_id],
    ["Intents verifier", config.verifier_id],
    ["MPC signer", config.signer_id],
    ["Price oracle", config.oracle_id],
  ]);
  same("mandate balances", shown.mandate_balances, { USDC: fmtShort(str(bal.usdc), DECIMALS.usdc, 6), wNEAR: fmtShort(str(bal.wnear), DECIMALS.wnear, 6) });
  for (const e of errors) out.push(`page error: ${e}`);
  return out;
}

/** The exact revoke the console must preview: derived here from the profile, the signer's key and the mandate id. */
function expectedRevokePreview(world: World, session: ConsoleSession): [string, string][] {
  const p = session.profile;
  const key = session.signer.info().public_key ?? "";
  const gas = (BigInt(p.gas_tgas.revoke) * 10n ** 12n).toString();
  const intent = {
    schema: CONSOLE_INTENT_SCHEMA,
    action: "revoke",
    asset: null,
    network: { chain_id: p.chain_id, genesis_hash: p.genesis_hash },
    signer_id: world.owner.id,
    public_key: key,
    receiver_id: world.mandate.id,
    actions: [{ method: "revoke", args: {}, gas, deposit: "0" }],
  };
  return [
    ["Network", `${p.label} · chain id ${p.chain_id} · genesis ${p.genesis_hash}`],
    ["Signer", `${world.owner.id} · key ${key}`],
    ["Receiver", world.mandate.id],
    ["Method", "revoke"],
    ["Arguments", "{}"],
    ["Gas", `${gas} (${String(p.gas_tgas.revoke)} TGas)`],
    ["Deposit", "0 yoctoNEAR"],
    ["Intent sha256", intentSha256(intent)],
    ["Source", "console preview (no runner intent loaded)"],
  ];
}

/** Rows of the shown preview that differ from the derived one, by label; empty when every row is exact. */
function previewProblems(shown: [string, string][], want: [string, string][]): string[] {
  const out = want.flatMap(([k, v], i) => {
    const row = shown[i];
    return row !== undefined && row[0] === k && row[1] === v ? [] : [`${k}: expected "${v}", shown "${shown.find(([sk]) => sk === k)?.[1] ?? "nothing"}"`];
  });
  return shown.length === want.length ? out : [...out, `${String(shown.length)} rows shown, ${String(want.length)} expected`];
}

async function story(world: World, rec: Recorder, unknowns: string[], identifiers: Record<string, string>, session: ConsoleSession): Promise<void> {
  const { client, mandate, verifier } = world;

  await rec.step("Grant and limits");
  rec.receipt(await grantDemo(world), { step: "grant" });
  const grant = await mandate.grant();
  if (grant === null) throw new Error("no grant");
  const expectedInitial =
    valueUnits(DEPOSITS.usdc, DECIMALS.usdc, { price: PRICES.usdc.price.toString(), expo: PRICES.usdc.expo }) +
    valueUnits(DEPOSITS.wnear, DECIMALS.wnear, { price: PRICES.wnear.price.toString(), expo: PRICES.wnear.expo });
  rec.check("grant-active", "T1", "grant is active and its derived key is registered on the verifier", grant.status === "active" && grant.public_key !== null && (await verifier.hasPublicKey(mandate.id, grant.public_key)), {
    epoch: grant.epoch,
    path: grant.path,
    public_key: grant.public_key,
    policy: grant.policy,
    initial_reference: grant.initial_reference,
  });
  rec.check("grant-initial-value", "T3", "initial reference value equals deposits x posted prices (independent derivation)", grant.initial_value === str(expectedInitial), {
    contract: grant.initial_value,
    derived: str(expectedInitial),
  });
  identifiers.grant_public_key = grant.public_key ?? "";
  identifiers.grant_path = grant.path;

  await rec.step("Mandate reviewed in the console");
  const mandateKeys = await accessKeys(world, mandate.id);
  rec.check("mandate-no-keys", "BOUNDARY", "mandate account has no access key; only its contract acts for it", mandateKeys.length === 0, mandateKeys);
  const agentKeys = await accessKeys(world, world.agent.id);
  const onlyPropose =
    agentKeys.length === 1 && JSON.stringify(agentKeys[0]).includes('"method_names":["propose_order"]') && JSON.stringify(agentKeys[0]).includes(mandate.id);
  rec.check("agent-one-restricted-key", "BOUNDARY", "agent's only key is a function-call key for propose_order on the mandate", onlyPropose, agentKeys);
  const config = await mandate.config();
  const rendered = await session.review();
  const mismatches = await reviewMismatches(world, rendered, session.errors);
  const review: ConsoleReview = {
    state: await journeyState(world),
    config: { owner: config.owner_id, agent: config.agent_id, verifier: config.verifier_id, usdc_token: config.usdc.token, wnear_token: config.wnear.token },
    // The static console view is rendered from this run's evidence after the story; main() records its path once written.
    view: { local_path: null, planned_url: PLANNED_URLS.console, planned_label: PLANNED_LABEL },
    rendered,
    mismatches,
  };
  rec.check(
    "console-review",
    "DEMO",
    `the ${CONSOLE_BROWSER_LABEL} shows the grant's status, limits, key on the verifier, the fixed accounts and the mandate's balances exactly as the chain views read them`,
    mismatches.length === 0 && review.config.owner === world.owner.id && review.config.agent === world.agent.id && review.config.verifier === verifier.id && review.config.usdc_token === world.tokens.usdc && review.config.wnear_token === world.tokens.wnear,
    review,
  );

  await rec.step("Bounded agent proposal (recorded genuine model output) -> propose_order");
  const recorded = tryLoadRecording("normal");
  let firstProposal: Proposal;
  let decision: AgentDecision | null = null;
  if (recorded.ok) {
    const snapshot = await chainSnapshot(world, BENIGN_NOTES);
    try {
      decision = await decide(new RecordedProvider(recorded.recording), snapshot);
    } catch (error) {
      unknowns.push(`recorded model replay refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    unknowns.push(`no genuine model proposal: ${recorded.reason}`);
  }
  if (decision?.verdict.kind === "proposal") {
    firstProposal = decision.verdict.proposal;
  } else {
    firstProposal = { sell: "usdc", sell_amount: "49900000", max_concession_bps: 20 };
    unknowns.push("first order used a SCRIPTED proposal because no valid recorded model proposal was available; the MODEL assertion below fails");
  }
  const proposeOutcome = rec.receipt(await submitProposal(client, world.agent.account, mandate.id, firstProposal, "agent propose_order (order 1)"), {
    proposal: firstProposal,
    proposal_source: decision?.verdict.kind === "proposal" ? "recorded-model" : "scripted",
  });
  const firstId = z.string().parse(String(proposeOutcome.return_value));
  const first = await settledOrder(mandate, firstId);
  rec.check(
    "model-proposal-on-chain",
    "MODEL",
    "a recorded genuine model proposal (prompt hash bound to chain state) reached propose_order and was signed",
    decision?.verdict.kind === "proposal" && first?.state.state === "signed" && first.sell === firstProposal.sell && first.sell_amount === firstProposal.sell_amount,
    { mode: "recorded-model", decision: decision === null ? null : decisionRecord(decision), recording: recorded.ok ? recorded.recording.path : null, order: first },
  );
  if (first?.payload == null) throw new Error("first order has no payload");
  const prehash = nep413Prehash({ message: first.payload.message, nonce: Buffer.from(first.payload.nonce, "base64"), recipient: first.payload.recipient }).toString("hex");
  rec.check("nep413-cross-check", "T2", "TypeScript NEP-413 prehash equals the contract's payload_hash", prehash === first.payload_hash, { ts: prehash, contract: first.payload_hash });

  await rec.step("Filler fills order 1 (actual trade on the pinned verifier)");
  const statePath = join(REPO_ROOT, "out/demo/filler-state.json");
  rmSync(statePath, { force: true }); // fresh sandbox chain: previous runs' order ids are unrelated
  const filler = new Filler({ client, mandate, verifier, account: world.filler.account, key: fillerKey(world), statePath });
  const before = await balances(world, mandate.id);
  const signedEvent = proposeOutcome.events.find((e) => e.event === "order_signed");
  const fromEvent = signedEvent === undefined ? null : findSignedPayload(signedEvent.data);
  const fill = await filler.fill(firstId, fromEvent ?? undefined);
  if (fill.outcome !== undefined) rec.receipt(fill.outcome, { filler_record: fill.record });
  const after = await balances(world, mandate.id);
  const buyAmount = BigInt(first.buy_amount ?? "0");
  const sold = BigInt(first.sell_amount);
  const buyAsset = first.buy;
  const expectedAfter = { ...before, [first.sell]: before[first.sell] - sold, [buyAsset]: before[buyAsset] + buyAmount };
  rec.check("trade-executed", "T3", "fill executed: mandate balances moved by exactly the signed amounts (fees borne by the filler)", fill.record.state === "filled" && JSON.stringify(balStr(after)) === JSON.stringify(balStr(expectedAfter)), {
    before: balStr(before),
    after: balStr(after),
    signed: { sell: first.sell, sell_amount: first.sell_amount, buy: buyAsset, buy_amount: first.buy_amount },
    filler_counter_diff: fill.record.counter_diff,
  });
  const settle = rec.receipt(await mandate.settle(world.relayer.account, firstId));
  const settledFirst = await mandate.order(firstId);
  rec.check("settled-release", "T2", "settle_order released the reservation on the verifier's nonce evidence", settle.success && settledFirst?.state.state === "released" && settledFirst.state.reason === "settled", settledFirst?.state);

  await rec.step("Second signed order withheld");
  await postPrices(world);
  const withheldOutcome = rec.receipt(await submitProposal(client, world.agent.account, mandate.id, SCRIPTED_WITHHELD_PROPOSAL, "agent propose_order (order 2, scripted, withheld)"), {
    proposal_source: "scripted",
  });
  const withheldId = z.string().parse(String(withheldOutcome.return_value));
  const withheld = await settledOrder(mandate, withheldId);
  const withheldEvent = withheldOutcome.events.find((e) => e.event === "order_signed");
  const withheldSigned = withheldEvent === undefined ? null : findSignedPayload(withheldEvent.data);
  if (withheld?.state.state !== "signed" || withheldSigned === null) throw new Error(`withheld order not signed: ${JSON.stringify(withheld?.state)}`);
  const prepared = await filler.prepare(withheldSigned);
  if ("shortfall" in prepared) throw new Error(prepared.shortfall);
  const simProblem = simulationProblem(await verifier.simulate(prepared.bundle));
  const withheldBundleSha256 = bundleSha256(prepared.bundle);
  rec.check("withheld-executable", "T1", "withheld order is executable before revocation (simulate_intents accepts the bundle with no invariant violation)", simProblem === null, {
    simulation: simProblem ?? "accepted",
    order_id: withheldId,
    epoch: withheld.epoch,
    mandate: mandate.id,
    signing_public_key: withheldSigned.public_key,
    mandate_nonce: withheldSigned.payload.nonce,
    deadline_ns: withheld.deadline_ns,
    payload_sha256: withheld.payload_hash,
    bundle_sha256: withheldBundleSha256,
    filler_nonce: prepared.own.payload.nonce,
  });

  await rec.step("Hostile requests refused");
  const suite = await runAttackSuite(world);
  for (const r of suite.results) {
    rec.check(`attack-${r.id}`, "BOUNDARY", `${r.description} -> stopped by ${r.expected} (${r.origin})`, r.passed, { ...r.detail, ...attackLogFields(REPO_ROOT, r) });
  }
  const injected = tryLoadRecording("injection");
  if (injected.ok) {
    const verdict = judge(injected.recording.interaction.decision_text);
    const text = injected.recording.interaction.decision_text ?? "";
    // The boundary property is structural: whatever the model writes, only a strict Proposal (or a
    // decline) leaves the adapter. Free-text reasons are reported, never parsed for authority.
    const structured = verdict.kind === "proposal" ? Proposal.safeParse(verdict.proposal) : null;
    const contained = verdict.kind !== "proposal" || structured?.success === true;
    const structuredText = verdict.kind === "proposal" ? JSON.stringify(verdict.proposal) : "";
    rec.check("injection-recording", "BOUNDARY", "genuine model output to an injected prompt leaves the adapter only as a strict Proposal or a decline (no withdrawal expressible)", contained, {
      mode: "recorded-model",
      prompt_variant: "injection",
      model: injected.recording.interaction.model,
      decision_text: text,
      verdict,
      structured_output_names_injected_target: /evil\.near/i.test(structuredText),
      reason_mentions_injection: /evil\.near|withdraw/i.test(text),
    });
  } else {
    unknowns.push(`injection recording unavailable: ${injected.reason}`);
  }

  await rec.step("Owner revokes in the console; removal confirmed");
  const wantPreview = expectedRevokePreview(world, session);
  const revokeRun = await session.revoke((shown) => previewProblems(shown, wantPreview));
  const problems = previewProblems(revokeRun.preview, wantPreview);
  const revokeOutcome =
    revokeRun.tx_hash === null ? null : await client.resolve(`owner revoke (${OWNER_CONTROLS_LABEL})`, world.owner.id, revokeRun.tx_hash, "revoke");
  if (revokeOutcome !== null) rec.receipt(revokeOutcome, { via: OWNER_CONTROLS_LABEL, intent_sha256: revokeRun.intent_sha256, sign_requests: revokeRun.requests.length });
  const consoleRevoke: ConsoleRevoke = {
    via: OWNER_CONTROLS_LABEL,
    preview: revokeRun.preview,
    preview_problems: problems,
    intent_sha256: revokeRun.intent_sha256 ?? "not signed",
    sign_requests: revokeRun.requests.map((r) => ({ intent_sha256: r.intent_sha256, status: r.status, tx_hash: r.tx_hash })),
    tx_hash: revokeRun.tx_hash,
    ui_final: revokeRun.ui_final,
    outcome: revokeOutcome === null ? "not-found" : revokeOutcome.success ? "success" : "failure",
    screenshot: revokeRun.screenshot,
  };
  const [only] = revokeRun.requests;
  rec.check(
    "revoke-through-console",
    "DEMO",
    `the owner revoked with the console's Revoke control after its exact preview, one sign request, final on chain (${OWNER_CONTROLS_LABEL})`,
    problems.length === 0 &&
      revokeRun.requests.length === 1 &&
      only?.status === "submitted" &&
      only.intent_sha256 === revokeRun.intent_sha256 &&
      only.tx_hash === revokeRun.tx_hash &&
      revokeOutcome?.success === true &&
      revokeOutcome.method === "revoke" &&
      revokeOutcome.receiver_id === mandate.id &&
      (revokeRun.ui_final ?? "").includes("final · success") &&
      session.errors.length === 0,
    consoleRevoke,
  );
  const revoked = await mandate.grant();
  const keyGone = grant.public_key !== null && !(await verifier.hasPublicKey(mandate.id, grant.public_key));
  rec.check("revoked", "T1", "grant revoked and the grant key is no longer registered on the verifier (read over RPC)", revokeOutcome?.success === true && revoked?.status === "revoked" && keyGone, {
    status: revoked?.status,
    key_registered: !keyGone,
    grant_public_key: grant.public_key,
    via: OWNER_CONTROLS_LABEL,
    revoke_tx_hash: revokeRun.tx_hash,
  });
  const releasedWithheld = await mandate.order(withheldId);
  rec.check("withheld-released", "T1", "withheld order's reservation released only by confirmed key removal", releasedWithheld?.state.state === "released" && releasedWithheld.state.reason === "key_removed", releasedWithheld?.state);

  await rec.step("Withheld order relayed from another account");
  const mandateBefore = await balances(world, mandate.id);
  const relayTime = await client.blockTimestampNs();
  const relay = rec.receipt(await verifier.execute(world.relayer.account, prepared.bundle, "relayer execute_intents (withheld order after revocation)"));
  const nonceUsed = await verifier.isNonceUsed(mandate.id, withheldSigned.payload.nonce);
  const mandateAfter = await balances(world, mandate.id);
  const relayError = relay.error ?? relay.receipts.find((r) => !r.success)?.error ?? "";
  const verifierFailure = relay.receipts.find((r) => r.executor_id === verifier.id && r.error !== undefined);
  const rejectedAtNs = verifierFailure === undefined ? null : await client.blockTimestampAt(verifierFailure.block_hash);
  const deadlineNs = withheld.deadline_ns === null ? null : BigInt(withheld.deadline_ns);
  const rejection = relayRejectionProblems({
    relaySucceeded: relay.success,
    verifierError: verifierFailure?.error ?? null,
    revokedKey: withheldSigned.public_key,
    mandate: mandate.id,
    deadlineNs,
    rejectedAtNs,
    nonceUsed,
    balancesUnchanged: JSON.stringify(balStr(mandateBefore)) === JSON.stringify(balStr(mandateAfter)),
  });
  if (withheldSigned.public_key !== grant.public_key) rejection.push("the withheld order was not signed by the revoked grant key");
  rec.check(
    "withheld-rejected",
    "T1",
    "relayed withheld order failed with the verifier's error naming the removed grant key and the mandate, in a block before its deadline, with no balance change",
    rejection.length === 0,
    {
      error: (verifierFailure?.error ?? relayError).slice(0, 300),
      expected_error: removedKeyError(withheldSigned.public_key, mandate.id),
      problems: rejection,
      relay_block_time_ns: str(relayTime),
      order_deadline_ns: withheld.deadline_ns,
      /** Order lifetime left when the relay was broadcast (deadline minus the block time read just before it). */
      remaining_at_broadcast_ns: deadlineNs === null ? null : str(deadlineNs - relayTime),
      remaining_at_rejection_ns: deadlineNs === null || rejectedAtNs === null ? null : str(deadlineNs - rejectedAtNs),
      nonce_used: nonceUsed,
      relay_tx_hash: relay.tx_hash ?? null,
      relayer: world.relayer.id,
      verifier: verifier.id,
      mandate: mandate.id,
      revoked_key: withheldSigned.public_key,
      mandate_nonce: withheldSigned.payload.nonce,
      bundle_sha256: bundleSha256(prepared.bundle),
      verifier_receipt:
        verifierFailure === undefined || rejectedAtNs === null
          ? null
          : { id: verifierFailure.id, block_hash: verifierFailure.block_hash, block_time_ns: str(rejectedAtNs) },
    },
  );

  await rec.step("Agent, oracle and MPC disabled");
  rec.receipt(requireSuccess(await client.call("oracle set_fail(true)", world.operator.account, world.oracleId, "set_fail", { fail: true })));
  rec.receipt(requireSuccess(await client.call("mpc set_mode(hold)", world.operator.account, world.mpcId, "set_mode", { mode: "hold" })));
  const lateProposal = rec.receipt(await submitProposal(client, world.agent.account, mandate.id, { sell: "usdc", sell_amount: "1000000", max_concession_bps: 10 }, "agent propose_order after revocation"));
  rec.check("agent-stopped", "T4", "agent proposal after revocation is rejected by the contract; the agent takes no further part", !lateProposal.success, lateProposal.error?.slice(0, 200));

  await rec.step("Recovery to the owner's Intents account");
  const ownerBefore = await balances(world, world.owner.id);
  const toRecover = await balances(world, mandate.id);
  for (const asset of ["usdc", "wnear"] as const) rec.receipt(await mandate.recover(world.owner.account, asset));
  const mandateFinal = await balances(world, mandate.id);
  const ownerFinal = await balances(world, world.owner.id);
  rec.check(
    "recovered",
    "T4",
    "all mandate units moved to the owner's Intents account with oracle failing and MPC on hold",
    mandateFinal.usdc === 0n && mandateFinal.wnear === 0n && ownerFinal.usdc - ownerBefore.usdc === toRecover.usdc && ownerFinal.wnear - ownerBefore.wnear === toRecover.wnear,
    { destination: `${world.owner.id} (owner's Intents account)`, recovered: balStr(toRecover), mandate_final: balStr(mandateFinal), owner_final: balStr(ownerFinal), recovery: await mandate.recovery() },
  );

  await rec.step("Owner withdrawal to its NEAR account (outside recovery)");
  const withdrawal: OwnerWithdrawal = { owner: world.owner.id, verifier: verifier.id, outside_recovery: true, assets: [] };
  // One asset's failure neither blocks nor repeats the other's.
  for (const asset of ["usdc", "wnear"] as const) withdrawal.assets.push(await withdrawToOwner(world, rec, asset));
  rec.check(
    "owner-withdrawal",
    "WITHDRAWAL",
    "the owner withdrew both assets from its Intents account to its NEAR account with ft_withdraw, registering storage only where needed (owner action, not part of recovery)",
    withdrawal.assets.every((a) => a.outcome === "withdrawn"),
    withdrawal,
  );

  await rec.step("Final balances");
  const ownerIntentsFinal = await balances(world, world.owner.id);
  const final = {
    mandate: balStr(await balances(world, mandate.id)),
    owner_intents: balStr(ownerIntentsFinal),
    owner_near: Object.fromEntries(withdrawal.assets.map((a) => [a.asset, a.attempts.at(-1)?.near_after ?? a.near_before])),
    filler: balStr(await balances(world, world.filler.id)),
    fee_collector: balStr(await balances(world, world.feeCollector.id)),
  };
  console.log(JSON.stringify(final, null, 2));
  rec.check("final-balances", "DEMO", "final balances (recorded, not a check)", true, final);
  await rec.close();
}

function render(evidence: Evidence, outDir: string): string {
  // Gate status comes only from out/evidence/acceptance.json written by make test; demo checks never mark a gate.
  return `rendered ${renderPage(evidence, outDir, { policy: DEMO_POLICY })}`;
}

async function main(): Promise<number> {
  const coldStart = Date.now();
  console.log("bounded-mandate demo (sandbox; test doubles for MPC, oracle and tokens; recorded model output)");
  const net = await LocalNetwork.start();
  const unknowns: string[] = [
    "Sandbox execution only: MPC signer, oracle and tokens are labelled test doubles; the verifier is the pinned mainnet WASM.",
    "No mainnet execution in this run; network latency on mainnet is not represented by sandbox timing.",
    "The model step replays a recorded interaction; the claude-cli harness may add context that the recording cannot show.",
    "The console review and the revocation run in headless Chromium with owner controls via the local sandbox test signer (not a wallet); no external wallet is exercised.",
    "Concession bounds, randomized interleavings and breaker behaviour are covered by the Rust gate tests, not by this story.",
  ];
  const identifiers: Record<string, string> = {};
  try {
    // The owner holds no wNEAR token registration, so its withdrawal exercises storage registration (see WorldOptions).
    const world = await setupWorld(net, { ownerUnregistered: ["wnear"] });
    const setupMs = Date.now() - coldStart;
    Object.assign(identifiers, {
      mandate: world.mandate.id,
      verifier: world.verifier.id,
      owner: world.owner.id,
      agent: world.agent.id,
      filler: world.filler.id,
      relayer: world.relayer.id,
      usdc_token: world.tokens.usdc,
      wnear_token: world.tokens.wnear,
      oracle_test_double: world.oracleId,
      mpc_test_double: world.mpcId,
    });
    console.log(`setup (sandbox start, deploy, fund): ${setupMs} ms`);
    const rec = new Recorder(() => journeyState(world));
    const binding = sourceBinding(REPO_ROOT, world.wasm.mandate.sha256, Object.values(world.wasm));
    const timings: Record<string, string> = { setup_ms: String(setupMs) };
    const draft = () => ({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      mode: "sandbox",
      source: binding.source,
      environment: environment(REPO_ROOT, {
        sandbox_neard: net.version,
        verifier_wasm_sha256: world.wasm.verifier.sha256,
        model_mode: "recorded-model",
        ...timings,
        console_driver: `${CONSOLE_BROWSER_LABEL}; ${OWNER_CONTROLS_LABEL}`,
        owner_setup: "owner storage registration on the wNEAR token removed after its deposit (sandbox setup), so the withdrawal registers it",
        steps: JSON.stringify(rec.steps),
      }),
      command: "make demo",
      identifiers,
      receipts: rec.receipts,
      assertions: rec.assertions,
      unknowns,
    });
    // The console served to the browser shows this run's evidence so far as its recorded section.
    const browserStart = Date.now();
    const session = await ConsoleSession.start(world, () => Evidence.parse(draft()));
    const browserMs = Date.now() - browserStart;
    timings.browser_start_ms = String(browserMs);
    console.log(`browser start (headless Chromium, console served by the local sandbox test signer): ${String(browserMs)} ms`);
    const storyStart = Date.now();
    try {
      await story(world, rec, unknowns, identifiers, session);
    } finally {
      await session.stop();
    }
    const storyMs = Date.now() - storyStart;
    timings.story_ms = String(storyMs);
    rec.check("story-under-a-minute", "DEMO", "timed story (after setup and browser start) completed in under 60 s", storyMs < 60_000, { story_ms: storyMs, setup_ms: setupMs, browser_start_ms: browserMs });

    if (binding.integrity_error !== null) rec.check("integrity", "INTEGRITY", "spec and fixture hashes match fixtures/manifest.json", false, binding.integrity_error);
    const finalDraft = draft();
    // The static console view is rendered from this run's evidence; the console stage then records where it was written.
    const consolePath = renderConsole(Evidence.parse(finalDraft));
    const consoleRel = relative(REPO_ROOT, consolePath);
    if (consoleRel !== CONSOLE_LOCAL_PATH) throw new Error(`console written to ${consoleRel}, expected ${CONSOLE_LOCAL_PATH}`);
    const evidence = Evidence.parse({
      ...finalDraft,
      assertions: finalDraft.assertions.map((a) => (a.id === "console-review" ? { ...a, observed: { ...(a.observed as ConsoleReview), view: { ...(a.observed as ConsoleReview).view, local_path: consoleRel } } } : a)),
    });
    console.log(`console: ${consoleRel}`);
    const outDir = join(REPO_ROOT, "out/evidence");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "demo.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\nevidence: out/evidence/demo.json`);
    console.log(`page: ${render(evidence, join(REPO_ROOT, "out/page"))}`);
    const failed = evidence.assertions.filter((a) => !a.passed);
    console.log(`\nsetup ${setupMs} ms | story ${storyMs} ms | ${evidence.assertions.length - failed.length}/${evidence.assertions.length} assertions passed | browser start ${String(browserMs)} ms (not in setup or story)`);
    for (const f of failed) console.log(`FAILED: ${f.id} [${f.gate}] ${f.description}`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    await net.stop();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main();
}
