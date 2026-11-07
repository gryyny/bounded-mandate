// Reads the live agent's inputs from chain state. The decision itself (objective guard, model call, verdicts)
// lives in objective.ts, which has no chain client; it is re-exported here for existing importers.
import { z } from "zod";
import type { NearClient } from "../near/client.js";
import { tokenId } from "../near/contracts.js";
import { GrantView, type Asset } from "../types.js";
import type { FreshObservations, PriceReading } from "./objective.js";

export * from "./objective.js";

const Units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const OraclePrice = z.object({ price: z.string(), conf: z.string(), expo: z.number().int(), publish_time: z.number().int() }).loose();

export interface ChainIds {
  mandate: string;
  verifier: string;
  oracle: string;
  tokens: Record<Asset, string>;
  priceIds: Record<Asset, string>;
}

export interface ObservationOptions {
  /**
   * Before the first grant: read both prices with this maximum age (the planned policy's oracle_max_age_sec), and
   * treat a mandate account that does not exist yet as "no grant". Without it, no grant means no prices.
   */
  plannedMaxAgeSec?: number;
}

const MISSING_ACCOUNT = /does not exist|AccountDoesNotExist|UNKNOWN_ACCOUNT|CodeDoesNotExist|no contract code/i;

/** Reads grant, mandate balances and both oracle prices at one final block (the client's finality). */
export async function readObservations(client: Pick<NearClient, "provider" | "finality">, ids: ChainIds, opts: ObservationOptions = {}): Promise<FreshObservations> {
  const block = await client.provider.viewBlock({ finality: client.finality });
  const height = block.header.height;
  const at = async <T>(contractId: string, method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    const raw = await client.provider.callFunctionRaw({ contractId, method, args, blockQuery: { blockId: height } });
    const text = Buffer.from(raw.result).toString("utf8");
    return schema.parse(text === "" ? null : JSON.parse(text));
  };
  const planned = opts.plannedMaxAgeSec;
  const grant = await at(ids.mandate, "get_grant", {}, GrantView.nullable()).catch((error: unknown) => {
    if (planned !== undefined && error instanceof Error && MISSING_ACCOUNT.test(error.message)) return null;
    throw error;
  });
  const balance = (a: Asset) => at(ids.verifier, "mt_balance_of", { account_id: ids.mandate, token_id: tokenId(ids.tokens[a]) }, Units);
  const nowSec = BigInt(block.header.timestamp_nanosec) / 1_000_000_000n;
  const errors: string[] = [];
  const price = async (a: Asset): Promise<PriceReading | null> => {
    const age = grant === null ? planned : grant.policy.oracle_max_age_sec;
    if (age === undefined) return null;
    try {
      const p = await at(ids.oracle, "get_price_no_older_than", { price_id: ids.priceIds[a], age }, OraclePrice.nullable());
      if (p === null) return null;
      return { price_id: ids.priceIds[a], max_age_sec: age, price: p.price, conf: p.conf, expo: p.expo, publish_time: p.publish_time, age_sec: Number(nowSec - BigInt(p.publish_time)) };
    } catch (error) {
      errors.push(`${a} oracle read failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
      return null;
    }
  };
  return {
    block: { height, hash: block.header.hash, timestamp_ns: block.header.timestamp_nanosec },
    grant,
    balances: { usdc: await balance("usdc"), wnear: await balance("wnear") },
    prices: { usdc: await price("usdc"), wnear: await price("wnear") },
    read_errors: errors,
  };
}
