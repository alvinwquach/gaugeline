import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

/** Each `$ npx gaugeline query <folder>` block (no environment variables) with the Output block after it. */
function examples(): Array<{ command: string; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline query \S+$/.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body.replace(/^\$ npx gaugeline /, ""), expected: next.body });
  });
  return out;
}

describe("docs/query-check.md: the command it shows", () => {
  it("has the example it describes", () => {
    expect(examples().map((e) => e.command)).toEqual(["query ./src/app"]);
  });

  it("prints what the page says", async () => {
    for (const e of examples()) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        e.command.split(/\s+/),
        { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: {} },
        { cwd: repo },
      );
      expect(code, e.command).toBe(EXIT.ok);
      expect(err.join(""), e.command).toBe("");
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
