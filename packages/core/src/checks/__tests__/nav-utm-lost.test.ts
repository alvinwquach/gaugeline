import { afterEach, describe, expect, it } from "vitest";
import { NetworkError } from "../../errors.js";
import { createFetcher, type Fetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { navTargets, NAV_TAGS } from "../../nav/probe.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { createPageRegistry } from "../index.js";
import { navUtmLost } from "../nav-utm-lost.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const ok: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "text/html" }).end("<html><body>page</body></html>");
};
/** A redirect that keeps the whole query string, one that drops it, one that keeps only utm_source. */
const keeps =
  (to: string): Handler =>
  (req, res) => {
    const q = new URL(req.url ?? "/", "http://x").search;
    res.writeHead(301, { location: `${to}${q}` }).end();
  };
const drops =
  (to: string): Handler =>
  (_req, res) => {
    res.writeHead(301, { location: to }).end();
  };
const onlySource =
  (to: string): Handler =>
  (req, res) => {
    const src = new URL(req.url ?? "/", "http://x").searchParams.get("utm_source") ?? "";
    res.writeHead(302, { location: `${to}?utm_source=${src}` }).end();
  };

const pageAt = (origin: string, body: string): PageSnapshot =>
  buildSnapshot([
    { url: `${origin}/`, status: 200, headers: { "content-type": "text/html" }, body, ms: 1 },
  ]);
const nav = (...hrefs: string[]) =>
  `<html><body><header><nav><ul>${hrefs.map((h) => `<li><a href="${h}">Link ${h}</a></li>`).join("")}</ul></nav></header><main><a href="/body-only">Body</a></main></body></html>`;

async function run(
  routes: Record<string, Handler>,
  html: (origin: string) => string,
  extra: Partial<CheckContext> = {},
) {
  const server = await startServer(routes);
  servers.push(server);
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    fetcher: createFetcher({ allowPrivate: true }),
    ...extra,
  };
  const found = await navUtmLost.run(pageAt(server.origin, html(server.origin)), ctx);
  return { found, notes, server };
}

describe("nav-utm-lost: registration and reading the menu", () => {
  it("is a registered page check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("nav-utm-lost");
    expect(navUtmLost.severity).toBe("medium");
  });

  it("takes header and footer links of the same site, header first, each once, never the body", () => {
    const page = pageAt(
      "https://bake.example",
      `<html><body><footer><a href="/privacy">Privacy</a><a href="/menu">Menu again</a></footer>
      <header><nav><a href="/menu">Menu</a><a href="/menu#top">Menu top</a><a href="https://other.example/x">Away</a><a href="tel:+15550100">Mail</a><a href="/about">About</a></nav></header>
      <main><a href="/blog">Blog</a></main></body></html>`,
    );
    const t = navTargets(page);
    expect(t.taken.map((x) => x.url)).toEqual([
      "https://bake.example/menu",
      "https://bake.example/about",
      "https://bake.example/privacy",
    ]);
    expect(t.taken[0]?.where).toBe("header › Menu");
    expect(t.seen).toBe(3);
  });

  it("stops at the stated allowance and says how many there were", () => {
    const links = Array.from({ length: 45 }, (_, i) => `/p${i}`);
    const t = navTargets(pageAt("https://bake.example", nav(...links)));
    expect(t.taken).toHaveLength(40);
    expect(t.taken[39]?.url).toBe("https://bake.example/p39");
    expect(t.seen).toBe(45);
  });
});

describe("nav-utm-lost: what is asked", () => {
  it("asks each menu destination once with the test tags added, HEAD first, and never the body link", async () => {
    const { server } = await run({ "/menu": ok, "/about": ok }, () => nav("/menu", "/about"));
    const asked = server.log.map((r) => `${r.method} ${r.path}`);
    const query = new URLSearchParams(NAV_TAGS).toString();
    expect(asked.sort()).toEqual([`HEAD /about?${query}`, `HEAD /menu?${query}`].sort());
    expect(server.log.every((r) => r.method === "GET" || r.method === "HEAD")).toBe(true);
    expect(asked.join(" ")).not.toContain("body-only");
  });

  it("asks again with GET when a server refuses HEAD", async () => {
    const { server, found } = await run(
      {
        "/menu": (req, res) => {
          if (req.method === "HEAD") res.writeHead(405).end();
          else void ok(req, res);
        },
      },
      () => nav("/menu"),
    );
    expect(found).toEqual([]);
    expect(server.log.map((r) => r.method)).toEqual(["HEAD", "GET"]);
  });

  it("adds the tags after a query the link already has and leaves its own utm keys alone", async () => {
    const { server } = await run({ "/menu": ok }, () => nav("/menu?lang=en&utm_source=newsletter"));
    const q = new URL(`http://x${server.log[0]?.path}`).searchParams;
    expect(q.get("lang")).toBe("en");
    expect(q.get("utm_source")).toBe("newsletter");
    expect(q.get("utm_medium")).toBe("menu-test");
  });

  it("asks nothing without a fetcher", async () => {
    const found = await navUtmLost.run(pageAt("https://bake.example", nav("/menu")), {
      warn: () => undefined,
    });
    expect(found).toEqual([]);
  });
});

describe("nav-utm-lost: what it reports", () => {
  it("passes when no redirect is involved and when a redirect keeps every tag", async () => {
    const { found, notes } = await run(
      { "/menu": ok, "/shop": keeps("/shop/all"), "/shop/all": ok },
      () => nav("/menu", "/shop"),
    );
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("reports the hop and the tags a redirect drops, with the test tags named as Gaugeline's own", async () => {
    const { found } = await run({ "/catering": drops("/events"), "/events": ok, "/menu": ok }, () =>
      nav("/menu", "/catering"),
    );
    expect(found).toHaveLength(1);
    const f = found[0];
    expect(f?.checkId).toBe("nav-utm-lost");
    expect(f?.severity).toBe("medium");
    expect(f?.evidence).toContain("1 of 2 menu links");
    expect(f?.evidence).toContain(
      "header › Link /catering: the 301 at hop 1 from /catering to /events drops utm_source, utm_medium, utm_campaign",
    );
    expect(f?.evidence).toContain("gaugeline-check");
    expect(f?.url).toMatch(/\/$/);
  });

  it("a redirect that keeps only some tags names the ones it drops", async () => {
    const { found } = await run({ "/a": onlySource("/b"), "/b": ok }, () => nav("/a"));
    expect(found[0]?.evidence).toContain("drops utm_medium, utm_campaign");
    expect(found[0]?.evidence).not.toContain("drops utm_source");
  });

  it("a long list is cut with the rest counted", async () => {
    const routes: Record<string, Handler> = {};
    const hrefs = ["/a", "/b", "/c", "/d", "/e"];
    for (const h of hrefs) {
      routes[h] = drops(`${h}-new`);
      routes[`${h}-new`] = ok;
    }
    const { found } = await run(routes, () => nav(...hrefs));
    expect(found[0]?.evidence).toContain("5 of 5 menu links");
    expect(found[0]?.evidence).toContain("and 2 more");
  });

  it("a menu link that ends in an error is not a tag finding: only the tags are judged", async () => {
    const { found } = await run({}, () => nav("/missing"));
    expect(found).toEqual([]);
  });

  it("a refusal (403) is could-not-check, never a finding", async () => {
    const { found, notes } = await run(
      {
        "/members": (_req, res) => {
          res.writeHead(403).end();
        },
      },
      () => nav("/members"),
    );
    expect(found).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toContain("refused automated readers (403)");
  });

  it("a destination that does not answer is could-not-check", async () => {
    const down = {
      get: async (url: string) => {
        throw new NetworkError("connection refused", { url });
      },
    } as unknown as Fetcher;
    const { found, notes } = await run({}, () => nav("/menu"), { fetcher: down });
    expect(found).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toBe("the menu link did not answer: header › Link /menu");
  });

  it("a redirect loop is could-not-check with its own reason, not a link that did not answer", async () => {
    const { found, notes } = await run({ "/loop": drops("/loop2"), "/loop2": drops("/loop") }, () =>
      nav("/loop"),
    );
    expect(found).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toBe(
      "header › Link /loop redirects in a loop, so its tags were not followed to a page",
    );
  });

  it("says how many menu links were not asked when the page has more than the allowance", async () => {
    const hrefs = Array.from({ length: 42 }, (_, i) => `/p${i}`);
    const { notes, server } = await run({}, () => nav(...hrefs));
    expect(server.log).toHaveLength(40);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toBe(
      "42 menu links on the page and the check asks the first 40, so 2 were not asked",
    );
  });

  it("a page with no menu links asks nothing and reports nothing", async () => {
    const { found, notes, server } = await run({}, () => "<html><body><p>hi</p></body></html>");
    expect([found, notes, server.log]).toEqual([[], [], []]);
  });
});
