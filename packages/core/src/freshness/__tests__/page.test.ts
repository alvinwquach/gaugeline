import { describe, expect, it } from "vitest";
import type { Hop } from "../../fetcher.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { readFigure, readForecasts, readStamp } from "../page.js";

function page(body: string, head = ""): PageSnapshot {
  const hop: Hop = {
    url: "https://hoops.example/players/jane-example",
    status: 200,
    headers: { "content-type": "text/html" },
    ms: 1,
    body: `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`,
  };
  return buildSnapshot([hop]);
}

describe("readStamp: unit", () => {
  it("prefers the datetime attribute of a time element", () => {
    const p = page(
      '<time class="updated" datetime="2026-11-10T09:30:00Z">Updated this morning</time>',
    );
    expect(readStamp(p, { selector: "time.updated" })).toEqual({
      found: true,
      raw: "2026-11-10T09:30:00Z",
      from: "time.updated (datetime)",
    });
  });

  it("reads the attribute the selector names: [data-updated]", () => {
    const p = page('<p data-updated="2026-11-10T09:30:00Z">Stats as of today</p>');
    expect(readStamp(p, { selector: "[data-updated]" })).toMatchObject({
      found: true,
      raw: "2026-11-10T09:30:00Z",
      from: "[data-updated] (data-updated)",
    });
  });

  it("reads the content attribute of a meta element", () => {
    const p = page('<meta itemprop="dateModified" content="2026-11-10T09:30:00Z">');
    expect(readStamp(p, { selector: "meta[itemprop=dateModified]" })).toMatchObject({
      found: true,
      raw: "2026-11-10T09:30:00Z",
    });
  });

  it("falls back to the element's text when it has no attribute to read", () => {
    const p = page('<span class="stamp">  Updated 3 hours   ago </span>');
    expect(readStamp(p, { selector: ".stamp" })).toMatchObject({
      found: true,
      raw: "Updated 3 hours ago",
      from: ".stamp (text)",
    });
  });

  it("a named attr wins over the others", () => {
    const p = page(
      '<time datetime="2020-01-01T00:00:00Z" data-synced="2026-11-10T09:30:00Z">x</time>',
    );
    expect(readStamp(p, { selector: "time", attr: "data-synced" })).toMatchObject({
      raw: "2026-11-10T09:30:00Z",
    });
  });

  it("uses the first matching element", () => {
    const p = page('<i class="s">2026-11-10</i><i class="s">2020-01-01</i>');
    expect(readStamp(p, { selector: ".s" })).toMatchObject({ raw: "2026-11-10" });
  });

  it("falls back to structured data when the element is not there", () => {
    const p = page(
      "<p>no stamp</p>",
      '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dataset","dateModified":"2026-11-10T09:30:00Z"}</script>',
    );
    expect(readStamp(p, { selector: "[data-updated]", jsonld: "dateModified" })).toEqual({
      found: true,
      raw: "2026-11-10T09:30:00Z",
      from: "structured data dateModified",
    });
  });

  it("finds the property inside a @graph and nested nodes", () => {
    const p = page(
      "",
      '<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"WebPage","mainEntity":{"@type":"Dataset","dateModified":"2026-11-09"}}]}</script>',
    );
    expect(readStamp(p, { jsonld: "dateModified" })).toMatchObject({
      found: true,
      raw: "2026-11-09",
    });
  });

  it("says there is no stamp when neither place has one, or the element is empty", () => {
    expect(
      readStamp(page("<p>nothing</p>"), { selector: "[data-updated]", jsonld: "dateModified" }),
    ).toEqual({
      found: false,
    });
    expect(readStamp(page('<p data-updated=""> </p>'), { selector: "[data-updated]" })).toEqual({
      found: false,
    });
  });

  it("ignores a stamp in a script or a template: only what the page is sent with counts", () => {
    const p = page('<template><time datetime="2026-11-10T09:30:00Z">x</time></template>');
    // cheerio keeps template content out of the tree: no element, no stamp.
    expect(readStamp(p, { selector: "time" }).found).toBe(false);
  });
});

describe("readFigure: unit", () => {
  it("reads the text of the first match", () => {
    const p = page('<span class="ppg">27.3</span><span class="ppg">1</span>');
    expect(readFigure(p, { selector: ".ppg" })).toEqual({ found: true, raw: "27.3" });
  });
  it("reads a named attribute, or the value attribute of an input", () => {
    const p = page('<b data-v="48.2">x</b><input class="v" value="12">');
    expect(readFigure(p, { selector: "b", attr: "data-v" })).toEqual({ found: true, raw: "48.2" });
    expect(readFigure(p, { selector: "input.v" })).toEqual({ found: true, raw: "12" });
  });
  it("says when nothing matches", () => {
    expect(readFigure(page("<p>x</p>"), { selector: ".ppg" })).toEqual({ found: false });
  });
});

describe("readForecasts: unit", () => {
  const pick = (when: string, extra = "") =>
    `<li class="pick"><span class="teams">Hawks at Harbor</span> <time datetime="${when}">${when}</time>${extra}</li>`;

  it("lists each item with the date found inside it", () => {
    const p = page(`<ul>${pick("2026-11-07T19:00:00Z")}${pick("2026-11-12T19:00:00Z")}</ul>`);
    const got = readForecasts(p, { item: ".pick", date: "time" });
    expect(got.map((i) => [i.raw, i.settled])).toEqual([
      ["2026-11-07T19:00:00Z", false],
      ["2026-11-12T19:00:00Z", false],
    ]);
    expect(got[0]?.label).toBe("Hawks at Harbor 2026-11-07T19:00:00Z");
  });

  it("without date, takes the item's own attribute or a time[datetime] inside it", () => {
    const p = page(
      '<div class="pick" data-game-date="2026-11-07"><b>A</b></div><div class="pick"><time datetime="2026-11-08">x</time></div>',
    );
    expect(readForecasts(p, { item: ".pick[data-game-date]" }).map((i) => i.raw)).toEqual([
      "2026-11-07",
    ]);
    expect(readForecasts(p, { item: ".pick" }).map((i) => i.raw)).toEqual([
      undefined,
      "2026-11-08",
    ]);
  });

  it("marks an item that already shows its result as settled", () => {
    const p = page(
      `<ul>${pick("2026-11-07T19:00:00Z", '<span class="final">W 101-99</span>')}</ul>`,
    );
    expect(readForecasts(p, { item: ".pick", date: "time", settled: ".final" })[0]?.settled).toBe(
      true,
    );
  });

  it("reads the date property of Event structured data when no item is named", () => {
    const p = page(
      "",
      '<script type="application/ld+json">[{"@type":"SportsEvent","name":"Hawks at Harbor","startDate":"2026-11-07T19:00:00Z"},{"@type":"Organization","startDate":"2000-01-01"},{"@type":["Thing","MusicEvent"],"name":"Late set","startDate":"2026-12-01"}]</script>',
    );
    expect(readForecasts(p, { jsonld: "startDate" }).map((i) => [i.label, i.raw])).toEqual([
      ["Hawks at Harbor", "2026-11-07T19:00:00Z"],
      ["Late set", "2026-12-01"],
    ]);
  });

  it("escapes the label and stops at 200 items", () => {
    const many = Array.from({ length: 250 }, () => pick("2026-11-07")).join("");
    expect(readForecasts(page(many), { item: ".pick", date: "time" })).toHaveLength(200);
    const p = page('<li class="pick"><time datetime="2026-11-07">a\u202Eb</time></li>');
    expect(readForecasts(p, { item: ".pick", date: "time" })[0]?.label).not.toMatch(/\u202E/);
  });
});
