import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";

/**
 * docs/guides/emails.md shows `npx gaugeline emails ./emails` twice, once for each invented project
 * (packages/fixtures/emails-marlowe and emails-cedar). The docs runner (pnpm docs:examples) points every
 * example at a fixture site and these read a folder, so this test runs the page's own commands with the
 * working folder set to each project and compares the Output block with what the CLI prints. The
 * "passed" lines (a tick and a check id) are left out of the blocks, as the docs runner leaves them out.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/emails.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const PROJECTS = [
  fileURLToPath(new URL("../../../fixtures/emails-marlowe/", import.meta.url)),
  fileURLToPath(new URL("../../../fixtures/emails-cedar/", import.meta.url)),
];

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

/** Each `$ npx gaugeline emails ...` block with the Output block that follows it. */
function examples(): Array<{ command: string; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline emails /.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body.replace(/^\$ npx gaugeline /, ""), expected: next.body });
  });
  return out;
}

describe("docs/guides/emails.md: the commands it shows", () => {
  it("has the two examples it describes", () => {
    expect(examples().map((e) => e.command)).toEqual(["emails ./emails", "emails ./emails"]);
  });

  it("prints what the page says, in each project", async () => {
    for (const [i, e] of examples().entries()) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        e.command.split(/\s+/),
        {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: (s) => err.push(s) },
          env: { NO_COLOR: "1" },
        },
        {
          cwd: PROJECTS[i] ?? "",
          now: () => new Date("2026-11-11T09:00:00Z"),
        },
      );
      expect(code, e.command).toBe(EXIT.ok);
      expect(err.join(""), e.command).toBe("");
      const shown = out
        .join("")
        .split("\n")
        .filter((l) => !/^\u2713 [a-z0-9-]+$/.test(l))
        .join("\n");
      expect(shown.trimEnd(), `example ${i + 1}`).toBe(e.expected);
    }
  });

  it("the page names the checks, the settings file and the flag", () => {
    for (const word of [
      "email-relative-link",
      "email-preview-placeholder",
      "email-no-text-part",
      "email-image-not-absolute",
      "gaugeline.emails.json",
      "--base",
      "textVersion",
      "tracking",
    ])
      expect(page, word).toContain(word);
  });
});
