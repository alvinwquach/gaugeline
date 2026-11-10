// check-community: allow-email (invented addresses at a reserved example domain, as mailto links the buy-button test must not treat as an address to buy at)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import type { Check, Finding } from "../../model.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { checkSite } from "../../site.js";
import { assetFilePublic } from "../asset-file-public.js";
import { checkoutJsOnly } from "../checkout-js-only.js";
import { PAGE_CHECKS, createPageRegistry } from "../index.js";
import {
  buyButtons,
  isAssetStoreFile,
  isSignedLink,
  publicFileAddress,
  showsPrice,
} from "../paid-files.js";
import { paidFilePublic } from "../paid-file-public.js";

const URL0 = "https://tideline-coaching.example/plans/";

function snap(body: string, head = "", url = URL0): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Tideline Coaching</title>${head}</head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

async function run(check: Check<PageSnapshot>, s: PageSnapshot): Promise<Finding[]> {
  return (await check.run(s, { warn: () => undefined })) as Finding[];
}

const PLAN = "https://cdn.sanity.io/files/k3x9q2/production/7e1c5a0b9d-7-day-plan.pdf";
const BROCHURE = "https://cdn.sanity.io/files/k3x9q2/production/2a4f6c8e01-brochure.pdf";
const TERMS = "https://cdn.sanity.io/files/k3x9q2/production/c0ffee0123-terms.pdf";
const LD = (offer: string): string =>
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"7-day plan","offers":${offer}}</script>`;

// ---- unit: isAssetStoreFile ---------------------------------------------------------------------

describe("isAssetStoreFile: unit", () => {
  const cases: { name: string; url: string; yes: boolean }[] = [
    { name: "a pdf on Sanity's file CDN", url: PLAN, yes: true },
    {
      name: "the same host with a jpg",
      url: "https://cdn.sanity.io/images/k3x9q2/production/9f8e7d-1200x800.jpg",
      yes: false,
    },
    {
      name: "a pdf on the site's own domain",
      url: "https://tideline-coaching.example/downloads/7-day-plan.pdf",
      yes: false,
    },
    {
      name: "a pdf with a query string and a fragment",
      url: `${PLAN}?dl=plan.pdf#page=2`,
      yes: true,
    },
    { name: "an upper-case extension", url: PLAN.replace(".pdf", ".PDF"), yes: true },
    {
      name: "a type nobody sells (txt) on the file CDN",
      url: "https://cdn.sanity.io/files/k3x9q2/production/9f8e7d.txt",
      yes: false,
    },
    {
      name: "a bucket host with a zip",
      url: "https://tideline-assets.s3.eu-west-2.amazonaws.com/plans/7-day.zip",
      yes: true,
    },
    {
      name: "the older path-style S3 host with an epub",
      url: "https://s3.amazonaws.com/tideline-assets/guide.epub",
      yes: true,
    },
    {
      name: "a Google Cloud Storage bucket with an mp3",
      url: "https://storage.googleapis.com/tideline-assets/warm-up.mp3",
      yes: true,
    },
    {
      name: "an Azure blob host with a docx",
      url: "https://tideline.blob.core.windows.net/files/workbook.docx",
      yes: true,
    },
    {
      name: "an R2 public host with an mp4",
      url: "https://pub-1a2b3c.r2.dev/lesson-1.mp4",
      yes: true,
    },
    {
      name: "an UploadThing file with an xlsx",
      url: "https://utfs.io/f/abc123-budget.xlsx",
      yes: true,
    },
    {
      name: "a public Supabase storage path",
      url: "https://abcdefgh.supabase.co/storage/v1/object/public/plans/week-1.pdf",
      yes: true,
    },
    {
      name: "a signed Supabase storage path",
      url: "https://abcdefgh.supabase.co/storage/v1/object/sign/plans/week-1.pdf",
      yes: false,
    },
    {
      name: "a Cloudinary upload",
      url: "https://res.cloudinary.com/tideline/raw/upload/v1/plans/week-1.pdf",
      yes: true,
    },
    {
      name: "a host that only ends with the store's name",
      url: "https://notcdn.sanity.io.example/files/k3x9q2/production/9f8e7d.pdf",
      yes: false,
    },
    {
      name: "a host that contains the store's name before another domain",
      url: "https://cdn.sanity.io.attacker.example/files/a/b/c.pdf",
      yes: false,
    },
    { name: "a relative path", url: "/files/k3x9q2/production/9f8e7d.pdf", yes: false },
    { name: "a mailto link", url: "mailto:hello@tideline-coaching.example", yes: false },
    { name: "text that is not an address", url: "not a url.pdf", yes: false },
    {
      name: "a bucket address with no file name",
      url: "https://storage.googleapis.com/tideline/",
      yes: false,
    },
  ];
  for (const c of cases) {
    it(`${c.name}: ${c.yes ? "yes" : "no"}`, () => {
      expect(isAssetStoreFile(c.url)).toBe(c.yes);
    });
  }
});

describe("isSignedLink and publicFileAddress: unit", () => {
  it("a signature and an expiry together are a signed link, in each store's spelling", () => {
    expect(isSignedLink(`${PLAN}?Expires=1893456000&Signature=abc&Key-Pair-Id=K2X`)).toBe(true);
    expect(isSignedLink(`${PLAN}?X-Amz-Expires=300&X-Amz-Signature=abc&X-Amz-Date=20260101`)).toBe(
      true,
    );
    expect(isSignedLink(`${PLAN}?X-Goog-Expires=300&X-Goog-Signature=abc`)).toBe(true);
    expect(isSignedLink(`${PLAN}?se=2026-12-01T00%3A00%3A00Z&sig=abc`)).toBe(true);
    expect(isSignedLink(`${PLAN}?expires=1893456000&signature=abc`)).toBe(true);
  });

  it("an expiry alone, a signature alone, or an empty value is not enough", () => {
    expect(isSignedLink(`${PLAN}?expires=1893456000`)).toBe(false);
    expect(isSignedLink(`${PLAN}?Signature=abc`)).toBe(false);
    expect(isSignedLink(`${PLAN}?Expires=&Signature=abc`)).toBe(false);
    expect(isSignedLink(`${PLAN}?dl=plan.pdf`)).toBe(false);
    expect(isSignedLink(PLAN)).toBe(false);
    expect(isSignedLink("nonsense")).toBe(false);
  });

  it("prints the host and the path and nothing after them", () => {
    expect(publicFileAddress(`${PLAN}?Signature=secret&Expires=1#frag`)).toBe(
      "cdn.sanity.io/files/k3x9q2/production/7e1c5a0b9d-7-day-plan.pdf",
    );
  });
});

// ---- unit: showsPrice ---------------------------------------------------------------------------

describe("showsPrice: unit", () => {
  const cases: { text: string; yes: boolean }[] = [
    { text: "The 7-day plan is $48", yes: true },
    { text: "Plan: 48 USD", yes: true },
    { text: "from \u00A39.50", yes: true },
    { text: "Only 48,00 \u20AC this week", yes: true },
    { text: "USD 12", yes: true },
    { text: "Save $5 today", yes: true },
    { text: "1,200 USD for the year", yes: true },
    { text: "\u20B9499 per month", yes: true },
    { text: "Call us on 555-0123", yes: false },
    { text: "Call (555) 010-0199 or 555 0123", yes: false },
    { text: "Coaching since 2019", yes: false },
    { text: "Open 9 to 5, room 4800", yes: false },
    { text: "Free download, $0", yes: false },
    { text: "Priced in dollars, euros and pounds", yes: false },
    { text: "48 usd", yes: false },
    { text: "", yes: false },
  ];
  for (const c of cases) {
    it(`"${c.text}": ${c.yes ? "a price" : "not a price"}`, () => {
      expect(showsPrice(snap(`<p>${c.text}</p>`))).toBe(c.yes);
    });
  }

  it("reads an Offer price in the structured data when the page shows none", () => {
    expect(
      showsPrice(
        snap("<p>Plan</p>", LD('{"@type":"Offer","price":"48.00","priceCurrency":"USD"}')),
      ),
    ).toBe(true);
    expect(
      showsPrice(snap("<p>Plan</p>", LD('[{"@type":"Offer","price":19,"priceCurrency":"GBP"}]'))),
    ).toBe(true);
    expect(
      showsPrice(
        snap(
          "<p>Plan</p>",
          LD('{"@type":"AggregateOffer","lowPrice":"9.50","priceCurrency":"GBP"}'),
        ),
      ),
    ).toBe(true);
    expect(
      showsPrice(
        snap(
          "<p>Plan</p>",
          '<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Product","offers":{"@type":"Offer","price":"12"}}]}</script>',
        ),
      ),
    ).toBe(true);
  });

  it("a free offer, a missing price and text that is not a number are not prices", () => {
    expect(
      showsPrice(snap("<p>Plan</p>", LD('{"@type":"Offer","price":"0","priceCurrency":"USD"}'))),
    ).toBe(false);
    expect(showsPrice(snap("<p>Plan</p>", LD('{"@type":"Offer","availability":"InStock"}')))).toBe(
      false,
    );
    expect(showsPrice(snap("<p>Plan</p>", LD('{"@type":"Offer","price":"call us"}')))).toBe(false);
  });

  it("does not read text a visitor cannot see", () => {
    expect(
      showsPrice(
        snap('<p style="display:none">$48</p><div hidden>$48</div><script>var p = "$48";</script>'),
      ),
    ).toBe(false);
  });
});

// ---- unit: buyButtons ---------------------------------------------------------------------------

describe("buyButtons: unit", () => {
  it("a button with no form is a buy button with nothing behind it", () => {
    const found = buyButtons(snap('<button class="btn">Buy now</button>'));
    expect(found).toEqual([
      { kind: "button", text: "Buy now", linkable: false, how: "a button that is not in a form" },
    ]);
  });

  it("an anchor with an address can be linked to", () => {
    const found = buyButtons(
      snap('<a class="btn" href="https://buy.stripe.com/test_7sY00cd1Q">Buy now</a>'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "a", text: "Buy now", linkable: true });
  });

  it("a submit button inside a form with an action can be linked to", () => {
    const found = buyButtons(
      snap(
        '<form action="/cart/add" method="post"><button type="submit">Add to cart</button></form>',
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "button", text: "Add to cart", linkable: true });
    const bare = buyButtons(snap('<form action="/cart/add"><button>Add to cart</button></form>'));
    expect(bare[0]?.linkable).toBe(true);
    const input = buyButtons(
      snap('<form action="/checkout"><input type="submit" value="Checkout"></form>'),
    );
    expect(input[0]).toMatchObject({ kind: "input", text: "Checkout", linkable: true });
  });

  it("a submit button in a form with no action, or a button that is not a submit button, cannot", () => {
    const noAction = buyButtons(snap("<form><button>Add to cart</button></form>"));
    expect(noAction[0]).toMatchObject({
      linkable: false,
      how: "a button in a form with no action",
    });
    const emptyAction = buyButtons(
      snap('<form action=" "><button type="submit">Purchase</button></form>'),
    );
    expect(emptyAction[0]?.linkable).toBe(false);
    const plainButton = buyButtons(
      snap('<form action="/cart/add"><button type="button">Add to cart</button></form>'),
    );
    expect(plainButton[0]).toMatchObject({
      linkable: false,
      how: "a button that does not submit its form",
    });
    const scriptAction = buyButtons(
      snap('<form action="javascript:void(0)"><button>Buy</button></form>'),
    );
    expect(scriptAction[0]?.linkable).toBe(false);
  });

  it("a button's own formaction gives a form with no action an address", () => {
    const found = buyButtons(
      snap('<form><button formaction="/cart/add">Add to cart</button></form>'),
    );
    expect(found[0]?.linkable).toBe(true);
  });

  it('an anchor with href="#", an empty href, a script address or a mailto link has no address', () => {
    for (const href of [
      "#",
      "",
      "#buy",
      "javascript:void(0)",
      "mailto:hello@tideline-coaching.example",
    ]) {
      const found = buyButtons(snap(`<a class="btn" href="${href}">Buy now</a>`));
      expect(found, href).toHaveLength(1);
      expect(found[0]?.linkable, href).toBe(false);
    }
    expect(buyButtons(snap('<a class="btn">Buy now</a>'))[0]).toMatchObject({
      linkable: false,
      how: "a link with no address",
    });
  });

  it("a div with a click handler, and a role=button element, are buttons with nothing behind them", () => {
    const found = buyButtons(
      snap(
        '<div class="btn" onclick="openCheckout()">Get it</div><span role="button" tabindex="0">Purchase</span>',
      ),
    );
    expect(found.map((b) => [b.kind, b.text, b.linkable])).toEqual([
      ["other", "Get it", false],
      ["other", "Purchase", false],
    ]);
    expect(found[0]?.how).toBe("an element with a click handler");
  });

  it("matches buy, add to cart, checkout, get it, purchase and download now, and nothing else", () => {
    const wanted = [
      "Buy",
      "Buy now",
      "Add to cart",
      "Add to bag",
      "Checkout",
      "Get it now",
      "Purchase",
      "Download now",
      "BUY THE PLAN",
    ];
    const other = [
      "Read more",
      "Contact us",
      "Forget it",
      "Download",
      "Buyer's guide",
      "Learn how to buy ethically and well and with care for the people who make things for you",
    ];
    const html = [...wanted, ...other].map((t) => `<button>${t}</button>`).join("");
    expect(buyButtons(snap(html)).map((b) => b.text)).toEqual(wanted);
  });

  it("leaves out buttons a visitor cannot see", () => {
    const html =
      '<button hidden>Buy now</button><div aria-hidden="true"><button>Buy now</button></div><p style="display:none"><a href="/x">Buy now</a></p>';
    expect(buyButtons(snap(html))).toEqual([]);
  });

  it("cuts and escapes the text it reports", () => {
    const found = buyButtons(snap("<button>Buy\u200B now</button>"));
    expect(found[0]?.text).toBe("Buy now");
  });
});

// ---- unit: the three checks ---------------------------------------------------------------------

describe("paid-file-public: unit", () => {
  it("a page with a price and a link to a pdf on the asset CDN: one high finding", async () => {
    const s = snap(
      `<h1>The 7-day plan</h1><p>$48</p><a href="${PLAN}">Download the 7-day plan</a>`,
    );
    expect(await run(paidFilePublic, s)).toEqual([
      {
        checkId: "paid-file-public",
        severity: "high",
        title: paidFilePublic.title,
        evidence:
          '"Download the 7-day plan" links to cdn.sanity.io/files/k3x9q2/production/7e1c5a0b9d-7-day-plan.pdf, a public asset address, and the page shows a price.',
        url: URL0,
      },
    ]);
    expect(await run(assetFilePublic, s)).toEqual([]);
  });

  it("strips the query string, which may carry a signature, from what it prints", async () => {
    const s = snap(`<p>$48</p><a href="${PLAN}?token=do-not-print&dl=1">Get the plan</a>`);
    const [f] = await run(paidFilePublic, s);
    expect(f?.evidence).not.toContain("do-not-print");
    expect(f?.evidence).not.toContain("?");
  });

  it("one finding per file, however many links point to it", async () => {
    const s = snap(
      `<p>$48</p><a href="${PLAN}">Download</a><a href="${PLAN}?dl=1">Download again</a><a href="${BROCHURE}">Brochure</a>`,
    );
    const found = await run(paidFilePublic, s);
    expect(found).toHaveLength(2);
    expect(found[0]?.evidence).toContain('"Download"');
  });

  it("a price in the structured data is enough", async () => {
    const s = snap(
      `<a href="${PLAN}">Download</a>`,
      LD('{"@type":"Offer","price":"48.00","priceCurrency":"USD"}'),
    );
    expect(await run(paidFilePublic, s)).toHaveLength(1);
  });

  it("a signed link with an expiry is a pass", async () => {
    const s = snap(
      `<p>$48</p><a href="${PLAN}?X-Amz-Expires=300&X-Amz-Signature=0f1e2d3c&X-Amz-Date=20260101T000000Z">Download</a>`,
    );
    expect(await run(paidFilePublic, s)).toEqual([]);
    expect(await run(assetFilePublic, s)).toEqual([]);
  });

  it("a link on the site's own domain, an image and a page with no price are not this finding", async () => {
    expect(
      await run(paidFilePublic, snap('<p>$48</p><a href="/downloads/plan.pdf">Plan</a>')),
    ).toEqual([]);
    expect(
      await run(
        paidFilePublic,
        snap(
          '<p>$48</p><a href="https://cdn.sanity.io/images/k3x9q2/production/a-1x1.jpg">Photo</a>',
        ),
      ),
    ).toEqual([]);
    expect(await run(paidFilePublic, snap(`<a href="${PLAN}">Plan</a>`))).toEqual([]);
  });

  it("a page that did not load as HTML is not judged", async () => {
    const s = { ...snap(`<p>$48</p><a href="${PLAN}">Plan</a>`), status: 404 };
    expect(await run(paidFilePublic, s)).toEqual([]);
    expect(await run(assetFilePublic, s)).toEqual([]);
    expect(await run(checkoutJsOnly, s)).toEqual([]);
  });

  it("names a link with no text, and escapes invisible characters in the text it quotes", async () => {
    const s = snap(`<p>$48</p><a href="${PLAN}"><img src="/x.png" alt=""></a>`);
    expect((await run(paidFilePublic, s))[0]?.evidence).toContain("A link with no text");
    const odd = snap(`<p>$48</p><a href="${PLAN}">Plan\u202E</a>`);
    expect((await run(paidFilePublic, odd))[0]?.evidence).toContain('"Plan\\u{202E}"');
  });
});

describe("asset-file-public: unit", () => {
  it("a page with a pdf on the asset CDN and no price: one low finding", async () => {
    const s = snap(`<h1>Press</h1><a href="${BROCHURE}">Download our brochure</a>`);
    expect(await run(assetFilePublic, s)).toEqual([
      {
        checkId: "asset-file-public",
        severity: "low",
        title: assetFilePublic.title,
        evidence:
          'Links to a downloadable file on a public asset address: "Download our brochure" (cdn.sanity.io/files/k3x9q2/production/2a4f6c8e01-brochure.pdf).',
        url: URL0,
      },
    ]);
    expect(await run(paidFilePublic, s)).toEqual([]);
  });

  it("lists several files in one finding and says how many more", async () => {
    const links = Array.from(
      { length: 8 },
      (_, i) =>
        `<a href="https://cdn.sanity.io/files/k3x9q2/production/${String(i).padStart(10, "a")}.pdf">Sheet ${i}</a>`,
    ).join("");
    const found = await run(assetFilePublic, snap(links));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("and 3 more");
  });

  it("terms, privacy and policy links are low even when the page shows a price", async () => {
    for (const text of ["Terms of sale", "Privacy notice", "Refund policy", "TERMS"]) {
      const s = snap(`<p>$48</p><footer><a href="${TERMS}">${text}</a></footer>`);
      expect(await run(paidFilePublic, s), text).toEqual([]);
      const low = await run(assetFilePublic, s);
      expect(low, text).toHaveLength(1);
      expect(low[0]?.severity).toBe("low");
    }
  });

  it("a price, a sales file and a terms file together: one high and one low", async () => {
    const s = snap(
      `<p>$48</p><a href="${PLAN}">Download the 7-day plan</a><footer><a href="${TERMS}">Terms</a></footer>`,
    );
    expect(await run(paidFilePublic, s)).toHaveLength(1);
    const low = await run(assetFilePublic, s);
    expect(low).toHaveLength(1);
    expect(low[0]?.evidence).toContain("terms.pdf");
  });

  it("one file linked as both Terms and Download is a sales file", async () => {
    const s = snap(`<p>$48</p><a href="${TERMS}">Terms</a><a href="${TERMS}">Download</a>`);
    expect(await run(paidFilePublic, s)).toHaveLength(1);
  });
});

describe("checkout-js-only: unit", () => {
  const PRICE = "<p>$48</p>";

  it("a price and a div styled as a button with a click handler: one medium finding", async () => {
    const s = snap(`${PRICE}<div class="btn" onclick="openCheckout()">Buy now</div>`);
    expect(await run(checkoutJsOnly, s)).toEqual([
      {
        checkId: "checkout-js-only",
        severity: "medium",
        title: checkoutJsOnly.title,
        evidence:
          'The page shows a price and 1 buy button, and none can be linked to: "Buy now" (an element with a click handler).',
        url: URL0,
      },
    ]);
  });

  it("lists up to five buttons and counts the rest", async () => {
    const buttons = Array.from({ length: 7 }, (_, i) => `<button>Buy option ${i}</button>`).join(
      "",
    );
    const [f] = await run(checkoutJsOnly, snap(PRICE + buttons));
    expect(f?.evidence).toContain("7 buy buttons");
    expect(f?.evidence).toContain("and 2 more");
  });

  it("a price and a Stripe payment link in an anchor: no finding", async () => {
    const s = snap(
      `${PRICE}<a class="btn" href="https://buy.stripe.com/test_7sY00cd1Q">Buy now</a>`,
    );
    expect(await run(checkoutJsOnly, s)).toEqual([]);
  });

  it("a link to a hosted payment page anywhere on the page is something to link to", async () => {
    const s = snap(
      `${PRICE}<div onclick="x()">Buy now</div><a href="https://buy.stripe.com/test_7sY00cd1Q">Reserve your place</a>`,
    );
    expect(await run(checkoutJsOnly, s)).toEqual([]);
  });

  it("one linkable buy button is enough, even beside one that is not", async () => {
    const s = snap(
      `${PRICE}<div onclick="x()">Buy now</div><form action="/cart/add"><button>Add to cart</button></form>`,
    );
    expect(await run(checkoutJsOnly, s)).toEqual([]);
  });

  it('an anchor with href="#" counts as no address', async () => {
    const s = snap(`${PRICE}<a class="btn" href="#">Buy now</a>`);
    expect(await run(checkoutJsOnly, s)).toHaveLength(1);
  });

  it("no price, or no buy button, is not this finding", async () => {
    expect(await run(checkoutJsOnly, snap('<div onclick="x()">Buy now</div>'))).toEqual([]);
    expect(await run(checkoutJsOnly, snap(`${PRICE}<p>Call us to order</p>`))).toEqual([]);
  });

  it("a price in the structured data and a submit button with no form action", async () => {
    const s = snap(
      "<form><button>Add to cart</button></form>",
      LD('{"@type":"Offer","price":"48","priceCurrency":"USD"}'),
    );
    expect(await run(checkoutJsOnly, s)).toHaveLength(1);
  });
});

// ---- integration: fixture pages -----------------------------------------------------------------

describe("integration: the paid-downloads fixture", () => {
  async function findingsFor(path: string): Promise<Finding[]> {
    const site = await startFixture("paid-downloads");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const { result } = await checkSite({
        address: `${site.origin}${path}`,
        fetcher,
        only: ["paid-file-public", "asset-file-public", "checkout-js-only"],
      });
      return result.findings;
    } finally {
      await site.close();
    }
  }

  it("the sales page with a price and a link to a pdf on the asset CDN: one high finding", async () => {
    const found = await findingsFor("/plan/");
    expect(found.filter((f) => f.severity === "high")).toHaveLength(1);
    expect(found.filter((f) => f.checkId === "paid-file-public")[0]?.evidence).toContain(
      "cdn.sanity.io/files/k3x9q2/production/",
    );
    expect(found.filter((f) => f.checkId === "checkout-js-only")).toEqual([]);
  });

  it("the press page with a brochure pdf and no price: one low finding", async () => {
    const found = await findingsFor("/press/");
    expect(found.map((f) => [f.checkId, f.severity])).toEqual([["asset-file-public", "low"]]);
  });

  it("a price plus a div styled as a button with a click handler: the js-only finding", async () => {
    const found = await findingsFor("/class/");
    expect(found.map((f) => [f.checkId, f.severity])).toEqual([["checkout-js-only", "medium"]]);
  });

  it("the home page shows all three kinds", async () => {
    const found = await findingsFor("/");
    expect(found.map((f) => f.checkId).sort()).toEqual([
      "asset-file-public",
      "checkout-js-only",
      "paid-file-public",
    ]);
  });
});

// ---- promise: no requests -----------------------------------------------------------------------

describe("promise: the checks send no request", () => {
  it("running the three checks over a loaded page adds no request to the fixture or the fetcher's history", async () => {
    const site = await startFixture("paid-downloads");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const s = buildSnapshot(await fetcher.getSite(`${site.origin}/`));
      const requestsBefore = site.requests.length;
      const historyBefore = fetcher.history?.().length ?? 0;
      let found = 0;
      for (const c of [paidFilePublic, assetFilePublic, checkoutJsOnly]) {
        found += (await run(c, s)).length;
      }
      expect(found).toBeGreaterThan(0);
      expect(site.requests.length).toBe(requestsBefore);
      expect(fetcher.history?.().length ?? 0).toBe(historyBefore);
    } finally {
      await site.close();
    }
  });

  it("a context that throws on any helper still gives findings: the checks use only the snapshot", async () => {
    const trap = (name: string) => () => {
      throw new Error(`${name} was called`);
    };
    const ctx = {
      warn: () => undefined,
      fetcher: new Proxy({}, { get: (_t, p) => trap(String(p)) }) as never,
      site: trap("site"),
      links: trap("links"),
      images: trap("images"),
      pages: trap("pages"),
    };
    const s = snap(`<p>$48</p><a href="${PLAN}">Plan</a><div onclick="x()">Buy now</div>`);
    for (const c of [paidFilePublic, assetFilePublic, checkoutJsOnly]) {
      await expect(Promise.resolve(c.run(s, ctx as never))).resolves.toBeDefined();
    }
  });

  it("the source of the checks imports nothing that can make a request", () => {
    for (const file of [
      "paid-files",
      "paid-file-public",
      "asset-file-public",
      "checkout-js-only",
    ]) {
      const text = readFileSync(fileURLToPath(new URL(`../${file}.ts`, import.meta.url)), "utf8");
      expect(text, file).not.toMatch(/from "\.\.\/(fetcher|fetch\/|transport|net\/)/);
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("is deterministic: the same page gives the same findings twice", async () => {
    const s = snap(
      `<p>$48</p><a href="${PLAN}">Plan</a><a href="${TERMS}">Terms</a><div onclick="x()">Buy now</div>`,
    );
    const once = await Promise.all(
      [paidFilePublic, assetFilePublic, checkoutJsOnly].map((c) => run(c, s)),
    );
    const twice = await Promise.all(
      [paidFilePublic, assetFilePublic, checkoutJsOnly].map((c) => run(c, s)),
    );
    expect(twice).toEqual(once);
  });
});

describe("registry", () => {
  it("registers the three ids in Sales & prices with the spec's levels", () => {
    const reg = createPageRegistry();
    const by = new Map(PAGE_CHECKS.map((c) => [c.id, c]));
    expect(by.get("paid-file-public")).toMatchObject({ severity: "high", area: "Sales & prices" });
    expect(by.get("asset-file-public")).toMatchObject({ severity: "low", area: "Sales & prices" });
    expect(by.get("checkout-js-only")).toMatchObject({
      severity: "medium",
      area: "Sales & prices",
    });
    expect(reg.byArea("Sales & prices").map((c) => c.id)).toEqual(
      expect.arrayContaining(["paid-file-public", "asset-file-public", "checkout-js-only"]),
    );
  });
});
