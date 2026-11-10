import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../snapshot.js";
import { findRawRefs, MAX_RAW_REFS } from "../raw-refs.js";

function snapshot(body: string) {
  return buildSnapshot([
    {
      url: "https://fernbrook.example/page",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      truncated: false,
    },
  ] as never);
}
const page = (html: string) =>
  snapshot(`<!doctype html><html><head><title>T</title></head><body>${html}</body></html>`);

describe("spotting a raw reference in HTML", () => {
  it('finds "[object Object]" in visible text', () => {
    const refs = findRawRefs(page("<h2>Our team</h2><p>Led by [object Object] and one more.</p>"));
    expect(refs).toEqual([
      { kind: "object-object", snippet: "Led by [object Object] and one more." },
    ]);
  });

  it('finds "[object Object]" in an address, written out or percent-encoded', () => {
    expect(findRawRefs(page('<a href="/team/[object Object]">Ana</a>'))[0]?.kind).toBe(
      "object-object",
    );
    const encoded = findRawRefs(page('<a href="/team/%5Bobject%20Object%5D">Ana</a>'));
    expect(encoded[0]?.snippet).toContain("in an address");
  });

  it("finds a _ref written out in the text, with its id, and does not also report its _type", () => {
    const refs = findRawRefs(
      page('<p>Author: {"_type":"reference","_ref":"practitioner-ana"}</p>'),
    );
    expect(refs).toEqual([
      {
        kind: "ref-text",
        snippet: 'Author: {"_type":"reference","_ref":"practitioner-ana"}',
        id: "practitioner-ana",
      },
    ]);
  });

  it("finds a quoted _type name in the text", () => {
    const refs = findRawRefs(page('<div>{ _type: "testimonial" }</div>'));
    expect(refs).toEqual([
      { kind: "type-text", snippet: '{ _type: "testimonial" }', id: "testimonial" },
    ]);
  });

  it("is not fooled by the words in prose, or by text that only hides in a script or a style", () => {
    const html = page(
      "<p>The _ref value of a reference is explained in the editors guide, as is the object model.</p>" +
        '<script>var s = "[object Object]"; var t = {_type: "post", _ref: "abc-123"};</script><style>.a::after{content:"[object Object]"}</style>',
    );
    expect(findRawRefs(html)).toEqual([]);
  });

  it("escapes invisible and control characters in what it quotes", () => {
    const refs = findRawRefs(page("<p>x [object Object]\u200B\u0007 y</p>"));
    expect(refs[0]?.snippet).toBe("x [object Object]\\u{200B}\\u{7} y");
  });

  it("cuts a long sentence around the match", () => {
    const refs = findRawRefs(
      page(`<p>${"word ".repeat(60)}[object Object] ${"tail ".repeat(60)}</p>`),
    );
    expect(refs[0]?.snippet.length).toBeLessThanOrEqual(91);
    expect(refs[0]?.snippet).toContain("[object Object]");
  });
});

describe("spotting a raw reference in embedded data", () => {
  const data = (value: unknown) =>
    page(
      `<p>Hello</p><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(value)}</script>`,
    );

  it("finds a reference that was never followed, and says where it is", () => {
    const refs = findRawRefs(
      data({
        props: {
          pageProps: {
            post: { title: "x", author: { _type: "reference", _ref: "practitioner-ana" } },
          },
        },
      }),
    );
    expect(refs).toEqual([
      {
        kind: "data-ref",
        snippet: '{"_type":"reference","_ref":"practitioner-ana"}',
        id: "practitioner-ana",
        where: "props.pageProps.post.author",
      },
    ]);
  });

  it("does not report an image or file asset reference: that is how Sanity stores a picture", () => {
    const refs = findRawRefs(
      data({
        hero: { _type: "image", asset: { _type: "reference", _ref: "image-abc123-800x600-jpg" } },
        brochure: { _type: "file", asset: { _type: "reference", _ref: "file-abc123-pdf" } },
      }),
    );
    expect(refs).toEqual([]);
  });

  it("finds references inside lists, and keeps at most five places", () => {
    const refs = findRawRefs(
      data({
        items: Array.from({ length: 12 }, (_, i) => ({
          by: { _type: "reference", _ref: `p-${i}` },
        })),
      }),
    );
    expect(refs).toHaveLength(MAX_RAW_REFS);
    expect(refs[0]?.where).toBe("items[0].by");
  });

  it("ignores data that is not JSON, and a _ref that is a plain string value", () => {
    const html = page(
      '<script type="application/json">{not json</script><script type="application/json">{"note":"_ref"}</script>',
    );
    expect(findRawRefs(html)).toEqual([]);
  });
});
