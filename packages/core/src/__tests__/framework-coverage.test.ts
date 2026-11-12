import { describe, expect, it } from "vitest";
import { frameworkCoversPreviewCanonical } from "../framework-coverage.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";

function page(body: string, headers: Record<string, string> = {}): PageSnapshot {
  return buildSnapshot([
    {
      url: "https://fernlight-cafe.example/",
      status: 200,
      headers: { "content-type": "text/html", ...headers },
      body: `<html><head></head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

describe("frameworkCoversPreviewCanonical", () => {
  const covered: [string, PageSnapshot][] = [
    ["Next.js", page("<main>Hi</main>", { "x-powered-by": "Next.js" })],
    ["Astro", page('<astro-island uid="1"></astro-island>')],
    ["SvelteKit", page("<main>Hi</main>", { "x-sveltekit-page": "true" })],
    ["Angular", page('<app-root ng-version="18.2.0"></app-root>')],
    ["Gatsby", page('<div id="___gatsby"></div>')],
    ["Hydrogen", page("<main>Hi</main>", { "powered-by": "Shopify, Hydrogen" })],
    ["Remix", page('<script>window.__reactRouterContext = {"basename":"/","ssr":true};</script>')],
    ["Qwik", page('<html q:container="paused"><body>Hi</body></html>')],
    [
      "SolidStart",
      page(
        '<script>window._$HY||(_$HY={events:[]});</script><script src="/_build/app.js"></script>',
      ),
    ],
    ["Hugo", page('<meta name="generator" content="Hugo 0.121.0">')],
    ["Docusaurus", page('<meta name="generator" content="Docusaurus v3.5.2">')],
  ];

  it.each(covered)("%s: its own pack already reports a preview canonical", (_name, p) => {
    expect(frameworkCoversPreviewCanonical(p)).toBe(true);
  });

  it("a plain page and a page with an unrecognised generator are not covered", () => {
    expect(frameworkCoversPreviewCanonical(page("<main>Hi</main>"))).toBe(false);
    expect(
      frameworkCoversPreviewCanonical(page('<meta name="generator" content="WordPress 6.4">')),
    ).toBe(false);
    expect(frameworkCoversPreviewCanonical(page("<main>Hi</main>", { server: "nginx" }))).toBe(
      false,
    );
  });

  it("a page that only mentions a framework in its text is not covered", () => {
    expect(
      frameworkCoversPreviewCanonical(page("<p>We moved from Gatsby and Astro to plain HTML.</p>")),
    ).toBe(false);
  });
});
