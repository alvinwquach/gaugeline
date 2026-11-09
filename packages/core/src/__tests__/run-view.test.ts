import { describe, expect, it } from "vitest";
import type { Hop } from "../fetcher.js";
import { pageData } from "../run-view.js";
import { buildSnapshot } from "../snapshot.js";

const hop = (body: string, url = "https://shop.example/"): Hop => ({
  url,
  status: 200,
  headers: { "content-type": "text/html" },
  body,
  ms: 1,
});
/** head and body are split, so the title is not read as page text. */
const data = (html: string) => pageData(buildSnapshot([hop(html)]));
const doc = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`;
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("pageData: unit", () => {
  it("reads the title, the canonical and the address the page ended at", () => {
    const d = data(
      doc(
        `<title> Brambleworth   Hardware </title><link rel="canonical" href="/home">`,
        "<p>One two</p>",
      ),
    );
    expect(d).toMatchObject({
      url: "https://shop.example/",
      title: "Brambleworth Hardware",
      canonical: "https://shop.example/home",
      words: 2,
      firstWords: "One two",
    });
  });

  it("a missing title or canonical is absent, an empty one is an empty string", () => {
    const missing = data("<p>No head at all</p>");
    expect(missing.title).toBeUndefined();
    expect(missing.canonical).toBeUndefined();
    expect("title" in missing).toBe(false);
    const empty = data(doc(`<title></title><link rel="canonical" href="">`, "<p>Words</p>"));
    expect(empty.title).toBe("");
    expect(empty.canonical).toBe("");
  });

  it("the preview is the first 200 readable words, not the navigation's, scripts' or hidden text", () => {
    const d = data(
      doc(
        "<title>t</title>",
        `<script>var x = 1</script><div hidden>secret hidden words</div><main>${words(300)}</main>`,
      ),
    );
    expect(d.words).toBe(300);
    expect(d.firstWords.split(" ")).toHaveLength(200);
    expect(d.firstWords.startsWith("w0 w1 w2")).toBe(true);
    expect(d.firstWords.endsWith("w199")).toBe(true);
    expect(d.firstWords).not.toContain("secret");
    expect(d.firstWords).not.toContain("var");
  });

  it("a page with no readable words has none to show", () => {
    const d = data(doc("<title>Shell</title>", `<div id="root"></div><script>render()</script>`));
    expect(d.words).toBe(0);
    expect(d.firstWords).toBe("");
  });

  it("keeps every structured data block in document order, a failed one as raw text with its error", () => {
    const d = data(
      `<script type="application/ld+json">{"@type":"Product","name":"Hammer"}</script>
       <script type="application/ld+json">{"@type": "Offer", </script>
       <script type="application/ld+json">[{"@type":"A"},{"@type":"B"}]</script>`,
    );
    expect(d.blocks).toHaveLength(3);
    expect(d.blocks[0]).toEqual({ ok: true, value: { "@type": "Product", name: "Hammer" } });
    expect(d.blocks[1]).toMatchObject({ ok: false, raw: '{"@type": "Offer",' });
    expect((d.blocks[1] as { error: string }).error).toMatch(/JSON|Expected|Unexpected/);
    expect(d.blocks[2]).toEqual({ ok: true, value: [{ "@type": "A" }, { "@type": "B" }] });
  });

  it("text that looks like a key is redacted in a block, and in the raw text of a failed one", () => {
    const key = ["sk", "live", "GaugelineFixtureNotAKey00"].join("_");
    const d = data(
      `<script type="application/ld+json">{"name":"${key}"}</script>
       <script type="application/ld+json">{"name":"${key}", </script>`,
    );
    expect(JSON.stringify(d)).not.toContain(key);
    expect(JSON.stringify(d.blocks[0])).toContain("[redacted]");
  });

  it("limits the number of blocks and the size of one", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `<script type="application/ld+json">{"n":${i}}</script>`,
    ).join("");
    expect(data(many).blocks).toHaveLength(20);
    const big = data(`<script type="application/ld+json">{"x":"${"a".repeat(60_000)}"}</script>`)
      .blocks[0];
    expect(big).toMatchObject({ ok: false });
    expect((big as { raw: string }).raw.length).toBeLessThanOrEqual(2000);
    expect((big as { error: string }).error).toMatch(/too large/i);
  });
});
