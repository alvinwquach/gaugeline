import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readPdf } from "../../../../documents/src/index.js";
import { makePdf, type PdfLine } from "../../../../testkit/src/pdf.js";
import type { DocumentReader, ReferenceItem } from "../../documents/types.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import { parseListedHours } from "../../listings/hours.js";
import type { ListingsRead } from "../../listings/read.js";
import type { CheckContext, Finding } from "../../model.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import {
  documentHoursMismatch,
  documentItemMissing,
  documentPriceMismatch,
  documentUnreadable,
} from "../documents.js";

const SITE = "https://harbor.example";
const reader: DocumentReader = { read: (bytes, limits) => readPdf(bytes, limits) };

interface Served {
  body: Buffer;
  status?: number;
  headers?: Record<string, string>;
}

/** A site that serves invented documents from memory, and records each request. */
function serve(files: Record<string, Served>, redirects: Record<string, string> = {}) {
  const seen: string[] = [];
  const transport: Transport = (url, req) => {
    seen.push(`${req.method} ${url.href}`);
    const to = redirects[url.href];
    if (to)
      return Promise.resolve({ status: 302, headers: { location: to }, body: Readable.from([]) });
    const f = files[url.href];
    if (!f) return Promise.resolve({ status: 404, headers: {}, body: Readable.from([]) });
    const headers = {
      "content-type": "application/pdf",
      "content-length": String(f.body.length),
      ...f.headers,
    };
    return Promise.resolve({
      status: f.status ?? 200,
      headers,
      body: Readable.from(req.method === "HEAD" ? [] : [f.body]),
    });
  };
  return { transport, seen };
}

function menuPage(links = '<a href="/menu.pdf">Download our menu (PDF)</a>'): PageSnapshot {
  return buildSnapshot([
    {
      url: `${SITE}/menu`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body><h1>Menu</h1>${links}</body></html>`,
      ms: 1,
    },
  ]);
}

function context(
  files: Record<string, Served>,
  extra: Partial<CheckContext> & {
    reference?: ReferenceItem[];
    reader?: DocumentReader | null;
  } = {},
  redirects: Record<string, string> = {},
) {
  const { transport, seen } = serve(files, redirects);
  const notices: { url: string; reason: string }[] = [];
  const { reference, reader: given, ...rest } = extra;
  const page = menuPage();
  const ctx: CheckContext = {
    warn: () => undefined,
    fetcher: createFetcher({ transport }),
    budget: createBudget(),
    pages: async () => [page],
    couldNotCheck: (url, reason) => notices.push({ url, reason }),
    documents: {
      ...(given === null ? {} : { reader: given ?? reader }),
      ...(reference ? { reference: async () => reference } : {}),
    },
    ...rest,
  };
  return { ctx, page, notices, seen };
}

const cms = (name: string, dollars: number): ReferenceItem => ({
  name,
  key: name.toLowerCase().replace(/[^a-z0-9]/g, ""),
  amount: Math.round(dollars * 100),
  source: "your content system",
});

const MENU: PdfLine[] = [
  ["Smash Burger", "$14.00"],
  ["Fish Tacos", "$12.00"],
  ["Ube Fries", "$7.00"],
  ["Cold Brew", "$4.50"],
  "Open Fri-Sat 4pm-2am; Sun noon-9pm",
];

const text = (f: Finding[]) => f.map((x) => x.evidence);

describe("documents: integration (invented PDFs with a text layer, invented CMS records)", () => {
  it("a menu with two prices out of date and one item removed from the CMS", async () => {
    const files = {
      [`${SITE}/menu.pdf`]: {
        body: makePdf([MENU]),
        headers: { "last-modified": "Mon, 02 Mar 2026 10:00:00 GMT" },
      },
    };
    const reference = [
      cms("Smash Burger", 16),
      cms("Fish Tacos", 12),
      cms("Cold Brew", 5),
      cms("Pickled Okra", 6),
    ];
    const { ctx, page, notices } = context(files, { reference });

    const prices = await documentPriceMismatch.run(page, ctx);
    expect(prices).toHaveLength(1);
    expect(prices[0]).toMatchObject({
      checkId: "document-price-mismatch",
      severity: "high",
      url: `${SITE}/menu.pdf`,
    });
    expect(prices[0]?.evidence).toContain(
      "Smash Burger: the document says $14.00, your content system says $16.00",
    );
    expect(prices[0]?.evidence).toContain(
      "Cold Brew: the document says $4.50, your content system says $5.00",
    );
    expect(prices[0]?.evidence).not.toContain("Fish Tacos");
    expect(prices[0]?.evidence).toContain("last modified Mon, 02 Mar 2026 10:00:00 GMT");

    const missing = await documentItemMissing.run(page, ctx);
    expect(text(missing)).toHaveLength(1);
    expect(missing[0]?.evidence).toContain("On the site but not in the document: Pickled Okra");
    expect(missing[0]?.evidence).toContain("In the document but not on the site: Ube Fries");
    expect(notices).toEqual([]);
  });

  it("reads the document once for all four checks", async () => {
    const files = { [`${SITE}/menu.pdf`]: { body: makePdf([MENU]) } };
    const { ctx, page, seen } = context(files, { reference: [cms("Smash Burger", 16)] });
    await documentPriceMismatch.run(page, ctx);
    await documentItemMissing.run(page, ctx);
    await documentHoursMismatch.run(page, ctx);
    await documentUnreadable.run(page, ctx);
    expect(seen.filter((s) => s.startsWith("GET"))).toEqual([`GET ${SITE}/menu.pdf`]);
  });

  it("falls back to the page's own text when no CMS is connected", async () => {
    const files = { [`${SITE}/menu.pdf`]: { body: makePdf([MENU]) } };
    const { ctx } = context(files);
    const page = buildSnapshot([
      {
        url: `${SITE}/menu`,
        status: 200,
        headers: { "content-type": "text/html" },
        body: '<html><body><a href="/menu.pdf">Menu PDF</a><ul><li>Smash Burger $16</li><li>Fish Tacos $12</li><li>Cold Brew $4.50</li></ul></body></html>',
        ms: 1,
      },
    ]);
    const found = await documentPriceMismatch.run(page, { ...ctx, pages: async () => [page] });
    expect(found[0]?.evidence).toContain(
      "Smash Burger: the document says $14.00, the page /menu says $16.00",
    );
    expect(found[0]?.evidence).not.toContain("Cold Brew");
  });

  it("hours in the document differ from the site's footer and the Google listing", async () => {
    const files = { [`${SITE}/menu.pdf`]: { body: makePdf([MENU]) } };
    const listings: ListingsRead = {
      listings: [
        {
          source: "google-business",
          label: "Google Business Profile",
          status: "open",
          hours: parseListedHours("Fri-Sat 4pm-midnight; Sun noon-9pm"),
        },
      ],
      notices: [],
      links: new Map(),
    };
    const { ctx, page } = context(files, {
      facts: { facts: [{ id: "hours", kind: "hours", value: "Fri-Sat 4pm-1am; Sun noon-9pm" }] },
      listings: async () => listings,
      now: () => new Date("2026-11-10T18:00:00Z"),
    });
    const found = await documentHoursMismatch.run(page, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.checkId).toBe("document-hours-mismatch");
    expect(found[0]?.evidence).toContain(
      "Friday: the document says 4pm-2am, your site says 4pm-1am",
    );
    expect(found[0]?.evidence).toContain(
      "Friday: the document says 4pm-2am, Google Business Profile says 4pm-midnight",
    );
    expect(found[0]?.evidence).not.toContain("Sunday");
  });

  it("the package not installed: could-not-check with the install hint, nothing else", async () => {
    const files = { [`${SITE}/menu.pdf`]: { body: makePdf([MENU]) } };
    const { ctx, page, notices } = context(files, { reader: null });
    // No injected reader: the real loader looks for @gaugeline/documents, which core does not depend on.
    for (const check of [
      documentPriceMismatch,
      documentItemMissing,
      documentHoursMismatch,
      documentUnreadable,
    ])
      expect(await check.run(page, ctx)).toEqual([]);
    expect(notices.length).toBeGreaterThan(0);
    expect(
      notices.every((n) => n.reason.includes("install @gaugeline/documents to read PDFs")),
    ).toBe(true);
  });
});

describe("documents: edge cases", () => {
  it("a scanned PDF is document-unreadable (low severity) with the reason, and no price is guessed", async () => {
    const files = { [`${SITE}/menu.pdf`]: { body: makePdf([["x"]], { scanned: true }) } };
    const { ctx, page } = context(files, { reference: [cms("Smash Burger", 16)] });
    const found = await documentUnreadable.run(page, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "document-unreadable",
      severity: "low",
      url: `${SITE}/menu.pdf`,
    });
    expect(found[0]?.evidence).toContain("no text layer");
    expect(await documentPriceMismatch.run(page, ctx)).toEqual([]);
    expect(await documentItemMissing.run(page, ctx)).toEqual([]);
  });

  it("an encrypted PDF is unreadable, not passed", async () => {
    const files = { [`${SITE}/menu.pdf`]: { body: makePdf([MENU], { encrypted: true }) } };
    const { ctx, page } = context(files);
    expect((await documentUnreadable.run(page, ctx))[0]?.evidence).toContain("encrypted");
  });

  it("a 40 MB brochure is skipped with the size reason, and never downloaded", async () => {
    const big = Buffer.alloc(40 * 1024 * 1024, 1);
    const files = {
      [`${SITE}/menu.pdf`]: { body: big, headers: { "content-length": String(big.length) } },
    };
    const { ctx, page, notices, seen } = context(files);
    expect(await documentPriceMismatch.run(page, ctx)).toEqual([]);
    expect(notices[0]?.reason).toContain("40 MB");
    expect(notices[0]?.reason).toContain("10 MB");
    expect(seen.filter((s) => s.startsWith("GET"))).toEqual([]);
  });

  it("a PDF behind a redirect to a file host is followed, and the evidence shows the final URL", async () => {
    const final = "https://files.example/hp/menu-v3.pdf";
    const files = { [final]: { body: makePdf([MENU]) } };
    const { ctx, page } = context(
      files,
      { reference: [cms("Smash Burger", 16)] },
      { [`${SITE}/menu.pdf`]: final },
    );
    const found = await documentPriceMismatch.run(page, ctx);
    expect(found[0]?.url).toBe(final);
    expect(found[0]?.evidence).toContain(final);
  });

  it("a page with no document link finds nothing, and says nothing", async () => {
    const { ctx, notices } = context({});
    const page = menuPage("<p>No downloads here</p>");
    expect(await documentPriceMismatch.run(page, { ...ctx, pages: async () => [page] })).toEqual(
      [],
    );
    expect(notices).toEqual([]);
  });

  it("a link that says menu but leads to an HTML page is not a document", async () => {
    const files = {
      [`${SITE}/our-menu`]: {
        body: Buffer.from("<html></html>"),
        headers: { "content-type": "text/html" },
      },
    };
    const page = menuPage('<a href="/our-menu">See the menu</a>');
    const { ctx, notices } = context(files);
    expect(await documentUnreadable.run(page, { ...ctx, pages: async () => [page] })).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("a file that is cut off by the download is unread, never partly read", async () => {
    const whole = makePdf([MENU]);
    const files = {
      [`${SITE}/menu.pdf`]: {
        body: whole.subarray(0, whole.length - 40),
        headers: { "content-length": "99" },
      },
    };
    const { ctx, page, notices } = context(files);
    await documentPriceMismatch.run(page, ctx);
    expect(notices[0]?.reason).toMatch(/ends early|cut/);
  });

  it("an item named __proto__ in a document does not break the comparison", async () => {
    const files = { [`${SITE}/menu.pdf`]: { body: makePdf([[["__proto__ Wrap", "$9.00"]]]) } };
    const { ctx, page } = context(files, { reference: [cms("__proto__ Wrap", 10)] });
    const found = await documentPriceMismatch.run(page, ctx);
    expect(found[0]?.evidence).toContain("$9.00");
  });
});
