import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { jsonldInvalid } from "../jsonld-invalid.js";
import { ogImageMissing } from "../og-image-missing.js";
import { ogImageRelative } from "../og-image-relative.js";
import { ogUrlMismatch } from "../og-url-mismatch.js";
import { findStega } from "../sharing/stega.js";
import { stegaLeak } from "../stega-leak.js";
import { structuredDuplicate } from "../structured-duplicate.js";
import { collectUrls, jsonLdTypes } from "../structured/collect.js";

const ctx = { warn: () => undefined };
const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Invisible characters built from code points, so none sit literally in this file. */
const TAG = (s: string) =>
  [...s].map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0))).join("");
const ZWJ = String.fromCodePoint(0x200d);
const ZWSP = String.fromCodePoint(0x200b);
const WOMAN_TECH = `${String.fromCodePoint(0x1f469)}${ZWJ}${String.fromCodePoint(0x1f4bb)}`;

function snap(head: string, body = "<p>Hello.</p>") {
  return buildSnapshot([
    {
      url: "https://loom.example/shop/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head>${head}</head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}
const ld = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

describe("structured data and sharing: unit", () => {
  it("JSON-LD walker: nested @graph and arrays of arrays, in document order", () => {
    const json = {
      "@graph": [
        {
          "@type": "Organization",
          url: "https://loom.example/",
          logo: { url: "https://loom.example/logo.png" },
        },
        [["https://loom.example/a"], ["not a url", "mailto:x", "https://loom.example/b"]],
      ],
    };
    expect(collectUrls(json)).toEqual([
      "https://loom.example/",
      "https://loom.example/logo.png",
      "https://loom.example/a",
      "https://loom.example/b",
    ]);
    expect([...jsonLdTypes(json)]).toEqual(["Organization"]);
  });

  it("JSON-LD walker: 10,000-deep nesting does not overflow the stack", () => {
    let deep: unknown = "https://loom.example/bottom";
    for (let i = 0; i < 10_000; i++) deep = { child: [deep] };
    expect(collectUrls(deep)).toEqual(["https://loom.example/bottom"]);
    expect(jsonLdTypes(deep).size).toBe(0);
  });

  it('og-image-relative: "/previews/landing.webp" flagged, absolute passes, protocol-relative flagged', () => {
    const og = (v: string) => snap(`<meta property="og:image" content="${v}">`);
    expect(ogImageRelative.run(og("/previews/landing.webp"), ctx)).toEqual([
      expect.objectContaining({ evidence: 'og:image is "/previews/landing.webp"' }),
    ]);
    expect(ogImageRelative.run(og("https://loom.example/previews/landing.webp"), ctx)).toEqual([]);
    expect(ogImageRelative.run(og("//cdn.loom.example/landing.webp"), ctx)).toHaveLength(1);
    expect(ogImageMissing.run(snap("<title>t</title>"), ctx)).toHaveLength(1);
    expect(ogImageMissing.run(og("https://loom.example/x.png"), ctx)).toEqual([]);
  });

  it("stega-leak: a title with U+E0067 characters is flagged; one zero-width joiner inside an emoji is not", () => {
    expect(findStega(`Loom${TAG("g")}`)).toEqual({ tags: 1, longestRun: 0 });
    expect(stegaLeak.run(snap(`<title>Loom ${TAG("gauge")}</title>`), ctx)).toEqual([
      expect.objectContaining({ evidence: "hidden characters in the title" }),
    ]);
    expect(findStega(`Our team ${WOMAN_TECH}`)).toBeUndefined();
    expect(stegaLeak.run(snap(`<title>Team ${WOMAN_TECH}</title>`), ctx)).toEqual([]);
    expect(findStega(`a${ZWSP.repeat(3)}b`)).toBeUndefined();
    expect(findStega(`a${ZWSP.repeat(4)}b`)).toEqual({ tags: 0, longestRun: 4 });
  });
});

describe("structured data and sharing: integration", () => {
  it("structured data naming 20 same-site addresses: 12 or fewer requests; the 404 is jsonld-404", async () => {
    const send = (status: number) => (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(status, { "content-type": "text/html" }).end("<title>p</title>");
    };
    const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
      "/": (req, res) => {
        const origin = `http://${req.headers.host}`;
        const items = Array.from({ length: 20 }, (_, i) => ({
          "@type": "Product",
          url: `${origin}/products/${i}`,
        }));
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(`<title>Shop</title>${ld({ "@context": "https://schema.org", "@graph": items })}`);
      },
      "/products/3": send(404),
    };
    const server = await startServer(routes, send(200));
    servers.push(server);
    const { result, budget } = await checkSite({
      address: `${server.origin}/`,
      fetcher: createFetcher({ allowPrivate: true }),
      only: ["jsonld-404"],
    });
    const productRequests = server.log.filter((r) => r.path.startsWith("/products/"));
    expect(productRequests.length).toBeLessThanOrEqual(12);
    expect(budget.summary().structuredDataAddresses).toEqual({ limit: 12, sampled: 12, found: 20 });
    expect(result.findings.map((f) => f.evidence)).toEqual([
      "structured data names /products/3, which returned 404",
    ]);
  });
});

describe("structured data and sharing: edge cases", () => {
  it("two JSON-LD blocks, one valid and one broken: jsonld-invalid once, and the valid block is still walked", () => {
    const p = snap(
      `${ld({ "@type": "Product", url: "https://loom.example/p" })}<script type="application/ld+json">{"@type": "FAQPage",}</script>`,
    );
    expect(jsonldInvalid.run(p, ctx)).toHaveLength(1);
    expect(collectUrls(p.jsonLd)).toEqual(["https://loom.example/p"]);
  });

  it("a FAQ in JSON-LD and a Product in microdata is not structured-duplicate; the same type is", () => {
    const micro =
      '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Loom</span></div>';
    expect(structuredDuplicate.run(snap(ld({ "@type": "FAQPage" }), micro), ctx)).toEqual([]);
    expect(structuredDuplicate.run(snap(ld({ "@type": "Product" }), micro), ctx)).toEqual([
      expect.objectContaining({ evidence: "Product is in both JSON-LD and microdata" }),
    ]);
  });

  it("stega characters in the title but not the body", async () => {
    const p = snap(`<title>Loom${ZWSP.repeat(6)}</title>`, "<p>Plain body text.</p>");
    expect(stegaLeak.run(p, ctx)).toEqual([
      expect.objectContaining({ evidence: "hidden characters in the title" }),
    ]);
    const body = snap("<title>Loom</title>", `<p>Body${ZWSP.repeat(6)}</p>`);
    expect(stegaLeak.run(body, ctx)).toEqual([]);
    const meta = snap(
      `<title>Loom</title><meta name="description" content="Weaving${TAG("x")}">${ld({ name: `Loom${TAG("y")}` })}`,
    );
    expect((await stegaLeak.run(meta, ctx))[0]?.evidence).toBe(
      "hidden characters in 1 meta tag, 1 structured data value",
    );
  });

  it("og:url and canonical that differ only by a trailing slash are equal; a different path is not", () => {
    const pair = (og: string) =>
      snap(
        `<link rel="canonical" href="https://loom.example/shop"><meta property="og:url" content="${og}">`,
      );
    expect(ogUrlMismatch.run(pair("https://loom.example/shop/"), ctx)).toEqual([]);
    expect(ogUrlMismatch.run(pair("https://loom.example/shop"), ctx)).toEqual([]);
    expect(ogUrlMismatch.run(pair("https://loom.example/tools"), ctx)).toEqual([
      expect.objectContaining({
        evidence:
          "og:url is https://loom.example/tools; the canonical is https://loom.example/shop (differs by path)",
      }),
    ]);
  });
});
