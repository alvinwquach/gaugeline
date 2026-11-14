// check-community: allow-email (an invented mailto link at a reserved example domain, which the discovery must leave out)
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../snapshot.js";
import {
  discoverRoutes,
  displayPath,
  routeFileToPath,
  routePattern,
  withoutQuery,
} from "../routes.js";

describe("routeFileToPath: route files to URL paths", () => {
  it.each([
    // The app router: a route.ts in a folder.
    ["app/api/download/[id]/route.ts", "/api/download/[id]"],
    ["src/app/api/download/[id]/route.ts", "/api/download/[id]"],
    ["app/api/export/route.js", "/api/export"],
    ["app/api/files/orders/route.mjs", "/api/files/orders"],
    ["app/route.ts", "/"],
    ["apps/web/src/app/api/deliver/route.tsx", "/api/deliver"],
    // Route groups and parallel slots are not part of the address.
    ["app/(shop)/api/download/[id]/route.ts", "/api/download/[id]"],
    ["app/(shop)/(members)/download/route.ts", "/download"],
    ["app/@modal/api/download/route.ts", "/api/download"],
    // Catch-all segments stay as they are.
    ["app/api/files/[...path]/route.ts", "/api/files/[...path]"],
    ["app/api/files/[[...path]]/route.ts", "/api/files/[[...path]]"],
    // The pages router: a file under pages/api.
    ["pages/api/download/[id].ts", "/api/download/[id]"],
    ["pages/api/download/index.ts", "/api/download"],
    ["pages/api/export.js", "/api/export"],
    ["src/pages/api/files/[...slug].ts", "/api/files/[...slug]"],
    ["pages/api/files/[[...slug]].ts", "/api/files/[[...slug]]"],
    // Windows separators.
    ["app\\api\\download\\[id]\\route.ts", "/api/download/[id]"],
  ])("%s -> %s", (file, path) => {
    expect(routeFileToPath(file)).toBe(path);
  });

  it.each([
    "app/api/download/[id]/page.tsx",
    "app/api/download/[id]/layout.tsx",
    "app/api/download/_lib/route.ts",
    "app/api/download/route.test.ts",
    "app/api/download/route.d.ts",
    "app/api/download/route.json",
    "pages/download/[id].tsx",
    "pages/index.tsx",
    "pages/api/download/[id].test.ts",
    "components/route.ts",
    "README.md",
  ])("%s is not a route", (file) => {
    expect(routeFileToPath(file)).toBeUndefined();
  });
});

describe("routePattern: a dynamic path matches only concrete addresses", () => {
  it("[id] is one segment", () => {
    const p = routePattern("/api/download/[id]");
    expect(p.test("/api/download/7-day-plan")).toBe(true);
    expect(p.test("/api/download/7-day-plan/extra")).toBe(false);
    expect(p.test("/api/download")).toBe(false);
    expect(p.test("/api/download/")).toBe(false);
  });

  it("[...path] is one or more segments, [[...path]] is none or more", () => {
    const one = routePattern("/api/files/[...path]");
    expect(one.test("/api/files/a")).toBe(true);
    expect(one.test("/api/files/a/b/c.pdf")).toBe(true);
    expect(one.test("/api/files")).toBe(false);
    const any = routePattern("/api/files/[[...path]]");
    expect(any.test("/api/files")).toBe(true);
    expect(any.test("/api/files/a/b")).toBe(true);
  });

  it("a static path matches itself only, and regex characters in it mean nothing", () => {
    const p = routePattern("/api/export.csv");
    expect(p.test("/api/export.csv")).toBe(true);
    expect(p.test("/api/exportXcsv")).toBe(false);
  });
});

function page(html: string, url = "https://tideline-coaching.example/shop/") {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Shop</title></head><body>${html}</body></html>`,
      ms: 1,
    },
  ]);
}

const link = (href: string) => `<a href="${href}">link</a>`;
const SITE = "https://tideline-coaching.example";

describe("discoverRoutes: from links", () => {
  it("takes same-site links whose path says download, file, deliver or export, or sits under /api/", () => {
    const p = page(
      [
        "/api/download/7-day-plan",
        "/account/downloads",
        "/files/guide",
        "/deliver/order-1",
        "/export",
        "/api/anything",
        "/about",
        "/shop/running-plan",
      ]
        .map(link)
        .join(""),
    );
    const d = discoverRoutes(p, []);
    expect(d.found.map((a) => displayPath(a))).toEqual([
      "/account/downloads",
      "/api/anything",
      "/api/download/7-day-plan",
      "/deliver/order-1",
      "/export",
      "/files/guide",
    ]);
  });

  it("leaves out other sites, mailto, tel, fragments and framework addresses", () => {
    const p = page(
      [
        "https://cdn.example/download/plan",
        "mailto:coach@tideline-coaching.example?subject=download",
        "tel:+15550100",
        "#download",
        "/_next/static/chunks/download.js",
        "/download?_rsc=abc",
      ]
        .map(link)
        .join(""),
    );
    expect(discoverRoutes(p, []).found).toEqual([]);
  });

  it("treats a link to a static file as a file, not a route", () => {
    const p = page(
      ["/files/menu.pdf", "/downloads/plan.zip", "/api/download/plan.pdf"].map(link).join(""),
    );
    expect(discoverRoutes(p, []).found.map(displayPath)).toEqual(["/api/download/plan.pdf"]);
  });

  it("does not ask a link that carries its own signature and expiry", () => {
    const p = page(link("/api/download/plan?Expires=1999999999&Signature=abc123"));
    const d = discoverRoutes(p, []);
    expect(d.found).toEqual([]);
    expect(d.notProbed).toEqual([{ path: "/api/download/plan", reason: "signed" }]);
  });

  it("removes repeats and sorts, so the same page gives the same routes every run", () => {
    const a = page(
      [link("/api/download/b"), link("/api/download/a"), link("/api/download/b#top")].join(""),
    );
    const b = page([link("/api/download/a"), link("/api/download/b")].join(""));
    expect(discoverRoutes(a, []).found).toEqual(discoverRoutes(b, []).found);
    expect(discoverRoutes(a, []).found).toEqual([
      `${SITE}/api/download/a`,
      `${SITE}/api/download/b`,
    ]);
  });
});

describe("discoverRoutes: from route files", () => {
  const empty = page("<p>No links.</p>");

  it("asks a static route file's address", () => {
    const d = discoverRoutes(empty, ["app/api/export/route.ts"]);
    expect(d.found).toEqual([`${SITE}/api/export`]);
  });

  it("only routes whose path says download, file, deliver or export are asked", () => {
    const d = discoverRoutes(empty, [
      "app/api/export/route.ts",
      "app/api/cron/purge/route.ts",
      "app/api/stripe/webhook/route.ts",
    ]);
    expect(d.found).toEqual([`${SITE}/api/export`]);
  });

  it("asks a dynamic route only for the concrete addresses seen in links", () => {
    const p = page([link("/api/download/7-day-plan"), link("/api/download/beach-class")].join(""));
    const d = discoverRoutes(p, ["app/api/download/[id]/route.ts"]);
    expect(d.found).toEqual([
      `${SITE}/api/download/7-day-plan`,
      `${SITE}/api/download/beach-class`,
    ]);
    expect(d.notProbed).toEqual([]);
  });

  it("lists a dynamic route with no concrete address as not probed, and never guesses an id", () => {
    const d = discoverRoutes(empty, ["app/api/download/[id]/route.ts"]);
    expect(d.found).toEqual([]);
    expect(d.notProbed).toEqual([{ path: "/api/download/[id]", reason: "no-address" }]);
  });

  it("a catch-all is asked for a deep address that was seen", () => {
    const p = page(link("/api/files/clients/tideline/plan.pdf"));
    const d = discoverRoutes(p, ["app/api/files/[...path]/route.ts"]);
    expect(d.found).toEqual([`${SITE}/api/files/clients/tideline/plan.pdf`]);
  });

  it("a static route is not asked bare when a link already gives its address with a query", () => {
    const p = page(link("/api/download?file=7-day-plan"));
    const d = discoverRoutes(p, ["app/api/download/route.ts"]);
    expect(d.found).toEqual([`${SITE}/api/download?file=7-day-plan`]);
  });

  it("merges the two sources into one set", () => {
    const p = page(link("/api/export"));
    const d = discoverRoutes(p, ["pages/api/export.ts", "app/api/export/route.ts"]);
    expect(d.found).toEqual([`${SITE}/api/export`]);
  });

  it("files that are not routes are ignored", () => {
    expect(discoverRoutes(empty, ["app/page.tsx", "README.md"]).found).toEqual([]);
  });
});

describe("addresses are shown as paths, never with a query string", () => {
  it("displayPath and withoutQuery drop the query and fragment", () => {
    expect(displayPath(`${SITE}/api/download/plan?token=abc#x`)).toBe("/api/download/plan");
    expect(withoutQuery(`${SITE}/api/download/plan?token=abc#x`)).toBe(`${SITE}/api/download/plan`);
  });
});
