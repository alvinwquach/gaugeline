import { createNetworkTransport, type Transport } from "@gaugeline/core";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { useCassette } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

// Placeholder values for the variables gaugeline.access.json names: never real keys.
const ENV = {
  NO_COLOR: "1",
  SUPABASE_ANON_KEY: "test-anon-key",
  GAUGELINE_TEST_CUSTOMER_TOKEN: "test-customer-token",
  GAUGELINE_TEST_CUSTOMER_ID: "4f9c2e1a-0b7d-4c3e-9a51-6d8e2f0b1c47",
};

function capture(env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("database access rules: e2e (CLI, version 0.1.0, recorded project answers)", () => {
  it("access-rules with its gaugeline.access.json prints exactly the guide's Output block", async () => {
    const site = await startFixture("access-rules");
    const local = createNetworkTransport({ allowPrivate: true });
    const recorded = useCassette("supabase-access", { mode: "replay" });
    // The project answers from the cassette, never from the live service.
    const transport: Transport = (url, req) =>
      url.hostname.endsWith(".supabase.co") ? recorded(url, req) : local(url, req);
    try {
      const run = capture(ENV);
      const code = await main([site.origin, "--no-open", "--allow-private"], run.io, {
        version: "0.1.0",
        cwd: `${SITES_DIR}access-rules`,
        fetcher: { transport },
      });
      expect(code).toBe(0);
      const printed = withoutPassed(run.out()).trimEnd();
      expect(printed).toBe(expectedOutput("guides/access-rules", "Example"));
      // No key or token reaches the output.
      expect(run.out() + run.err()).not.toMatch(/test-anon-key|test-customer-token/);
    } finally {
      await site.close();
    }
  });

  it("a variable the file names but the environment lacks stops the run naming it (exit 2)", async () => {
    const run = capture({ NO_COLOR: "1" });
    expect(await main(["https://pop.example/"], run.io, { cwd: `${SITES_DIR}access-rules` })).toBe(
      2,
    );
    expect(run.err()).toContain("anonKeyEnv names SUPABASE_ANON_KEY, which is not set.");
  });
});
