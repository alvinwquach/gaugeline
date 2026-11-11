import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../../adapters/config.js";
import { detectAdapters, matchDetection, signsOf } from "../hints.js";
import { ADAPTER_ENTRIES } from "../../adapters/entries.generated.js";
import { createFetcher } from "../../fetcher.js";
import { costConfigSchema } from "../../cost/config.js";
import { handoffConfigSchema } from "../../handoff/config.js";
import { listingsConfigSchema } from "../../listings/config.js";
import { paymentsConfigSchema } from "../../payments/types.js";
import { html, worldTransport, type SiteDef } from "../../advisory/__tests__/world.js";
import { planInit, NOTES_FILE } from "../plan.js";
import { renderInit } from "../render.js";
import { detectStack, LINKED_PAGES, type StackReport } from "../stack.js";

/**
 * Invented sites, answered from memory. Every site is an invented client of an invented freelancer: a bar, a
 * clinic, a bakery. The detection hints in the entry files were written from what each platform is known to leave
 * in a page and have not been compared with real builds: each hint has a row here, and a wrong one only means a
 * suggestion that is not made.
 */
const SITE = "harbour-bar.example";

const nav = (...paths: string[]): string =>
  `<nav>${paths.map((p) => `<a href="${p}">${p}</a>`).join("")}</nav>`;

const page = (head: string, body = "", scripts: string[] = []): string =>
  html({ head, body: `<h1>Harbour Bar</h1>${body}`, scripts });

async function detect(site: SiteDef, opts: { dns?: string[] } = {}) {
  const world = worldTransport({ [SITE]: site });
  const fetcher = createFetcher({ transport: world.transport });
  const report = await detectStack({
    fetcher,
    address: SITE,
    ...(opts.dns
      ? {
          dns: {
            txt: () => Promise.resolve([]),
            mx: () => Promise.resolve([]),
            ns: () => Promise.resolve(opts.dns ?? []),
          },
        }
      : {}),
  });
  return { report, world };
}

describe("adapter entries: detect hints", () => {
  const signs = (over: Record<string, string> = {}, markup = "") =>
    signsOf(`<!doctype html><head>${markup}</head>`, `https://${SITE}/`, over);

  const rows: [string, string, Record<string, string>][] = [
    ["wordpress", '<meta name="generator" content="WordPress 6.6">', {}],
    ["wordpress", '<link rel="stylesheet" href="/wp-content/themes/x/style.css">', {}],
    ["wordpress", "", { Link: '<https://harbour-bar.example/wp-json/>; rel="https://api.w.org/"' }],
    ["webflow", '<meta name="generator" content="Webflow">', {}],
    [
      "webflow",
      '<link rel="stylesheet" href="https://cdn.prod.website-files.com/abc/css/x.css">',
      {},
    ],
    ["framer", '<meta name="generator" content="Framer 4f2a">', {}],
    ["framer", '<script src="https://framerusercontent.com/sites/abc/chunk.mjs"></script>', {}],
    ["wix", '<meta name="generator" content="Wix.com Website Builder">', {}],
    ["wix", '<script src="https://static.parastorage.com/services/x.js"></script>', {}],
    ["wix", "", { "X-Wix-Request-Id": "abc" }],
    ["contentful", '<img src="https://images.ctfassets.net/space/abc/menu.jpg">', {}],
    ["sanity", '<img src="https://cdn.sanity.io/images/abc123xy/production/menu-1x1.jpg">', {}],
    ["squarespace", '<meta name="generator" content="Squarespace 7.1">', {}],
    ["duda", '<img src="https://irp.cdn-website.com/abc/x.jpg">', {}],
  ];
  it.each(rows)("%s is seen from its own sign", (id, markup, headers) => {
    expect(detectAdapters(signs(headers, markup)).map((s) => s.id)).toContain(id);
  });

  it("says why, in a line a person can check", () => {
    const [hit] = detectAdapters(signs({}, '<meta name="generator" content="WordPress 6.6">'));
    expect(hit).toEqual({
      id: "wordpress",
      name: "WordPress",
      evidence: 'generator tag "WordPress 6.6"',
    });
  });

  it("is never fooled by a link to the platform or a word in the text", () => {
    const s = signsOf(
      `<head></head><body><a href="https://webflow.com/">Made in Webflow</a><p>wp-content</p><a href="https://cdn.sanity.io/x">x</a></body>`,
      `https://${SITE}/`,
      {},
    );
    expect(detectAdapters(s)).toEqual([]);
  });

  it("gives the same list for the same page, in the entries' order", () => {
    const s = signs(
      {},
      '<meta name="generator" content="WordPress 6.6"><img src="https://cdn.sanity.io/images/abc123xy/p/a.jpg"><img src="https://images.ctfassets.net/a.jpg">',
    );
    const a = detectAdapters(s).map((x) => x.id);
    expect(a).toEqual(["contentful", "sanity", "wordpress"]);
    expect(detectAdapters(s).map((x) => x.id)).toEqual(a);
  });

  it("every detect hint is lower case, and only built entries have one", () => {
    const withHints = ADAPTER_ENTRIES.filter((e) => e.detect);
    expect(withHints.map((e) => e.id)).toEqual(
      expect.arrayContaining([
        "wordpress",
        "webflow",
        "framer",
        "wix",
        "contentful",
        "sanity",
        "squarespace",
      ]),
    );
    for (const e of withHints) {
      expect(e.status).toBe("built");
      const d = e.detect;
      for (const v of [
        ...(d?.generator ?? []),
        ...(d?.hosts ?? []),
        ...(d?.paths ?? []),
        ...Object.keys(d?.headers ?? {}),
        ...Object.values(d?.headers ?? {}),
      ])
        expect(v, `${e.id}: ${v}`).toBe(v.toLowerCase());
    }
  });

  it("a hint list with nothing in it matches nothing", () => {
    expect(matchDetection({}, signs())).toBeUndefined();
  });
});

describe("detectStack: what a bar's WordPress site shows", () => {
  const bar: SiteDef = {
    headers: { "x-powered-by": "WP Engine", server: "nginx" },
    routes: {
      "/": page(
        `<meta name="generator" content="WordPress 6.6"><link rel="stylesheet" href="/wp-content/themes/harbour/style.css">`,
        nav(
          "/menu/",
          "/book/",
          "/wp-login.php",
          "/wp-admin/",
          "/files/menu.pdf",
          "/events/",
          "/a/",
          "/b/",
        ) +
          `<a href="https://buy.stripe.com/harbourtable1">Pay a deposit</a>` +
          `<a href="https://www.yelp.com/biz/harbour-bar-testville">Reviews</a>`,
        ["https://www.googletagmanager.com/gtag/js?id=G-HARBOUR01"],
      ),
      "/menu/": page(`<meta name="generator" content="WordPress 6.6">`),
      "/book/": page(
        "",
        `<form action="https://formspree.io/f/xharbour1" method="post"><input name="email"></form>`,
      ),
      "/events/": page(""),
      "/a/": page(""),
      "/b/": page(""),
    },
  };

  it("names the CMS, the host, the form, the payment, the analytics and the listing, each with its evidence", async () => {
    const { report } = await detect(bar);
    expect(report.adapters.map((a) => [a.id, a.evidence])).toEqual([
      ["wordpress", 'generator tag "WordPress 6.6" on the home page'],
    ]);
    expect(report.hosting).toMatchObject({ name: "WP Engine" });
    expect(report.forms).toEqual([
      { id: "formspree", name: "Formspree", evidence: "a form on /book/" },
    ]);
    expect(report.payments).toEqual([
      expect.objectContaining({
        kind: "stripe-link",
        value: expect.stringContaining("buy.stripe.com/harbourtable1"),
      }),
    ]);
    expect(report.analytics.map((a) => a.id)).toContain("ga4");
    expect(report.listings.map((l) => l.id)).toEqual(["yelp"]);
    expect(report.yelpBusiness).toBe("harbour-bar-testville");
  });

  it("reads the home page and at most four linked pages, and never a login, an admin screen or a file", async () => {
    const { report, world } = await detect(bar);
    expect(report.pages).toEqual(["/", "/menu/", "/book/", "/events/", "/a/"]);
    expect(report.pages.length).toBe(LINKED_PAGES + 1);
    const asked = world.seen.map((r) => new URL(r.url).pathname);
    expect(asked.sort()).toEqual(["/", "/a/", "/book/", "/events/", "/menu/"]);
    for (const bad of [
      "/wp-login.php",
      "/wp-admin/",
      "/files/menu.pdf",
      "/wp-json/",
      "/.env",
      "/robots.txt",
    ])
      expect(asked).not.toContain(bad);
  });

  it("sends only GET or HEAD, and nothing else", async () => {
    const { world } = await detect(bar);
    expect(world.seen.length).toBeGreaterThan(0);
    for (const r of world.seen) expect(["GET", "HEAD"]).toContain(r.method);
    expect(world.osvSeen).toEqual([]);
  });

  it("names the DNS host with --dns, and says it did not read DNS without it", async () => {
    const withDns = await detect(bar, { dns: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] });
    expect(withDns.report.dns).toMatchObject({ name: "Cloudflare" });
    const without = await detect(bar);
    expect(without.report.dns).toBeUndefined();
    expect(without.report.notes.join(" ")).toMatch(/--dns/);
  });

  it("gives the same report twice", async () => {
    expect(JSON.stringify((await detect(bar)).report)).toBe(
      JSON.stringify((await detect(bar)).report),
    );
  });

  it("leaves out a linked page that fails, and says so", async () => {
    const { report } = await detect({
      routes: { "/": page("", nav("/gone/", "/menu/")), "/menu/": page("") },
    });
    expect(report.pages).toEqual(["/", "/menu/"]);
    expect(report.notes.join(" ")).toMatch(/\/gone\/ did not give a page/);
  });

  it("fails with a message when the site cannot be reached", async () => {
    const world = worldTransport({});
    await expect(
      detectStack({
        fetcher: createFetcher({ transport: world.transport }),
        address: "nowhere.example",
      }),
    ).rejects.toThrow(/could not be reached/);
  });
});

describe("detectStack: one fixture site per content system", () => {
  const cases: [string, string, string][] = [
    ["wordpress", `<meta name="generator" content="WordPress 6.6">`, ""],
    [
      "webflow",
      `<meta name="generator" content="Webflow"><link rel="stylesheet" href="https://cdn.prod.website-files.com/a.css">`,
      "",
    ],
    ["framer", `<meta name="generator" content="Framer abc">`, ""],
    ["wix", `<script src="https://static.parastorage.com/a.js"></script>`, ""],
    ["contentful", "", `<img src="https://images.ctfassets.net/s/a/menu.jpg" alt="">`],
    [
      "sanity",
      "",
      `<img src="https://cdn.sanity.io/images/abc123xy/production/menu-100x100.jpg" alt="">`,
    ],
    ["squarespace", `<meta name="generator" content="Squarespace 7.1">`, ""],
  ];
  it.each(cases)("%s", async (id, head, body) => {
    const { report } = await detect({ routes: { "/": page(head, body) } });
    expect(report.adapters.map((a) => a.id)).toEqual([id]);
    const plan = planInit(report, SITE);
    const adapters = plan.files.find((f) => f.name === "gaugeline.adapters.json");
    expect(adaptersConfigSchema.parse(JSON.parse(adapters?.text ?? "{}")).adapters[0]?.id).toBe(id);
  });

  it("reads a Sanity project id from an image address, and writes it to the handoff settings", async () => {
    const { report } = await detect({
      routes: {
        "/": page(
          "",
          `<img src="https://cdn.sanity.io/images/abc123xy/production/a-1x1.jpg" alt="">`,
        ),
      },
    });
    expect(report.sanityProjectId).toBe("abc123xy");
    const handoff = planInit(report, SITE).files.find((f) => f.name === "gaugeline.handoff.json");
    expect(handoffConfigSchema.parse(JSON.parse(handoff?.text ?? "{}"))).toEqual({
      sanity: { projectId: "abc123xy" },
    });
  });

  it("detects Next.js on Vercel and writes the pages the cost check visits", async () => {
    const { report } = await detect({
      headers: { server: "Vercel", "x-vercel-id": "lhr1::abc", "x-powered-by": "Next.js" },
      routes: { "/": page("", nav("/menu", "/events")), "/menu": page(""), "/events": page("") },
    });
    expect(report.framework?.name).toBe("Next.js");
    expect(report.hosting?.name).toBe("Vercel");
    const cost = planInit(report, SITE).files.find((f) => f.name === "gaugeline.cost.json");
    expect(costConfigSchema.parse(JSON.parse(cost?.text ?? "{}"))).toEqual({
      pages: ["/menu", "/events"],
    });
  });
});

describe("planInit", () => {
  const bareSite: SiteDef = { routes: { "/": page("") } };

  it("a site with nothing detectable gets a minimal config: the sitemap adapter and the notes", async () => {
    const { report } = await detect(bareSite);
    const plan = planInit(report, SITE);
    expect(plan.files.map((f) => f.name)).toEqual(["gaugeline.adapters.json", NOTES_FILE]);
    expect(JSON.parse(plan.files[0]?.text ?? "")).toEqual({ adapters: [{ id: "sitemap-feed" }] });
    expect(plan.envVars).toEqual([]);
    expect(plan.next[0]?.command).toBe(`npx gaugeline ${SITE}`);
    expect(renderInit({ report, plan, dryRun: true, wrote: [] })).toContain(
      "Nothing it could name",
    );
  });

  const rich = async (): Promise<StackReport> =>
    (
      await detect({
        headers: { "x-powered-by": "WP Engine" },
        routes: {
          "/": page(
            `<meta name="generator" content="WordPress 6.6">`,
            `<a href="https://buy.stripe.com/harbourtable1">Pay</a><a href="https://www.yelp.com/biz/harbour-bar-testville">Yelp</a>`,
          ),
        },
      })
    ).report;

  it("every settings file it writes is accepted by the schema Gaugeline reads it with", async () => {
    const plan = planInit(await rich(), SITE);
    const by = (n: string) => JSON.parse(plan.files.find((f) => f.name === n)?.text ?? "null");
    expect(adaptersConfigSchema.safeParse(by("gaugeline.adapters.json")).success).toBe(true);
    expect(paymentsConfigSchema.safeParse(by("gaugeline.payments.json")).success).toBe(true);
    expect(listingsConfigSchema.safeParse(by("gaugeline.listings.json")).success).toBe(true);
  });

  it("names the environment variables to set, and writes none of their values", async () => {
    const plan = planInit(await rich(), SITE);
    expect(plan.envVars.map((v) => v.name)).toEqual(
      expect.arrayContaining([
        "WORDPRESS_URL",
        "WORDPRESS_USER",
        "WORDPRESS_APP_PASSWORD",
        "YELP_API_KEY",
      ]),
    );
    const all = plan.files.map((f) => f.text).join("\n");
    expect(all).toContain("WORDPRESS_APP_PASSWORD");
    // No file has a line that assigns a value to a variable name, and none holds a key-shaped string.
    expect(all).not.toMatch(/[A-Z][A-Z_]{3,}\s*=\s*\S/);
    expect(all).not.toMatch(/\b(?:sk|pk|rk)_(?:live|test)_/);
    for (const f of plan.files.filter((x) => x.name.endsWith(".json")))
      expect(f.text, f.name).not.toMatch(/token|password|secret|apikey/i);
  });

  it("is deterministic: the same report gives the same text, in the same order", async () => {
    const report = await rich();
    expect(planInit(report, SITE)).toEqual(planInit(report, SITE));
    const out = renderInit({
      report,
      plan: planInit(report, SITE),
      dryRun: true,
      wrote: [],
    });
    expect(out).toBe(renderInit({ report, plan: planInit(report, SITE), dryRun: true, wrote: [] }));
  });

  it("orders the next steps by value: the first check first, the handoff last, a docs page for each", async () => {
    const { next } = planInit(await rich(), SITE);
    expect(next[0]?.title).toMatch(/first check/);
    expect(next.at(-1)?.command).toBe(`npx gaugeline handoff ${SITE}`);
    for (const n of next) expect(n.docs).toMatch(/^https:\/\/gaugeline\.dev\/docs\//);
  });

  it("--dry-run prints every file and says nothing was written", async () => {
    const report = await rich();
    const text = renderInit({
      report,
      plan: planInit(report, SITE),
      dryRun: true,
      wrote: [],
    });
    expect(text).toContain("nothing was written");
    expect(text).toContain("--- gaugeline.adapters.json ---");
    expect(text).toContain('"id": "wordpress"');
  });
});
