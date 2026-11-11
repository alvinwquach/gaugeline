import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import {
  MAX_ISLANDS,
  MAX_PROPS_CHARS,
  actionNames,
  devMarkers,
  isAstroSite,
  readIslands,
  serverIslandNames,
} from "../../astro/detect.js";
import { createFetcher } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { astroDevToolsPublic } from "../astro-dev-tools-public.js";
import { astroDraftEntryPublic } from "../astro-draft-entry-public.js";
import { astroEndpointsListed } from "../astro-endpoints-listed.js";
import { astroPreviewCanonical } from "../astro-preview-canonical.js";
import { astroPrivateProps } from "../astro-private-props.js";

const ASTRO_CHECKS = [
  "astro-dev-tools-public",
  "astro-preview-canonical",
  "astro-private-props",
  "astro-draft-entry-public",
  "astro-endpoints-listed",
];

function page(body: string, opts: { truncated?: boolean; url?: string } = {}) {
  return buildSnapshot([
    {
      url: opts.url ?? "https://fernlight.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
      ...(opts.truncated ? { truncated: true } : {}),
    },
  ]);
}
/** An astro-island element the way Astro writes it: the props JSON is HTML-escaped. */
const island = (props: unknown, name = "Booking") =>
  `<astro-island uid="Z1" component-url="/_astro/${name}.Dk3f9aZ1.js" component-export="default" props="${JSON.stringify(props).replace(/"/g, "&quot;")}" ssr client="load"></astro-island>`;
const ASTRO = "<html><body data-astro-cid-abc12><main>Hi</main></body></html>";
const ctx: CheckContext = { warn: () => undefined, budget: createBudget() };

describe("astro: unit", () => {
  it("an Astro site is recognised from its HTML, and a plain page is not", () => {
    expect(isAstroSite(page(ASTRO))).toBe(true);
    expect(isAstroSite(page(island({})))).toBe(true);
    expect(isAstroSite(page('<meta name="generator" content="Astro v5.1.2">'))).toBe(true);
    expect(isAstroSite(page('<script type="module" src="/_astro/page.1a2b3c.js"></script>'))).toBe(
      true,
    );
    expect(isAstroSite(page("<html><body>Plain astro mention</body></html>"))).toBe(false);
    expect(isAstroSite(page('<meta name="generator" content="WordPress 6.5">'))).toBe(false);
  });

  it("dev markers, actions and server islands are read from the HTML", () => {
    expect(
      devMarkers(
        '<script type="module" src="/@vite/client"></script><div data-astro-source-file="/a.astro">',
      ),
    ).toEqual(["the Vite dev client (/@vite/client)", "data-astro-source-file attributes"]);
    expect(devMarkers("<main>Hello</main>")).toEqual([]);
    expect(
      actionNames(
        'fetch("/_actions/bookClass/"); <form action="?_action=subscribe"> /_actions/bookClass',
      ),
    ).toEqual(["bookClass", "subscribe"]);
    expect(serverIslandNames('fetch("/_server-islands/NextClass?e=default&p=&s=")')).toEqual([
      "NextClass",
    ]);
  });

  it("island props give field names and kinds, never values", () => {
    const html = island({
      classId: [0, "vinyasa"],
      teacher: [0, { name: [0, "Mira"], paid: [0, true] }],
      tags: [
        1,
        [
          [0, "a"],
          [0, "b"],
        ],
      ],
      none: [0, null],
    });
    const { islands } = readIslands(html);
    expect(islands).toHaveLength(1);
    expect(islands[0]?.component).toBe("Booking");
    expect(islands[0]?.fields.map((f) => `${f.name}:${f.kind}`)).toEqual([
      "classId:string",
      "teacher.name:string",
      "teacher.paid:boolean",
      "tags:string",
      "tags:string",
      "none:null",
    ]);
    expect(JSON.stringify(islands)).not.toContain("Mira");
    expect(JSON.stringify(islands)).not.toContain("vinyasa");
  });
});

describe("astro: each check", () => {
  it("dev tools in production are reported once, naming what was seen", async () => {
    const p = page(`${ASTRO}<script type="module" src="/@vite/client"></script>`);
    const out = await astroDevToolsPublic.run(p, ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      ["high", "the page carries the Vite dev client (/@vite/client)"],
    ]);
    expect(await astroDevToolsPublic.run(page(ASTRO), ctx)).toEqual([]);
  });

  it("a preview canonical on a production host is reported; the same on a preview host is not", async () => {
    const html = `${ASTRO}<link rel="canonical" href="https://fernlight-git-main.vercel.app/">`;
    const out = await astroPreviewCanonical.run(page(html), ctx);
    expect(out.map((f) => f.evidence)).toEqual([
      "canonical https://fernlight-git-main.vercel.app/ is on a preview domain",
    ]);
    expect(
      await astroPreviewCanonical.run(page(html, { url: "https://x.vercel.app/" }), ctx),
    ).toEqual([]);
  });

  it("private-looking props are named without their values", async () => {
    const out = await astroPrivateProps.run(
      page(
        island({
          apiToken: [0, "invented-secret-value"],
          title: [0, "Hi"],
          teacher: [0, { internalNotes: [0, "n"] }],
        }),
      ),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toBe(
      "2 private-looking fields in island props: Booking.apiToken (string), Booking.teacher.internalNotes (string)",
    );
    expect(JSON.stringify(out)).not.toContain("invented-secret-value");
  });

  it("a draft flag set to true is reported; false is not", async () => {
    const on = await astroDraftEntryPublic.run(page(island({ draft: [0, true] }, "Post")), ctx);
    expect(on.map((f) => f.evidence)).toEqual([
      "a draft flag set to true in island props: Post.draft",
    ]);
    expect(await astroDraftEntryPublic.run(page(island({ draft: [0, false] })), ctx)).toEqual([]);
  });

  it("actions and server islands are listed from the page, with no request", async () => {
    const out = await astroEndpointsListed.run(
      page(
        `${ASTRO}<form action="?_action=subscribe"></form><script>fetch("/_server-islands/NextClass?e=a&p=&s=")</script>`,
      ),
      ctx,
    );
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      ["low", "the page calls action subscribe and loads server island NextClass"],
    ]);
  });
});

describe("astro: integration (the astro-like fixture)", () => {
  it("each check fires once, and no action or server-island address is requested", async () => {
    const site = await startFixture("astro-like");
    try {
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ hosts: site.hosts }),
        only: ASTRO_CHECKS,
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        [
          "astro-dev-tools-public",
          "high",
          "the page carries the Vite dev client (/@vite/client), data-astro-source-file attributes",
        ],
        [
          "astro-preview-canonical",
          "high",
          "canonical https://fernlight-yoga-git-main.vercel.app/ is on a preview domain",
        ],
        [
          "astro-private-props",
          "high",
          "2 private-looking fields in island props: BookingForm.apiToken (string), BookingForm.teacher.internalNotes (string)",
        ],
        [
          "astro-draft-entry-public",
          "medium",
          "a draft flag set to true in island props: Newsletter.draft",
        ],
        [
          "astro-endpoints-listed",
          "low",
          "the page calls actions subscribe, bookClass and loads server island NextClass",
        ],
      ]);
      expect(
        [...site.hits.keys()].filter((k) => /^\/(_actions|_server-islands|_image)/.test(k)),
      ).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("astro: edge cases", () => {
  it("on a site that is not Astro, every check is silent and nothing is requested", async () => {
    const plain = page(
      `<link rel="canonical" href="https://x.vercel.app/"><script src="/@vite/client"></script>`,
    );
    for (const c of [
      astroDevToolsPublic,
      astroPreviewCanonical,
      astroPrivateProps,
      astroDraftEntryPublic,
      astroEndpointsListed,
    ])
      expect(await c.run(plain, ctx), c.id).toEqual([]);
  });

  it("a __proto__ key is a field name, and pollutes nothing", () => {
    const html = island(JSON.parse('{"__proto__":[0,{"isAdmin":[0,true]}],"a":[0,1]}'));
    const { islands } = readIslands(html);
    expect(islands[0]?.fields.map((f) => f.name)).toEqual(["__proto__.isAdmin", "a"]);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it("malformed, huge and deeply nested props are skipped or capped, never thrown", () => {
    const bad =
      '<astro-island component-url="/_astro/A.1234abcd.js" props="{&quot;a&quot;:[0," ssr></astro-island>';
    expect(readIslands(bad)).toEqual({ islands: [], unreadIslands: 1 });
    const huge = island({ x: [0, "y".repeat(MAX_PROPS_CHARS)] });
    expect(readIslands(huge)).toEqual({ islands: [], unreadIslands: 1 });
    let deep: unknown = [0, "leaf"];
    for (let i = 0; i < 200; i++) deep = [0, { k: deep }];
    expect(() => readIslands(island({ deep }))).not.toThrow();
    const many = Array.from({ length: MAX_ISLANDS + 50 }, () => island({ a: [0, 1] })).join("");
    expect(readIslands(many).islands).toHaveLength(MAX_ISLANDS);
    // An element that never closes its tag.
    expect(readIslands('<astro-island props="' + "a".repeat(50_000)).unreadIslands).toBe(1);
  });

  it("lone surrogates and control characters in a field name come out harmless", () => {
    const { islands } = readIslands(island({ ["tok\ud800en\u0007"]: [0, "v"] }));
    expect(islands[0]?.fields[0]?.name).toBe("tok?en?");
  });

  it("a long field name is cut, and a hostile page with many markers is read in linear time", async () => {
    const { islands } = readIslands(island({ ["a".repeat(500)]: [0, 1] }));
    expect(islands[0]?.fields[0]?.name).toHaveLength(40);
    const noise = "/_actions/".repeat(200_000);
    const started = Date.now();
    expect(actionNames(noise).length).toBeLessThanOrEqual(20);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a truncated page is still searched for what was read", async () => {
    const p = page(`${ASTRO}<script src="/@vite/client"></script>`, { truncated: true });
    expect((await astroDevToolsPublic.run(p, ctx)).length).toBe(1);
  });
});
