// check-community: allow-email (DMARC records carry a report address; these are invented, at reserved example domains).
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import {
  createDnsReader,
  dnsName,
  isReservedName,
  registrableDomain,
  type DnsReader,
  type DnsResolver,
  type MxRecord,
} from "../../dns.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { emailDmarcMissing } from "../email-dmarc-missing.js";
import { emailDmarcNone } from "../email-dmarc-none.js";
import { emailSpfMissing } from "../email-spf-missing.js";
import { emailSpfMultiple } from "../email-spf-multiple.js";
import { dmarcTags, isSpf, nullMx } from "../email/records.js";

const EMAIL_CHECKS = [
  "email-dmarc-missing",
  "email-dmarc-none",
  "email-spf-missing",
  "email-spf-multiple",
];

/** A Map-backed reader: names it doesn't know have no records. Every name asked is logged. */
function fakeReader(
  txt: Record<string, string[]>,
  mx: Record<string, MxRecord[]> = {},
  asked: string[] = [],
): DnsReader {
  return {
    txt: async (name) => {
      asked.push(`TXT ${name}`);
      return txt[name] ?? [];
    },
    mx: async (name) => {
      asked.push(`MX ${name}`);
      return mx[name] ?? [];
    },
  };
}

const pageAt = (url: string) =>
  buildSnapshot([
    { url, status: 200, headers: { "content-type": "text/html" }, body: "<html></html>", ms: 1 },
  ]);
const ctxOf = (dns: DnsReader): CheckContext => ({ warn: () => undefined, dns });
const MX: MxRecord[] = [{ exchange: "mx1.mail.pop.example", priority: 10 }];

async function idsFor(url: string, dns: DnsReader): Promise<string[]> {
  const p = pageAt(url);
  const ctx = ctxOf(dns);
  const out = await Promise.all(
    [emailSpfMissing, emailSpfMultiple, emailDmarcMissing, emailDmarcNone].map((c) =>
      c.run(p, ctx),
    ),
  );
  return out.flat().map((f) => f.checkId);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("email records: unit (fake DnsReader)", () => {
  const DMARC = { "_dmarc.pop.example": ["v=DMARC1; p=reject"] };
  it.each([
    ["MX and no SPF", { "pop.example": [] }, MX, ["email-spf-missing"]],
    ["MX and one SPF", { "pop.example": ["v=spf1 include:_spf.mail.example -all"] }, MX, []],
    [
      "MX and two SPF",
      { "pop.example": ["v=spf1 include:a.example -all", "v=spf1 -all"] },
      MX,
      ["email-spf-multiple"],
    ],
    ["no MX and no SPF", { "pop.example": [] }, [], []],
  ])("%s", async (_name, txt, mx, want) => {
    expect(
      await idsFor(
        "https://www.pop.example/",
        fakeReader({ ...DMARC, ...txt }, { "pop.example": mx }),
      ),
    ).toEqual(want);
  });

  it("the DMARC tag parser: p=none, quarantine, reject, upper case, spaces around the semicolons", () => {
    expect(dmarcTags("v=DMARC1; p=none").get("p")).toBe("none");
    expect(dmarcTags("v=DMARC1;p=quarantine;pct=50").get("p")).toBe("quarantine");
    expect(dmarcTags("v=DMARC1 ; p = reject ; rua=mailto:d@pop.example").get("p")).toBe("reject");
    expect(dmarcTags("V=DMARC1; P=NONE").get("p")).toBe("none");
    expect([...dmarcTags("v=DMARC1;  p=none ;sp=reject;").keys()]).toEqual(["v", "p", "sp"]);
  });

  it("a TXT record split into three chunks is joined before matching", async () => {
    const resolver: DnsResolver = {
      resolveTxt: async () => [["v=spf1 ", "include:_spf.mail.example ", "-all"]],
      resolveMx: async () => MX,
    };
    const dns = createDnsReader({ resolver });
    expect(await dns.txt("pop.org.test.gaugeline.dev")).toEqual([
      "v=spf1 include:_spf.mail.example -all",
    ]);
  });

  it("registrableDomain strips www. and keeps the host as given otherwise", () => {
    expect(registrableDomain("www.Pop.Example")).toBe("pop.example");
    expect(registrableDomain("app.pop.example.")).toBe("app.pop.example");
    expect(registrableDomain("shop.example.co.uk")).toBe("shop.example.co.uk");
    expect(dnsName("https://127.0.0.1:4000/")).toBeUndefined();
    expect(dnsName("http://localhost/")).toBeUndefined();
    expect(dnsName("https://[::1]/")).toBeUndefined();
  });

  it("names reserved for examples and tests never reach the resolver", async () => {
    for (const n of [
      "pop.example",
      "shop.test",
      "x.invalid",
      "a.localhost",
      "example.com",
      "app.example.org",
    ])
      expect(isReservedName(n), n).toBe(true);
    expect(isReservedName("examples.com")).toBe(false);
    const asked: string[] = [];
    const resolver: DnsResolver = {
      resolveTxt: async (n) => {
        asked.push(n);
        return [];
      },
      resolveMx: async (n) => {
        asked.push(n);
        return [];
      },
    };
    const dns = createDnsReader({ resolver });
    expect([await dns.txt("shop.test"), await dns.mx("pop.example")]).toEqual([[], []]);
    expect(asked).toEqual([]);
    // And the checks skip them, rather than report a missing record.
    expect(await idsFor("https://shop.test/", dns)).toEqual([]);
  });
});

describe("email records: integration", () => {
  it("a reader that rejects with ETIMEOUT: no finding, and the four checks are could-not-check", async () => {
    const timeout = Object.assign(new Error("queryTxt ETIMEOUT pop.dev"), { code: "ETIMEOUT" });
    const resolver: DnsResolver = {
      resolveTxt: () => Promise.reject(timeout),
      resolveMx: () => Promise.reject(timeout),
    };
    const site = await startFixture("duplicate-host");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts, allowPrivate: true }),
        only: EMAIL_CHECKS,
        // A reader whose reserved-name guard is off, so the fixture's .test host is asked about.
        dns: createDnsReader({ resolver, askReserved: true }),
      });
      expect(result.findings).toEqual([]);
      expect(result.failed.map((f) => (typeof f === "string" ? f : f.id)).sort()).toEqual(
        EMAIL_CHECKS,
      );
    } finally {
      await site.close();
    }
  });

  it("the fixture site's hits are only the page itself: the email checks make no HTTP request", async () => {
    const site = await startFixture("duplicate-host");
    try {
      const asked: string[] = [];
      await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts, allowPrivate: true }),
        only: EMAIL_CHECKS,
        dns: fakeReader({}, { "duplicate.test": MX }, asked),
      });
      expect([...site.hits.keys()]).toEqual(["/"]);
      expect([...new Set(asked)].sort()).toEqual([
        "MX duplicate.test",
        "TXT _dmarc.duplicate.test",
        "TXT duplicate.test",
      ]);
    } finally {
      await site.close();
    }
  });
});

describe("email records: promise (public DNS only, never a mail server)", () => {
  it("only resolveTxt and resolveMx are called, and no socket is opened to port 25, 465 or 587", async () => {
    const called: string[] = [];
    const resolver = new Proxy({} as DnsResolver, {
      get: (_t, prop: string) => async (name: string) => {
        called.push(prop);
        return prop === "resolveMx" ? [{ exchange: `mx.${name}`, priority: 10 }] : [];
      },
    });
    const ports: number[] = [];
    const connect = net.Socket.prototype.connect;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      const first = args[0];
      const opts = (Array.isArray(first) ? first[0] : first) as { port?: number } | number;
      ports.push(typeof opts === "number" ? opts : Number(opts?.port));
      return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    });
    const ids = await idsFor("https://pop.gaugeline.dev/", createDnsReader({ resolver }));
    expect(ids).toEqual(["email-spf-missing", "email-dmarc-missing"]);
    expect([...new Set(called)].sort()).toEqual(["resolveMx", "resolveTxt"]);
    expect(ports.filter((p) => [25, 465, 587].includes(p))).toEqual([]);
  });
});

describe("email records: edge cases", () => {
  it("v=spf1 in the middle of another value is not an SPF record", async () => {
    expect(isSpf("google-site-verification=abc v=spf1 -all")).toBe(false);
    expect(isSpf("v=spf10 -all")).toBe(false);
    expect(isSpf("  V=SPF1 -all")).toBe(true);
    expect(
      await idsFor(
        "https://pop.example/",
        fakeReader(
          { "pop.example": ["note: v=spf1 -all"], "_dmarc.pop.example": ["v=DMARC1; p=reject"] },
          { "pop.example": MX },
        ),
      ),
    ).toEqual(["email-spf-missing"]);
  });

  it('a null MX (one record, exchange ".") means the domain receives no email: SPF checks skip', async () => {
    expect(nullMx([{ exchange: ".", priority: 0 }])).toBe(true);
    expect(nullMx([{ exchange: "", priority: 0 }])).toBe(true);
    expect(nullMx(MX)).toBe(false);
    expect(
      await idsFor(
        "https://pop.example/",
        fakeReader(
          { "_dmarc.pop.example": ["v=DMARC1; p=reject"] },
          { "pop.example": [{ exchange: "", priority: 0 }] },
        ),
      ),
    ).toEqual([]);
  });

  it("the address checked is app.example.com: records are read for app.example.com, not a guessed parent", async () => {
    const asked: string[] = [];
    await idsFor("https://app.example.com/login", fakeReader({}, { "app.example.com": MX }, asked));
    expect([...new Set(asked)].sort()).toEqual([
      "MX app.example.com",
      "TXT _dmarc.app.example.com",
      "TXT app.example.com",
    ]);
  });

  it("a DMARC record with p=none and sp=reject is still email-dmarc-none, with the record as published", async () => {
    const p = pageAt("https://pop.example/");
    const dns = fakeReader({
      "_dmarc.pop.example": ["v=DMARC1; p=none; sp=reject; rua=mailto:d@pop.example"],
    });
    expect((await emailDmarcNone.run(p, ctxOf(dns))).map((f) => [f.severity, f.evidence])).toEqual([
      ["low", '_dmarc.pop.example: "v=DMARC1; p=none; sp=reject; rua=mailto:d@pop.example"'],
    ]);
  });

  it("evidence is the record text as published", async () => {
    const dns = fakeReader(
      { "pop.example": ["v=spf1 include:a.example -all", "v=spf1 -all"] },
      { "pop.example": MX },
    );
    const p = pageAt("https://pop.example/");
    expect((await emailSpfMultiple.run(p, ctxOf(dns)))[0]?.evidence).toBe(
      'pop.example has 2 SPF records: "v=spf1 include:a.example -all"; "v=spf1 -all"',
    );
    expect(
      (await emailSpfMissing.run(p, ctxOf(fakeReader({}, { "pop.example": MX }))))[0]?.evidence,
    ).toBe(
      "pop.example receives email (MX mx1.mail.pop.example) and has no TXT record starting v=spf1",
    );
    expect((await emailDmarcMissing.run(p, ctxOf(fakeReader({}))))[0]?.evidence).toBe(
      "no TXT record starting v=DMARC1 at _dmarc.pop.example",
    );
  });
});
