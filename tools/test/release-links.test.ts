// README reference check: local files, line anchors and heading anchors. External URLs are never requested.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLinks, checkReadme, slug } from "../src/release/links.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("markdown links", () => {
  it("builds GitHub heading slugs", () => {
    expect(slug("Verify on mainnet (read-only)")).toBe("verify-on-mainnet-read-only");
    expect(slug("What it guarantees, and what it does not")).toBe("what-it-guarantees-and-what-it-does-not");
    expect(slug("Matched baseline (T5)")).toBe("matched-baseline-t5");
  });

  it("accepts valid references and reports each broken one", () => {
    const root = mkdtempSync(join(tmpdir(), "bm-links-"));
    dirs.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.rs"), "1\n2\n3\n");
    writeFileSync(join(root, "OTHER.md"), "# Other part\n");
    writeFileSync(
      join(root, "README.md"),
      [
        "# Top",
        "## Attack log",
        "[ok](src/a.rs#L2-L3) [one](src/a.rs#L1) [dir](src/) [head](#attack-log) [other](OTHER.md#other-part) [web](https://example.org/x)",
        "[past end](src/a.rs#L3-L9) [missing](src/b.rs) [bad head](#nope) [bad other](OTHER.md#nope) [dir line](src/#L1)",
        "`[in code](missing.md)`",
        "```",
        "[in fence](missing.md)",
        "```",
      ].join("\n"),
    );
    const r = checkLinks(join(root, "README.md"), root);
    expect(r.external).toEqual(["https://example.org/x"]);
    expect(r.problems).toEqual([
      "README.md:4: src/a.rs#L3-L9 is outside src/a.rs (3 lines)",
      "README.md:4: src/b.rs does not exist",
      "README.md:4: #nope matches no heading",
      "README.md:4: #nope matches no heading in OTHER.md",
      "README.md:4: src/#L1 puts a line anchor on a directory",
    ]);
  });

  it("finds no broken local reference in this repository's README", () => {
    expect(checkReadme(resolve(import.meta.dirname, "../..")).problems).toEqual([]);
  });
});
