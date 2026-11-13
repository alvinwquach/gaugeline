import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import type { Transport } from "@gaugeline/core";
import { describe, expect, it } from "vitest";
import { answer, pageSpeedTransport } from "../../../core/src/pagespeed/__tests__/world.js";
import { SITES_DIR } from "../../../fixtures/src/index.js";
import { staticSite } from "../../../testkit/src/index.js";
import { main } from "../main.js";

/**
 * docs/guides/pagespeed.md shows what `gaugeline corner-pantry.example --pagespeed` prints. This runs that
 * command in memory, with Google's answer replaced by the invented numbers the page describes, and checks that
 * every line of the page's output blocks is in what the command printed.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/pagespeed.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (title: string): string[] =>
  (
    new RegExp('```[a-z]* title="?' + title + '[^"\\n]*"?\\n([\\s\\S]*?)\\n```').exec(page)?.[1] ??
    ""
  )
    .split("\n")
    .filter((l) => l !== "");

const HOST = "corner-pantry.example";
const HOME = `https://${HOST}/`;

describe("docs/guides/pagespeed.md: the command it shows", () => {
  it("prints the lines the page shows, on stdout and on stderr", async () => {
    const others: Transport = () =>
      Promise.resolve({ status: 404, headers: {}, body: Readable.from([Buffer.from("x")]) });
    const site = staticSite(HOST, join(SITES_DIR, "old-theme-shop"), others);
    const google = pageSpeedTransport({
      [HOME]: {
        status: 200,
        body: answer(HOME, {
          field: { lcp: [0.62, 0.22, 0.16], inp: [0.9, 0.06, 0.04], cls: [0.88, 0.07, 0.05] },
          lab: { score: 0.42, lcp: 4210, tbt: 610, cls: 0.123, si: 5100 },
        }),
      },
    });
    const transport: Transport = (url, req) =>
      url.hostname === "pagespeedonline.googleapis.com"
        ? google.transport(url, req)
        : site(url, req);
    const out: string[] = [];
    const err: string[] = [];
    await main(
      [HOST, "--pagespeed", "--no-open"],
      {
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
        env: { NO_COLOR: "1" },
      },
      {
        cwd: mkdtempSync(join(tmpdir(), "gaugeline-pagespeed-docs-")),
        fetcher: {
          transport,
          resolver: () => Promise.resolve([{ address: "93.184.216.35", family: 4 }]),
        },
        pageSpeed: { reservedNamesAllowed: true },
      } as never,
    );
    const stdout = out.join("").split("\n");
    const shown = block("Output");
    expect(shown.length).toBeGreaterThan(0);
    for (const line of shown) expect(stdout, line).toContain(line);
    const stderr = err.join("").split("\n");
    for (const line of block("Stderr")) expect(stderr, line).toContain(line);
  });

  it("names the flag, the check ids and the key rule", () => {
    expect(page).toContain("--pagespeed");
    expect(page).toContain("pagespeed-field-vitals");
    expect(page).toContain("pagespeed-lab-advice");
    expect(page).toContain("sends no key to Google");
  });
});
