// HTML helpers shared by the page modules.
import { EvidenceMode } from "../types.js";

export const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export const word = (cls: string, text: string): string => `<span class="status ${escapeHtml(cls)}">${escapeHtml(text)}</span>`;

export const modeBadge = (mode: string): string => {
  const known = EvidenceMode.safeParse(mode);
  const cls = known.success ? known.data : "other";
  return `<span class="mode ${cls}" title="execution mode">${escapeHtml(mode)}</span>`;
};

export const chip = (cls: string, text: string): string => `<span class="mode ${cls}">${escapeHtml(text)}</span>`;
