import { describe, expect, it } from "vitest";
import { LIMIT_ROWS, footerLines, isProblem, toRows } from "../rows";
import type { RequestKind, RequestRow } from "../../types";

const req = (over: Partial<RequestRow> = {}): RequestRow => ({
  url: "https://shop.example/",
  kind: "page",
  method: "GET",
  status: 200,
  ms: 12,
  ...over,
});
const answer = (over: Partial<RequestRow>) => toRows([req(over)])[0]?.answer;

describe("toRows: unit", () => {
  it("a three-hop redirect is three rows, two of them 'Moved to' the next address", () => {
    const rows = toRows([
      req({ url: "https://shop.example/a", status: 301, location: "https://shop.example/b" }),
      req({ url: "https://shop.example/b", status: 302, location: "https://shop.example/c" }),
      req({ url: "https://shop.example/c", status: 200 }),
    ]);
    expect(rows.map((r) => r.answer)).toEqual([
      "Moved to https://shop.example/b",
      "Moved to https://shop.example/c",
      "Loaded",
    ]);
    expect(rows.map((r) => r.redirectedTo)).toEqual([
      "https://shop.example/b",
      "https://shop.example/c",
      undefined,
    ]);
    expect(rows.filter((r) => r.answer.startsWith("Moved to"))).toHaveLength(2);
  });

  it("carries the address, the kind, the status, the method and the time", () => {
    expect(toRows([req({ kind: "image", method: "HEAD", status: 404, ms: 31 })])).toEqual([
      {
        address: "https://shop.example/",
        kind: "image",
        method: "HEAD",
        status: 404,
        answer: "Not found",
        ms: 31,
      },
    ]);
  });

  it("sorts by kind, then by the order the server gave, and leaves the input alone", () => {
    const kinds: RequestKind[] = [
      "other",
      "extra-page",
      "script",
      "feed",
      "sitemap",
      "image",
      "link",
      "page",
    ];
    const input = kinds.flatMap((kind) =>
      [1, 2].map((n) => req({ kind, url: `https://shop.example/${kind}-${n}` })),
    );
    const before = JSON.stringify(input);
    const rows = toRows(input);
    expect(rows.map((r) => r.kind)).toEqual([
      "page",
      "page",
      "link",
      "link",
      "image",
      "image",
      "sitemap",
      "sitemap",
      "feed",
      "feed",
      "script",
      "script",
      "extra-page",
      "extra-page",
      "other",
      "other",
    ]);
    expect(rows.filter((r) => r.kind === "link").map((r) => r.address)).toEqual([
      "https://shop.example/link-1",
      "https://shop.example/link-2",
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("renders about 95 rows when every limit is full", () => {
    const counts: [RequestKind, number][] = [
      ["page", 1],
      ["link", 30],
      ["image", 20],
      ["sitemap", 25],
      ["feed", 3],
      ["script", 15],
    ];
    const rows = toRows(
      counts.flatMap(([kind, n]) =>
        Array.from({ length: n }, (_, i) =>
          req({ kind, url: `https://shop.example/${kind}/${i}` }),
        ),
      ),
    );
    expect(rows).toHaveLength(94);
    expect(LIMIT_ROWS).toBe(94);
  });
});

describe("the answer phrase", () => {
  const table: [Partial<RequestRow>, string][] = [
    [{ status: 200 }, "Loaded"],
    [{ status: 204 }, "Loaded"],
    [{ status: 301, location: "https://shop.example/new" }, "Moved to https://shop.example/new"],
    [{ status: 302, location: "https://shop.example/new" }, "Moved to https://shop.example/new"],
    [{ status: 404 }, "Not found"],
    [{ status: 410 }, "Not found"],
    [{ status: 500 }, "Server error"],
    [{ status: 503 }, "Server error"],
    [{ status: null, error: "timeout" }, "No answer"],
    [{ status: null, error: "no-answer" }, "No answer"],
    [{ status: null, error: "private-address-refused" }, "Not followed (private address)"],
    [{ status: 403 }, "Refused (403)"],
    [{ status: 429 }, "Refused (429)"],
    [{ status: 418 }, "Error 418"],
    [{ status: 301 }, "Moved (no address given)"],
    [{ status: null }, "No answer"],
  ];
  it.each(table)("%j is %s", (over, phrase) => {
    expect(answer(over)).toBe(phrase);
  });
});

describe("isProblem: anything that did not end in a 2xx", () => {
  it.each([
    [200, false],
    [204, false],
    [301, true],
    [404, true],
    [500, true],
    [null, true],
  ])("status %s", (status, expected) => {
    expect(isProblem(toRows([req({ status })])[0]!)).toBe(expected);
  });

  it("a request that was not followed is a problem too", () => {
    expect(isProblem(toRows([req({ status: null, error: "private-address-refused" })])[0]!)).toBe(
      true,
    );
  });
});

describe("footerLines: the sample against the published limits", () => {
  it("says how much was taken out of up to the limit, and how many were found", () => {
    expect(
      footerLines({
        links: { seen: 52, taken: 24, limit: 30 },
        images: { seen: 20, taken: 20, limit: 20 },
        sitemapPages: { seen: 3, taken: 3, limit: 25 },
        feeds: { seen: 1, taken: 1, limit: 3 },
        scripts: { seen: 15, taken: 15, limit: 15 },
      }),
    ).toEqual([
      "24 of up to 30 same-site links (52 found)",
      "20 of up to 20 images",
      "3 of up to 25 sitemap pages",
      "1 of up to 3 feeds",
      "15 of up to 15 JavaScript files",
    ]);
  });

  it("leaves out a kind with nothing found, and kinds that are not part of this table", () => {
    expect(
      footerLines({
        links: { seen: 0, taken: 0, limit: 30 },
        calendars: { seen: 2, taken: 2, limit: 3 },
        images: { seen: 1, taken: 1, limit: 20 },
      }),
    ).toEqual(["1 of up to 20 images"]);
  });
});
