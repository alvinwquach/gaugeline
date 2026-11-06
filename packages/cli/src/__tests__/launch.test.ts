import type { DnsReader } from "@gaugeline/core";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const withoutPassed = (text: string) => text.replace(/^✓ [a-z0-9-]+\n/gm, "");

/** No name resolves: staging.<fixture> and anything unmapped never reach real DNS. */
const nowhere = async (): Promise<never> => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND (test)"), { code: "ENOTFOUND" });
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** A DNS reader that answers nothing and logs every lookup. */
function recordingDns(asked: string[]): DnsReader {
  return {
    txt: async (n) => {
      asked.push(`TXT ${n}`);
      return [];
    },
    mx: async (n) => {
      asked.push(`MX ${n}`);
      return [];
    },
  };
}

async function launch(fixture: string, flags: string[], dns?: DnsReader) {
  const site = await startFixture(fixture);
  try {
    const run = capture();
    const code = await main(["launch", site.origin, "--no-open", ...flags], run.io, {
      version: "0.1.0",
      fetcher: { hosts: site.hosts, resolver: nowhere },
      ...(dns ? { dns } : {}),
    });
    return { code, out: run.out(), err: run.err() };
  } finally {
    await site.close();
  }
}

describe("gaugeline launch: e2e (CLI, version 0.1.0)", () => {
  it('the clean fixture prints "Ready to launch" and exits 0', async () => {
    const r = await launch("launch-clean", []);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().split("\n").at(-1)).toBe("Ready to launch");
  });

  it("--ci exits 1 on the fixture with a temporary-address link, and the output is the quick-start's", async () => {
    const r = await launch("launch-preview", ["--ci"]);
    expect(r.code).toBe(1);
    expect(withoutPassed(r.out).trimEnd()).toBe(expectedOutput("quick-start", "Launch day"));
  });

  it("without --dns the DNS reader records zero lookups; with --dns it records TXT and MX lookups", async () => {
    const without: string[] = [];
    await launch("launch-clean", [], recordingDns(without));
    expect(without).toEqual([]);
    const withDns: string[] = [];
    const r = await launch("launch-clean", ["--dns"], recordingDns(withDns));
    expect([...new Set(withDns)].sort()).toEqual(["MX fernwood.test", "TXT _dmarc.fernwood.test"]);
    // No MX: the SPF checks skip, so the only finding is the missing DMARC record.
    expect(r.out).toContain("no TXT record starting v=DMARC1 at _dmarc.fernwood.test");
  });

  it("a preset id from a later phase is missing: the command still runs and says which check was skipped", async () => {
    const r = await launch("launch-clean", []);
    expect(r.code).toBe(0);
    expect(r.err).toContain("stripe-test-mode: not available in this version\n");
    // Only the launch preset ran: no page check outside it reports.
    expect(r.out).not.toMatch(/✓ (canonical-missing|thin-html|viewport)\n/);
    expect(r.out).toMatch(/✓ temp-host-links\n/);
  });

  it("gaugeline launch --help prints the options page's launch usage, from the built bin", async () => {
    const r = await runBin(["launch", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.launch);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The launch command"));
  });
});
