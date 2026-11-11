import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import {
  MAX_STATE_CHARS,
  analogFunctions,
  analogPageEndpoints,
  devMarkers,
  errorMarkers,
  isAngularSite,
  readStateScripts,
  serverContext,
  visibleText,
} from "../../angular/detect.js";
import { createFetcher } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { angularAnalogEndpointsListed } from "../angular-analog-endpoints-listed.js";
import { angularDevToolsPublic } from "../angular-dev-tools-public.js";
import { angularPreviewCanonical } from "../angular-preview-canonical.js";
import { angularSsrError200 } from "../angular-ssr-error-200.js";
import { angularStatePrivateFields } from "../angular-state-private-fields.js";

const ANGULAR_CHECKS = [
  "angular-dev-tools-public",
  "angular-preview-canonical",
  "angular-state-private-fields",
  "angular-ssr-error-200",
  "angular-analog-endpoints-listed",
];

function page(body: string, opts: { truncated?: boolean; url?: string; status?: number } = {}) {
  return buildSnapshot([
    {
      url: opts.url ?? "https://harbourside.example/",
      status: opts.status ?? 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
      ...(opts.truncated ? { truncated: true } : {}),
    },
  ]);
}
/** The transfer-state script the way Angular writes it: JSON, with "<" and "/" escaped. */
const state = (value: unknown, id = "ng-state") =>
  `<script id="${id}" type="application/json">${JSON.stringify(value).replace(/</g, "\\u003C").replace(/\//g, "\\u002F")}</script>`;
const ANGULAR = '<html><body><app-root ng-version="19.2.0" ngh="0">Hi</app-root></body></html>';
const calls: string[] = [];
const ctx: CheckContext = {
  warn: () => undefined,
  budget: createBudget(),
  couldNotCheck: (_url, reason) => calls.push(reason),
};

describe("angular: unit", () => {
  it("an Angular site is recognised from its HTML, and a plain page is not", () => {
    expect(isAngularSite(page(ANGULAR))).toBe(true);
    expect(isAngularSite(page('<app-root ng-server-context="ssr"></app-root>'))).toBe(true);
    expect(isAngularSite(page(state({ a: 1 })))).toBe(true);
    expect(isAngularSite(page(state({ a: 1 }, "serverApp-state")))).toBe(true);
    expect(isAngularSite(page("<html><body>Plain ng-version mention</body></html>"))).toBe(false);
    expect(isAngularSite(page(state({ a: 1 }, "other")))).toBe(false);
    expect(serverContext('<app-root ng-server-context="ssr-analog">')).toBe("ssr-analog");
  });

  it("transfer state gives field names and kinds, never values", () => {
    const html = state({
      clinic: { name: "Harbourside", open: true },
      list: [{ id: 1 }, { id: 2 }],
      none: null,
      h1: {
        b: { slot: "09:00" },
        h: {},
        s: 200,
        st: "OK",
        u: "http://127.0.0.1/api/x",
        rt: "json",
      },
    });
    const read = readStateScripts(html);
    expect(read.found).toBe(1);
    expect(read.fields.map((f) => `${f.name}:${f.kind}`)).toEqual([
      "clinic.name:string",
      "clinic.open:boolean",
      "list[].id:number",
      "list[].id:number",
      "none:null",
      "http-cache[0].slot:string",
    ]);
    expect(JSON.stringify(read)).not.toContain("Harbourside");
    expect(JSON.stringify(read)).not.toContain("09:00");
  });

  it("dev markers, errors and Analog endpoints are read from the HTML", () => {
    expect(
      devMarkers('<script type="module" src="/@vite/client"></script> fetch("/@ng/component?c=a")'),
    ).toEqual([
      "the Vite dev client (/@vite/client)",
      "the dev server's component update address (/@ng/component)",
    ]);
    expect(devMarkers("<main>Hello</main>")).toEqual([]);
    expect(
      errorMarkers(
        "<pre>NG0200: Circular dependency in DI detected for A. Find more at x\n    at f (/srv/node_modules/@angular/core/fesm2022/core.mjs:1:1)</pre>",
      ),
    ).toEqual(["an Angular error code (NG0...)", "a stack trace through @angular"]);
    expect(errorMarkers("<script>throw new Error('NG0200: x')</script><p>Fine</p>")).toEqual([]);
    expect(analogFunctions('fetch("/_analog/fn/abc123"); "/_analog/fn/abc123"')).toEqual([
      "abc123",
    ]);
    expect(analogPageEndpoints('"/api/_analog/pages/exercises/[id]"')).toEqual([
      "/api/_analog/pages/exercises/[id]",
    ]);
    expect(visibleText("a<style>x</style>b<script>y</script>c")).toBe("abc");
  });
});

describe("angular: each check", () => {
  it("dev tools in production are reported once, naming what was seen", async () => {
    const p = page(`${ANGULAR}<script type="module" src="/@vite/client"></script>`);
    const out = await angularDevToolsPublic.run(p, ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      ["high", "the page carries the Vite dev client (/@vite/client)"],
    ]);
    expect(await angularDevToolsPublic.run(page(ANGULAR), ctx)).toEqual([]);
  });

  it("a preview canonical on a production host is reported; the same on a preview host is not", async () => {
    const html = `${ANGULAR}<link rel="canonical" href="https://harbourside-git-main.vercel.app/">`;
    const out = await angularPreviewCanonical.run(page(html), ctx);
    expect(out.map((f) => f.evidence)).toEqual([
      "canonical https://harbourside-git-main.vercel.app/ is on a preview domain",
    ]);
    expect(
      await angularPreviewCanonical.run(page(html, { url: "https://x.vercel.app/" }), ctx),
    ).toEqual([]);
  });

  it("private-looking state fields are named without their values", async () => {
    const out = await angularStatePrivateFields.run(
      page(
        ANGULAR +
          state({
            adminToken: "invented-secret-value",
            title: "Hi",
            h: { b: { internalNotes: "n" }, s: 200, u: "http://x/api", h: {} },
          }),
      ),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toBe(
      "2 private-looking fields in the transfer state: adminToken (string), http-cache[0].internalNotes (string)",
    );
    expect(JSON.stringify(out)).not.toContain("invented-secret-value");
    expect(
      await angularStatePrivateFields.run(page(ANGULAR + state({ title: "Hi" })), ctx),
    ).toEqual([]);
  });

  it("an error page with 200 is reported; the same with 500 is not", async () => {
    const body = `${ANGULAR}<pre>ReferenceError: window is not defined</pre>`;
    const out = await angularSsrError200.run(page(body), ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "medium",
        "the page answers 200 and contains a ReferenceError from browser-only code run on the server",
      ],
    ]);
    expect(await angularSsrError200.run(page(body, { status: 500 }), ctx)).toEqual([]);
  });

  it("Analog server functions and page endpoints are listed from the page, with no request", async () => {
    const out = await angularAnalogEndpointsListed.run(
      page(
        `${ANGULAR}<script>fetch("/_analog/fn/abc"); fetch("/api/_analog/pages/exercises")</script>`,
      ),
      ctx,
    );
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      ["low", "the page names server function abc and page endpoint /api/_analog/pages/exercises"],
    ]);
  });
});

describe("angular: integration (the angular-like fixture)", () => {
  it("each check fires once, and no Analog address is requested", async () => {
    const site = await startFixture("angular-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ANGULAR_CHECKS,
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        [
          "angular-dev-tools-public",
          "high",
          "the page carries the Vite dev client (/@vite/client)",
        ],
        [
          "angular-preview-canonical",
          "high",
          "canonical https://harbourside-physio-git-main.vercel.app/ is on a preview domain",
        ],
        [
          "angular-state-private-fields",
          "high",
          "3 private-looking fields in the transfer state: clinic.adminToken (string), http-cache[0].internalNotes (string), http-cache[0].slots[].wholesaleRate (number)",
        ],
        [
          "angular-ssr-error-200",
          "medium",
          "the page answers 200 and contains an Angular error code (NG0...), a stack trace through @angular",
        ],
        [
          "angular-analog-endpoints-listed",
          "low",
          "the page names server function c3b1e9a2 and page endpoint /api/_analog/pages/exercises",
        ],
      ]);
      expect([...site.hits.keys()].filter((k) => /_analog/.test(k))).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("angular: edge cases", () => {
  it("on a site that is not Angular, every check is silent", async () => {
    const plain = page(
      `<link rel="canonical" href="https://x.vercel.app/"><script src="/@vite/client"></script><pre>NG0201: x</pre>`,
    );
    for (const c of [
      angularDevToolsPublic,
      angularPreviewCanonical,
      angularStatePrivateFields,
      angularSsrError200,
      angularAnalogEndpointsListed,
    ])
      expect(await c.run(plain, ctx), c.id).toEqual([]);
  });

  it("a __proto__ key is a field name, and pollutes nothing", () => {
    const html = `<script id="ng-state" type="application/json">{"__proto__":{"isAdmin":true},"constructor":{"a":1}}</script>`;
    expect(readStateScripts(html).fields.map((f) => f.name)).toEqual([
      "__proto__.isAdmin",
      "constructor.a",
    ]);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("an unparseable or huge state is could-not-check, never a pass", async () => {
    calls.length = 0;
    const bad = '<script id="ng-state" type="application/json">{"a":[</script>';
    expect(readStateScripts(bad)).toEqual({ found: 1, unread: 1, fields: [] });
    expect(await angularStatePrivateFields.run(page(ANGULAR + bad), ctx)).toEqual([]);
    const huge = state({ x: "y".repeat(MAX_STATE_CHARS) });
    expect(readStateScripts(huge).unread).toBe(1);
    // A script that never closes.
    expect(readStateScripts('<script id="ng-state" type="application/json">{"a":').unread).toBe(1);
    // An array at the top is not a state object.
    expect(
      readStateScripts('<script id="ng-state" type="application/json">[1]</script>').unread,
    ).toBe(1);
    expect(calls).toEqual(["the transfer state is too large or is not JSON (1 script unread)"]);
  });

  it("deeply nested and many-field state is capped, never thrown", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 200; i++) deep = { k: deep };
    expect(() => readStateScripts(state({ deep }))).not.toThrow();
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`f${i}`, i]));
    expect(readStateScripts(state(wide)).fields.length).toBeLessThanOrEqual(500);
  });

  it("lone surrogates and control characters in a field name come out harmless", () => {
    const html = state({ ["tok\ud800en\u0007"]: "v" });
    expect(readStateScripts(html).fields[0]?.name).toBe("tok?en?");
  });

  it("a long field name is cut, and hostile pages are read in linear time", () => {
    expect(readStateScripts(state({ ["a".repeat(500)]: 1 })).fields[0]?.name).toHaveLength(40);
    const started = Date.now();
    readStateScripts("<script ".repeat(200_000) + ">");
    visibleText("<script>".repeat(200_000));
    visibleText("<style>x".repeat(100_000) + "<script>".repeat(100_000));
    errorMarkers("\n".repeat(500_000) + "\n  ".repeat(100_000));
    analogFunctions("/_analog/fn/".repeat(200_000));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a truncated page is still searched for what was read", async () => {
    const p = page(`${ANGULAR}<script src="/@vite/client"></script>`, { truncated: true });
    expect((await angularDevToolsPublic.run(p, ctx)).length).toBe(1);
  });
});
