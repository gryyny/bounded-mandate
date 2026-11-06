// Budget derived only from the ledger. Spending is counted conservatively when a transaction is
// intended (before it is sent); fees are replaced by the actual tokens_burnt once the outcome is known.
// An external owner action is counted from its intent (before the owner signs) and settled to the imported
// transaction's actual fee: once per intent, however often its handoff is presented or reconciled.
import { z } from "zod";
import type { Asset } from "../types.js";
import type { Ledger } from "./ledger.js";
import { Refusal, type LiveManifest } from "./manifest.js";

const AssetUnits = z.object({ asset: z.enum(["usdc", "wnear"]), units: z.string() }).strict();
export const Planned = z
  .object({
    worst_fee_yocto: z.string(),
    deposit_yocto: z.string(),
    sell: AssetUnits.optional(),
    filler_pay: AssetUnits.optional(),
  })
  .strict();
export type Planned = z.infer<typeof Planned>;

export class BudgetExceeded extends Refusal {}

export interface Totals {
  transactions: number;
  fee_yocto: bigint;
  deposit_yocto: bigint;
  sold: Record<Asset, bigint>;
  filler_paid: Record<Asset, bigint>;
}

export function totals(ledger: Ledger): Totals {
  const t: Totals = { transactions: 0, fee_yocto: 0n, deposit_yocto: 0n, sold: { usdc: 0n, wnear: 0n }, filler_paid: { usdc: 0n, wnear: 0n } };
  const actualFee = new Map<string, bigint>();
  // Refused by the network before inclusion: it cannot execute later, spent nothing, and its step is planned again.
  const rejected = new Set<string>();
  for (const e of ledger.entries) {
    if ((e.kind === "tx-result" || e.kind === "reconciled") && e.data.status === "rejected" && typeof e.data.tx_hash === "string") rejected.add(e.data.tx_hash);
    if ((e.kind === "tx-result" || e.kind === "reconciled") && typeof e.data.tx_hash === "string" && typeof e.data.fee_yocto === "string" && e.data.status !== "ambiguous") {
      actualFee.set(e.data.tx_hash, BigInt(e.data.fee_yocto));
    }
  }
  const count = (planned: Planned, actual: bigint | undefined): void => {
    t.transactions += 1;
    t.fee_yocto += actual ?? BigInt(planned.worst_fee_yocto);
    t.deposit_yocto += BigInt(planned.deposit_yocto);
    if (planned.sell !== undefined) t.sold[planned.sell.asset] += BigInt(planned.sell.units);
    if (planned.filler_pay !== undefined) t.filler_paid[planned.filler_pay.asset] += BigInt(planned.filler_pay.units);
  };
  for (const e of ledger.ofKind("tx-intent")) {
    const hash = z.string().parse(e.data.tx_hash);
    if (!rejected.has(hash)) count(Planned.parse(e.data.planned), actualFee.get(hash));
  }
  const importedFee = new Map<string, bigint>();
  for (const e of ledger.entries) {
    if ((e.kind === "tx-result" || e.kind === "reconciled") && typeof e.data.intent_sha256 === "string" && e.data.status === "executed" && typeof e.data.fee_yocto === "string") {
      importedFee.set(e.data.intent_sha256, BigInt(e.data.fee_yocto));
    }
  }
  for (const e of ledger.ofKind("external-intent")) count(Planned.parse(e.data.planned), importedFee.get(z.string().parse(e.data.intent_sha256)));
  return t;
}

/** Why selling `sell` would exceed the run's sale caps, or null. */
export function sellProblem(budget: LiveManifest["budget"], spent: Totals, sell: z.infer<typeof AssetUnits>): string | null {
  const { asset, units } = sell;
  if (BigInt(units) > BigInt(budget.max_order_sell[asset])) return `order selling ${units} ${asset} exceeds max_order_sell ${budget.max_order_sell[asset]}`;
  const total = spent.sold[asset] + BigInt(units);
  if (total > BigInt(budget.max_total_sell[asset])) return `selling ${units} ${asset} would bring the run to ${total}, above max_total_sell ${budget.max_total_sell[asset]}`;
  return null;
}

/** Throws before a transaction whose worst case would exceed any cap. */
export function checkPlanned(budget: LiveManifest["budget"], spent: Totals, planned: Planned): void {
  const fail = (msg: string): never => {
    throw new BudgetExceeded(`budget: ${msg}`);
  };
  if (spent.transactions + 1 > budget.max_transactions) fail(`transaction ${spent.transactions + 1} exceeds max_transactions ${budget.max_transactions}`);
  const fee = spent.fee_yocto + BigInt(planned.worst_fee_yocto);
  if (fee > BigInt(budget.max_fee_yocto)) fail(`worst-case fees ${fee} yocto would exceed max_fee_yocto ${budget.max_fee_yocto}`);
  const dep = spent.deposit_yocto + BigInt(planned.deposit_yocto);
  if (dep > BigInt(budget.max_deposit_yocto)) fail(`deposits ${dep} yocto would exceed max_deposit_yocto ${budget.max_deposit_yocto}`);
  if (planned.sell !== undefined) {
    const problem = sellProblem(budget, spent, planned.sell);
    if (problem !== null) fail(problem);
  }
  if (planned.filler_pay !== undefined) {
    const { asset, units } = planned.filler_pay;
    const total = spent.filler_paid[asset] + BigInt(units);
    if (total > BigInt(budget.filler_spend_max[asset])) fail(`filler paying ${units} ${asset} (fees included) would bring it to ${total}, above filler_spend_max ${budget.filler_spend_max[asset]}`);
  }
}

/** After an outcome: actual spend must still be within the caps (a breach stops the run). */
export function checkActual(budget: LiveManifest["budget"], spent: Totals): string | null {
  if (spent.fee_yocto > BigInt(budget.max_fee_yocto)) return `actual fees ${spent.fee_yocto} exceed max_fee_yocto ${budget.max_fee_yocto}`;
  if (spent.deposit_yocto > BigInt(budget.max_deposit_yocto)) return `deposits ${spent.deposit_yocto} exceed max_deposit_yocto`;
  return null;
}
