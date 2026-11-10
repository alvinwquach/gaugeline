import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../../snapshot.js";
import type { StatePage, StatePages } from "../../switches/pages.js";
import { MAX_LISTING_PAGES, modelConfigSchema } from "../config.js";
import { readListing } from "../listing.js";

const ORIGIN = "https://fernbrook.example";
const listing = (over: Record<string, unknown> = {}) =>
  modelConfigSchema.parse({
    listings: [{ page: "/news", type: "article", item: "article.card", ...over }],
  }).listings![0]!;

function cards(from: number, to: number): string {
  return Array.from(
    { length: to - from + 1 },
    (_, i) => `<article class="card"><a href="/news/tip-${from + i}">T</a></article>`,
  ).join("");
}

function pages(html: Record<string, string | StatePage>, asked: string[] = []): StatePages {
  return {
    get(url) {
      asked.push(url);
      const h = html[url];
      if (h === undefined)
        return Promise.resolve({ ok: false, url, kind: "gone", message: "the page answers 404" });
      if (typeof h !== "string") return Promise.resolve(h);
      return Promise.resolve({
        ok: true,
        url,
        page: buildSnapshot([
          { url, status: 200, headers: { "content-type": "text/html" }, body: h, truncated: false },
        ] as never),
      });
    },
  };
}
const doc = (body: string, head = "") =>
  `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;

describe("counting a listing across its pages of results", () => {
  it("follows rel=next from the page, counts each entry and keeps the addresses", async () => {
    const asked: string[] = [];
    const got = await readListing(
      listing(),
      ORIGIN,
      pages(
        {
          [`${ORIGIN}/news`]: doc(cards(1, 20), '<link rel="next" href="/news/page/2">'),
          [`${ORIGIN}/news/page/2`]: doc(cards(21, 31)),
        },
        asked,
      ),
    );
    expect(got).toMatchObject({ ok: true, pages: 2, shown: 31, allAddressed: true });
    expect(got.ok && got.slugs[0]).toBe("tip-1");
    expect(got.ok && got.slugs.at(-1)).toBe("tip-31");
    expect(asked).toEqual([`${ORIGIN}/news`, `${ORIGIN}/news/page/2`]);
  });

  it("follows the next selector the config names, and an a[rel=next] link", async () => {
    const withSelector = await readListing(
      listing({ next: "a.older" }),
      ORIGIN,
      pages({
        [`${ORIGIN}/news`]: doc(`${cards(1, 2)}<a class="older" href="?page=2">Older</a>`),
        [`${ORIGIN}/news?page=2`]: doc(cards(3, 3)),
      }),
    );
    expect(withSelector).toMatchObject({ ok: true, pages: 2, shown: 3 });
    const anchor = await readListing(
      listing(),
      ORIGIN,
      pages({
        [`${ORIGIN}/news`]: doc(`${cards(1, 2)}<a rel="next" href="/news/page/2">Older</a>`),
        [`${ORIGIN}/news/page/2`]: doc(cards(3, 4)),
      }),
    );
    expect(anchor).toMatchObject({ ok: true, pages: 2, shown: 4 });
  });

  it("counts an entry once however many pages repeat it", async () => {
    const got = await readListing(
      listing(),
      ORIGIN,
      pages({
        [`${ORIGIN}/news`]: doc(cards(1, 3), '<link rel="next" href="/news/page/2">'),
        [`${ORIGIN}/news/page/2`]: doc(cards(2, 4)),
      }),
    );
    expect(got).toMatchObject({ ok: true, shown: 4 });
  });

  it("stops at a loop, and does not follow a link to another site", async () => {
    const loop = await readListing(
      listing(),
      ORIGIN,
      pages({ [`${ORIGIN}/news`]: doc(cards(1, 2), '<link rel="next" href="/news">') }),
    );
    expect(loop).toMatchObject({ ok: true, pages: 1, shown: 2 });
    const away = await readListing(
      listing(),
      ORIGIN,
      pages({
        [`${ORIGIN}/news`]: doc(
          cards(1, 2),
          '<link rel="next" href="https://other.example/news/2">',
        ),
      }),
    );
    expect(away).toMatchObject({ ok: true, pages: 1 });
  });

  it("gives no count when a page cannot be read: a partial count would call entries missing", async () => {
    const got = await readListing(
      listing(),
      ORIGIN,
      pages({ [`${ORIGIN}/news`]: doc(cards(1, 2), '<link rel="next" href="/news/page/2">') }),
    );
    expect(got).toEqual({ ok: false, reason: "the page answers 404" });
  });

  it(`gives no count for a listing longer than ${MAX_LISTING_PAGES} pages`, async () => {
    const all: Record<string, string> = {};
    for (let i = 1; i <= MAX_LISTING_PAGES + 2; i++)
      all[`${ORIGIN}${i === 1 ? "/news" : `/news/page/${i}`}`] = doc(
        cards(i, i),
        `<link rel="next" href="/news/page/${i + 1}">`,
      );
    const got = await readListing(listing(), ORIGIN, pages(all));
    expect(got.ok).toBe(false);
    expect(!got.ok && got.reason).toContain(`more than ${MAX_LISTING_PAGES} pages`);
  });

  it("counts an entry with no link, and says the missing ones cannot then be named", async () => {
    const got = await readListing(
      listing(),
      ORIGIN,
      pages({ [`${ORIGIN}/news`]: doc(`${cards(1, 2)}<article class="card">No link</article>`) }),
    );
    expect(got).toMatchObject({ ok: true, shown: 3, allAddressed: false });
  });

  it("an entry that is itself the link is read too, and a percent-encoded slug is decoded", async () => {
    const got = await readListing(
      listing({ item: "a.card" }),
      ORIGIN,
      pages({ [`${ORIGIN}/news`]: doc('<a class="card" href="/news/caf%C3%A9-tips">x</a>') }),
    );
    expect(got).toMatchObject({ ok: true, shown: 1, slugs: ["caf\u00E9-tips"] });
  });

  it("a listing that matches nothing has zero entries", async () => {
    expect(
      await readListing(
        listing({ item: ".nope" }),
        ORIGIN,
        pages({ [`${ORIGIN}/news`]: doc(cards(1, 3)) }),
      ),
    ).toMatchObject({ ok: true, shown: 0 });
  });
});
