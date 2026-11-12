import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import type { ImageSettings } from "../../images/config.js";
import type { CheckContext } from "../../model.js";
import { PROBING_CHECKS } from "../../presets.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer, type Handler } from "../../__tests__/helpers/server.js";
import { createPageRegistry } from "../index.js";
import { imageOptimizerAllowlistUnanchored } from "../image-optimizer-allowlist-unanchored.js";
import { imageOptimizerAllowlistWide } from "../image-optimizer-allowlist-wide.js";
import { NO_CONSENT_REASON, imageOptimizerOpen } from "../image-optimizer-open.js";

/**
 * Open image optimizers (XF-04, ADR-0007). Harbour Lane Books is an invented bookshop whose
 * Next.js site resizes its covers through /_next/image. The passive checks read the settings files
 * given; the probing check sends one GET per optimizer to the site's own origin, only with consent
 * and only with the address the owner chose.
 */

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const PROBE = "https://photos.example-gallery.test/probe.png?token=abc123";
const GIF = "GIF89a" + "x".repeat(3000);
const image: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "image/gif" }).end(GIF);
};
const answer =
  (code: number, headers: Record<string, string> = {}, body = "no"): Handler =>
  (_req, res) => {
    res.writeHead(code, { "content-type": "text/plain", ...headers }).end(body);
  };

const COVER = "/_next/image?url=%2Fcovers%2Ftide.jpg&w=640&q=75";
function pageAt(
  origin: string,
  body = `<img src="${COVER}" alt="Tide and Thistle">`,
): PageSnapshot {
  return buildSnapshot([
    {
      url: `${origin}/`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Harbour Lane Books</title></head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

async function open(
  routes: Record<string, Handler>,
  extra: Partial<CheckContext> = {},
  body?: string,
  settings: ImageSettings = { settings: [], probeUrl: PROBE },
) {
  const server = await startServer(routes);
  servers.push(server);
  const notes: { url: string; reason: string }[] = [];
  const fetcher = createFetcher({ allowPrivate: true });
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => notes.push({ url, reason }),
    fetcher,
    ownerConsent: true,
    imageSettings: settings,
    ...extra,
  };
  const found = await imageOptimizerOpen.run(pageAt(server.origin, body), ctx);
  const gets = server.log.filter((r) => r.path.startsWith("/_"));
  return { found, notes, server, gets, fetcher, ctx };
}

describe("image-optimizer-open: integration", () => {
  it("an optimizer that answers 200 with an image is a finding, after exactly one GET", async () => {
    const { found, gets, server } = await open({ "/_next/image": image });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "image-optimizer-open",
      severity: "high",
      url: `${server.origin}/_next/image`,
    });
    expect(found[0]?.evidence).toContain("photos.example-gallery.test/probe.png");
    expect(gets).toHaveLength(1);
    expect(gets[0]?.method).toBe("GET");
    expect(gets[0]?.path).toBe(`/_next/image?url=${encodeURIComponent(PROBE)}&w=640&q=75`);
  });

  it("the query string and the body never reach the finding", async () => {
    const { found } = await open({ "/_next/image": image });
    const text = JSON.stringify(found);
    expect(text).not.toContain("token=abc123");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("GIF89a");
  });

  it.each([400, 403, 404])("%i is a pass: the optimizer refused an unlisted host", async (code) => {
    const { found, notes } = await open({ "/_next/image": answer(code) });
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
  });

  it.each([
    ["500", answer(500)],
    ["429", answer(429)],
    ["a redirect, not followed", answer(302, { location: "/elsewhere" })],
    ["200 with a web page", answer(200, { "content-type": "text/html" }, "<!doctype html><html>")],
    [
      "200 with an image type but not an image",
      answer(200, { "content-type": "image/png" }, "hello"),
    ],
  ])("%s is could not check, not a finding", async (_name, handler) => {
    const { found, notes, server } = await open({
      "/_next/image": handler,
      "/elsewhere": image,
    });
    expect(found).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toContain("does not say whether it is open");
    expect(server.log.filter((r) => r.path === "/elsewhere")).toHaveLength(0);
  });

  it("without consent it asks nothing and says why", async () => {
    const { found, notes, gets } = await open({ "/_next/image": image }, { ownerConsent: false });
    expect(found).toEqual([]);
    expect(gets).toHaveLength(0);
    expect(notes[0]?.reason).toBe(NO_CONSENT_REASON);
  });

  it("with consent but no probe address it asks nothing and says so", async () => {
    const { found, notes, gets } = await open({ "/_next/image": image }, {}, undefined, {
      settings: [],
    });
    expect(found).toEqual([]);
    expect(gets).toHaveLength(0);
    expect(notes[0]?.reason).toContain("imageOptimizerProbeUrl");
  });

  it.each([
    "http://photos.example-gallery.test/p.png",
    "https://127.0.0.1/p.png",
    "https://169.254.169.254/latest/meta-data/",
    "https://images.harbour-lane.example/p.png",
  ])("a probe address that is refused (%s) sends nothing", async (probeUrl) => {
    const { found, notes, gets } = await open(
      { "/_next/image": image },
      {},
      `<img src="${COVER}"><img src="/_next/image?url=https%3A%2F%2Fimages.harbour-lane.example%2Fa.jpg&w=640&q=75">`,
      { settings: [], probeUrl },
    );
    expect(found).toEqual([]);
    expect(gets).toHaveLength(0);
    expect(notes).toHaveLength(1);
  });

  it("the site's own host is refused", async () => {
    const server = await startServer({ "/_next/image": image });
    servers.push(server);
    const fetcher = createFetcher({ allowPrivate: true });
    const notes: string[] = [];
    const found = await imageOptimizerOpen.run(pageAt(server.origin), {
      warn: () => undefined,
      couldNotCheck: (_u, r) => notes.push(r),
      fetcher,
      ownerConsent: true,
      imageSettings: {
        settings: [],
        probeUrl: `https://127.0.0.1:${new URL(server.origin).port}/p.png`,
      },
    });
    expect(found).toEqual([]);
    expect(notes[0]).toContain("IP address");
    expect(server.log).toHaveLength(0);
  });

  it("two optimizers on one page are two requests, never three, and a second page adds none", async () => {
    const body = `<img src="${COVER}"><img src="/_image?href=%2Fa.png&w=300&f=webp"><img src="/_next/image?url=%2Fb.jpg&w=1080&q=75">`;
    const server = await startServer({ "/_next/image": image, "/_image": answer(400) });
    servers.push(server);
    const fetcher = createFetcher({ allowPrivate: true });
    const ctx: CheckContext = {
      warn: () => undefined,
      couldNotCheck: () => undefined,
      fetcher,
      ownerConsent: true,
      imageSettings: { settings: [], probeUrl: PROBE },
    };
    const first = await imageOptimizerOpen.run(pageAt(server.origin, body), ctx);
    const second = await imageOptimizerOpen.run(pageAt(server.origin, body), ctx);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(server.log.filter((r) => r.path.startsWith("/_"))).toHaveLength(2);
    expect(server.log.every((r) => r.method === "GET")).toBe(true);
  });

  it("a page with no optimizer sends nothing", async () => {
    const { found, notes, server } = await open({}, {}, `<img src="/cover.jpg" alt="">`);
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
    expect(server.log).toHaveLength(0);
  });

  it("an address with no width gives no probe: Gaugeline does not guess one", async () => {
    const { found, notes, gets } = await open(
      { "/_next/image": image },
      {},
      `<img src="/_next/image?url=%2Fa.jpg">`,
    );
    expect(found).toEqual([]);
    expect(gets).toHaveLength(0);
    expect(notes[0]?.reason).toContain("no width");
  });

  it("a body bigger than the peek is not read past it", async () => {
    const big: Handler = (_req, res) => {
      res.writeHead(200, { "content-type": "image/gif" });
      res.write(GIF);
      res.end("x".repeat(2_000_000));
    };
    const { found } = await open({ "/_next/image": big });
    expect(found).toHaveLength(1);
  });

  it("is a registered probing check", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toEqual(
      expect.arrayContaining([
        "image-optimizer-open",
        "image-optimizer-allowlist-wide",
        "image-optimizer-allowlist-unanchored",
      ]),
    );
    expect(PROBING_CHECKS).toContain("image-optimizer-open");
    expect(PROBING_CHECKS).not.toContain("image-optimizer-allowlist-wide");
  });
});

describe("image-optimizer-allowlist-wide and -unanchored: integration", () => {
  const files = (file: string, text: string): ImageSettings => ({ settings: [{ file, text }] });
  const wide = `module.exports = { images: { remotePatterns: [{ protocol: "https", hostname: "**" }] } };`;
  const toml = `[images]\n  remote_images = ["https://images\\\\.harbour-lane\\\\.example/.*"]\n`;

  async function run(check: typeof imageOptimizerAllowlistWide, settings?: ImageSettings) {
    const server = await startServer({});
    servers.push(server);
    const notes: { url: string; reason: string }[] = [];
    const ctx: CheckContext = {
      warn: () => undefined,
      couldNotCheck: (url, reason) => notes.push({ url, reason }),
      ...(settings ? { imageSettings: settings } : {}),
    };
    const found = await check.run(pageAt(server.origin), ctx);
    return { found, notes, server };
  }

  it("a wildcard host in next.config is a finding that names the file and the line, with no request", async () => {
    const { found, server } = await run(imageOptimizerAllowlistWide, files("next.config.js", wide));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "image-optimizer-allowlist-wide", severity: "high" });
    expect(found[0]?.evidence).toContain("next.config.js line 1");
    expect(server.log).toHaveLength(0);
  });

  it("a tight list is no finding", async () => {
    const tight = `module.exports = { images: { remotePatterns: [{ protocol: "https", hostname: "images.harbour-lane.example" }] } };`;
    const { found, notes } = await run(imageOptimizerAllowlistWide, files("next.config.js", tight));
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("an optimizer on the page and no settings given is could not check, and nothing is requested", async () => {
    const { found, notes, server } = await run(imageOptimizerAllowlistWide);
    expect(found).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.url).toBe(`${server.origin}/_next/image`);
    expect(notes[0]?.reason).toContain("not visible from the page");
    expect(server.log).toHaveLength(0);
  });

  it("a page with no optimizer and no settings says nothing", async () => {
    const server = await startServer({});
    servers.push(server);
    const notes: string[] = [];
    const found = await imageOptimizerAllowlistWide.run(
      pageAt(server.origin, `<img src="/a.jpg">`),
      { warn: () => undefined, couldNotCheck: (_u, r) => notes.push(r) },
    );
    expect([found, notes]).toEqual([[], []]);
  });

  it("an unanchored Netlify expression is medium and is not also called wide", async () => {
    const settings = files("netlify.toml", toml);
    const un = await run(imageOptimizerAllowlistUnanchored, settings);
    const wd = await run(imageOptimizerAllowlistWide, settings);
    expect(un.found).toHaveLength(1);
    expect(un.found[0]).toMatchObject({ severity: "medium" });
    expect(un.found[0]?.evidence).toContain("netlify.toml line 2");
    expect(wd.found).toEqual([]);
  });

  it("a setting is reported once for the run, whichever page reaches it first", async () => {
    const server = await startServer({});
    servers.push(server);
    const ctx: CheckContext = {
      warn: () => undefined,
      imageSettings: files("next.config.js", wide),
    };
    const a = await imageOptimizerAllowlistWide.run(pageAt(server.origin), ctx);
    const b = await imageOptimizerAllowlistWide.run(pageAt(server.origin), ctx);
    expect([a.length, b.length]).toEqual([1, 0]);
  });

  it("are not probing checks: they run without consent", () => {
    expect(PROBING_CHECKS).not.toContain("image-optimizer-allowlist-unanchored");
  });
});
