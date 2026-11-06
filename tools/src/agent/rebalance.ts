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

/** Reads grant, mandate balances and both oracle prices at one final block (the client's finality). */
export async function readObservations(client: NearClient, ids: ChainIds): Promise<FreshObservations> {
  const block = await client.provider.viewBlock({ finality: client.finality });
  const height = block.header.height;
  const at = async <T>(contractId: string, method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    const raw = await client.provider.callFunctionRaw({ contractId, method, args, blockQuery: { blockId: height } });
    const text = Buffer.from(raw.result).toString("utf8");
    return schema.parse(text === "" ? null : JSON.parse(text));
  };
  const grant = await at(ids.mandate, "get_grant", {}, GrantView.nullable());
  const balance = (a: Asset) => at(ids.verifier, "mt_balance_of", { account_id: ids.mandate, token_id: tokenId(ids.tokens[a]) }, Units);
  const nowSec = BigInt(block.header.timestamp_nanosec) / 1_000_000_000n;
  const errors: string[] = [];
  const price = async (a: Asset): Promise<PriceReading | null> => {
    if (grant === null) return null;
    const age = grant.policy.oracle_max_age_sec;
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
