// check-community: allow-email (invented addresses at reserved example domains, used by the test)
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeBody } from "../charset.js";
import type { Hop } from "../fetcher.js";
import { INLINE_SCRIPT_MAX, buildSnapshot, jsonLdNodes } from "../snapshot.js";

const URL0 = "https://shop.example/menu/";
function page(body: string, extra: Partial<Hop> = {}): Hop[] {
  return [
    { url: URL0, status: 200, headers: { "content-type": "text/html" }, body, ms: 1, ...extra },
  ];
}
const snap = (html: string) => buildSnapshot(page(html));

describe("buildSnapshot: unit", () => {
  it("canonical: absolute, relative, missing, two canonicals (keep both, flag)", () => {
    expect(snap('<link rel="canonical" href="https://shop.example/a">').canonical).toBe(
      "https://shop.example/a",
    );
    expect(snap('<link rel="canonical" href="../b">').canonical).toBe("https://shop.example/b");
    const none = snap("<title>x</title>");
    expect(none.canonical).toBeUndefined();
    expect(none.canonicals).toEqual([]);
    const two = snap('<link rel="canonical" href="/one"><link rel="Canonical" href="/two">');
    expect(two.canonical).toBe("https://shop.example/one");
    expect(two.canonicals).toEqual(["https://shop.example/one", "https://shop.example/two"]);
  });

  it("h1 text with nested inline tags and entities", () => {
    const s = snap(
      '<h1 id="top">Fish &amp; <em>Chips</em>&nbsp;<span>to&#8209;go</span></h1><h2>Two</h2><h4>Four</h4>',
    );
    expect(s.headings).toEqual([
      { level: 1, text: "Fish & Chips to\u2011go", id: "top" },
      { level: 2, text: "Two" },
    ]);
  });

  it('alt="" is "" and missing alt is null', () => {
    const s = snap(
      '<img src="/a.png" alt=""><img src="/b.png"><img src="c.png" alt="Logo" width="40" height="20">',
    );
    expect(s.images).toEqual([
      { src: "https://shop.example/a.png", alt: "" },
      { src: "https://shop.example/b.png", alt: null },
      { src: "https://shop.example/menu/c.png", alt: "Logo", width: 40, height: 20 },
    ]);
  });

  it("JSON-LD: valid, invalid JSON, an array of blocks, @graph", () => {
    const s = snap(`
      <script type="application/ld+json">{"@type":"Restaurant","name":"Fixture Diner"}</script>
      <script type="application/ld+json">{ not json }</script>
      <script type="application/ld+json">[{"@type":"Event"},{"@type":"Offer"}]</script>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Organization"}]}</script>
    `);
    expect(s.jsonLd).toHaveLength(4);
    expect(s.jsonLdErrors).toHaveLength(1);
    expect(s.jsonLdErrors[0]).toMatch(/^JSON-LD block 2:/);
    expect(jsonLdNodes(s).map((n) => n["@type"])).toEqual([
      "Restaurant",
      "Event",
      "Offer",
      "WebSite",
      "Organization",
    ]);
  });

  it("wordCount ignores script, style, noscript and hidden elements", () => {
    const s = snap(`<body><p>one two</p><p>three</p>
      <script>var a = "not words";</script><style>.x{}</style><noscript>enable js please</noscript>
      <div hidden>secret words</div><div style="display: none">gone</div><span style="visibility:hidden">x</span>
      <template>tpl words</template></body>`);
    expect(s.wordCount).toBe(3);
  });

  it("ids Set contains ids from any element, not just headings", () => {
    const s = snap('<h2 id="specialties">S</h2><section id="hours"></section><span id="x"></span>');
    expect(s.ids).toEqual(new Set(["specialties", "hours", "x"]));
    expect(s.ids.has("hours")).toBe(true);
  });

  it("links resolve, keep rel, and mark same-site (www and bare host are one site)", () => {
    const s = snap(
      '<a href="/a">A</a><a href="https://www.shop.example/b" rel="nofollow">B</a><a href="https://other.example/">O</a><a href="mailto:hi@shop.example">M</a><a href="">empty</a>',
    );
    expect(s.links).toEqual([
      { href: "https://shop.example/a", text: "A", sameSite: true },
      { href: "https://www.shop.example/b", text: "B", rel: "nofollow", sameSite: true },
      { href: "https://other.example/", text: "O", sameSite: false },
      { href: "mailto:hi@shop.example", text: "M", sameSite: false },
    ]);
  });

  it("title, meta robots, og, scripts, forms and hops", () => {
    const hops: Hop[] = [
      { url: "https://shop.example/old", status: 301, headers: { location: "/menu/" }, ms: 1 },
      ...page(`<title> Menu </title><meta name="robots" content="noindex, nofollow">
        <meta property="og:title" content="Our menu"><meta property="og:image" content="/i.png">
        <script src="/app.js"></script><script>inline()</script>
        <form action="/subscribe" method="POST"><input type="hidden" name="utm_source"><input name="email"></form>`),
    ];
    const s = buildSnapshot(hops);
    expect(s.requestedUrl).toBe("https://shop.example/old");
    expect(s.finalUrl).toBe(URL0);
    expect(s.status).toBe(200);
    expect(s.hops).toBe(hops);
    expect(s.title).toBe("Menu");
    expect(s.metaRobots).toBe("noindex, nofollow");
    expect(s.og).toEqual({ "og:title": "Our menu", "og:image": "/i.png" });
    expect(s.scripts).toEqual(["https://shop.example/app.js"]);
    expect(s.forms).toEqual([
      {
        action: "https://shop.example/subscribe",
        method: "post",
        hiddenFields: ["utm_source"],
        position: 2,
      },
    ]);
  });

  it("numbers forms, iframes and scripts together in document order, and keeps inline scripts", () => {
    const s = snap(`<script src="/a.js"></script>
      <iframe src="//video.example/embed/1"></iframe><iframe></iframe><iframe data-src="/lazy"></iframe>
      <form action="/go"></form>
      <script>hbspt.forms.create({});</script>
      <script type="application/ld+json">{"a":1}</script>
      <script type="text/template"><form></form></script><script src=""></script><script> </script>`);
    expect(s.iframes).toEqual([
      { src: "https://video.example/embed/1", position: 1 },
      { src: "https://shop.example/lazy", position: 3 },
    ]);
    expect(s.forms.map((f) => f.position)).toEqual([4]);
    expect(s.scriptTags).toEqual([
      { src: "https://shop.example/a.js", position: 0 },
      { inline: "hbspt.forms.create({});", position: 5 },
    ]);
    expect(s.scripts).toEqual(["https://shop.example/a.js"]);
  });

  it("keeps only the start of a very long inline script", () => {
    const s = snap(`<script>${"a".repeat(INLINE_SCRIPT_MAX + 500)}</script>`);
    expect(s.scriptTags?.[0]?.inline).toHaveLength(INLINE_SCRIPT_MAX);
  });

  it("never executes scripts", () => {
    const g = globalThis as { __gaugelineRan?: boolean };
    snap(
      '<script>globalThis.__gaugelineRan = true</script><img src=x onerror="globalThis.__gaugelineRan=true">',
    );
    expect(g.__gaugelineRan).toBeUndefined();
  });
});

describe("buildSnapshot: edge cases", () => {
  it("unclosed tags still parse", () => {
    const s = snap("<html><body><h1>Open heading<p>para <b>bold<div id=deep>x");
    expect(s.headings[0]?.text).toMatch(/^Open heading/);
    expect(s.ids.has("deep")).toBe(true);
  });

  it("a 4 MB single-line document parses", () => {
    const big = `<p>${"word ".repeat(800_000)}</p>`;
    expect(big.length).toBeGreaterThan(4_000_000);
    expect(snap(big).wordCount).toBe(800_000);
  });

  it("a BOM at the start is ignored", () => {
    expect(snap("\uFEFF<title>Hi</title>").title).toBe("Hi");
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("<title>Hi</title>"),
    ]);
    expect(decodeBody(bytes, "text/html")).toBe("<title>Hi</title>");
  });

  it("charset from meta, not header: a windows-1252 page decodes correctly", () => {
    const head = new TextEncoder().encode('<meta charset="windows-1252"><title>Caf');
    const bytes = new Uint8Array([...head, 0xe9, ...new TextEncoder().encode("</title>")]);
    const body = decodeBody(bytes, "text/html");
    expect(buildSnapshot(page(body)).title).toBe("Café");
    // a header charset wins over the meta
    expect(
      decodeBody(new TextEncoder().encode("<title>é</title>"), "text/html; charset=utf-8"),
    ).toBe("<title>é</title>");
  });

  it("base href changes link resolution", () => {
    const s = snap(
      '<base href="https://cdn.shop.example/assets/"><a href="x.html">x</a><img src="i.png" alt="">',
    );
    expect(s.links[0]?.href).toBe("https://cdn.shop.example/assets/x.html");
    expect(s.images[0]?.src).toBe("https://cdn.shop.example/assets/i.png");
  });

  it("stega zero-width characters inside the title are stripped and recorded", () => {
    const s = snap("<title>Pop\u200Bup\u200C\u200D nights\uFEFF</title>");
    expect(s.title).toBe("Popup nights");
    expect(s.stega).toBe(true);
    expect(snap("<title>Plain</title>").stega).toBe(false);
  });

  it("an empty body (thin HTML) gives wordCount 0 and does not throw", () => {
    const s = snap(
      '<html><head><script src="/bundle.js"></script></head><body><div id="root"></div></body></html>',
    );
    expect(s.wordCount).toBe(0);
    expect(snap("").wordCount).toBe(0);
    expect(buildSnapshot([{ url: URL0, status: 204, headers: {}, ms: 0 }]).wordCount).toBe(0);
  });
});

describe("buildSnapshot: property test", () => {
  it("never throws for arbitrary strings (500 runs)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 2000 }), (body) => {
        buildSnapshot(page(body));
      }),
      { numRuns: 500 },
    );
  });

  it("never throws for arbitrary HTML-ish strings (500 runs)", () => {
    const tag = fc.constantFrom(
      "<a href=",
      "<img src=",
      "<script type=application/ld+json>",
      "</script>",
      "<link rel=canonical href=",
      "<base href=",
      "<h1>",
      "<div hidden>",
      '"',
      ">",
      "{",
      "[",
      "&amp",
      "\u200B",
      "javascript:",
      "//",
      "http://[",
      "%",
    );
    fc.assert(
      fc.property(
        fc.array(fc.oneof(tag, fc.string({ maxLength: 10 })), { maxLength: 60 }),
        (parts) => {
          buildSnapshot(page(parts.join("")));
        },
      ),
      { numRuns: 500 },
    );
  });
});
