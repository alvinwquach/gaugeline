// check-community: allow-email (mock-content-live is tested on an @example.com address).
import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import { CheckRegistry } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { collectNav, contentIndex } from "../content/parse.js";
import { PLACEHOLDER_IMAGE_HOSTS } from "../content/lists.js";
import { duplicateTitle } from "../duplicate-title.js";
import { PAGE_CHECKS } from "../index.js";
import { linksVagueText } from "../links-vague-text.js";
import { linksWrapped } from "../links-wrapped.js";
import { mockContentLive } from "../mock-content-live.js";
import { navHomeLinks } from "../nav-home-links.js";
import { navLabelDrift } from "../nav-label-drift.js";
import { placeholderImages } from "../placeholder-images.js";
import { placeholderText } from "../placeholder-text.js";

const ctx = { warn: () => undefined };
/** The first finding's evidence: these checks answer synchronously. */
const first = (r: unknown) => (r as { evidence: string }[])[0]?.evidence;
const CONTENT_CHECKS = [
  "duplicate-title",
  "placeholder-text",
  "placeholder-images",
  "mock-content-live",
  "nav-home-links",
  "nav-label-drift",
  "links-vague-text",
  "links-wrapped",
];

function snap(body: string, head = "<title>Marigold Bindery</title>") {
  return buildSnapshot([
    {
      url: "https://bindery.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head>${head}</head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

describe("content and navigation: unit", () => {
  it('nav-label-drift: the same href labelled "Home Health" and "Home Health Providers" in two nav elements is one finding', () => {
    const p = snap(
      '<nav><a href="/care">Home Health</a></nav><nav><a href="/care/">Home Health Providers</a></nav><footer><a href="/care">home health</a></footer>',
    );
    expect(collectNav(contentIndex(p)).get("https://bindery.example/care")).toEqual(
      new Set(["Home Health", "Home Health Providers", "home health"]),
    );
    expect(navLabelDrift.run(p, ctx)).toEqual([
      expect.objectContaining({
        evidence: '1 link has two labels: /care is "Home Health" and "Home Health Providers"',
      }),
    ]);
  });

  it('nav-home-links: "Home" and the site name pass; "Services" pointing at / is flagged', () => {
    const ok = snap(
      '<header><a href="/">Home</a> <a href="/"><img src="/logo.svg" alt="Marigold Bindery"></a></header>',
    );
    expect(navHomeLinks.run(ok, ctx)).toEqual([]);
    const bad = snap(
      '<nav><a href="/">Home</a> <a href="/">Services</a> <a href="https://bindery.example">Contact</a></nav>',
    );
    expect(navHomeLinks.run(bad, ctx)).toEqual([
      expect.objectContaining({ evidence: '2 menu items go to /: "Services", "Contact"' }),
    ]);
  });

  it('links-vague-text: "Read more" flagged; "Read more about pricing" passes; an icon link with aria-label passes', () => {
    const p = snap(
      '<main><a href="/a">Read more →</a> <a href="/b">Read more about pricing</a> <a href="/c" aria-label="Read the pricing guide"><svg></svg></a> <a href="/d">here</a></main>',
    );
    expect(linksVagueText.run(p, ctx)).toEqual([
      expect.objectContaining({ evidence: '2 links: "Read more →" to /a, "here" to /d' }),
    ]);
  });

  it("placeholder-images host list: each listed host flagged, a look-alike host is not", () => {
    for (const host of PLACEHOLDER_IMAGE_HOSTS) {
      expect(
        placeholderImages.run(snap(`<img src="https://${host}/300" alt="x">`), ctx),
        host,
      ).toHaveLength(1);
    }
    expect(
      placeholderImages.run(snap('<img src="https://cdn.picsum.photos/300" alt="x">'), ctx),
    ).toHaveLength(1);
    for (const lookalike of [
      "https://placehold.co.example/1",
      "https://notplacehold.co/1",
      "https://dummyimage.com.cdn.example/1",
    ]) {
      expect(
        placeholderImages.run(snap(`<img src="${lookalike}" alt="x">`), ctx),
        lookalike,
      ).toEqual([]);
    }
  });

  it("mock-content-live: a test product, John Doe, example.com email and a 555 number in the main content", () => {
    const p = snap(
      "<main><h2>Test Product</h2><p>Posted by John Doe. Write to jane@example.com or call (415) 555-0100.</p></main><footer>Test product</footer>",
    );
    expect(first(mockContentLive.run(p, ctx))).toBe(
      '4 test items in the main content: "Test Product", "John Doe", "jane@example.com" and 1 more',
    );
    expect(
      mockContentLive.run(snap("<main><p>Our test products are rigorous.</p></main>"), ctx),
    ).toEqual([]);
  });

  it("links-wrapped: shorteners and /redirect?url= are flagged; ordinary links are not", () => {
    const p = snap(
      '<main><a href="https://bit.ly/3abc">Offer</a> <a href="https://bindery.example/redirect?url=https%3A%2F%2Fshop.example%2F">Shop</a> <a href="https://bitly.example/x">Not one</a> <a href="https://bindery.example/redirect?url=/local">Local</a></main>',
    );
    expect(first(linksWrapped.run(p, ctx))).toBe(
      "2 wrapped links: https://bit.ly/3abc (bit.ly), https://bindery.example/redirect?url=https%3A%2F%2Fshop.example%2F (/redirect?url=)",
    );
  });
});

describe("content and navigation: integration (fixture site)", () => {
  it("lorem ipsum in the main content and a placehold.co image: two findings, two check ids", async () => {
    const site = await startFixture("content-hygiene");
    try {
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      const { result } = await checkSite({ address: site.origin, fetcher, only: CONTENT_CHECKS });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        ["placeholder-images", "1 placeholder image: https://placehold.co/600x400"],
        ["placeholder-text", '1 placeholder: "Lorem ipsum"'],
      ]);
    } finally {
      await site.close();
    }
  });

  it("the hits Map is identical with and without these eight checks registered", async () => {
    const hitsWith = async (exclude: boolean) => {
      const site = await startFixture("content-hygiene");
      try {
        const registry = new CheckRegistry();
        for (const c of PAGE_CHECKS)
          if (!exclude || !CONTENT_CHECKS.includes(c.id)) registry.register(c);
        await checkSite({
          address: site.origin,
          fetcher: createFetcher({ allowPrivate: true }),
          registry,
        });
        return [...site.hits.entries()].sort();
      } finally {
        await site.close();
      }
    };
    expect(await hitsWith(false)).toEqual(await hitsWith(true));
  });
});

describe("content and navigation: edge cases", () => {
  it("lorem ipsum inside a code sample is not placeholder-text", () => {
    expect(
      placeholderText.run(
        snap("<main><pre><code>lorem ipsum</code></pre><p>Real copy.</p></main>"),
        ctx,
      ),
    ).toEqual([]);
  });

  it("nav links that differ only by a #fragment are different destinations", () => {
    const p = snap(
      '<nav><a href="/faq#shipping">Shipping</a></nav><footer><a href="/faq#returns">Returns</a></footer>',
    );
    expect(navLabelDrift.run(p, ctx)).toEqual([]);
    expect(collectNav(contentIndex(p)).size).toBe(2);
  });

  it('a page about testing whose h1 is "Test your site" is not placeholder-text (whole titles, not words)', () => {
    expect(
      placeholderText.run(
        snap("<main><h1>Test your site</h1></main>", "<title>Testing in production</title>"),
        ctx,
      ),
    ).toEqual([]);
    expect(
      first(
        placeholderText.run(
          snap("<main><h1>Untitled</h1></main>", "<title>Test page</title>"),
          ctx,
        ),
      ),
    ).toBe('2 placeholders: title "Test page", h1 "Untitled"');
  });

  it("an svg with its own title element is not duplicate-title; two head titles are", () => {
    expect(duplicateTitle.run(snap("<svg><title>Logo</title></svg>"), ctx)).toEqual([]);
    expect(
      duplicateTitle.run(snap("<p>x</p>", "<title>One</title><title>Two</title>"), ctx),
    ).toEqual([expect.objectContaining({ evidence: '2 title elements: "One", "Two"' })]);
  });

  it("a link to bit.ly in the footer social row is still links-wrapped", () => {
    const p = snap(
      '<footer><a href="https://bit.ly/bindery-ig" aria-label="Instagram"><svg></svg></a></footer>',
    );
    expect(linksWrapped.run(p, ctx)).toHaveLength(1);
  });
});
