import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_FILE, main } from "../main.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Key-shaped values built at run time, so no secret scanner sees a literal.
const KEYS = {
  SANITY_TOKEN: ["sk", "popup", "kitchen", "0123456789abcdef"].join("_"),
  STRIPE_API_KEY: ["rk", "live", "popupkitchen0123456789"].join("_"),
  PRINTFUL_API_TOKEN: ["pf", "popupkitchen", "0123456789abcdef"].join("-"),
  SHOPIFY_ACCESS_TOKEN: ["shp", "at", "popupkitchen0123456789abcdef"].join(""),
  SQUARE_ACCESS_TOKEN: ["EAAA", "popupkitchen0123456789abcdefghij"].join(""),
};

/** The promise the docs make (docs/products-and-prices.md): keys are never printed or saved. */
describe("keys in the environment reach no output: promise test", () => {
  it("a run with every key set: stdout, stderr (--verbose), the JSON result and the HTML report hold none", async () => {
    const site = await startFixture("quick-start");
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-keys-"));
    dirs.push(cwd);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: (s: string) => err.push(s) },
        env: { NO_COLOR: "1", ...KEYS },
      };
      const code = await main([site.origin, "--allow-private", "--verbose", "--no-open"], io, {
        cwd,
      });
      expect([0, 1]).toContain(code);
      const html = readFileSync(join(cwd, REPORT_FILE), "utf8");

      const jsonOut: string[] = [];
      const jsonCode = await main(
        [site.origin, "--allow-private", "--json"],
        { ...io, stdout: { write: (s: string) => jsonOut.push(s) }, stderr: { write: () => true } },
        { cwd },
      );
      expect([0, 1]).toContain(jsonCode);
      const json = jsonOut.join("");
      expect(JSON.parse(json)).toBeTypeOf("object");

      const seen = { stdout: out.join(""), stderr: err.join(""), json, html };
      expect(seen.html.length).toBeGreaterThan(100);
      for (const [where, text] of Object.entries(seen))
        for (const [name, value] of Object.entries(KEYS))
          expect(text.includes(value), `${name} found in ${where}`).toBe(false);
    } finally {
      await site.close();
    }
  }, 30_000);
});
