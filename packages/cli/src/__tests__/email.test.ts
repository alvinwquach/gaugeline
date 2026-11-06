import { readFileSync } from "node:fs";
import type { DnsReader, MxRecord } from "@gaugeline/core";
import { SITES_DIR, expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

/** The fixture's DNS answers, from its dns.json: never a real resolver. */
function fixtureDns(name: string): DnsReader {
  const data = JSON.parse(readFileSync(`${SITES_DIR}${name}/dns.json`, "utf8")) as {
    txt: Record<string, string[]>;
    mx: Record<string, MxRecord[]>;
  };
  return {
    txt: async (n) => data.txt[n] ?? [],
    mx: async (n) => data.mx[n] ?? [],
  };
}

describe("email records: e2e (CLI, version 0.1.0, the fixture's DNS answers)", () => {
  it("email-records prints exactly the Privacy page's Email records Output block", async () => {
    const site = await startFixture("email-records");
    try {
      const out: string[] = [];
      const io = {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: () => true },
        env: { NO_COLOR: "1" },
      };
      const code = await main([site.origin, "--no-open"], io, {
        version: "0.1.0",
        fetcher: { hosts: site.hosts },
        dns: fixtureDns("email-records"),
      });
      expect(code).toBe(0);
      expect(withoutPassed(out.join("")).trimEnd()).toBe(
        expectedOutput("privacy", "Email records"),
      );
    } finally {
      await site.close();
    }
  });
});
