import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPPERHILL_COUNTS, sanityCountsTransport } from "@gaugeline/testkit";
import { EXIT, main } from "../main.js";

/**
 * docs/query-check.md shows `npx gaugeline query ./src/app` and what it prints. The docs runner
 * (pnpm docs:examples) points every example at a fixture website, and this command reads a folder,
 * so this test runs the page's own command in the invented bakery repository
 * (packages/fixtures/repo-groq) and compares the Output block with what the CLI prints.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/query-check.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const repo = fileURLToPath(new URL("../../../fixtures/repo-groq/", import.meta.url));

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

/**
 * Each `$ [SANITY_PROJECT_ID=...] npx gaugeline query <folder>` block with the Output block after
 * it. An example with a project id is run against the invented Copperhill dataset.
 */
function examples(): Array<{ command: string; env: Record<string, string>; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; env: Record<string, string>; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    const m = /^\$ (SANITY_PROJECT_ID=([a-z0-9]+) )?npx gaugeline (query \S+)$/.exec(f.body);
    if (!/title=Terminal/.test(f.info) || !m) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({
      command: m[3] ?? "",
      env: m[2] ? { SANITY_PROJECT_ID: m[2], SANITY_DATASET: "production" } : {},
      expected: next.body,
    });
  });
  return out;
}

describe("docs/query-check.md: the command it shows", () => {
  it("has the example it describes", () => {
    expect(examples().map((e) => e.command)).toEqual(["query ./src/app", "query ./src/app"]);
  });

  it("prints what the page says", async () => {
    for (const e of examples()) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        e.command.split(/\s+/),
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: (s) => err.push(s) },
          env: e.env,
        },
        {
          cwd: repo,
          now: () => new Date("2026-11-10T12:00:00Z"),
          fetcher: { transport: sanityCountsTransport(COPPERHILL_COUNTS), timeoutMs: 5000 },
        },
      );
      expect(code, e.command).toBe(EXIT.ok);
      if (e.env.SANITY_PROJECT_ID) expect(err.join(""), e.command).toBe("");
      else expect(err.join(""), e.command).toContain("SANITY_PROJECT_ID is not set");
      expect(out.join("").trimEnd(), e.command).toBe(e.expected);
    }
  });

  it("the page names the three reasons a query is unreadable, and what it reads", () => {
    for (const word of [
      "concatenated",
      "parse-error",
      "no-type-filter",
      "defineQuery",
      "groq",
      ".mjs",
      ".gitignore",
      "npx -p gaugeline -p typescript",
    ])
      expect(page, word).toContain(word);
  });
});
