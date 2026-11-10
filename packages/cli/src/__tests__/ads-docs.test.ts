import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAdsExport } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";

/**
 * docs/ad-landing-pages.md shows `npx gaugeline ads meta.csv` and what it prints. The docs runner
 * (pnpm docs:examples) points every example at a fixture site, and this command reads a file, so
 * this test runs the page's own command in the invented export's folder and compares the page's
 * Output block with what the CLI prints: first the line on stderr, then the lines on stdout.
 */
const ADS = fileURLToPath(new URL("../../../fixtures/ads/", import.meta.url));
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/ad-landing-pages.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

/** Each `$ npx gaugeline ads ...` block with the Output block that follows it. */
function examples(): Array<{ command: string; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline ads /.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body, expected: next.body });
  });
  return out;
}

describe("docs/ad-landing-pages.md", () => {
  it("has the example it describes", () => {
    expect(examples().map((e) => e.command)).toEqual(["$ npx gaugeline ads meta.csv"]);
  });

  it("prints what the page says", async () => {
    for (const e of examples()) {
      const argv = e.command.replace(/^\$ npx gaugeline /, "").split(/\s+/);
      const err: string[] = [];
      const out: string[] = [];
      const code = await main(
        argv,
        { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
        { cwd: ADS },
      );
      expect(code).toBe(EXIT.ok);
      expect(`${err.join("")}${out.join("")}`.trimEnd()).toBe(e.expected);
    }
  });

  it("every link and ad-name column the page lists is read as that column", () => {
    const cell = (label: string) =>
      (new RegExp(`^\\| ${label}\\s+\\| (.+?) +\\|$`, "m").exec(page)?.[1] ?? "")
        .replace(/\(in that order\)/, "")
        .replace(/ or /g, ", ")
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n !== "");
    const links = cell("Link");
    expect(links.length).toBe(10);
    for (const name of links)
      expect(readAdsExport(`${name},Spend\nhttps://tapas-bar.example/a,1\n`).columns.link).toBe(
        name,
      );
    const names = cell("Ad name");
    expect(names).toEqual(["Ad name", "Ad", "Name", "Creative name"]);
    for (const name of names)
      expect(
        readAdsExport(`${name},Link,Spend\nx,https://tapas-bar.example/a,1\n`).rows[0]?.name,
      ).toBe("x");
  });
});
