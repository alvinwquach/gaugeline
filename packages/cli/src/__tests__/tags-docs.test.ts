import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { EXIT, main } from "../main.js";

/**
 * docs/ad-landing-pages.md shows `npx gaugeline tags <link>` and what it prints. The docs runner
 * (pnpm docs:examples) only runs the page check, so this test runs the page's own command against
 * the ad-redirects fixture, with the page's invented address standing in for the fixture's, and
 * compares the page's Output block with what the CLI prints.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/ad-landing-pages.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const SHOP = "https://tapas-bar.example";

function fences(): Array<{ info: string; body: string }> {
  const out: Array<{ info: string; body: string }> = [];
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    out.push({ info: m[1] ?? "", body: m[2] ?? "" });
  return out;
}

function examples(): Array<{ command: string; expected: string }> {
  const all = fences();
  const out: Array<{ command: string; expected: string }> = [];
  all.forEach((f, i) => {
    const next = all[i + 1];
    if (!/title=Terminal/.test(f.info) || !/^\$ npx gaugeline tags /.test(f.body)) return;
    if (!next || !/title="?Output/.test(next.info)) return;
    out.push({ command: f.body, expected: next.body });
  });
  return out;
}

describe("docs/ad-landing-pages.md: gaugeline tags", () => {
  it("has the example it describes", () => {
    expect(examples()).toHaveLength(1);
  });

  it("prints what the page says", async () => {
    const site = await startFixture("ad-redirects");
    try {
      for (const e of examples()) {
        const link = /"([^"]+)"/.exec(e.command)?.[1] ?? "";
        const out: string[] = [];
        const code = await main(["tags", link.replace(SHOP, site.origin), "--allow-private"], {
          stdout: { write: (s) => out.push(s) },
          stderr: { write: () => true },
        });
        expect(code).toBe(EXIT.ok);
        expect(out.join("").split(site.origin).join(SHOP).trimEnd()).toBe(e.expected);
      }
    } finally {
      await site.close();
    }
  });
});
