import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { EMAIL_PRESET, LAUNCH_PRESET } from "../../presets.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { createPageRegistry } from "../index.js";
import { TEMP_HOST_SUFFIXES, isTemporaryHost } from "../launch/hosts.js";
import { ogImageBroken } from "../og-image-broken.js";
import { stagingIndexable } from "../staging-indexable.js";
import { tempHostCanonical } from "../temp-host-canonical.js";
import { tempHostLinks } from "../temp-host-links.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function page(url: string, head = "", body = ""): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head>${head}</head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

/** A resolver that knows no names: an unmapped host never reaches real DNS. */
const nowhere = async (): Promise<never> => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND (test)"), { code: "ENOTFOUND" });
};

function ctxFor(hosts: Record<string, string>): CheckContext {
  return {
    warn: () => undefined,
    fetcher: createFetcher({ hosts, allowPrivate: true, resolver: nowhere }),
    budget: createBudget(),
  };
}

const send =
  (status: number, body: string, headers: Record<string, string> = {}) =>
  (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { "content-type": "text/html", ...headers }).end(body);
  };

describe("launch: unit", () => {
  it("isTemporaryHost: project.vercel.app, site.netlify.app and x.pages.dev; not vercel.com or example.app", () => {
    for (const h of ["project.vercel.app", "site.netlify.app", "x.pages.dev", "A-B.Vercel.App."])
      expect(isTemporaryHost(h), h).toBe(true);
    for (const h of [
      "vercel.com",
      "example.app",
      "vercel.app",
      "notvercel.app",
      "pages.dev.example",
    ])
      expect(isTemporaryHost(h), h).toBe(false);
    expect(Object.isFrozen(TEMP_HOST_SUFFIXES)).toBe(true);
  });

  it("LAUNCH_PRESET names no id twice, and every registered id resolves in the registry", () => {
    expect(new Set(LAUNCH_PRESET).size).toBe(LAUNCH_PRESET.length);
    const ids = new Set(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    );
    for (const id of [
      "temp-host-links",
      "temp-host-canonical",
      "og-image-broken",
      "staging-indexable",
      "noindex",
      "robots-block",
      "stripe-test-mode",
    ])
      expect(ids.has(id) && LAUNCH_PRESET.includes(id), id).toBe(true);
    expect(EMAIL_PRESET.every((id) => ids.has(id))).toBe(true);
  });
});

describe("launch: integration", () => {
  it("a custom-domain page linking to a vercel.app address: temp-host-links with the href as evidence", async () => {
    const p = page(
      "https://thistle.example/",
      "",
      '<a href="https://thistle-git-main-team.vercel.app/menu">Menu</a> <a href="/about">About</a> <a href="https://vercel.com/">Hosted by</a>',
    );
    const out = await tempHostLinks.run(p, { warn: () => undefined });
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      ["high", "1 link to a temporary address: https://thistle-git-main-team.vercel.app/menu"],
    ]);
  });

  it("og:image pointing at a 404 is og-image-broken; no og:image at all passes (og-image-missing reports that)", async () => {
    const server = await startServer({ "/og.png": send(404, "not found") });
    servers.push(server);
    const ctx = ctxFor({});
    const broken = page(
      `${server.origin}/`,
      `<meta property="og:image" content="${server.origin}/og.png">`,
    );
    expect((await ogImageBroken.run(broken, ctx)).map((f) => [f.severity, f.evidence])).toEqual([
      ["medium", `og:image ${server.origin}/og.png returned 404`],
    ]);
    expect(ctx.budget?.summary().images).toEqual({ limit: 20, sampled: 1, found: 1 });
    expect(await ogImageBroken.run(page(`${server.origin}/`), ctxFor({}))).toEqual([]);
  });

  it("the staging host answers 200 with X-Robots-Tag: noindex: no finding; without it, staging-indexable", async () => {
    const hidden = await startServer({
      "/": send(200, "<title>Staging</title>", { "x-robots-tag": "noindex" }),
    });
    const open = await startServer({ "/": send(200, "<title>Staging</title>") });
    servers.push(hidden, open);
    const p = page("http://www.thistle.test/");
    expect(
      await stagingIndexable.run(p, ctxFor({ "staging.thistle.test": `127.0.0.1:${hidden.port}` })),
    ).toEqual([]);
    const found = await stagingIndexable.run(
      p,
      ctxFor({ "staging.thistle.test": `127.0.0.1:${open.port}` }),
    );
    expect(found.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "high",
        "http://staging.thistle.test/ answers 200 with no noindex in meta robots or X-Robots-Tag",
      ],
    ]);
    // A meta robots noindex hides it too.
    const meta = await startServer({
      "/": send(200, '<meta name="robots" content="noindex, nofollow">'),
    });
    servers.push(meta);
    expect(
      await stagingIndexable.run(p, ctxFor({ "staging.thistle.test": `127.0.0.1:${meta.port}` })),
    ).toEqual([]);
  });

  it("temp-host-canonical: a page served from a temporary host with no canonical tag", async () => {
    const bare = page("https://thistle-git-main-team.vercel.app/");
    expect(
      (await tempHostCanonical.run(bare, { warn: () => undefined })).map((f) => f.evidence),
    ).toEqual(["served from thistle-git-main-team.vercel.app with no canonical tag"]);
    const tagged = page(
      "https://thistle-git-main-team.vercel.app/",
      '<link rel="canonical" href="https://thistle.example/">',
    );
    expect(await tempHostCanonical.run(tagged, { warn: () => undefined })).toEqual([]);
    expect(
      await tempHostCanonical.run(page("https://thistle.example/"), { warn: () => undefined }),
    ).toEqual([]);
  });
});

describe("launch: edge cases", () => {
  it("the site being checked IS a vercel.app address: its own links are not temp-host-links", async () => {
    const p = page(
      "https://thistle-git-main-team.vercel.app/",
      "",
      '<a href="https://thistle-git-main-team.vercel.app/menu">Menu</a> <a href="https://other.netlify.app/">Friend</a>',
    );
    expect(await tempHostLinks.run(p, { warn: () => undefined })).toEqual([]);
  });

  it("staging.<domain> does not resolve: a pass, and no error", async () => {
    expect(await stagingIndexable.run(page("https://thistle.test/"), ctxFor({}))).toEqual([]);
  });

  it("staging is not asked about for an IP address, a temporary host or a staging host itself", async () => {
    let asked = 0;
    const ctx: CheckContext = {
      warn: () => undefined,
      budget: createBudget(),
      fetcher: {
        get: async () => {
          asked += 1;
          return [];
        },
        getSite: async () => [],
        stats: { requests: 0, maxInFlight: 0 },
      },
    };
    for (const url of [
      "http://127.0.0.1:4000/",
      "https://x.vercel.app/",
      "https://staging.thistle.example/",
    ])
      expect(await stagingIndexable.run(page(url), ctx)).toEqual([]);
    expect(asked).toBe(0);
  });

  it("og:image on a domain that is not live yet (connection refused): og-image-broken, not a crash", async () => {
    const server = await startServer({});
    const port = server.port;
    await server.close();
    const p = page(
      "http://thistle.test/",
      `<meta property="og:image" content="http://cdn.thistle.test/og.png">`,
    );
    const out = await ogImageBroken.run(p, ctxFor({ "cdn.thistle.test": `127.0.0.1:${port}` }));
    expect(out.map((f) => f.evidence)).toEqual([
      "og:image http://cdn.thistle.test/og.png could not be reached",
    ]);
  });
});
