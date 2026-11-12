import { describe, expect, it } from "vitest";
import { frameworkCoversDevTools } from "../framework-dev-tools.js";
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

const VITE = '<script type="module" src="/@vite/client"></script>';

describe("frameworkCoversDevTools", () => {
  const covered: [string, PageSnapshot][] = [
    ["Angular", page(`<app-root ng-version="18.2.0"></app-root>${VITE}`)],
    ["Astro", page(`<astro-island uid="1"></astro-island>${VITE}`)],
    ["SvelteKit", page(`<main>Hi</main>${VITE}`, { "x-sveltekit-page": "true" })],
    ["Hydrogen", page(`<main>Hi</main>${VITE}`, { "powered-by": "Shopify, Hydrogen" })],
    [
      "Gatsby",
      page(
        '<div id="___gatsby"></div><script src="/commons.js"></script><script src="/framework.js"></script>',
      ),
    ],
    [
      "Remix",
      page(`<script>window.__reactRouterContext = {"basename":"/","ssr":true};</script>${VITE}`),
    ],
    [
      "Nuxt",
      page(
        '<script type="module" src="/_nuxt/@vite/client"></script><script src="/_nuxt/entry.js"></script>',
      ),
    ],
    ["Qwik", page('<html q:container="paused" q:render="ssr-dev"><body>Hi</body></html>')],
    [
      "SolidStart",
      page(
        '<script>window._$HY||(_$HY={events:[]});</script><script src="/_build/@fs/app/entry-client.tsx"></script>',
      ),
    ],
    [
      "Eleventy",
      page(
        '<meta name="generator" content="Eleventy v3.0.0"><script src="/.11ty/reload-client.js"></script>',
      ),
    ],
  ];

  it.each(covered)("%s: its own pack reports the dev tools on this page", (_name, p) => {
    expect(frameworkCoversDevTools(p)).toBe(true);
  });

  it("a plain page with the Vite client is not covered", () => {
    expect(frameworkCoversDevTools(page(`<main>Hi</main>${VITE}`))).toBe(false);
  });

  it("a page of an unknown framework is not covered", () => {
    expect(
      frameworkCoversDevTools(
        page(`<meta name="generator" content="Zola 0.19"><main>Hi</main>${VITE}`),
      ),
    ).toBe(false);
  });

  it("a framework page the pack finds nothing wrong on is not covered, so the generic check still reads it", () => {
    expect(frameworkCoversDevTools(page('<app-root ng-version="18.2.0"></app-root>'))).toBe(false);
    expect(frameworkCoversDevTools(page('<astro-island uid="1"></astro-island>'))).toBe(false);
    expect(frameworkCoversDevTools(page("<main>Hi</main>", { "x-sveltekit-page": "true" }))).toBe(
      false,
    );
  });

  it("a Next.js page has no pack check of its own, so it is never covered", () => {
    expect(
      frameworkCoversDevTools(page(`<main>Hi</main>${VITE}`, { "x-powered-by": "Next.js" })),
    ).toBe(false);
  });
});
