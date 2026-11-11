import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detect, LIBRARY_CHECKS } from "@gaugeline/core";
import { describe, expect, it } from "vitest";

/**
 * docs/guides/served-libraries.md shows `npx gaugeline ... --libraries` against the old-theme-shop fixture, which
 * `pnpm docs:examples` runs and compares in CI. This test holds the rest of the page to what the code does: the
 * addresses its CDN example lists give the versions it states, and it names the check, the flag and the limits.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/served-libraries.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

describe("docs/guides/served-libraries.md", () => {
  it("has the shop example the docs runner runs", () => {
    expect(page).toContain("<!-- fixture: old-theme-shop -->");
    expect(page).toContain("$ npx gaugeline corner-pantry.example --libraries");
  });

  it("the CDN addresses it lists give the versions it states", () => {
    const lines = [...page.matchAll(/^(https:\/\/\S+)\s+(jQuery|Bootstrap) (\d+\.\d+\.\d+)$/gm)];
    expect(lines.length).toBe(2);
    for (const [, url, name, version] of lines)
      expect(
        detect("", url ?? "").map((d) => [d.name, d.version]),
        url,
      ).toEqual([[name, version]]);
  });

  it("names the check, the flag, the size and number limits and the libraries", () => {
    for (const word of [
      ...LIBRARY_CHECKS.map((c) => c.id),
      "--libraries",
      "run --all --libraries",
      "2 MiB",
      "at most 20",
      "jQuery, jQuery UI, Lodash, Moment.js, Bootstrap and AngularJS",
      "library-advisories.json",
      "could-not-check",
    ])
      expect(page, word).toContain(word);
  });

  it("states facts and does not call a site vulnerable or hacked", () => {
    expect(page).toContain("It does not say a site is vulnerable");
    expect(page).not.toMatch(/\byou are (vulnerable|at risk)\b|\bhacked\b|\bexploit(ed|able)\b/i);
  });
});
