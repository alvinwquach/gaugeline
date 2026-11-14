import { afterEach, describe, expect, it } from "vitest";
import { NetworkError } from "../../errors.js";
import { createFetcher, type Fetcher } from "../../fetcher.js";
import { lazyLinkSample } from "../../links.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { createPageRegistry } from "../index.js";
import { navLinkNot200 } from "../nav-link-not-200.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const ok: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "text/html" }).end("<html><body>page</body></html>");
};
const to =
  (status: number, location: string): Handler =>
  (_req, res) => {
    res.writeHead(status, { location }).end();
  };
const status =
  (code: number): Handler =>
  (_req, res) => {
    res.writeHead(code, { "content-type": "text/html" }).end("");
  };

const nav = (...hrefs: string[]) =>
  `<html><body><header><nav><ul>${hrefs.map((h) => `<li><a href="${h}">Link ${h}</a></li>`).join("")}</ul></nav></header><main><a href="/body-only">Body</a></main></body></html>`;
const pageAt = (origin: string, body: string): PageSnapshot =>
  buildSnapshot([
    { url: `${origin}/`, status: 200, headers: { "content-type": "text/html" }, body, ms: 1 },
  ]);

async function run(
  routes: Record<string, Handler>,
  hrefs: string[],
  opts: { sampled?: boolean; fetcher?: Fetcher } = {},
) {
  const server = await startServer(routes);
  servers.push(server);
  const notes: { url: string; reason: string }[] = [];
  const page = pageAt(server.origin, nav(...hrefs));
  const fetcher = opts.fetcher ?? createFetcher({ allowPrivate: true });
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    fetcher,
    ...(opts.sampled ? { links: lazyLinkSample({ page, fetcher, budget: createBudget() }) } : {}),
  };
  const found = await navLinkNot200.run(page, ctx);
  return { found, notes, server };
}
const asked = (s: FixtureServer) => s.log.map((r) => `${r.method} ${r.path}`);

describe("nav-link-not-200: registration", () => {
  it("is a registered page check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("nav-link-not-200");
  });
});

describe("nav-link-not-200: what passes", () => {
  it("menu links that answer 200 at once, and links through one redirect (links-via-redirect's), pass", async () => {
    const { found, notes } = await run({ "/menu": ok, "/old": to(301, "/new"), "/new": ok }, [
      "/menu",
      "/old",
    ]);
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("never asks for the body links, a method that changes anything, or the same destination twice", async () => {
    const { server } = await run({ "/menu": ok }, ["/menu", "/menu", "/menu#top"]);
    expect(asked(server)).toEqual(["HEAD /menu"]);
  });
});

describe("nav-link-not-200: chains with hop counts", () => {
  it("a menu link that takes two redirects is a finding with the count and every hop", async () => {
    const { found } = await run(
      {
        "/catering": to(301, "/catering/"),
        "/catering/": to(302, "/events"),
        "/events": ok,
        "/menu": ok,
      },
      ["/menu", "/catering"],
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "nav-link-not-200", severity: "medium" });
    expect(found[0]?.evidence).toBe(
      "1 of 2 menu links does not answer 200 at once: header › Link /catering takes 2 redirects (301 /catering, 302 /catering/, 200 /events)",
    );
  });

  it("counts three redirects as three and lists the others by their own text", async () => {
    const { found } = await run(
      {
        "/a": to(301, "/a1"),
        "/a1": to(301, "/a2"),
        "/a2": to(301, "/a3"),
        "/a3": ok,
        "/b": to(301, "/b1"),
        "/b1": to(308, "/b2"),
        "/b2": ok,
      },
      ["/a", "/b"],
    );
    expect(found[0]?.evidence).toContain("2 of 2 menu links");
    expect(found[0]?.evidence).toContain("takes 3 redirects");
    expect(found[0]?.evidence).toContain("takes 2 redirects");
  });
});

describe("nav-link-not-200: other answers", () => {
  it("a 204 is not a page: reported as the status it gave", async () => {
    const { found } = await run({ "/empty": status(204) }, ["/empty"]);
    expect(found[0]?.evidence).toContain("header › Link /empty answers 204, not 200");
  });

  it("a redirect loop is a finding that says so, not a link that did not answer", async () => {
    const { found, notes } = await run({ "/loop": to(302, "/loop2"), "/loop2": to(302, "/loop") }, [
      "/loop",
    ]);
    expect(notes).toEqual([]);
    expect(found[0]?.evidence).toContain("header › Link /loop redirects in a loop");
  });

  it("a 404 that broken-links already reports is left to it; one it never sampled is reported", async () => {
    const withSample = await run({}, ["/gone"], { sampled: true });
    expect(withSample.found).toEqual([]);
    const without = await run({}, ["/gone"]);
    expect(without.found[0]?.evidence).toContain("header › Link /gone answers 404, not 200");
    expect(without.found[0]?.severity).toBe("high");
  });

  it("a refusal (403 or 429) is could-not-check, never a finding", async () => {
    const { found, notes } = await run({ "/members": status(403), "/busy": status(429) }, [
      "/members",
      "/busy",
    ]);
    expect(found).toEqual([]);
    expect(notes.map((n) => n.reason)).toEqual([
      "header › Link /members refused automated readers (403)",
      "header › Link /busy rate limited (429)",
    ]);
  });

  it("a destination that does not answer at all is could-not-check", async () => {
    const down = {
      get: async (url: string) => {
        throw new NetworkError("connection refused", { url });
      },
    } as unknown as Fetcher;
    const { found, notes } = await run({}, ["/menu"], { fetcher: down });
    expect(found).toEqual([]);
    expect(notes[0]?.reason).toBe("the menu link did not answer: header › Link /menu");
  });
});

describe("nav-link-not-200: the requests are shared", () => {
  it("a link the link sample already asked is not asked again", async () => {
    const { server } = await run({ "/menu": ok, "/about": ok }, ["/menu", "/about"], {
      sampled: true,
    });
    expect(asked(server).filter((r) => r.endsWith("/menu"))).toHaveLength(1);
    expect(asked(server).filter((r) => r.endsWith("/about"))).toHaveLength(1);
  });

  it("says how many menu links were not asked when the menu is longer than the allowance", async () => {
    const hrefs = Array.from({ length: 42 }, (_, i) => `/p${i}`);
    const { notes, server } = await run({}, hrefs);
    expect(server.log).toHaveLength(40);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toBe(
      "42 menu links on the page and the check asks the first 40, so 2 were not asked",
    );
  });

  it("asks nothing without a fetcher", async () => {
    expect(
      await navLinkNot200.run(pageAt("https://bake.example", nav("/menu")), {
        warn: () => undefined,
      }),
    ).toEqual([]);
  });
});
