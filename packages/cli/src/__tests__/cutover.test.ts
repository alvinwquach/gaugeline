import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  createDnsReader,
  type DnsResolver,
  type MxRecord,
  type TransportResponse,
} from "@gaugeline/core";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The invented Fern and Kiln studio's zone, as a stand-in resolver: never the network. */
function zone() {
  const z = {
    txt: {
      "fernkiln.example": [["v=spf1 include:_spf.mailhost.example ~all"], ["site-verification=k1"]],
      "_dmarc.fernkiln.example": [["v=DMARC1; p=quarantine"]],
      "s1._domainkey.fernkiln.example": [["v=DKIM1; k=rsa; p=MIGfMA0"]],
    } as Record<string, string[][]>,
    mx: { "fernkiln.example": [{ exchange: "mx1.mailhost.example", priority: 10 }] } as Record<
      string,
      MxRecord[]
    >,
    a: { "fernkiln.example": ["192.0.2.10"] } as Record<string, string[]>,
  };
  const miss = () => Object.assign(new Error("no data"), { code: "ENODATA" });
  const from =
    <T>(t: Record<string, T[]>) =>
    async (n: string) => {
      const hit = t[n];
      if (!hit) throw miss();
      return hit;
    };
  const resolver: DnsResolver = {
    resolveTxt: (n) => from(z.txt)(n),
    resolveMx: (n) => from(z.mx)(n),
    resolve4: (n) => from(z.a)(n),
    resolve6: () => Promise.reject(miss()),
  };
  // A new reader per command, as each run of the CLI has: the reader memoises its lookups.
  return { z, dns: () => createDnsReader({ resolver, askReserved: true }) };
}

/** Recorded answers: the bare domain serves the site, www redirects to it, one certificate. */
const transport = async (url: URL): Promise<TransportResponse> => ({
  status: url.hostname.startsWith("www.") ? 301 : 200,
  headers: url.hostname.startsWith("www.")
    ? { location: "https://fernkiln.example/" }
    : { "content-type": "text/html" },
  body: Readable.from([Buffer.from("<p>Fern and Kiln</p>")]),
  certificate: {
    names: ["fernkiln.example", "www.fernkiln.example"],
    validFrom: "2026-10-01T00:00:00.000Z",
    validTo: "2026-11-23T00:00:00.000Z",
    issuer: "Invented Test CA",
  },
});

async function cli(argv: string[], cwd: string, dns: ReturnType<typeof zone>["dns"]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    { cwd, dns: dns(), fetcher: { transport }, now: () => new Date("2026-11-07T09:00:00Z") },
  );
  return { code, out: out.join("").trimEnd(), err: err.join("") };
}

describe("cutover: e2e (CLI, a stand-in resolver and recorded responses)", () => {
  it("snapshot, change the mail record, cutover reports it as fix first with both values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-cutover-"));
    dirs.push(dir);
    writeFileSync(join(dir, "gaugeline.cutover.json"), JSON.stringify({ dkimSelectors: ["s1"] }));
    const { z, dns } = zone();
    const snap = await cli(["snapshot", "fernkiln.example", "--out", "before.json"], dir, dns);
    expect(snap.code).toBe(0);
    expect(snap.out).toBe(expectedOutput("guides/cutover", "The snapshot"));
    expect(snap.err).toContain("Domain registration expiry needs the registrar's records");
    const saved = JSON.parse(readFileSync(join(dir, "before.json"), "utf8")) as {
      records: { mx: string[] };
    };
    expect(saved.records.mx).toEqual(["10 mx1.mailhost.example"]);
    // Cutover day: the new host's DNS template replaced the mail record.
    z.mx["fernkiln.example"] = [{ exchange: "mx.newhost.example", priority: 10 }];
    const r = await cli(["cutover", "--before", "before.json"], dir, dns);
    expect(r.out).toBe(expectedOutput("guides/cutover", "The comparison"));
    expect(r.code).toBe(1);
  });

  it("a change listed under expectedChanges is left out, and said once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-cutover-"));
    dirs.push(dir);
    const { z, dns } = zone();
    await cli(["snapshot", "fernkiln.example", "--out", "before.json"], dir, dns);
    writeFileSync(
      join(dir, "gaugeline.cutover.json"),
      JSON.stringify({ expectedChanges: [{ record: "mx", reason: "mail moved to the new host" }] }),
    );
    z.mx["fernkiln.example"] = [{ exchange: "mx.newhost.example", priority: 10 }];
    const r = await cli(["cutover", "--before", "before.json"], dir, dns);
    expect(r.out).not.toContain("MX for");
    expect(r.err).toContain("Expected change, not reported: mx (mail moved to the new host)");
  });

  it("cutover without --before, or a file that isn't a snapshot, is exit 2 with what to do", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gaugeline-cutover-"));
    dirs.push(dir);
    const { dns } = zone();
    expect((await cli(["cutover"], dir, dns)).code).toBe(2);
    writeFileSync(join(dir, "x.json"), "{}");
    const bad = await cli(["cutover", "--before", "x.json"], dir, dns);
    expect([bad.code, bad.err]).toEqual([
      2,
      expect.stringContaining("x.json is not a snapshot written by gaugeline snapshot."),
    ]);
  });
});
