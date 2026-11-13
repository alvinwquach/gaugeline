import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createNetworkTransport } from "@gaugeline/core";
import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { findBrowser } from "../browser.js";
import { createPlaywrightRenderer } from "../playwright.js";

/**
 * docs/rendered-pages.md shows what a render of the invented bakery gives back. This renders it in a real
 * browser and compares, where one is installed (and says why it is skipped where none is).
 */
const found = findBrowser({ env: process.env, exists: existsSync, platform: process.platform });
let driver = true;
try {
  await import("playwright-core");
} catch {
  driver = false;
}
const skipped = !driver ? "playwright-core is not installed" : found.ok ? undefined : "no browser";

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/rendered-pages.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** `bytes` is the size of the file on disk, which a checkout's line endings change: left out of the page and here. */
const withoutBytes = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (k, v: unknown) => (k === "bytes" ? undefined : v)));

describe.skipIf(skipped !== undefined)("docs/rendered-pages.md: the result it shows", () => {
  it("is what the renderer gives back for the invented bakery", async () => {
    const shown = /```json title="?Result"?\n([\s\S]*?)\n```/.exec(page)?.[1];
    expect(shown).toBeDefined();
    const site = await startFixture("renderer-edges");
    const renderer = createPlaywrightRenderer({
      transport: createNetworkTransport({ allowPrivate: true, target: site.origin }),
      chromiumSandbox: process.getuid?.() !== 0,
    });
    try {
      const result = await renderer.render({ url: `${site.origin}/` });
      if (result.kind === "could-not-check" && /could not start/.test(result.reason)) return;
      const actual = JSON.stringify(withoutBytes(result))
        .split(site.origin)
        .join("http://bakery.example");
      const totals = (withoutBytes(result) as { totals: unknown }).totals;
      expect(totals).toEqual({ requests: 3 });
      expect(JSON.parse(actual)).toEqual(JSON.parse(shown ?? ""));
    } finally {
      await renderer.close();
      await site.close();
    }
  }, 60_000);
});

describe.skipIf(skipped === undefined)(
  "docs/rendered-pages.md: the result it shows, without a browser",
  () => {
    it("is skipped, and says why", () => {
      expect(skipped).toBeDefined();
    });
  },
);
