import { Readable } from "node:stream";
import { createNetworkTransport, type Transport } from "@gaugeline/core";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

describe("facts: e2e (CLI, version 0.1.0)", () => {
  it("popup with its gaugeline.facts.json prints exactly the facts guide's Output block", async () => {
    const site = await startFixture("popup");
    const local = createNetworkTransport({ allowPrivate: true });
    // The Venmo profile is answered here, never by venmo.com.
    const transport: Transport = async (url, req) =>
      /(?:^|\.)(?:venmo\.com|cash\.app)$/.test(url.hostname)
        ? {
            status: 200,
            headers: { "content-type": "text/html" },
            body: Readable.from([Buffer.from("")]),
          }
        : local(url, req);
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const out: string[] = [];
      const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => true } };
      const code = await main([site.origin, "--no-open", "--allow-private"], io, {
        version: "0.1.0",
        cwd: `${SITES_DIR}popup`,
        fetcher: { transport },
      });
      expect(code).toBe(0);
      expect(withoutPassed(out.join("")).trimEnd()).toBe(expectedOutput("guides/facts", "Example"));
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      await site.close();
    }
  });
});
