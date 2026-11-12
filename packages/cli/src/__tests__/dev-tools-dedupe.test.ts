import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

async function run(fixture: string): Promise<string> {
  const site = await startFixture(fixture);
  try {
    const out: string[] = [];
    const io = {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => true },
      env: { NO_COLOR: "1" },
    };
    const code = await main([site.origin, "--allow-private", "--no-open"], io, {
      version: "0.1.0",
      fetcher: { hosts: site.hosts },
    });
    expect(code).toBe(0);
    return withoutPassed(out.join(""));
  } finally {
    await site.close();
  }
}

describe("development tools: the generic check steps aside for a framework's own", () => {
  // Each of these pages loads /@vite/client and its pack already reports it.
  it.each([
    ["angular-like", "The live Angular site is serving its development tools"],
    ["astro-like", "The live Astro site is serving its development tools"],
    ["sveltekit-dev", "The live site is a development server"],
    ["hydrogen-dev", "The live Hydrogen store is a development server"],
    ["remix-dev", "The live Remix site is a development server"],
    ["qwik-dev", "The live Qwik or SolidStart site is a development server"],
  ])("%s: the pack's own check reports it once", async (name, title) => {
    const text = await run(name);
    expect(text).toContain(`✗ ${title}\n`);
    expect(text).not.toContain("Development tools are live on your site");
  });
});

describe("development tools: Hydrogen and Remix do not report the same dev server twice", () => {
  it("hydrogen-dev (a Hydrogen storefront on React Router) is the Hydrogen check's, not the Remix check's", async () => {
    const text = await run("hydrogen-dev");
    expect(text).toContain("\u2717 The live Hydrogen store is a development server\n");
    expect(text).not.toContain("The live Remix site is a development server");
  });

  it("remix-dev (a React Router 7 site that is not Hydrogen) is the Remix check's, not the Hydrogen check's", async () => {
    const text = await run("remix-dev");
    expect(text).toContain("\u2717 The live Remix site is a development server\n");
    expect(text).not.toContain("The live Hydrogen store is a development server");
  });
});
