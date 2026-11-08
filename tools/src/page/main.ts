// Regenerate the page from an already recorded demo and the latest local acceptance files.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../evidence/report.js";
import { Evidence, Policy } from "../types.js";
import { renderPage } from "./render.js";

const demoPath = join(REPO_ROOT, "out/evidence/demo.json");
if (!existsSync(demoPath)) throw new Error("No saved demo at out/evidence/demo.json. Run make demo first.");
const evidence = Evidence.parse(JSON.parse(readFileSync(demoPath, "utf8")));
const grant = z.object({ policy: Policy }).safeParse(evidence.assertions.find((a) => a.id === "grant-active")?.observed);
console.log(`rendered ${renderPage(evidence, join(REPO_ROOT, "out/page"), grant.success ? { policy: grant.data.policy } : {})}`);
