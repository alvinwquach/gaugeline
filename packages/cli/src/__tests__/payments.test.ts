import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNetworkTransport, type Transport } from "@gaugeline/core";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { useCassette } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("payment details: e2e (CLI, version 0.1.0, recorded Square and Stripe answers)", () => {
  it("payments-popup with its gaugeline.payments.json prints exactly the payments guide's Output block", async () => {
    const site = await startFixture("payments-popup");
    const local = createNetworkTransport({ allowPrivate: true });
    const recorded = useCassette("payment-links", { mode: "replay" });
    // Square and Stripe answer from the cassette and the Venmo profile here: never the live sites.
    const transport: Transport = async (url, req) => {
      if (/(?:^|\.)(?:square\.link|stripe\.com)$/.test(url.hostname)) return recorded(url, req);
      if (/(?:^|\.)(?:venmo\.com|cash\.app)$/.test(url.hostname))
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: Readable.from([Buffer.from("")]),
        };
      return local(url, req);
    };
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const run = capture();
      const code = await main([site.origin, "--no-open", "--allow-private"], run.io, {
        version: "0.1.0",
        cwd: `${SITES_DIR}payments-popup`,
        fetcher: { transport },
      });
      expect(code).toBe(0);
      expect(withoutPassed(run.out()).trimEnd()).toBe(expectedOutput("guides/payments", "Example"));
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
      await site.close();
    }
  });

  it("an invalid gaugeline.payments.json stops the run naming the field (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-payments-"));
    try {
      writeFileSync(
        join(dir, "gaugeline.payments.json"),
        JSON.stringify({ payments: [{ kind: "venmo", value: "not a handle!" }] }),
      );
      const run = capture();
      expect(await main(["https://pop.example/"], run.io, { cwd: dir })).toBe(2);
      expect(run.err()).toContain(
        'gaugeline.payments.json: payments.0.value: "not a handle!" is not a Venmo handle.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
