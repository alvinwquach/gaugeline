import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../snapshot.js";
import { thinHtml } from "../thin-html.js";
import { URL0, ctx, page } from "./helpers.js";

describe("thin-html", () => {
  it("passes with 60 or more words", () => {
    expect(thinHtml.run(page({ contentWordCount: 60 }), ctx)).toEqual([]);
  });

  it("fails with fewer, with the exact evidence", () => {
    expect(thinHtml.run(page({ contentWordCount: 12 }), ctx)).toEqual([
      {
        checkId: "thin-html",
        severity: "high",
        title: "Google sees an almost empty page",
        evidence:
          "12 words in the server-rendered HTML outside header, nav and footer (fewer than 60)",
        url: URL0,
      },
    ]);
  });

  it("header, nav and footer words do not count", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const snap = buildSnapshot([
      {
        url: URL0,
        status: 200,
        headers: { "content-type": "text/html" },
        ms: 1,
        body: `<header>${words(40)}</header><nav>${words(40)}</nav><main><div id="root"></div>${words(5)}</main><footer>${words(40)}</footer>`,
      },
    ]);
    expect(snap.contentWordCount).toBe(5);
    expect(thinHtml.run(snap, ctx)).toHaveLength(1);
  });

  it("does not judge a 404 or a non-HTML response", () => {
    expect(thinHtml.run(page({ status: 404, contentWordCount: 0 }), ctx)).toEqual([]);
    const pdf = [{ url: URL0, status: 200, headers: { "content-type": "application/pdf" }, ms: 1 }];
    expect(thinHtml.run(page({ hops: pdf, contentWordCount: 0 }), ctx)).toEqual([]);
  });
});
