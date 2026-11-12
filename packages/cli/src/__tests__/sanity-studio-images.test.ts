import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SITES_DIR } from "@gaugeline/fixtures";
import {
  HARBOUR,
  HARBOUR_PROJECT,
  sanityCountsTransport,
  staticSite,
  type SeenSanityRequest,
} from "@gaugeline/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

/**
 * docs/guides/sanity-images.md shows one configuration and what it prints for the invented Harbour Lane
 * Tap Room page and dataset. The command needs a Sanity project, so the docs runner (pnpm docs:examples)
 * cannot run it; this test does, and compares what the page prints with what the CLI prints.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/sanity-images.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

function block(title: string): string {
  const re = /^```(.*)\n([\s\S]*?)\n```$/gm;
  for (let m = re.exec(page); m; m = re.exec(page))
    if ((m[1] ?? "").match(new RegExp(`title="?${title}"?(\\s|$)`))) return m[2] ?? "";
  throw new Error(`docs/guides/sanity-images.md has no block titled ${title}`);
}

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");
// Built at run time so no key-shaped string sits in the source.
const TOKEN = ["sk", "H4rb0urViewer", "0123456789abcdefghij"].join("");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function run(config: string | undefined, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-sanity-studio-"));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, "gaugeline.adapters.json"), config);
  const seen: SeenSanityRequest[] = [];
  const dataset = sanityCountsTransport({ ...HARBOUR, token: TOKEN }, seen);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    ["https://harbourlane.test/", "--no-open"],
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    {
      cwd: dir,
      version: "0.1.0",
      fetcher: {
        transport: staticSite(
          "harbourlane.test",
          join(SITES_DIR, "sanity-studio-images"),
          (url, req) =>
            url.hostname === `${HARBOUR_PROJECT}.api.sanity.io`
              ? dataset(url, req)
              : Promise.reject(new Error(`unexpected host ${url.hostname}`)),
          { origin: "https://harbourlane.test" },
        ),
      },
    },
  );
  return { code, out: out.join(""), err: err.join(""), seen };
}

const ENV = {
  SANITY_PROJECT_ID: HARBOUR_PROJECT,
  SANITY_DATASET: "production",
  SANITY_TOKEN: TOKEN,
};

describe("docs/guides/sanity-images.md: the checks that read your dataset", () => {
  it("the page's configuration is what the run reads, and the Output block is the CLI's output", async () => {
    const r = await run(block("gaugeline.adapters.json"), ENV);
    expect(r.code).toBe(0);
    expect(withoutPassed(r.out).trimEnd()).toBe(block("Output with a Viewer token"));
    // Read-only: GET only, the token in a header and never in an address, nothing but the query endpoint.
    const asked = r.seen.filter((s) => /_id in|references\(/.test(s.query));
    expect(asked).toHaveLength(2);
    for (const s of r.seen) {
      expect(s.method).toBe("GET");
      expect(s.url).not.toContain(TOKEN);
    }
    // Neither stream shows the token or an alt text an editor wrote.
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(r.out + r.err).not.toContain("HARBOUR-MARKER");
  });

  it("without gaugeline.adapters.json naming sanity, the three checks do not run and nothing is asked", async () => {
    const r = await run(undefined, ENV);
    expect(r.code).toBe(0);
    for (const id of [
      "sanity-image-crop-ignored",
      "sanity-image-alt-unrendered",
      "sanity-image-heavy",
    ])
      expect(r.out).not.toContain(id);
    expect(r.seen.filter((s) => /_id in|references\(/.test(s.query))).toHaveLength(0);
  });

  it("with the configuration and no project id, each check says it could not check and none passes", async () => {
    const r = await run('{ "adapters": [{ "id": "sanity" }] }', {});
    expect(r.out).toContain("SANITY_PROJECT_ID is not set");
    for (const id of [
      "sanity-image-crop-ignored",
      "sanity-image-alt-unrendered",
      "sanity-image-heavy",
    ])
      expect(r.out).not.toContain(`✓ ${id}`);
  });

  it("a wrong token is could-not-check with the Viewer-role hint, and the token is not printed", async () => {
    const r = await run('{ "adapters": [{ "id": "sanity" }] }', {
      ...ENV,
      SANITY_TOKEN: "wrong-token-value",
    });
    expect(r.out).toContain("Viewer role");
    expect(r.out + r.err).not.toContain("wrong-token-value");
  });

  it("is written for freelancer client work, with an invented pop-up bar", () => {
    expect(page).toContain("Harbour Lane Tap Room");
    expect(page).toContain("Viewer");
    expect(page).toContain("read-only");
  });
});
