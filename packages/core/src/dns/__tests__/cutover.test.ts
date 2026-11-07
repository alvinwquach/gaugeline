import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCutoverRegistry, type CutoverCheckInput } from "../../checks/cutover.js";
import { expiryFinding } from "../../checks/certificate-expiring.js";
import { createDnsReader, type DnsResolver, type MxRecord } from "../../dns.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { certificateOf, covers, type Certificate } from "../certificate.js";
import { takeCutoverSnapshot, type CutoverSnapshot } from "../cutover-snapshot.js";
import { parseDmarc, parseSpf, readDomainRecords } from "../records.js";

/** A stand-in resolver: answers from a table, ENODATA for anything else. Never the network. */
function standIn(zone: {
  txt?: Record<string, string[][]>;
  mx?: Record<string, MxRecord[]>;
  a?: Record<string, string[]>;
}): DnsResolver & { zone: typeof zone } {
  const miss = () => Object.assign(new Error("no data"), { code: "ENODATA" });
  const from =
    <T>(table: Record<string, T[]> | undefined) =>
    async (name: string) => {
      const hit = table?.[name];
      if (!hit) throw miss();
      return hit;
    };
  return {
    zone,
    resolveTxt: (n) => from(zone.txt)(n),
    resolveMx: (n) => from(zone.mx)(n),
    resolve4: (n) => from(zone.a)(n),
    resolve6: () => Promise.reject(miss()),
  };
}

const ZONE = () => ({
  txt: {
    "fernkiln.test": [["v=spf1 include:_spf.mailhost.test ", "~all"], ["site-verification=abc"]],
    "_dmarc.fernkiln.test": [["v=DMARC1; p=quarantine; pct=100"]],
    "s1._domainkey.fernkiln.test": [["v=DKIM1; k=rsa; p=MIGf"]],
  },
  mx: { "fernkiln.test": [{ exchange: "mx1.mailhost.test", priority: 10 }] },
  a: { "fernkiln.test": ["192.0.2.10"] },
});

const NOW = new Date("2026-11-07T12:00:00Z");
const cert = (validTo: string, names = ["fernkiln.test", "www.fernkiln.test"]): Certificate => ({
  names,
  validFrom: "2026-08-01T00:00:00.000Z",
  validTo,
  issuer: "Test CA",
});

describe("cutover: unit", () => {
  it("reads SPF: its includes and how it ends", () => {
    expect(parseSpf("v=spf1 include:_spf.Mailhost.test ip4:192.0.2.1 -all")).toEqual({
      mechanisms: ["include:_spf.Mailhost.test", "ip4:192.0.2.1", "-all"],
      includes: ["_spf.mailhost.test"],
      all: "-all",
    });
    expect(parseSpf("v=spf10 nope")).toBeUndefined();
    expect(parseSpf("site-verification=abc")).toBeUndefined();
  });

  it("reads DMARC tags", () => {
    expect(parseDmarc("v=DMARC1; p=reject; sp=none;")).toEqual({
      v: "DMARC1",
      p: "reject",
      sp: "none",
    });
    expect(parseDmarc("v=spf1 -all")).toBeUndefined();
  });

  it("the expiry thresholds: 21 days is fine, 20 is fix soon, 6 is fix first, expired is fix first", () => {
    const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
    const level = (days: number) =>
      expiryFinding(cert(at(days)), NOW, "https://fernkiln.test/", "fernkiln.test")?.severity;
    expect([level(21), level(20), level(7), level(6), level(0), level(-1)]).toEqual([
      undefined,
      "medium",
      "medium",
      "high",
      "high",
      "high",
    ]);
    expect(
      expiryFinding(cert("2026-11-04T12:00:00Z"), NOW, "https://fernkiln.test/", "fernkiln.test")
        ?.evidence,
    ).toBe("The certificate for fernkiln.test expired on 2026-11-04, 3 days ago");
  });

  it("a certificate read from a socket: subjectAltName names, else the common name", () => {
    const socket = (peer: object) => ({ getPeerCertificate: () => peer });
    expect(
      certificateOf(
        socket({
          subject: { CN: "fernkiln.test" },
          issuer: { O: "Test CA" },
          subjectaltname: "DNS:www.fernkiln.test, DNS:Fernkiln.test, IP Address:192.0.2.1",
          valid_from: "Nov  1 00:00:00 2026 GMT",
          valid_to: "Nov 12 00:00:00 2026 GMT",
        }),
      ),
    ).toEqual({
      names: ["fernkiln.test", "www.fernkiln.test"],
      validFrom: "2026-11-01T00:00:00.000Z",
      validTo: "2026-11-12T00:00:00.000Z",
      issuer: "Test CA",
    });
    expect(certificateOf({})).toBeUndefined();
    expect(certificateOf(socket({}))).toBeUndefined();
  });
});

const snapshot = (over: Partial<CutoverSnapshot> = {}): CutoverSnapshot => ({
  schema: 1,
  domain: "fernkiln.test",
  takenAt: NOW.toISOString(),
  records: {
    a: ["192.0.2.10"],
    aaaa: [],
    mx: ["10 mx1.mailhost.test"],
    spf: ["v=spf1 include:_spf.mailhost.test ~all"],
    dmarc: ["v=DMARC1; p=quarantine"],
    dkim: { s1: ["v=DKIM1; k=rsa; p=MIGf"] },
    failed: [],
  },
  certificate: cert("2027-02-01T00:00:00.000Z"),
  hosts: { bare: { status: 200 }, www: { status: 301, location: "fernkiln.test/" } },
  ...over,
});
const run = (input: CutoverCheckInput) =>
  runChecks(input, createCutoverRegistry(), { ctx: { now: () => NOW } });

describe("cutover: edge cases", () => {
  it("a domain with no mail records at all: read as none, and none to none is no change", async () => {
    const r = await readDomainRecords(
      createDnsReader({ resolver: standIn({}), askReserved: true }),
      "quiet.test",
    );
    expect([r.mx, r.spf, r.dmarc, r.failed]).toEqual([[], [], [], []]);
    const empty = snapshot();
    empty.records = r;
    expect((await run({ before: empty, now: empty })).findings).toEqual([]);
  });

  it("several text records: only v=spf1 is SPF, chunks are joined, order is not a change", async () => {
    const zone = ZONE();
    zone.txt["fernkiln.test"] = [
      ["google-site=x"],
      ["v=spf1 include:_spf.mailhost.test ", "~all"],
      ["ms=y"],
    ];
    const r = await readDomainRecords(
      createDnsReader({ resolver: standIn(zone), askReserved: true }),
      "fernkiln.test",
      ["s1"],
    );
    expect(r.spf).toEqual(["v=spf1 include:_spf.mailhost.test ~all"]);
    expect(r.dkim).toEqual({ s1: ["v=DKIM1; k=rsa; p=MIGf"] });
    const before = snapshot();
    const reordered = snapshot();
    reordered.records = { ...reordered.records, a: ["192.0.2.11", "192.0.2.10"] };
    before.records = { ...before.records, a: ["192.0.2.10", "192.0.2.11"] };
    expect((await run({ before, now: reordered })).findings).toEqual([]);
  });

  it("a wildcard certificate covers one label, not the bare domain or two labels", () => {
    expect(covers("*.fernkiln.test", "www.fernkiln.test")).toBe(true);
    expect(covers("*.fernkiln.test", "fernkiln.test")).toBe(false);
    expect(covers("*.fernkiln.test", "a.b.fernkiln.test")).toBe(false);
    expect(covers("fernkiln.test", "FERNKILN.test.")).toBe(true);
  });

  it("an expected change is left out; a failed lookup is could not check, never a change", async () => {
    const now = snapshot();
    now.records = {
      ...now.records,
      mx: ["10 mx.newhost.test"],
      failed: ["TXT fernkiln.test (ETIMEOUT)"],
      spf: [],
    };
    const r = await run({
      before: snapshot(),
      now,
      expected: [{ record: "mx", reason: "mail moved to the new host on purpose" }],
    });
    expect(r.findings).toEqual([]);
    expect(r.couldNotCheck.map((c) => [c.id, c.reason])).toEqual([
      ["cutover-mail-changed", "the TXT lookup for fernkiln.test failed in one of the two runs"],
    ]);
  });

  it("both hosts answering 200, or a temporary redirect, is not one canonical host", async () => {
    const both = snapshot({ hosts: { bare: { status: 200 }, www: { status: 200 } } });
    const temp = snapshot({
      hosts: { bare: { status: 302, location: "www.fernkiln.test/" }, www: { status: 200 } },
    });
    expect(
      (await run({ before: snapshot(), now: both })).findings.map((f) => [f.severity, f.evidence]),
    ).toEqual([
      [
        "high",
        "fernkiln.test answers 200; www.fernkiln.test answers 200: one should answer 200 and the other redirect to it with 301",
      ],
      ["medium", "www.fernkiln.test answered 301 to fernkiln.test/ before cutover; now 200"],
    ]);
    expect((await run({ before: temp, now: temp })).findings.map((f) => f.checkId)).toEqual([
      "cutover-canonical-host",
    ]);
  });
});

// A local https server with a certificate made for this run (5 days left), and the stand-in zone.
const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)(
  "cutover: integration (a stand-in resolver and a local https server)",
  () => {
    let dir = "";
    let ca = "";
    let server: Server;
    let port = 0;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "gaugeline-tls-"));
      const o = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
      o(
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-days",
        "30",
        "-subj",
        "/CN=Gaugeline Test CA",
      );
      o(
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "leaf.key",
        "-out",
        "leaf.csr",
        "-subj",
        "/CN=fernkiln.test",
      );
      writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:fernkiln.test,DNS:*.fernkiln.test\n");
      o(
        "x509",
        "-req",
        "-in",
        "leaf.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "leaf.pem",
        "-days",
        "5",
        "-extfile",
        "ext.cnf",
      );
      ca = readFileSync(join(dir, "ca.pem"), "utf8");
      server = createServer(
        { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.pem")) },
        (req, res) => {
          if ((req.headers.host ?? "").startsWith("www."))
            res.writeHead(301, { location: `https://fernkiln.test:${port}/` }).end();
          else res.writeHead(200, { "content-type": "text/html" }).end("<p>Fern and Kiln</p>");
        },
      );
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      port = (server.address() as AddressInfo).port;
    }, 30_000);
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    });

    const take = (resolver: DnsResolver) =>
      takeCutoverSnapshot({
        domain: "fernkiln.test",
        dns: createDnsReader({ resolver, askReserved: true }),
        fetcher: createFetcher({
          ca,
          allowPrivate: true,
          resolver: async () => [{ address: "127.0.0.1", family: 4 }],
        }),
        selectors: ["s1"],
        port,
        now: () => new Date(),
      });

    it("snapshot, change the mail record, cutover reports it as fix first with both values", async () => {
      const zone = ZONE();
      const before = await take(standIn(zone));
      expect(before.records.mx).toEqual(["10 mx1.mailhost.test"]);
      expect(before.hosts).toEqual({
        bare: { status: 200 },
        www: { status: 301, location: "fernkiln.test/", endsAt: "fernkiln.test/" },
      });
      expect(before.certificate?.names).toEqual(["*.fernkiln.test", "fernkiln.test"]);
      zone.mx["fernkiln.test"] = [{ exchange: "mx.newhost.test", priority: 10 }];
      const now = await take(standIn(zone));
      const r = await runChecks({ before, now }, createCutoverRegistry(), {
        ctx: { now: () => new Date() },
      });
      expect(r.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        [
          "certificate-expiring",
          "high",
          expect.stringMatching(
            /^The certificate for fernkiln\.test expires on \d{4}-\d\d-\d\d: [45] days left \(issued by /,
          ),
        ],
        [
          "cutover-mail-changed",
          "high",
          "MX for fernkiln.test was 10 mx1.mailhost.test; now 10 mx.newhost.test",
        ],
      ]);
    });
  },
);
