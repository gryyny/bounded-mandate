import { z } from "zod";
import type { ReportFile } from "./casefiles.js";
import { escapeHtml } from "./html.js";
import { reportDetails } from "./results.js";

const STAGES = [
  ["dao_is_pinned_code_and_fixed_owner", "A DAO owns the mandate", "The deployed Sputnik code and the fixed owner are checked. The DAO account has no access keys; council members cannot bypass its proposals."],
  ["non_owner_direct_calls_refused", "Council membership is not owner authority", "Direct council-member calls to grant, revoke and recover are refused by the mandate."],
  ["outsider_cannot_propose", "Outsiders cannot create owner proposals", "The pinned DAO rejects a proposal from an account outside the council."],
  ["grant_one_of_three_executes_nothing", "One approval leaves the grant pending", "A first approval does not grant authority. Duplicate votes and outsider votes are refused."],
  ["rejected_proposal_executes_nothing", "A rejected grant creates no authority", "A rejected proposal leaves the mandate without a grant and cannot be revived by a late approval."],
  ["grant_two_of_three_executes", "The threshold grants trading authority", "The second council approval executes the FunctionCall proposal. The agent can then propose trades within the approved policy."],
  ["agent_trade_under_dao_grant", "The agent trades under those limits", "The sandbox fills and settles a trade, then holds back another signed order."],
  ["removed_proposal_executes_nothing", "Removing a proposal does not revoke the grant", "Removing a revoke proposal leaves the active grant unchanged. Revocation requires an executed owner call."],
  ["revoke_one_of_three_executes_nothing", "One approval does not revoke", "The revoke proposal stays pending until the council reaches its threshold. Already-signed orders remain authority until key removal is confirmed."],
  ["revoke_two_of_three_removes_key", "Threshold approval removes the key", "The approved revoke removes the grant key at the verifier. The held order is relayed and rejected."],
  ["recover_both_assets_to_dao_intents_account", "Recover into the DAO's Intents account", "Separate approved recover calls move both remaining assets to the fixed DAO owner inside Intents."],
  ["ft_withdraw_to_unregistered_dao_refunds", "A missing token registration causes a refund", "The first USDC withdrawal cannot pay an unregistered token account; the assets remain recoverable inside Intents."],
  ["storage_deposit_two_of_three_registers_dao", "Approve registration before retrying", "The council approves the DAO's token storage registration; one approval alone makes no change."],
  ["dao_ft_withdraw_to_own_account", "Withdraw separately to the DAO account", "The DAO withdraws both assets from its Intents account into its own token accounts. Withdrawal is the DAO's later action, outside the mandate's recovery claim."],
] as const;

export const DaoData = z.object({
  owner: z.string(),
  vote_policy: z.string(),
  steps: z.array(z.object({ check: z.string(), passed: z.boolean(), detail: z.unknown() })).nonempty(),
}).refine((d) => d.steps.every((s) => s.passed) && STAGES.every(([id]) => d.steps.filter((s) => s.check === id).length === 1), "DAO walkthrough requires all recorded workflow checks to pass exactly once");

export function daoBody(result: { data: z.infer<typeof DaoData>; report: ReportFile } | null): string {
  const intro = `<p>A DAO can be the mandate's single fixed owner. Its members approve limits, revocation and recovery through the DAO's own proposal policy; the agent never gets a council vote or owner authority.</p><p class="note-line"><strong>Recorded sandbox walkthrough, not interactive voting.</strong> Pinned Sputnik DAO code and the pinned Intents verifier execute in sandbox; MPC signer, oracle and tokens are test doubles. No DAO mainnet run or external governance UI is demonstrated.</p>`;
  if (result === null) return `${intro}<p class="muted">No matching certified DAO workflow report is attached to this replay. No voting outcome is shown. Reproduce the workflow with <code class="cmd">make test</code>, gate <code>DAO.sputnik-owner</code>.</p>`;
  const rows = STAGES.map(([id, title, explanation]) => {
    const step = result.data.steps.find((s) => s.check === id);
    return `<li><h3>${escapeHtml(title)}</h3><p>${escapeHtml(explanation)}</p><details><summary>Inspect the recorded check: <code>${escapeHtml(id)}</code></summary><p>Recorded assertion: ${step?.passed === true ? "passed" : "not passed"}.</p><pre>${escapeHtml(JSON.stringify(step?.detail, null, 2))}</pre></details></li>`;
  });
  return `${intro}<p><strong>Recorded policy:</strong> ${escapeHtml(result.data.vote_policy)}.</p><p><strong>Recorded owner:</strong> ${escapeHtml(result.data.owner)}.</p><ol class="dao-workflow">${rows.join("")}</ol><p>Rejected and removed proposals, duplicate votes and outsiders are also exercised; inspect the full report below. This presentation reads the same acceptance run as the page, rather than simulating council decisions in the browser. Reproduce with <code class="cmd">make test</code>, gate <code>DAO.sputnik-owner</code>.</p>${reportDetails(result.report)}`;
}
