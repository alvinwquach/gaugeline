import { fileURLToPath } from "node:url";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const MAP_HOSTS = fileURLToPath(new URL("./helpers/map-hosts.cjs", import.meta.url));
const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

async function printed(args: string[]): Promise<string> {
  const site = await startFixture("nuxt-like");
  try {
    const out: string[] = [];
    const io = {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => true },
      env: { NO_COLOR: "1" },
    };
    const code = await main([site.origin, "--no-open", ...args], io, {
      version: "0.1.0",
      fetcher: { hosts: site.hosts },
    });
    expect(code).toBe(0);
    return withoutPassed(out.join("")).trimEnd();
  } finally {
    await site.close();
  }
}

describe("nuxt: e2e", () => {
  it('the built command on the nuxt-like fixture says "2 framework addresses ignored" and never asks for the probing addresses', async () => {
    const site = await startFixture("nuxt-like");
    try {
      const r = await runBin([site.origin, "--allow-private", "--no-open"], {
        NODE_OPTIONS: `--require=${MAP_HOSTS}`,
        GAUGELINE_TEST_OFFLINE: "1",
        GAUGELINE_TEST_HOSTS: JSON.stringify(site.hosts),
        NO_COLOR: "1",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/\b2 framework addresses ignored\.\n/);
      expect(r.stdout).toMatch(/A Nuxt page sends fields that look private/);
      expect(r.stdout).not.toMatch(/invented-value/);
      const asked = [...site.hits.keys()];
      expect(
        asked.filter((k) => k.includes("_payload") || k.includes("__nuxt_devtools__")),
      ).toEqual([]);
      expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("the guide's first Output block is the CLI's output on nuxt-like (version 0.1.0)", async () => {
    expect(await printed([])).toBe(expectedOutput("guides/nuxt", "Example"));
  });

  it("the guide's second Output block is the output with --owner-consent", async () => {
    expect(await printed(["--owner-consent"])).toBe(
      expectedOutput("guides/nuxt", "Example with consent"),
    );
  });
});
