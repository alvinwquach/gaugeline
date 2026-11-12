import { describe, expect, it } from "vitest";
import { createDrupalAdapter } from "../../adapters/drupal.js";
import { readDrupal, type DrupalReading } from "../../adapters/drupal-read.js";
import {
  DRUPAL_MARKERS,
  DRUPAL_SITE,
  FERNLEA,
  PAGES_CLOSED,
  PAGES_LEAK,
  drupalTransport,
  type DrupalFixtureNode,
  type DrupalFixtureOptions,
} from "../../adapters/__tests__/drupal-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import type { AdapterSettings } from "../../adapters/types.js";
import { DRUPAL_CHECKS, createDrupalRegistry, drupalUnpublishedReachable } from "../drupal.js";

const KEY = testKey("drupal-checks");
const SETTINGS: AdapterSettings = {
  id: "drupal",
  urls: { "node--article": "/news/{id}", "node--page": "/pages/{id}" },
  readUnpublished: true,
};

async function reading(
  content: readonly DrupalFixtureNode[],
  options: {
    fixture?: DrupalFixtureOptions;
    settings?: AdapterSettings;
    env?: Record<string, string>;
    consent?: boolean;
    maxPages?: number;
    wrap?: (t: Transport) => Transport;
  } = {},
): Promise<{ reading: DrupalReading; seen: { method: string; url: string; auth?: string }[] }> {
  const seen: { method: string; url: string; auth?: string }[] = [];
  const base = drupalTransport(content, {
    credential: { kind: "bearer", token: KEY },
    ...options.fixture,
  });
  const inner = options.wrap ? options.wrap(base) : base;
  const transport: Transport = (url, req) => {
    seen.push({
      method: req.method,
      url: url.href,
      ...(req.headers.authorization !== undefined ? { auth: req.headers.authorization } : {}),
    });
    return inner(url, req);
  };
  const fetcher = createFetcher({ transport, timeoutMs: 5000 });
  const adapter = createDrupalAdapter({
    env: { DRUPAL_URL: DRUPAL_SITE, DRUPAL_TOKEN: KEY, ...options.env },
    fetcher,
    settings: options.settings ?? SETTINGS,
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readDrupal({
      adapter,
      fetcher,
      ownerConsent: options.consent ?? true,
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    }),
    seen,
  };
}

const run = (r: DrupalReading) => runChecks(r, createDrupalRegistry());
const ID = "drupal-unpublished-reachable";
const said = (o: Awaited<ReturnType<typeof run>>): string =>
  o.couldNotCheck.map((c) => c.reason).join("\n");

describe("the Drupal check: a clinic whose unpublished node can be opened", () => {
  it("is a probing check in its own registry, with the plain sentences the checks reference needs", () => {
    expect(DRUPAL_CHECKS.map((c) => c.id)).toEqual([ID]);
    expect(
      createDrupalRegistry()
        .all()
        .map((c) => c.id),
    ).toEqual([ID]);
    expect(drupalUnpublishedReachable.tech).toContain("probing check, off without --owner-consent");
    expect(drupalUnpublishedReachable.tech).toContain(
      "only on sites you own or have permission to test",
    );
  });

  it("finds the unpublished node that answers a visitor, and only it", async () => {
    const { reading: r } = await reading(FERNLEA, { fixture: { pages: PAGES_LEAK } });
    const out = await run(r);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "node--article: node 3 is not published in Drupal and /node/3 answers a visitor 200",
    ]);
    expect(out.findings[0]?.url).toBe(`${DRUPAL_SITE}/node/3`);
    expect(out.findings[0]?.severity).toBe("high");
    expect(out.passed).not.toContain(ID);
    expect(JSON.stringify(out)).not.toContain(DRUPAL_MARKERS.staff);
    for (const marker of Object.values(DRUPAL_MARKERS))
      expect(JSON.stringify(r)).not.toContain(marker);
  });

  it("a clinic where Drupal says no to every unpublished node passes", async () => {
    const { reading: r } = await reading(FERNLEA, { fixture: { pages: PAGES_CLOSED } });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([]);
    expect(out.passed).toEqual([ID]);
  });

  it("asks a visitor for the unpublished nodes' pages only: GET, no credential, no published node", async () => {
    const { seen } = await reading(FERNLEA, { fixture: { pages: PAGES_LEAK } });
    const pages = seen.filter((s) => new URL(s.url).pathname.startsWith("/node/"));
    expect(pages.map((s) => new URL(s.url).pathname).sort()).toEqual([
      "/node/3",
      "/node/4",
      "/node/6",
    ]);
    for (const p of pages) {
      expect(p.method).toBe("GET");
      expect(p.auth).toBeUndefined();
    }
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    // The credential goes to the JSON:API, for the lists and the recheck, in a header and never in an address.
    for (const s of seen.filter((s) => s.auth !== undefined)) {
      expect(new URL(s.url).pathname.startsWith("/jsonapi/")).toBe(true);
      expect(s.auth).toBe(`Bearer ${KEY}`);
    }
    expect(seen.some((s) => s.url.includes(KEY))).toBe(false);
  });
});

describe("the Drupal check: the probing gate", () => {
  it("without --owner-consent nothing is asked and the check says why", async () => {
    const { reading: r, seen } = await reading(FERNLEA, { consent: false });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.passed).not.toContain(ID);
    expect(said(out)).toContain("--owner-consent");
    expect(said(out)).toContain("only on sites you own or have permission to test");
  });

  it("without the readUnpublished entry nothing is asked, whatever the consent", async () => {
    const { reading: r, seen } = await reading(FERNLEA, {
      settings: { id: "drupal", urls: { "node--article": "/news/{id}" } },
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.passed).not.toContain(ID);
    expect(said(out)).toContain('"readUnpublished": true');
  });

  it("without a credential nothing is asked, and a published read needs none", async () => {
    const { reading: r, seen } = await reading(FERNLEA, { env: { DRUPAL_TOKEN: "" } });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.passed).not.toContain(ID);
    expect(said(out)).toContain("needs a credential");
  });

  it("no type named: nothing is asked and the check is could-not-check, never a pass", async () => {
    const { reading: r, seen } = await reading(FERNLEA, {
      settings: { id: "drupal", readUnpublished: true },
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.passed).not.toContain(ID);
    expect(said(out)).toContain("No type is named");
  });

  it("a credential that cannot be used is could-not-check with the reason, and nothing is asked", async () => {
    const { reading: r, seen } = await reading(FERNLEA, {
      env: { DRUPAL_TOKEN: `${KEY} with a space` },
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.passed).not.toContain(ID);
    expect(said(out)).toContain("not a token");
    expect(said(out)).not.toContain(KEY);
  });
});

describe("the Drupal check: every part that cannot be checked is named, and none is a pass", () => {
  it("a 403 that is not Drupal's (a firewall) is could-not-check for that node", async () => {
    const { reading: r } = await reading(FERNLEA, {
      fixture: { pages: { ...PAGES_CLOSED, 3: { status: 403, drupal: false } } },
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(said(out)).toContain("nothing in the answer says Drupal sent it");
    expect(out.passed).not.toContain(ID);
  });

  it("a 200 that does not say Drupal sent it (a front end's own route) is could-not-check, not a finding", async () => {
    const { reading: r } = await reading(FERNLEA, {
      fixture: { pages: { ...PAGES_CLOSED, 3: { status: 200, drupal: false } } },
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(said(out)).toContain("nothing in the answer says Drupal sent it");
  });

  it("a 404 that is Drupal's is closed; a 401, a 500 and a login redirect are not answers", async () => {
    const { reading: r } = await reading(FERNLEA, {
      fixture: {
        pages: {
          ...PAGES_CLOSED,
          3: { status: 404 },
          4: { status: 500 },
          6: { status: 302, location: "/user/login?destination=/node/6" },
        },
      },
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(said(out)).toContain("the site answered 500");
    expect(said(out)).toContain("/user/login");
    expect(out.passed).not.toContain(ID);
  });

  it("a redirect to another host is never followed to an answer", async () => {
    const { reading: r, seen } = await reading(FERNLEA, {
      fixture: {
        pages: { ...PAGES_CLOSED, 3: { status: 301, location: "https://evil.example/node/3" } },
      },
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(said(out)).toContain("another site");
    expect(seen.some((s) => new URL(s.url).host === "evil.example")).toBe(false);
  });

  it("a redirect to the node's alias that Drupal then closes is a closed node", async () => {
    const { reading: r } = await reading(FERNLEA, {
      fixture: { pages: { ...PAGES_CLOSED, 3: { status: 301, location: "/news/staff-changes" } } },
      wrap: (t) => (url, req) =>
        url.pathname === "/news/staff-changes" ? t(new URL("/node/4", url), req) : t(url, req),
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(said(out)).not.toContain("node 3");
  });

  it("a node published while the check ran is not a finding", async () => {
    let calls = 0;
    const { reading: r } = await reading(FERNLEA, {
      fixture: { pages: PAGES_LEAK },
      wrap: (t) => (url, req) => {
        // The recheck of node 3 sees it published: someone clicked Publish in between.
        if (
          url.pathname === "/jsonapi/node/article/5f1c0a10-0000-4000-8000-000000000003" &&
          calls++ >= 0
        )
          return t(url, req).then(async (res) => {
            const chunks: Buffer[] = [];
            for await (const c of res.body) chunks.push(Buffer.from(c as Buffer));
            const text = Buffer.concat(chunks)
              .toString()
              .replace('"status":false', '"status":true');
            return {
              ...res,
              body: (await import("node:stream")).Readable.from([Buffer.from(text)]),
            };
          });
        return t(url, req);
      },
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(said(out)).toContain("published while the check ran");
    expect(out.passed).not.toContain(ID);
  });

  it("an open node that Drupal will not confirm is unpublished is could-not-check", async () => {
    const { reading: r } = await reading(FERNLEA, {
      fixture: { pages: PAGES_LEAK },
      wrap: (t) => (url, req) =>
        url.pathname === "/jsonapi/node/article/5f1c0a10-0000-4000-8000-000000000003"
          ? t(new URL("/jsonapi/node/article/5f1c0a10-0000-4000-8000-0000000000ff", url), req)
          : t(url, req),
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(said(out)).toContain("would not confirm it is unpublished");
  });

  it("a credential that lists no unpublished node is could-not-check (its role may not view them), never a pass", async () => {
    const { reading: r, seen } = await reading(FERNLEA, { fixture: { seesUnpublished: false } });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).not.toContain(ID);
    expect(said(out)).toContain("lists no unpublished node");
    expect(seen.some((s) => new URL(s.url).pathname.startsWith("/node/"))).toBe(false);
  });

  it("a type that is not a node type is named and not asked; a type the credential cannot read is named", async () => {
    const { reading: r } = await reading(FERNLEA, {
      settings: {
        ...SETTINGS,
        urls: { "node--article": "/n/{id}", "taxonomy_term--tags": "/t/{id}" },
      },
    });
    const out = await run(r);
    expect(said(out)).toContain(
      "taxonomy_term--tags: not checked, only nodes have a page at /node/ID",
    );
    const denied = await reading(FERNLEA, {
      wrap: (t) => (url, req) =>
        url.pathname.endsWith("/page")
          ? t(new URL("/jsonapi/node/nothing", url), req)
          : t(url, req),
    });
    expect(said(await run(denied.reading))).toContain(
      "node--page: Drupal would not give the unpublished nodes",
    );
  });

  it("more unpublished nodes than a run asks about are counted as not asked", async () => {
    const many: DrupalFixtureNode[] = Array.from({ length: 120 }, (_x, i) => ({
      ...FERNLEA[2]!,
      id: `5f1c0a10-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`,
      nid: 1000 + i,
    }));
    const { reading: r } = await reading(many, {
      settings: { id: "drupal", urls: { "node--article": "/n/{id}" }, readUnpublished: true },
      fixture: { pages: Object.fromEntries(many.map((m) => [m.nid, { status: 403 }])) },
    });
    const out = await run(r);
    expect(r.pages).toHaveLength(100);
    expect(said(out)).toContain("more unpublished nodes than a run asks about");
    expect(out.passed).not.toContain(ID);
  });

  it("the page budget is a bound, and the nodes beyond it are named", async () => {
    const { reading: r } = await reading(FERNLEA, {
      maxPages: 2,
      fixture: { pages: PAGES_CLOSED },
    });
    const out = await run(r);
    expect(r.pages).toHaveLength(2);
    expect(said(out)).toContain("1 page was not asked for, because a run asks for at most 2");
    expect(out.passed).not.toContain(ID);
  });

  it("a rate limit that stays ends the read and says the result is partial", async () => {
    const { reading: r } = await reading(FERNLEA, {
      wrap: (t) => {
        let n = 0;
        return (url, req) => {
          if (n++ >= 1)
            return Promise.resolve({
              status: 429,
              headers: { "retry-after": "3600" },
              body: (async function* () {
                yield Buffer.from("{}");
              })() as never,
            });
          return t(url, req);
        };
      },
    });
    const out = await run(r);
    expect(r.partial?.reason).toBe("rate-limited");
    expect(said(out)).toContain("slow down");
    expect(out.passed).not.toContain(ID);
  });

  it("a Drupal address that is not usable is could-not-check with the reason, and nothing is asked", async () => {
    const { reading: r, seen } = await reading(FERNLEA, {
      env: { DRUPAL_URL: "ftp://nope.example" },
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(said(out)).toContain("DRUPAL_URL");
    expect(out.passed).not.toContain(ID);
  });
});
