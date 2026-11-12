import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import type { ScriptRead } from "../../scripts.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { devToolsInProduction } from "../dev-tools-in-production.js";

const ORIGIN = "https://fennel-lane.example";
const page = (body: string) =>
  buildSnapshot([
    { url: `${ORIGIN}/`, status: 200, headers: { "content-type": "text/html" }, body, ms: 1 },
  ]);
const file = (path: string, text: string): ScriptRead => ({
  url: `${ORIGIN}${path}`,
  status: 200,
  text,
  truncated: false,
});
const ctxOf = (scripts: ScriptRead[]): CheckContext => ({
  warn: () => undefined,
  scripts: async () => scripts,
});

describe("dev-tools-in-production: unit", () => {
  it("a Vite dev client in the page is a fix-first finding naming the marker and the place", async () => {
    const out = await devToolsInProduction.run(
      page('<html><script type="module" src="/@vite/client"></script><main>Hi</main></html>'),
      ctxOf([]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      checkId: "dev-tools-in-production",
      severity: "high",
      evidence: "Vite dev client (/@vite/client) in the page",
    });
  });

  const VITE = '<script type="module" src="/@vite/client"></script>';

  it.each([
    ["Angular", `<app-root ng-version="18.2.0"></app-root>${VITE}`],
    ["Astro", `<astro-island uid="1"></astro-island>${VITE}`],
    [
      "Eleventy",
      '<meta name="generator" content="Eleventy v3.0.0"><script src="/.11ty/reload-client.js"></script>',
    ],
  ])("a %s page whose own dev-tools check reports it is left to that check", async (_n, markup) => {
    const out = await devToolsInProduction.run(
      page(`<html>${markup}<main>Hi</main></html>`),
      ctxOf([]),
    );
    expect(out).toEqual([]);
  });

  it("a framework page the pack finds nothing on still gets the generic read of its bundles", async () => {
    const out = await devToolsInProduction.run(
      page('<html><app-root ng-version="18.2.0"></app-root><main>Hi</main></html>'),
      ctxOf([file("/a.js", 'const u="http://127.0.0.1:4010/api"')]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toContain("127.0.0.1:4010");
  });

  it("a plain site and a Next.js site with the Vite client still get the finding", async () => {
    const html = `<html>${VITE}<main>Hi</main></html>`;
    expect(await devToolsInProduction.run(page(html), ctxOf([]))).toHaveLength(1);
    const next = buildSnapshot([
      {
        url: `${ORIGIN}/`,
        status: 200,
        headers: { "content-type": "text/html", "x-powered-by": "Next.js" },
        body: html,
        ms: 1,
      },
    ]);
    expect(await devToolsInProduction.run(next, ctxOf([]))).toHaveLength(1);
  });

  it("an address on the developer's machine in a bundle is fix soon, by host and port only", async () => {
    const out = await devToolsInProduction.run(
      page("<html><main>Hi</main></html>"),
      ctxOf([file("/a.js", 'const u="http://127.0.0.1:4010/api/orders?key=abc"')]),
    );
    expect(out[0]).toMatchObject({
      severity: "medium",
      evidence: "127.0.0.1:4010 (an address on the visitor's own machine) in /a.js",
    });
    expect(JSON.stringify(out)).not.toContain("key=abc");
  });

  it("a development build of React served as a file is read from its address", async () => {
    const out = await devToolsInProduction.run(
      page('<html><script src="https://cdn.example/react.development.js"></script></html>'),
      ctxOf([]),
    );
    expect(out[0]?.evidence).toBe("React development build in the page");
  });

  it("several markers are one finding, at most six listed, the rest counted", async () => {
    const body =
      '<script src="/@vite/client"></script><script>import "/@react-refresh"; "/__webpack_hmr"; "webpack-dev-server/client"; "webpack-internal:///x"; "Download the React DevTools for a better development experience"; NODE_ENV:"development"; "/_next/static/development/"</script>';
    const out = await devToolsInProduction.run(page(body), ctxOf([]));
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toMatch(/ and 2 more$/);
  });

  it("a clean page and clean files pass, and a page on loopback is not flagged for its own address", async () => {
    const clean = page("<html><main>Fresh bread</main></html>");
    expect(await devToolsInProduction.run(clean, ctxOf([file("/a.js", "x();")]))).toEqual([]);
    const own = buildSnapshot([
      {
        url: "http://127.0.0.1:9000/",
        status: 200,
        headers: { "content-type": "text/html" },
        body: '<a href="http://127.0.0.1:9000/menu">Menu</a>',
        ms: 1,
      },
    ]);
    expect(await devToolsInProduction.run(own, ctxOf([]))).toEqual([]);
  });

  it("a script cut at the size cap is could not check, not a pass", async () => {
    const unchecked: string[] = [];
    const ctx: CheckContext = {
      ...ctxOf([{ ...file("/a.js", "x();"), truncated: true }]),
      couldNotCheck: (url) => void unchecked.push(url),
    };
    await devToolsInProduction.run(page("<html></html>"), ctx);
    expect(unchecked).toEqual([`${ORIGIN}/a.js`]);
  });
});

describe("dev-tools-in-production: integration (the source-maps fixture)", () => {
  it("the page imports /@react-refresh and a bundle holds an API address on port 4010", async () => {
    const site = await startFixture("source-maps");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: ["dev-tools-in-production"],
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        [
          "dev-tools-in-production",
          "high",
          "React Refresh (/@react-refresh) in the page; 127.0.0.1:4010 (an address on the visitor's own machine) in /assets/app-4c9d.js",
        ],
      ]);
      // Nothing dev-only was asked for: the page's own addresses are never guessed at.
      expect([...site.hits.keys()].filter((k) => k.startsWith("/@"))).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});
