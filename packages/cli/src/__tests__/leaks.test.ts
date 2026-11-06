import { createNetworkTransport, type Transport } from "@gaugeline/core";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { useCassette } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("leaked keys and datasets: e2e (CLI, version 0.1.0, recorded Sanity answers)", () => {
  it("the leaks fixture prints exactly the Private datasets page's Output block", async () => {
    const site = await startFixture("leaks");
    const local = createNetworkTransport({ allowPrivate: true });
    const recorded = useCassette("sanity-datasets", { mode: "replay" });
    // Sanity answers from the cassette, never from the live API.
    const transport: Transport = (url, req) =>
      url.hostname.endsWith(".api.sanity.io") ? recorded(url, req) : local(url, req);
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const out: string[] = [];
      const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => true } };
      const code = await main([site.origin, "--no-open", "--allow-private"], io, {
        version: "0.1.0",
        fetcher: { transport },
      });
      expect(code).toBe(0);
      expect(withoutPassed(out.join("")).trimEnd()).toBe(
        expectedOutput("private-datasets", "Example"),
      );
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      await site.close();
    }
  });
});
