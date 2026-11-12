// The lab page's browser code. page.ts serializes every function in LAB_CLIENT_FUNCTIONS with
// Function.prototype.toString into the page's single inline script (pinned by hash in the CSP), like the evidence
// page's verification panel. So each function may use only browser globals and the other listed functions: no
// imports, no module-level values. The page talks only to the lab that served it (same origin), holds no key, and
// shows what the lab's responses say: it computes no outcome of its own.
import type { ActionRecord, TxView } from "./actions.js";
import type { AlternativeOrder, AlternativeResult } from "./alternatives.js";
import type { SessionView } from "./lab.js";
import type { LabState } from "./world.js";

export interface El {
  textContent: string | null;
  className: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  open: boolean;
  append(...children: (El | string)[]): void;
  prepend(...children: (El | string)[]): void;
  replaceChildren(...children: (El | string)[]): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: () => void): void;
}

export interface Doc {
  getElementById(id: string): El | null;
  createElement(tag: string): El;
  querySelectorAll(selector: string): Iterable<El>;
}

export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LabFetchResponse {
  status: number;
  json(): Promise<unknown>;
}
export type LabFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; credentials: "omit"; cache: "no-store" }) => Promise<LabFetchResponse>;

export interface Preset {
  id: string;
  label: string;
  explain: string;
  sell: "usdc" | "wnear";
  /** Token units. */
  sell_amount: string;
  /** Basis points, or the maximum the session's current grant allows. */
  max_concession_bps: number | "grant_max";
}

export interface LabPageData {
  policy_fields: string[];
  presets: Preset[];
  alternatives: { id: string; label: string }[];
  decimals: { usdc: number; wnear: number };
}

/** Token units as a decimal number with at most six fractional digits (truncated, never rounded up). */
export function fmtUnits(units: string, decimals: number): string {
  const digits = units.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = digits
    .slice(digits.length - decimals)
    .slice(0, 6)
    .replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

/** A decimal number as token units; null when it is not a plain non-negative decimal with at most `decimals` places. */
export function toUnits(text: string, decimals: number): string | null {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text);
  if (m === null) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return `${m[1] ?? ""}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
}

/** The contract's own panic message out of a NEAR execution error, or the error unchanged. */
export function panicText(error: string | null): string {
  if (error === null) return "";
  const m = /Smart contract panicked: ([^"\\]+)/.exec(error);
  return m?.[1] ?? error;
}

/** One line saying what an action's receipts and views showed. */
export function summarize(record: ActionRecord, decimals: { usdc: number; wnear: number }): { text: string; tone: "ok" | "refused" | "info" } {
  const result = record.result as {
    not_sent?: string;
    order_id?: string | null;
    order?: { id: string; sell: "usdc" | "wnear"; sell_amount: string; buy: "usdc" | "wnear"; buy_amount: string | null; state: { state: string; reason?: string } } | null;
    executed?: boolean;
    rejected_for_removed_key?: boolean;
    not_a_revocation_rejection_because?: string[];
    executable_now?: boolean;
    simulation?: string;
    filler_record?: { state: string; detail: string | null };
    comparison?: AlternativeResult;
    owner_received?: { usdc: string; wnear: string };
  };
  if (typeof result.not_sent === "string") return { text: `Nothing was sent: ${result.not_sent}`, tone: "info" };
  const failed = record.transactions.find((t) => !t.success || t.any_receipt_failed);
  const sym = { usdc: "USDC", wnear: "wNEAR" };
  if (record.action === "relay") {
    if (result.executed === true) return { text: "The withheld order executed: the grant key was still registered on the verifier.", tone: "ok" };
    if (result.rejected_for_removed_key === true) return { text: `Rejected by the verifier before the order's deadline: ${panicText(failed?.error ?? null)}`, tone: "refused" };
    return { text: `The relay failed, but not as evidence of revocation (${(result.not_a_revocation_rejection_because ?? []).join("; ")}): ${panicText(failed?.error ?? null)}`, tone: "info" };
  }
  if (record.action === "withhold") {
    return { text: result.executable_now === true ? "Order withheld. The verifier's dry run accepts the bundle: it can execute until its deadline or until the key is removed." : `Order withheld, but the verifier's dry run does not accept it: ${result.simulation ?? ""}`, tone: "info" };
  }
  if (record.action === "alternative" && result.comparison !== undefined) {
    const c = result.comparison;
    const executed = c.orders.filter((o) => o.executed_after_action).length;
    return { text: `${c.title}: ${executed} of ${c.orders.length} withheld orders still executed after the owner's action.`, tone: "info" };
  }
  if (record.action === "propose" && result.order != null) {
    const o = result.order;
    if (o.state.state === "signed") {
      return { text: `Order ${o.id} signed by the contract: sells ${fmtUnits(o.sell_amount, decimals[o.sell])} ${sym[o.sell]} for at least ${fmtUnits(o.buy_amount ?? "0", decimals[o.buy])} ${sym[o.buy]}.`, tone: "ok" };
    }
    if (o.state.state === "rejected") return { text: `Order ${o.id} refused by the contract when pricing it: ${o.state.reason ?? ""}`, tone: "refused" };
    return { text: `Order ${o.id} is ${o.state.state}: no signature has been recorded.`, tone: "info" };
  }
  if (failed !== undefined) {
    const where = failed.receipts.find((r) => !r.success)?.executor_id ?? failed.receiver_id;
    return { text: `Refused by ${where}: ${panicText(failed.error)}`, tone: "refused" };
  }
  if (record.action === "fill") return { text: `Filler: ${result.filler_record?.state ?? "done"}${result.filler_record?.detail == null ? "" : ` (${panicText(result.filler_record.detail)})`}. Order ${result.order?.id ?? ""} is ${result.order?.state.state ?? "unknown"}${result.order?.state.reason === undefined ? "" : ` (${result.order.state.reason})`}.`, tone: "ok" };
  if (record.action === "grant") return { text: `Grant ${record.state.grant?.status ?? "missing"}; its key is ${record.state.key_on_verifier === true ? "registered" : "not registered"} on the verifier.`, tone: "ok" };
  if (record.action === "revoke") return { text: `Grant ${record.state.grant?.status ?? "missing"}; its key is ${record.state.key_on_verifier === true ? "still registered" : "no longer registered"} on the verifier.`, tone: "ok" };
  if (record.action === "recover" && result.owner_received !== undefined) {
    return { text: `Recovered to the owner's Intents account: ${fmtUnits(result.owner_received.usdc, decimals.usdc)} USDC and ${fmtUnits(result.owner_received.wnear, decimals.wnear)} wNEAR.`, tone: "ok" };
  }
  return { text: "Done.", tone: "ok" };
}

/** Wires the page: called once with the document, fetch and (when available) session storage. */
export function install(doc: Doc, fetchFn: LabFetch, store: Store | null): void {
  const root = doc.getElementById("lab-root");
  if (root === null) return;
  const data = JSON.parse(root.getAttribute("data-lab") ?? "{}") as LabPageData;
  const SYM = { usdc: "USDC", wnear: "wNEAR" };
  const OPEN = ["pricing", "signing", "signed", "sign_unknown"];
  let sessionId: string | null = null;
  let state: LabState | null = null;
  let busy = false;

  const el = (id: string): El => {
    const found = doc.getElementById(id);
    if (found === null) throw new Error(`missing #${id}`);
    return found;
  };
  const h = (tag: string, cls: string, text: string, kids: (El | string)[] = []): El => {
    const e = doc.createElement(tag);
    if (cls !== "") e.className = cls;
    if (text !== "") e.textContent = text;
    if (kids.length > 0) e.append(...kids);
    return e;
  };
  const button = (label: string, fn: () => void): El => {
    const b = h("button", "", label);
    b.setAttribute("type", "button");
    b.setAttribute("data-needs", "session");
    b.disabled = busy;
    b.addEventListener("click", fn);
    return b;
  };
  const setStatus = (text: string, tone: string): void => {
    const s = el("lab-status");
    s.textContent = text;
    s.className = `status ${tone}`;
  };
  const gate = (): void => {
    for (const b of doc.querySelectorAll("button[data-needs]")) {
      const needs = b.getAttribute("data-needs");
      b.disabled = busy || (needs === "session" ? sessionId === null : needs === "no-session" ? sessionId !== null : false);
    }
  };
  const remember = (id: string | null): void => {
    sessionId = id;
    try {
      if (id === null) store?.removeItem("lab-session");
      else store?.setItem("lab-session", id);
    } catch {
      // Storage is a convenience for reloads only.
    }
  };

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetchFn(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      cache: "no-store",
    });
    const parsed: unknown = await res.json().catch(() => null);
    return { status: res.status, body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {} };
  };
  const refused = (r: { status: number; body: Record<string, unknown> }): void => {
    const code = typeof r.body.error === "string" ? r.body.error : "error";
    const message = typeof r.body.message === "string" ? r.body.message : "the lab did not answer as expected";
    if (code === "no_session") {
      remember(null);
      state = null;
      renderState();
    }
    setStatus(`The lab refused this request (${r.status} ${code}): ${message}`, "refused");
  };
  const run = async (what: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    gate();
    setStatus(`${what}…`, "work");
    try {
      await fn();
    } catch (error) {
      setStatus(`${what}: the lab could not be reached (${error instanceof Error ? error.message : String(error)}). Nothing is shown as a result.`, "refused");
    } finally {
      busy = false;
      gate();
    }
  };

  const kv = (rows: [string, string][]): El => h("dl", "kv", "", rows.flatMap(([k, v]) => [h("dt", "", k), h("dd", "", v)]));
  const pairText = (p: { usdc: string; wnear: string }): string => `${fmtUnits(p.usdc, data.decimals.usdc)} USDC · ${fmtUnits(p.wnear, data.decimals.wnear)} wNEAR`;
  const share = (part: string, whole: string | null): string => {
    if (whole === null || whole === "0") return "n/a";
    return `${(Number((BigInt(part) * 100_000n) / BigInt(whole)) / 1_000).toFixed(2)}% of the grant's starting value`;
  };

  function renderState(): void {
    const box = el("state");
    const orders = el("orders");
    if (state === null) {
      box.replaceChildren(h("p", "muted", "No session yet. Start one to get your own sandbox treasury."));
      orders.replaceChildren();
      return;
    }
    const s = state;
    const g = s.grant;
    const oracle = s.oracle.available
      ? `answering · wNEAR ${s.oracle.prices.wnear === null ? "no fresh price" : fmtUnits(s.oracle.prices.wnear.price, -s.oracle.prices.wnear.expo)} USD · USDC ${s.oracle.prices.usdc === null ? "no fresh price" : fmtUnits(s.oracle.prices.usdc.price, -s.oracle.prices.usdc.expo)} USD`
      : `failing (${panicText(s.oracle.error)})`;
    box.replaceChildren(
      kv([
        ["Grant", g === null ? "none yet" : `${g.status} · epoch ${g.epoch}${g.breaker === null ? "" : " · loss breaker tripped"}`],
        ["Grant key on the verifier", s.key_on_verifier === null ? "no key" : s.key_on_verifier ? "registered" : "absent"],
        ["Outstanding (reserved by open orders)", g === null ? "n/a" : share(g.outstanding, g.initial_value)],
        ["Turnover used", g === null ? "n/a" : share(g.turnover_used, g.initial_value)],
        ["Mandate (the treasury)", pairText(s.balances.mandate)],
        ["Owner's Intents account", pairText(s.balances.owner_intents)],
        ["Filler (the counterparty)", pairText(s.balances.filler)],
        ["Price oracle TEST DOUBLE", oracle],
        ["MPC signer TEST DOUBLE", s.signer_mode === "immediate" ? "signing" : `failing (${s.signer_mode})`],
        ["Mandate account", s.accounts.mandate],
      ]),
    );
    const now = BigInt(s.block_time_ns);
    const withheld = new Set(s.withheld.map((w) => w.order_id));
    const rows = s.orders.map((o) => {
      const left = o.deadline_ns === null ? null : (BigInt(o.deadline_ns) - now) / 1_000_000_000n;
      const open = OPEN.includes(o.state.state);
      const actions = h("td", "acts", "");
      if (open) actions.append(button("Fill", () => void act(`Filler fills order ${o.id}`, "fill", { order_id: o.id })));
      if (open && !withheld.has(o.id)) actions.append(button("Withhold", () => void act(`Counterparty withholds order ${o.id}`, "withhold", { order_id: o.id })));
      if (withheld.has(o.id)) actions.append(button("Relay withheld", () => void act(`Another account relays withheld order ${o.id}`, "relay", { order_id: o.id })));
      if (open) actions.append(button("Expire", () => void act(`Ask the contract to expire order ${o.id}`, "expire", { order_id: o.id })));
      const reason = "reason" in o.state ? ` (${o.state.reason})` : "";
      return h("tr", "", "", [
        h("td", "", o.id),
        h("td", "", `${fmtUnits(o.sell_amount, data.decimals[o.sell])} ${SYM[o.sell]}`),
        h("td", "", o.buy_amount === null ? "not priced" : `${fmtUnits(o.buy_amount, data.decimals[o.buy])} ${SYM[o.buy]}`),
        h("td", "", `${(o.concession_bps / 100).toFixed(2)}%`),
        h("td", "", `${o.state.state}${reason}${withheld.has(o.id) ? " · withheld" : ""}`),
        h("td", "", left === null ? "n/a" : left > 0n ? `${left} s left when last read` : "passed"),
        actions,
      ]);
    });
    orders.replaceChildren(...(rows.length === 0 ? [h("tr", "", "", [h("td", "muted", "No orders yet.")])] : rows));
  }

  const txBlock = (t: TxView): El => {
    const ok = t.success && !t.any_receipt_failed;
    const line = h("summary", "", "", [h("span", `pill ${ok ? "ok" : "refused"}`, ok ? "success" : "failed"), ` ${t.label} `, h("code", "", t.tx_hash ?? "not included")]);
    const receipts = t.receipts.map((r) => {
      const item = h("li", "", "", [h("span", `pill ${r.success ? "ok" : "refused"}`, r.success ? "ok" : "failed"), ` ${r.executor_id} `, h("code", "", r.receipt_id)]);
      if (r.error !== null) item.append(h("div", "err", panicText(r.error)));
      if (r.logs.length > 0) item.append(h("details", "", "", [h("summary", "", `${r.logs.length} log line${r.logs.length === 1 ? "" : "s"}`), h("pre", "", r.logs.join("\n"))]));
      return item;
    });
    return h("details", "tx", "", [line, h("p", "muted", `${t.signer_id} → ${t.receiver_id} · ${t.method}${t.block_height === null ? "" : ` · block ${t.block_height}`}`), h("ol", "receipts", "", receipts)]);
  };

  const relayTable = (rows: AlternativeOrder[]): El =>
    h("table", "", "", [
      h("thead", "", "", [h("tr", "", "", ["Order", "Relayed", "Key registered before relay", "Nonce used before relay", "Before its deadline", "Executed", "Verifier's answer"].map((c) => h("th", "", c)))]),
      h(
        "tbody",
        "",
        "",
        rows.map((o) =>
          h("tr", "", "", [
            h("td", "", o.label),
            h("td", "", o.phase),
            h("td", "", o.key_registered_before_relay ? "yes" : "no"),
            h("td", "", o.nonce_used_before_relay ? "yes" : "no"),
            h("td", "", o.relayed_before_deadline ? "yes" : "no"),
            h("td", "", "", [h("span", `pill ${o.executed_after_action ? "exec" : "info"}`, o.executed_after_action ? "EXECUTED" : "did not execute")]),
            h("td", "err", o.error === null ? "" : panicText(o.error)),
          ]),
        ),
      ),
    ]);

  const comparisonBlock = (c: AlternativeResult): El =>
    h("article", "rec", "", [
      h("h3", "", c.title),
      h("p", "", c.owner_action),
      h("p", "muted", `Signatures by the account's key in the owner's action: ${c.account_key_signatures}. Starting conditions: treasury ${fmtUnits(c.start.treasury_usdc, data.decimals.usdc)} USDC, ${c.start.withheld.length} signed orders withheld, each selling ${fmtUnits(c.start.withheld[0]?.sell_usdc ?? "0", data.decimals.usdc)} USDC.`),
      relayTable(c.orders),
      ...(c.other_relays.length === 0 ? [] : [h("p", "muted", "Further relays of this run:"), relayTable(c.other_relays)]),
      h("p", "", `To resume: ${c.resume}`),
      h("p", "muted", c.labels.join(" · ")),
    ]);

  function addRecord(record: ActionRecord): void {
    const sum = summarize(record, data.decimals);
    const comparison = (record.result as { comparison?: AlternativeResult }).comparison;
    const entry = h("article", "rec", "", [
      h("h3", "", "", [h("span", "seq", `${record.seq}`), ` ${record.action} `, h("span", `pill ${sum.tone}`, sum.tone === "refused" ? "refused" : sum.tone === "ok" ? "executed" : "note")]),
      h("p", "", sum.text),
      h("p", "muted", `Input: ${JSON.stringify(record.input)} · ${record.transactions.length} transaction${record.transactions.length === 1 ? "" : "s"} · ${record.duration_ms} ms`),
      ...record.transactions.map(txBlock),
    ]);
    el("log").prepend(entry);
    if (comparison !== undefined) el("compare-results").prepend(comparisonBlock(comparison));
  }

  const adopt = (view: SessionView): void => {
    remember(view.session_id);
    state = view.state;
    el("session-info").textContent = `This session ends by ${view.ends_at}, or after ${view.idle_sec} s without a request, and accepts ${view.actions_max} actions before it must be reset.`;
    renderState();
  };

  function act(what: string, action: string, input: unknown): Promise<void> {
    return run(what, async () => {
      const r = await call("POST", `/api/sessions/${sessionId ?? ""}/actions`, { action, input });
      if (r.status !== 200) {
        refused(r);
        return;
      }
      const record = r.body.record as ActionRecord;
      state = record.state;
      addRecord(record);
      renderState();
      const sum = summarize(record, data.decimals);
      setStatus(sum.text, sum.tone);
    });
  }

  const startSession = (): Promise<void> =>
    run("Building your sandbox treasury: deploying the contracts and funding the accounts takes about 15 seconds", async () => {
      const r = await call("POST", "/api/sessions");
      if (r.status !== 201) {
        refused(r);
        return;
      }
      el("log").replaceChildren();
      el("compare-results").replaceChildren();
      adopt(r.body.session as SessionView);
      setStatus("Your sandbox treasury is ready. Step 1: set the limits and grant.", "ok");
    });

  const intField = (id: string): number | null => {
    const text = el(id).value.trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  };

  el("session-start").addEventListener("click", () => void startSession());
  el("session-reset").addEventListener("click", () => {
    void run("Resetting: building a new sandbox treasury", async () => {
      const r = await call("POST", `/api/sessions/${sessionId ?? ""}/reset`);
      if (r.status !== 200) {
        refused(r);
        return;
      }
      el("log").replaceChildren();
      el("compare-results").replaceChildren();
      adopt(r.body.session as SessionView);
      setStatus("Reset: a new treasury with the starting balances and no grant.", "ok");
    });
  });
  el("session-end").addEventListener("click", () => {
    void run("Ending the session", async () => {
      await call("DELETE", `/api/sessions/${sessionId ?? ""}`);
      remember(null);
      state = null;
      renderState();
      el("session-info").textContent = "";
      setStatus("Session ended; its sandbox world is gone.", "ok");
    });
  });
  el("session-refresh").addEventListener("click", () => {
    void run("Reading the state", async () => {
      const r = await call("GET", `/api/sessions/${sessionId ?? ""}`);
      if (r.status !== 200) {
        refused(r);
        return;
      }
      adopt(r.body.session as SessionView);
      setStatus("State read from the sandbox chain.", "ok");
    });
  });
  el("session-export").addEventListener("click", () => {
    void run("Exporting the scenario", async () => {
      const r = await call("GET", `/api/sessions/${sessionId ?? ""}/export`);
      if (r.status !== 200) {
        refused(r);
        return;
      }
      const text = `${JSON.stringify(r.body.scenario, null, 2)}\n`;
      el("export-text").value = text;
      el("export-link").setAttribute("href", `data:application/json;charset=utf-8,${encodeURIComponent(text)}`);
      el("export-box").hidden = false;
      setStatus("Scenario exported below. Save it and replay it locally with the command shown.", "ok");
    });
  });

  el("act-grant").addEventListener("click", () => {
    const policy: Record<string, number> = {};
    for (const key of data.policy_fields) {
      const v = intField(`policy-${key}`);
      if (v === null) {
        setStatus(`Limit "${key}" must be a whole number.`, "refused");
        return;
      }
      policy[key] = v;
    }
    void act("Owner grants the mandate with these limits", "grant", { policy });
  });
  for (const preset of data.presets) {
    el(`preset-${preset.id}`).addEventListener("click", () => {
      const max = preset.max_concession_bps === "grant_max" ? (state?.grant?.policy.max_concession_bps ?? intField("policy-max_concession_bps") ?? 0) : preset.max_concession_bps;
      void act(`Agent proposes: ${preset.label}`, "propose", { sell: preset.sell, sell_amount: preset.sell_amount, max_concession_bps: max });
    });
  }
  el("act-propose").addEventListener("click", () => {
    const sell = el("prop-sell").value === "wnear" ? "wnear" : "usdc";
    const amount = toUnits(el("prop-amount").value, data.decimals[sell]);
    const bps = intField("prop-concession");
    if (amount === null || bps === null) {
      setStatus("Enter an amount as a plain number and a concession in whole basis points.", "refused");
      return;
    }
    void act("Agent proposes a custom trade", "propose", { sell, sell_amount: amount, max_concession_bps: bps });
  });
  el("act-revoke").addEventListener("click", () => void act("Owner revokes the grant", "revoke", {}));
  el("act-recover").addEventListener("click", () => void act("Owner recovers both assets", "recover", {}));
  el("act-oracle-off").addEventListener("click", () => void act("Test double: the price oracle starts failing", "set_oracle", { available: false }));
  el("act-oracle-on").addEventListener("click", () => {
    const price = toUnits(el("oracle-wnear").value, 8);
    if (price === null || /^0*$/.test(price)) {
      setStatus("Enter the wNEAR price in USD as a positive number with at most 8 decimals.", "refused");
      return;
    }
    void act("Test double: the price oracle answers with this wNEAR price", "set_oracle", { available: true, wnear_price: price });
  });
  el("act-signer-off").addEventListener("click", () => void act("Test double: the MPC signer starts failing", "set_signer", { available: false }));
  el("act-signer-on").addEventListener("click", () => void act("Test double: the MPC signer signs again", "set_signer", { available: true }));
  for (const alt of data.alternatives) {
    el(`alt-${alt.id}`).addEventListener("click", () => void act(`Comparison: ${alt.label}`, "alternative", { id: alt.id }));
  }
  const showTab = (name: string): void => {
    for (const tab of ["operate", "compare"]) {
      el(`panel-${tab}`).hidden = tab !== name;
      el(`tab-${tab}`).setAttribute("aria-selected", tab === name ? "true" : "false");
    }
  };
  el("tab-operate").addEventListener("click", () => {
    showTab("operate");
  });
  el("tab-compare").addEventListener("click", () => {
    showTab("compare");
  });

  renderState();
  gate();
  const recall = (): string | null => {
    try {
      return store?.getItem("lab-session") ?? null;
    } catch {
      return null;
    }
  };
  const saved = recall();
  if (saved !== null && /^[0-9a-f]{32}$/.test(saved)) {
    const id = saved;
    void run("Reconnecting to your session", async () => {
      const r = await call("GET", `/api/sessions/${id}`);
      if (r.status !== 200) {
        remember(null);
        setStatus("Your earlier session has ended. Start a new one.", "info");
        return;
      }
      adopt(r.body.session as SessionView);
      const log = await call("GET", `/api/sessions/${id}/log`);
      if (log.status === 200 && Array.isArray(log.body.log)) for (const record of log.body.log as ActionRecord[]) addRecord(record);
      setStatus("Reconnected to your session.", "ok");
    });
  }
}

/** Serialized into the page in this order. */
export const LAB_CLIENT_FUNCTIONS = [fmtUnits, toUnits, panicText, summarize, install] as const;
