import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import { CheckRegistry } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { htmlHeavy } from "../html-heavy.js";
import { htmlHuge } from "../html-huge.js";
import { PAGE_CHECKS } from "../index.js";
import { badTelNumber } from "../mobile.js";
import { pageHeavy } from "../page-heavy.js";
import { telFormat } from "../tel-format.js";
import { viewport } from "../viewport.js";
import {
  HTML_HUGE_BYTES,
  INLINE_DATA_HEAVY_BYTES,
  PAGE_HEAVY_BYTES,
  measurePage,
} from "../weight.js";

const ctx = { warn: () => undefined };
const WEIGHT_CHECKS = ["html-huge", "html-heavy", "page-heavy", "viewport", "tel-format"];

function snap(body: string, extra: { truncated?: boolean } = {}) {
  return buildSnapshot([
    {
      url: "https://loom.example/",
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body,
      ms: 1,
      ...extra,
    },
  ]);
}

/** An HTML page of exactly `bytes` bytes, the first `data` of them an inline __NEXT_DATA__ block. */
function pageOf(bytes: number, data = 0): string {
  const head = '<!doctype html><meta name="viewport" content="width=device-width"><title>t</title>';
  const open = '<script id="__NEXT_DATA__" type="application/json">';
  const close = "</script>";
  const block = data > 0 ? `${open}${"d".repeat(data)}${close}` : "";
  const fill = bytes - Buffer.byteLength(head + block, "utf8");
  return head + block + "x".repeat(fill);
}

describe("weight and mobile: unit", () => {
  it("measurePage: a 400 KB __NEXT_DATA__ block is reported in inlineDataBytes", () => {
    const m = measurePage(pageOf(600 * 1024, 400 * 1024));
    expect(m.inlineDataBytes).toBe(400 * 1024);
    expect(m.htmlBytes).toBe(600 * 1024);
    expect(m.scriptCount).toBe(1);
  });

  it("threshold table: one byte under and one byte over each constant", () => {
    expect(htmlHuge.run(snap(pageOf(HTML_HUGE_BYTES)), ctx)).toEqual([]);
    expect(htmlHuge.run(snap(pageOf(HTML_HUGE_BYTES + 1)), ctx)).toHaveLength(1);
    // html-heavy: data over 300 KB and over half the HTML.
    const justData = (d: number) => snap(pageOf(Math.max(d * 2 - 1, d + 200), d));
    expect(htmlHeavy.run(justData(INLINE_DATA_HEAVY_BYTES), ctx)).toEqual([]);
    expect(htmlHeavy.run(justData(INLINE_DATA_HEAVY_BYTES + 1), ctx)).toHaveLength(1);
    // Exactly half is not "more than half".
    expect(htmlHeavy.run(snap(pageOf(800 * 1024, 400 * 1024)), ctx)).toEqual([]);
    expect(htmlHeavy.run(snap(pageOf(800 * 1024 - 1, 400 * 1024)), ctx)).toHaveLength(1);
  });

  it("page-heavy: HTML plus sampled image sizes, one byte under and over 3 MB, saying it is a floor", async () => {
    const html = pageOf(1024 * 1024);
    const withImages = (len: number) => ({
      warn: () => undefined,
      imagesIfSampled: () =>
        Promise.resolve({
          seen: 1,
          taken: [
            {
              url: "https://loom.example/a.jpg",
              ref: { src: "https://loom.example/a.jpg", alt: "a", srcset: [], sources: [] },
              hops: [
                {
                  url: "https://loom.example/a.jpg",
                  status: 200,
                  headers: { "content-length": String(len) },
                  ms: 1,
                },
              ],
            },
          ],
        }),
    });
    expect(await pageHeavy.run(snap(html), withImages(PAGE_HEAVY_BYTES - 1024 * 1024))).toEqual([]);
    const found = await pageHeavy.run(snap(html), withImages(PAGE_HEAVY_BYTES - 1024 * 1024 + 1));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("sampled files only");
    // With no sample taken by another check, page-heavy counts the HTML alone.
    expect(await pageHeavy.run(snap(html), ctx)).toEqual([]);
  });

  it('tel-format: "tel:+14155550100" passes; "tel:(415) 555 0100" is flagged; dots and dashes pass', () => {
    expect(badTelNumber("tel:+14155550100")).toBeUndefined();
    expect(badTelNumber("tel:(415) 555 0100")).toBe("(415) 555 0100");
    expect(badTelNumber("tel:415.555.0100")).toBeUndefined();
    expect(badTelNumber("tel:+1-415-555-0100")).toBeUndefined();
    expect(badTelNumber("tel:415%20555%200100")).toBe("415 555 0100");
    expect(badTelNumber("mailto:a")).toBeUndefined();
  });
});

describe("weight and mobile: integration", () => {
  it("a 2.5 MB page: html-huge only, with the size in the evidence", async () => {
    const site = await startFixture("weight");
    try {
      const fetcher = createFetcher({ allowPrivate: true, timeoutMs: 5000 });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        only: ["html-huge", "html-heavy"],
      });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        ["html-huge", "the HTML is 2.5 MB (2,621,440 bytes)"],
      ]);
    } finally {
      await site.close();
    }
  });

  it("no meta viewport tag: one finding; the tag in the body instead of the head: still passes", () => {
    expect(viewport.run(snap("<title>t</title><p>Hi</p>"), ctx)).toHaveLength(1);
    expect(
      viewport.run(
        snap('<title>t</title><body><meta name="viewport" content="width=device-width"><p>Hi</p>'),
        ctx,
      ),
    ).toEqual([]);
  });
});

describe("weight and mobile: promise test", () => {
  it("the hits Map is identical with and without these five checks registered", async () => {
    const hitsWith = async (exclude: boolean) => {
      const site = await startFixture("images");
      try {
        const registry = new CheckRegistry();
        for (const c of PAGE_CHECKS)
          if (!exclude || !WEIGHT_CHECKS.includes(c.id)) registry.register(c);
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

describe("weight and mobile: edge cases", () => {
  it('a body cut at the 5 MB cap is reported as "over 5 MB", not as exactly 5 MB', async () => {
    const found = await htmlHuge.run(snap("x".repeat(5 * 1024 * 1024), { truncated: true }), ctx);
    expect(found[0]?.evidence).toBe(
      "the HTML is over 5 MB (5,242,880 bytes read, then cut at the limit)",
    );
  });

  it("multi-byte text: 1,000 emoji count as 4,000 bytes", () => {
    const emoji = "\u{1F9F5}".repeat(1000);
    expect(measurePage(emoji).htmlBytes).toBe(4000);
    expect(measurePage(`<script type="application/json">${emoji}</script>`).inlineDataBytes).toBe(
      4000,
    );
  });

  it("an inline script with real code and no data does not count toward html-heavy", () => {
    const code = `<script>${"function f(){return 1}".repeat(30000)}</script>`;
    expect(measurePage(code).inlineDataBytes).toBe(0);
    expect(htmlHeavy.run(snap(code), ctx)).toEqual([]);
    // Framework payloads by their opening call count as data.
    expect(
      measurePage('<script>self.__next_f.push([1,"abc"])</script>').inlineDataBytes,
    ).toBeGreaterThan(0);
  });

  it("two tel: links with the same bad number are one finding", () => {
    const p = snap(
      '<a href="tel:(415) 555 0100">Call</a><a href="tel:(415) 555 0100">Call again</a><a href="tel:+14155550100">OK</a>',
    );
    expect(telFormat.run(p, ctx)).toEqual([
      expect.objectContaining({
        evidence: '<a href="tel:(415) 555 0100"> has spaces and brackets',
      }),
    ]);
  });

  it("html-huge and html-heavy never both fire: the higher one is reported", () => {
    const p = snap(pageOf(HTML_HUGE_BYTES + 1024, 1800 * 1024));
    expect(htmlHuge.run(p, ctx)).toHaveLength(1);
    expect(htmlHeavy.run(p, ctx)).toEqual([]);
  });
});
