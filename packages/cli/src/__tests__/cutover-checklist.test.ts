import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createDnsReader, type DnsResolver, type TransportResponse } from "@gaugeline/core";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GOLDEN = join(import.meta.dirname, "fixtures", "cutover-before.golden.json");
const HEADER = "Do by hand (Gaugeline sends nothing):";

/** The invented Fern and Kiln studio, read through stand-ins: never the network. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-checklist-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gaugeline.cutover.json"), JSON.stringify({ dkimSelectors: ["s1"] }));
  const mx = [{ exchange: "mx1.mailhost.example", priority: 10 }];
  const miss = () => Object.assign(new Error("no data"), { code: "ENODATA" });
  const txt: Record<string, string[][]> = {
    "fernkiln.example": [["v=spf1 include:_spf.mailhost.example ~all"], ["site-verification=k1"]],
    "_dmarc.fernkiln.example": [["v=DMARC1; p=quarantine"]],
    "s1._domainkey.fernkiln.example": [["v=DKIM1; k=rsa; p=MIGfMA0"]],
  };
  const lookups: string[] = [];
  const requests: string[] = [];
  const resolver: DnsResolver = {
    resolveTxt: async (n) => {
      lookups.push(`txt ${n}`);
      return txt[n] ?? Promise.reject(miss());
    },
    resolveMx: async (n) => {
      lookups.push(`mx ${n}`);
      if (n === "fernkiln.example") return mx;
      throw miss();
    },
    resolve4: async (n) => {
      lookups.push(`a ${n}`);
      if (n === "fernkiln.example") return ["192.0.2.10"];
      throw miss();
    },
    resolve6: () => Promise.reject(miss()),
  };
  const transport = async (url: URL): Promise<TransportResponse> => {
    requests.push(`GET ${url.hostname}`);
    const www = url.hostname.startsWith("www.");
    return {
      status: www ? 301 : 200,
      headers: www ? { location: "https://fernkiln.example/" } : { "content-type": "text/html" },
      body: Readable.from([Buffer.from("<p>Fern and Kiln</p>")]),
      certificate: {
        names: ["fernkiln.example", "www.fernkiln.example"],
        validFrom: "2026-10-01T00:00:00.000Z",
        validTo: "2026-11-23T00:00:00.000Z",
        issuer: "Invented Test CA",
      },
    };
  };
  /** Every write, in order, tagged with its stream: to prove the checklist comes after the diff. */
  const log: { stream: "out" | "err"; text: string }[] = [];
  async function cli(argv: string[]) {
    const code = await main(
      argv,
      {
        stdout: { write: (s: string) => log.push({ stream: "out", text: s }) },
        stderr: { write: (s: string) => log.push({ stream: "err", text: s }) },
        env: { NO_COLOR: "1" },
      },
      {
        cwd: dir,
        dns: createDnsReader({ resolver, askReserved: true }),
        fetcher: { transport },
        now: () => new Date("2026-11-07T09:00:00Z"),
      },
    );
    const of = (s: "out" | "err") =>
      log
        .filter((l) => l.stream === s)
        .map((l) => l.text)
        .join("");
    return { code, out: of("out"), err: of("err") };
  }
  return { dir, mx, cli, log, lookups, requests };
}

/** The index of the last write to stdout: the checklist must come after it. */
const lastOut = (log: { stream: "out" | "err" }[]) => log.map((l) => l.stream).lastIndexOf("out");

const STDERR_AFTER_SNAPSHOT = () => expectedOutput("guides/cutover", "Stderr after the snapshot");
const STDERR_AFTER_COMPARISON = () =>
  expectedOutput("guides/cutover", "Stderr after the comparison");

describe("cutover manual checklist: the wording (unit)", () => {
  it("names the two-way mail test and the SPF, DKIM and DMARC comparison, as steps to do by hand", async () => {
    const { manualChecklist } = await import("../manual-checklist.js");
    for (const mode of ["snapshot", "cutover"] as const) {
      const text = manualChecklist(mode);
      const lines = text.split("\n");
      expect(lines[0]).toBe(HEADER);
      expect(lines[1]).toMatch(
        /^ {2}1\. Send a test email from outside to an address on the client's domain, and one from the client's mail to outside\./,
      );
      expect(lines[2]).toMatch(/^ {2}2\. .*SPF, DKIM and DMARC/);
      expect(lines[3]).toMatch(/^ {2}3\. Domain registration expiry needs the registrar's records/);
      expect(lines).toHaveLength(4);
    }
  });

  it("says plainly that it is a manual step, and claims nothing about mail working or about Gaugeline sending", async () => {
    const { manualChecklist } = await import("../manual-checklist.js");
    for (const mode of ["snapshot", "cutover"] as const) {
      // The one sentence about sending is the header's "Gaugeline sends nothing"; take it out, then
      // no other form of "sent", "sends", "sending", "we send" or "will send" may remain.
      const rest = manualChecklist(mode).replace(HEADER, "");
      expect(rest).not.toMatch(/\b(sent|sends|sending|we send|will send|has sent)\b/i);
      expect(rest).not.toMatch(
        /\b(works?|working|delivered|verified|passed|passes|confirmed|healthy|good to go)\b/i,
      );
      expect(manualChecklist(mode)).toMatch(/by hand/i);
    }
  });

  it("is a small constant: it reads nothing from the site and imports nothing", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "manual-checklist.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\b(fetch|resolve[A-Z0-9]\w*|createFetcher|createDnsReader|process\.)/);
  });
});

describe("cutover manual checklist: the commands (integration and end to end)", () => {
  it("snapshot ends with the checklist on stderr, after the snapshot lines, and the registrar note once", async () => {
    const t = setup();
    const r = await t.cli(["snapshot", "fernkiln.example", "--out", "before.json"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(HEADER);
    expect(r.err).toContain(
      "1. Send a test email from outside to an address on the client's domain",
    );
    expect(r.err.match(/Domain registration expiry needs the registrar's records/g)).toHaveLength(
      1,
    );
    expect(r.err.indexOf(HEADER)).toBeLessThan(r.err.indexOf("Domain registration expiry"));
    expect(t.log.findIndex((l) => l.stream === "err")).toBeGreaterThan(lastOut(t.log));
    expect(r.err.trimEnd()).toBe(STDERR_AFTER_SNAPSHOT());
  });

  it("cutover --before ends with the checklist on stderr, after the diff, and the registrar note once", async () => {
    const t = setup();
    await t.cli(["snapshot", "fernkiln.example", "--out", "before.json"]);
    t.log.length = 0;
    t.mx[0] = { exchange: "mx.newhost.example", priority: 10 };
    const r = await t.cli(["cutover", "--before", "before.json"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("The domain's mail records changed at cutover");
    expect(r.err).toContain(HEADER);
    expect(r.err).toContain("and one from the client's mail to outside");
    expect(r.err.match(/Domain registration expiry needs the registrar's records/g)).toHaveLength(
      1,
    );
    expect(t.log.findIndex((l) => l.stream === "err")).toBeGreaterThan(lastOut(t.log));
    expect(r.err.trimEnd()).toBe(STDERR_AFTER_COMPARISON());
  });

  it("the checklist comes after an expected-change note, and --quiet leaves the notes and the checklist out together", async () => {
    const t = setup();
    await t.cli(["snapshot", "fernkiln.example", "--out", "before.json"]);
    writeFileSync(
      join(t.dir, "gaugeline.cutover.json"),
      JSON.stringify({ expectedChanges: [{ record: "mx", reason: "mail moved to the new host" }] }),
    );
    t.log.length = 0;
    t.mx[0] = { exchange: "mx.newhost.example", priority: 10 };
    const loud = await t.cli(["cutover", "--before", "before.json"]);
    expect(loud.err.indexOf("Expected change, not reported")).toBeLessThan(
      loud.err.indexOf(HEADER),
    );
    t.log.length = 0;
    const quiet = await t.cli(["cutover", "--before", "before.json", "--quiet"]);
    const quietSnap = await t.cli(["snapshot", "fernkiln.example", "--out", "b2.json", "--quiet"]);
    expect(quiet.err).toBe("");
    expect(quietSnap.err).toBe("");
  });

  it("a snapshot with no DKIM selector named still ends with the checklist", async () => {
    const t = setup();
    writeFileSync(join(t.dir, "gaugeline.cutover.json"), JSON.stringify({}));
    const r = await t.cli(["snapshot", "fernkiln.example", "--out", "before.json"]);
    expect(r.err).toContain(HEADER);
  });

  it("the snapshot file is unchanged byte for byte (golden), and stdout is the documented output", async () => {
    const t = setup();
    const r = await t.cli(["snapshot", "fernkiln.example", "--out", "before.json"]);
    expect(readFileSync(join(t.dir, "before.json"), "utf8")).toBe(readFileSync(GOLDEN, "utf8"));
    expect(r.out.trimEnd()).toBe(expectedOutput("guides/cutover", "The snapshot"));
    expect(r.out).not.toContain("Do by hand");
  });

  it("neither command has --json, and the checklist is not in any file or machine output", async () => {
    const t = setup();
    expect((await t.cli(["snapshot", "fernkiln.example", "--json"])).code).toBe(2);
    expect((await t.cli(["cutover", "--before", "before.json", "--json"])).code).toBe(2);
    await t.cli(["snapshot", "fernkiln.example", "--out", "before.json"]);
    expect(readFileSync(join(t.dir, "before.json"), "utf8")).not.toMatch(/by hand|test email/i);
  });

  it("adds no request and no lookup: the same GETs and lookups as before, per command", async () => {
    const t = setup();
    await t.cli(["snapshot", "fernkiln.example", "--out", "before.json"]);
    // The bare domain, www, and the one redirect hop www answers with: as before this row.
    const GETS = ["GET fernkiln.example", "GET www.fernkiln.example", "GET fernkiln.example"];
    expect(t.requests).toEqual(GETS);
    const perCommand = t.lookups.length;
    expect(perCommand).toBe(5);
    t.requests.length = 0;
    t.lookups.length = 0;
    await t.cli(["cutover", "--before", "before.json"]);
    expect(t.requests).toEqual(GETS);
    expect(t.lookups.length).toBe(perCommand);
  });
});
