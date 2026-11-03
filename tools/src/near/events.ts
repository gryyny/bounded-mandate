// NEP-297 event parsing. Logs are external input: validate before use.
import { z } from "zod";

export const EVENT_PREFIX = "EVENT_JSON:";

export const NearEvent = z.object({
  standard: z.string(),
  version: z.string(),
  event: z.string(),
  data: z.unknown(),
});
export type NearEvent = z.infer<typeof NearEvent>;

export interface EmittedEvent extends NearEvent {
  emitter: string;
  receipt_id: string;
}

/** Parses one log line; returns null for non-event logs and throws on a malformed event. */
export function parseEventLog(log: string): NearEvent | null {
  if (!log.startsWith(EVENT_PREFIX)) return null;
  return NearEvent.parse(JSON.parse(log.slice(EVENT_PREFIX.length)));
}
