// The specified authority lifecycle (SPEC.md "Authority lifecycle"), drawn as inline SVG.
// This is the specification being tested, not an evidence claim; the page labels it so.

interface Node {
  x: number;
  label: string;
  tone?: "warn" | "safe";
  notes: readonly string[];
}

const NODES: readonly Node[] = [
  { x: 20, label: "No grant", notes: [] },
  { x: 270, label: "Activating", notes: ["key registration", "in flight"] },
  { x: 520, label: "Active", notes: ["agent may propose", "within limits"] },
  { x: 770, label: "Revoking", tone: "warn", notes: ["new authorization stopped", "signed orders may execute", "failed removal: retry"] },
  { x: 1020, label: "Revoked", tone: "safe", notes: ["key removal confirmed", "covered orders cannot execute"] },
];
const W = 150;
const Y = 70;
const H = 56;

const box = (n: Node): string => {
  const cx = n.x + W / 2;
  const notes = n.notes
    .map((t, i) => `<text class="note" x="${cx}" y="${Y + H + 20 + i * 15}" text-anchor="middle">${t}</text>`)
    .join("");
  return `<g class="node${n.tone ? ` ${n.tone}` : ""}"><rect x="${n.x}" y="${Y}" width="${W}" height="${H}" rx="3"/><text x="${cx}" y="${Y + 34}" text-anchor="middle">${n.label}</text>${notes}</g>`;
};

const arrow = (x1: number, x2: number, label: string): string =>
  `<path class="edge" d="M${x1} ${Y + H / 2} H${x2 - 2}" marker-end="url(#arr)"/><text class="label" x="${(x1 + x2) / 2}" y="${Y + H / 2 - 8}" text-anchor="middle">${label}</text>`;

export const LIFECYCLE_SVG = `<svg viewBox="0 0 1190 330" role="img" aria-labelledby="lc-title lc-desc" xmlns="http://www.w3.org/2000/svg">
<title id="lc-title">Specified authority lifecycle of one grant</title>
<desc id="lc-desc">No grant, then Activating, Active, Revoking and Revoked. Revocation is possible during activation. In Revoking, new authorization has stopped but already-signed orders may still execute; Revoked means removal of the key was confirmed and covered orders cannot execute. From Revoked the owner can recover assets without agent, oracle or MPC, or regrant with a new epoch and a never-reused derivation path.</desc>
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
${NODES.map(box).join("\n")}
${arrow(170, 270, "grant")}
${arrow(420, 520, "key confirmed")}
${arrow(670, 770, "revoke")}
${arrow(920, 1020, "removal ok")}
<path class="edge" d="M345 ${Y} C 400 10, 790 10, 845 ${Y - 2}" marker-end="url(#arr)"/>
<text class="label" x="595" y="28" text-anchor="middle">revoke during activation</text>
<g class="node safe"><rect x="1020" y="236" width="${W}" height="46" rx="3"/><text x="1095" y="265" text-anchor="middle">Owner recovery</text></g>
<text class="note" x="1095" y="302" text-anchor="middle">no agent, oracle or MPC</text>
<path class="edge" d="M1095 ${Y + H + 46} V234" marker-end="url(#arr)"/>
<text class="label" x="1105" y="${Y + H + 76}" text-anchor="start">recover</text>
<path class="edge back" d="M1020 259 H345 V${Y + H + 52}" marker-end="url(#arr)"/>
<text class="label" x="682" y="251" text-anchor="middle">regrant: epoch + 1, new never-reused path</text>
</svg>`;
