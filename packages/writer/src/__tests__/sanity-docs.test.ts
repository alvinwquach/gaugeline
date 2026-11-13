/** The guide shows the real output of its example, and the writer page says what the code does. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../../examples/cms-fix-drafts.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const guide = readFileSync(join(root, "docs/guides/cms-fix-drafts.md"), "utf8");

describe("docs/guides/cms-fix-drafts.md", () => {
  it("shows the real output of the runnable example", async () => {
    const shown = /This is the real output:\n\n```text\n([\s\S]*?)\n```/.exec(guide)![1]!;
    expect(shown).toBe((await run()).join("\n"));
  });

  it("names the command that produces it", () => {
    expect(guide).toContain("pnpm exec tsx packages/writer/examples/cms-fix-drafts.ts");
  });

  it("lists every reason the Sanity apply can give", () => {
    for (const reason of [
      "payload",
      "field",
      "missing",
      "type",
      "stale",
      "draft exists",
      "document",
    ])
      expect(guide, reason).toContain(`\`${reason}\``);
  });
});
