import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bindDemo } from "../src/evidence/binding.js";
import { Acceptance, GateReportV2 } from "../src/evidence/schema.js";
import { DaoData, daoBody } from "../src/page/dao.js";
import { renderHtml } from "../src/page/render.js";
import { sandboxResults } from "../src/page/results.js";
import { Evidence } from "../src/types.js";

// The committed certified bundle (evidence/index.json): its own DAO report, demo and acceptance.
const repoRoot = resolve(import.meta.dirname, "../..");
const bundle = join(repoRoot, (JSON.parse(readFileSync(join(repoRoot, "evidence/index.json"), "utf8")) as { bundles: { path: string; status: string }[] }).bundles.find((b) => b.status === "certified")?.path ?? "evidence/(none)");
const read = (path: string): unknown => JSON.parse(readFileSync(join(bundle, path), "utf8")) as unknown;
const ev = Evidence.parse(read("demo.json"));
const acc = Acceptance.parse(read("acceptance.json"));
const binding = bindDemo(ev, acc, acc.run_id);
const text = readFileSync(join(bundle, "tests/DAO.sputnik-owner.json"), "utf8");
const report = GateReportV2.parse(JSON.parse(text) as unknown);
const data = DaoData.parse(report.data);
const file = { file: "DAO.sputnik-owner.json", text };

describe("DAO treasury preset: recorded sandbox workflow", () => {
  it("presents actual pinned DAO approval, revocation, refund and withdrawal evidence", () => {
    const result = sandboxResults(acc, binding, [file]).dao;
    expect(result).not.toBeNull();
    const html = daoBody(result);
    expect(html).toContain("Recorded sandbox walkthrough, not interactive voting");
    expect(html).toContain("council of 3, RoleWeight, threshold 2");
    for (const label of ["One approval leaves the grant pending", "Threshold approval removes the key", "Recover into the DAO&#39;s Intents account", "A missing token registration causes a refund", "Withdraw separately to the DAO account"]) expect(html).toContain(label);
    expect(html).toContain("Report SHA-256");
    expect(html).toContain("No DAO mainnet run or external governance UI is demonstrated");
    expect(html).not.toContain("<button");
  });

  it("links and renders the preset without adding a network request or an imitation vote", () => {
    const html = renderHtml(ev, { acceptance: acc, latestRunId: acc.run_id, reports: [file], live: null });
    expect(html).toContain('href="#dao"');
    expect(html).toContain('id="dao"');
    expect(html).toContain("The second council approval executes the FunctionCall proposal");
  });

  it("shows no outcome without matching certified evidence", () => {
    for (const result of [sandboxResults(null, binding, [file]).dao, sandboxResults(acc, { ...binding, certified: false }, [file]).dao, sandboxResults(acc, binding, []).dao, sandboxResults(acc, binding, [file, file]).dao]) {
      expect(result).toBeNull();
      expect(daoBody(result)).toContain("No voting outcome is shown");
      expect(daoBody(result)).not.toContain("Recorded assertion: passed");
    }
  });

  it("refuses altered identity, failed steps, missing threshold evidence and malformed data", () => {
    const mutations: unknown[] = [
      { ...report, run_id: "another-run" },
      { ...report, source: { ...report.source, revision: "a".repeat(40) } },
      { ...report, source: { ...report.source, dirty: true } },
      { ...report, spec_sha256: "a".repeat(64) },
      { ...report, fixture_manifest_sha256: "a".repeat(64) },
      { ...report, wasm_sha256: { sputnikdao2: "a".repeat(64) } },
      { ...report, mode: "unit", passed: false },
      { ...report, data: { owner: "SYNTHETIC", vote_policy: "synthetic", steps: [] } },
      { ...report, data: { owner: "SYNTHETIC", vote_policy: "synthetic", steps: [{ check: "grant_two_of_three_executes", passed: false, detail: {} }] } },
      { ...report, data: { ...data, steps: data.steps.filter((s) => s.check !== "grant_two_of_three_executes") } },
      { ...report, data: { ...data, steps: data.steps.map((s) => s.check === "grant_two_of_three_executes" ? { ...s, passed: false } : s) } },
      { ...report, data: { ...data, steps: [...data.steps, ...data.steps.filter((s) => s.check === "grant_two_of_three_executes")] } },
    ];
    for (const mutation of mutations) expect(sandboxResults(acc, binding, [{ ...file, text: JSON.stringify(mutation) }]).dao).toBeNull();
    expect(sandboxResults(acc, binding, [{ ...file, text: "not JSON" }]).dao).toBeNull();
  });
});
