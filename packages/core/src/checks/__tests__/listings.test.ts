import { describe, expect, it } from "vitest";
import { parseListedHours } from "../../listings/hours.js";
import { BAR_ADDRESS, KEYS, barFetcher, barSettings } from "../../listings/__tests__/helpers.js";
import type { ListingsRead } from "../../listings/read.js";
import type { Listing } from "../../listings/types.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { listingAddressMismatch } from "../listing-address-mismatch.js";
import { listingHoursMismatch } from "../listing-hours-mismatch.js";
import { listingNameMismatch } from "../listing-name-mismatch.js";
import { listingPhoneMismatch } from "../listing-phone-mismatch.js";
import { listingSpecialHoursMissing } from "../listing-special-hours-missing.js";
import { listingWebsiteWrong } from "../listing-website-wrong.js";

const NOW = () => new Date("2026-11-10T18:00:00Z");
const ids = [
  "listing-address-mismatch",
  "listing-hours-mismatch",
  "listing-name-mismatch",
  "listing-phone-mismatch",
  "listing-special-hours-missing",
  "listing-website-wrong",
];

describe("listing checks: integration (recorded API responses only)", () => {
  it("the bar with an old name on Google, Sunday hours that differ on Yelp and a link to the old domain", async () => {
    const { result } = await checkSite({
      address: BAR_ADDRESS,
      fetcher: barFetcher("listings-bucktavern"),
      only: ids,
      now: NOW,
      listings: barSettings(),
      expect: { timeZone: "America/Chicago" },
    });
    expect(result.failed).toEqual([]);
    // Apple's export has no special hours: that is said, never passed over.
    expect(result.couldNotCheck.map((c) => [c.id, c.reason])).toEqual([
      [
        "listing-special-hours-missing",
        "Apple Business Connect gives Gaugeline no special hours, so its holiday closures were not compared.",
      ],
    ]);
    expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
      [
        "listing-hours-mismatch",
        "Friday: Google Business Profile says 4pm-1am, your site says 4pm-2am; Saturday: Google Business Profile says 4pm-1am, your site says 4pm-2am (site hours from the page's structured data)",
      ],
      [
        "listing-hours-mismatch",
        "Sunday: Yelp says noon-9pm, your site says noon-10pm (site hours from the page's structured data)",
      ],
      [
        "listing-name-mismatch",
        'Google Business Profile says "Buckhorn Tavern"; your site says "The BUCK Tavern" (the page\'s structured data)',
      ],
      [
        "listing-phone-mismatch",
        "Yelp says (217) 555-0163; your site says (217) 555-0142 (the page's structured data)",
      ],
      [
        "listing-website-wrong",
        "Google Business Profile: the listing links to buckhorn-tavern.example, which redirects to bucktavern.example",
      ],
      [
        "listing-website-wrong",
        "Instagram bio link: the link-in-bio page https://links.example/bucktavern does not link to bucktavern.example",
      ],
      [
        "listing-address-mismatch",
        'Apple Business Connect says "418 Alder Street, Fairmont Heights, IL 62999"; your site says "412 Alder Street, Fairmont Heights, 62999" (the page\'s structured data)',
      ],
      [
        "listing-special-hours-missing",
        "Google Business Profile has no closure for Thanksgiving (2026-11-26); your site says closed on it (/)",
      ],
    ]);
    expect(result.findings.map((f) => f.severity)).toEqual([
      "high",
      "high",
      "high",
      "high",
      "high",
      "high",
      "medium",
      "medium",
    ]);
    // Looked at only: nothing but GET and HEAD, and no key in any finding.
    for (const key of Object.values(KEYS)) expect(JSON.stringify(result)).not.toContain(key);
  });

  it("a clean bar passes every listing check", async () => {
    const { result } = await checkSite({
      address: BAR_ADDRESS,
      fetcher: barFetcher("listings-places"),
      only: ids,
      now: NOW,
      listings: barSettings(KEYS, { google: { placeId: "ChIJexampleBuckTavern01" } }),
    });
    expect(result.findings).toEqual([]);
    // Places has no special hours, so that check could not compare the closure: reported, not passed.
    expect(result.couldNotCheck.map((c) => c.id)).toEqual(["listing-special-hours-missing"]);
    expect(result.passed.sort()).toEqual(ids.filter((i) => i !== "listing-special-hours-missing"));
  });
});

// ---- unit: each check over a stand-in reader -------------------------------------------------

function page(jsonLd: unknown, body = "<p>Hello</p>"): PageSnapshot {
  const ld = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : "";
  return buildSnapshot([
    {
      url: "https://bucktavern.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<!doctype html><html lang="en"><head><title>x</title>${ld}</head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

const BAR_LD = {
  "@type": "BarOrPub",
  name: "The BUCK Tavern",
  telephone: "(217) 555-0142",
  address: { streetAddress: "412 Alder Street", postalCode: "62999" },
  openingHours: ["Mo-Th 16:00-01:00", "Fr-Sa 16:00-02:00", "Su 12:00-22:00"],
};

function listing(over: Partial<Listing>): Listing {
  return { source: "yelp", label: "Yelp", status: "open", ...over };
}

function ctxWith(
  listings: Listing[],
  extra: Partial<ListingsRead> = {},
  ctx: Partial<CheckContext> = {},
): { ctx: CheckContext; cannot: string[] } {
  const cannot: string[] = [];
  const read: ListingsRead = { listings, notices: [], links: new Map(), ...extra };
  return {
    cannot,
    ctx: {
      warn: () => undefined,
      now: NOW,
      listings: () => Promise.resolve(read),
      couldNotCheck: (_url, reason) => cannot.push(reason),
      ...ctx,
    },
  };
}

describe("with no listing set up", () => {
  it("a run that does not name a listing check does not run them: not passed, not asked of anyone", async () => {
    const { result } = await checkSite({
      address: BAR_ADDRESS,
      fetcher: barFetcher("listings-bucktavern"),
      now: NOW,
    });
    for (const id of ids) {
      expect(result.passed).not.toContain(id);
      expect(result.failed.map((f) => f.id)).not.toContain(id);
    }
    expect(result.couldNotCheck.filter((c) => ids.includes(c.id))).toEqual([]);
  });

  it("a listing check asked for by id says it could not check, never that it passed", async () => {
    const { result } = await checkSite({
      address: BAR_ADDRESS,
      fetcher: barFetcher("listings-bucktavern"),
      only: ["listing-phone-mismatch"],
      now: NOW,
    });
    expect(result.passed).toEqual([]);
    expect(result.couldNotCheck.map((c) => [c.id, c.reason])).toEqual([
      [
        "listing-phone-mismatch",
        "No listing is set up, so listings were not compared. Add gaugeline.listings.json to name your Google, Yelp or Apple listing or your bio links.",
      ],
    ]);
  });

  it("a source named in the config whose key is not set is could-not-check, and the others still run", async () => {
    const { result } = await checkSite({
      address: BAR_ADDRESS,
      fetcher: barFetcher("listings-bucktavern"),
      only: ["listing-phone-mismatch", "listing-name-mismatch"],
      now: NOW,
      listings: barSettings({ ...KEYS, YELP_API_KEY: undefined }),
    });
    expect(result.passed).toEqual([]);
    expect(result.couldNotCheck.map((c) => c.id)).toEqual([
      "listing-name-mismatch",
      "listing-phone-mismatch",
    ]);
    expect(result.couldNotCheck[0]?.reason).toContain("Set YELP_API_KEY to include it.");
    // Google's name is still compared.
    expect(result.findings.map((f) => f.checkId)).toEqual(["listing-name-mismatch"]);
  });
});

describe("name and phone", () => {
  it("'The BUCK Tavern' versus 'Buck Tavern, The' is not a mismatch; the old name is", async () => {
    const { ctx } = ctxWith([
      listing({ name: "Buck Tavern, The" }),
      listing({ name: "Buckhorn Tavern", source: "apple", label: "Apple Business Connect" }),
    ]);
    const found = await listingNameMismatch.run(page(BAR_LD), ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain('Apple Business Connect says "Buckhorn Tavern"');
  });

  it("a phone written another way is the same phone; a different number is not", async () => {
    const { ctx } = ctxWith([
      listing({ phone: "+1 217-555-0142" }),
      listing({ phone: "(217) 555-0199", label: "Google Maps", source: "google-places" }),
    ]);
    const found = await listingPhoneMismatch.run(page(BAR_LD), ctx);
    expect(found.map((f) => f.evidence)).toEqual([
      "Google Maps says (217) 555-0199; your site says (217) 555-0142 (the page's structured data)",
    ]);
  });

  it("a site that states no name is could-not-check, not a pass", async () => {
    const { ctx, cannot } = ctxWith([listing({ name: "Whatever" })]);
    expect(await listingNameMismatch.run(page(undefined), ctx)).toEqual([]);
    expect(cannot[0]).toMatch(/states no business name/);
  });

  it("a name declared in gaugeline.facts.json beats the structured data", async () => {
    const { ctx } = ctxWith(
      [listing({ name: "The BUCK Tavern" })],
      {},
      {
        facts: { facts: [{ id: "name", kind: "text", value: "Buckhorn Tavern" }] },
      },
    );
    const found = await listingNameMismatch.run(page(BAR_LD), ctx);
    expect(found[0]?.evidence).toContain("(gaugeline.facts.json)");
  });
});

describe("hours", () => {
  const SITE = page(BAR_LD);

  it("compares per day: only Friday differs", async () => {
    const { ctx } = ctxWith([
      listing({
        hours: parseListedHours("Mon-Thu 4pm-1am; Fri 4pm-1am; Sat 4pm-2am; Sun 12pm-10pm"),
      }),
    ]);
    const found = await listingHoursMismatch.run(SITE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toMatch(/^Friday: Yelp says 4pm-1am, your site says 4pm-2am/);
  });

  it("split shifts and past-midnight closes compare equal when they are the same hours", async () => {
    const ld = { ...BAR_LD, openingHours: ["Fr 11:00-14:00", "Fr 17:00-02:00"] };
    const { ctx } = ctxWith([listing({ hours: parseListedHours("Fri 11am-2pm, 5pm-2am") })]);
    expect(await listingHoursMismatch.run(page(ld), ctx)).toEqual([]);
  });

  it("a permanently closed listing is left out of every comparison and said so", async () => {
    const { ctx, cannot } = ctxWith([
      listing({ status: "closed-permanently", hours: {}, name: "Buckhorn Tavern" }),
    ]);
    expect(await listingHoursMismatch.run(SITE, ctx)).toEqual([]);
    expect(await listingNameMismatch.run(SITE, ctx)).toEqual([]);
    expect(cannot).toHaveLength(2);
    expect(cannot[0]).toMatch(/permanently closed, so it was not compared/);
  });

  it("an unverified listing is compared, and the evidence says it is unverified", async () => {
    const { ctx } = ctxWith([
      listing({ status: "unverified", hours: parseListedHours("Fri 4pm-1am") }),
    ]);
    const found = await listingHoursMismatch.run(SITE, ctx);
    expect(found[0]?.evidence).toContain("(the owner has not verified this listing)");
  });

  it("hours declared in gaugeline.facts.json are used before the structured data", async () => {
    const { ctx } = ctxWith(
      [listing({ hours: parseListedHours("Fri 4pm-1am") })],
      {},
      {
        facts: { facts: [{ id: "hours", kind: "hours", value: "Fri 4pm-1am" }] },
      },
    );
    expect(await listingHoursMismatch.run(SITE, ctx)).toEqual([]);
  });
});

describe("source problems become could-not-check, with the reason and the retry time", () => {
  it("a rate-limited source: the check is not passed and the message carries when to retry", async () => {
    const { ctx, cannot } = ctxWith([], {
      notices: [
        {
          connector: "yelp",
          kind: "unreachable",
          message:
            "yelp could not be read. The system asked Gaugeline to slow down (HTTP 429). Try again in 120 seconds.",
        },
      ],
    });
    expect(await listingPhoneMismatch.run(page(BAR_LD), ctx)).toEqual([]);
    expect(cannot).toEqual([
      "yelp could not be read. The system asked Gaugeline to slow down (HTTP 429). Try again in 120 seconds.",
    ]);
  });

  it("a source that cannot supply the thing a check compares is not blamed by that check", async () => {
    const { ctx, cannot } = ctxWith([], {
      notices: [{ connector: "bio-link", kind: "unreachable", message: "x" }],
    });
    await listingPhoneMismatch.run(page(BAR_LD), ctx);
    expect(cannot).toEqual([]);
  });
});

describe("website links", () => {
  it("a dead page, a redirect chain and a page that will not open are each named", async () => {
    const links = new Map([
      [
        "https://bucktavern.example/old-menu",
        { status: 404, finalUrl: "https://bucktavern.example/old-menu", redirects: 0 },
      ],
      [
        "https://bucktavern.example/a",
        { status: 200, finalUrl: "https://bucktavern.example/d", redirects: 3 },
      ],
      ["https://bucktavern.example/b", { error: "No answer within 5000 ms", redirects: 0 }],
    ]);
    const { ctx } = ctxWith(
      [
        listing({
          source: "google-business",
          label: "Google Business Profile",
          website: "https://bucktavern.example/old-menu",
        }),
        listing({
          source: "apple",
          label: "Apple Business Connect",
          website: "https://bucktavern.example/a",
        }),
        listing({
          source: "google-places",
          label: "Google Maps",
          website: "https://bucktavern.example/b",
        }),
      ],
      { links },
    );
    const found = await listingWebsiteWrong.run(page(BAR_LD), ctx);
    expect(found.map((f) => f.evidence)).toEqual([
      "Google Business Profile: https://bucktavern.example/old-menu answers 404",
      "Apple Business Connect: https://bucktavern.example/a goes through 3 redirects to reach https://bucktavern.example/d",
      "Google Maps: https://bucktavern.example/b could not be opened (No answer within 5000 ms)",
    ]);
  });

  it("a link to the site itself, www or not, is fine", async () => {
    const links = new Map([
      [
        "https://www.bucktavern.example/",
        { status: 200, finalUrl: "https://bucktavern.example/", redirects: 1 },
      ],
    ]);
    const { ctx } = ctxWith(
      [
        listing({
          source: "apple",
          label: "Apple Business Connect",
          website: "https://www.bucktavern.example/",
        }),
      ],
      { links },
    );
    expect(await listingWebsiteWrong.run(page(BAR_LD), ctx)).toEqual([]);
  });
});

describe("special hours", () => {
  const TEXT = "<p>We are closed on Thanksgiving Day and on December 25.</p>";

  it("finds the closures the site announces that the listing does not have", async () => {
    const { ctx } = ctxWith([
      listing({ specialDays: [{ date: "2026-12-25", closed: true }] }),
      listing({ source: "google-business", label: "Google Business Profile", specialDays: [] }),
    ]);
    const found = await listingSpecialHoursMissing.run(page(BAR_LD, TEXT), ctx);
    expect(found.map((f) => f.evidence)).toEqual([
      "Yelp has no closure for Thanksgiving (2026-11-26); your site says closed on it (/)",
      "Google Business Profile has no closure for Thanksgiving (2026-11-26), December 25 (2026-12-25); your site says closed on them (/)",
    ]);
  });

  it("a listing that has the closure, and a closure that has passed, are not findings", async () => {
    const { ctx } = ctxWith([
      listing({
        specialDays: [
          { date: "2026-11-26", closed: true },
          { date: "2026-12-25", closed: true },
        ],
      }),
    ]);
    expect(await listingSpecialHoursMissing.run(page(BAR_LD, TEXT), ctx)).toEqual([]);
    const past = ctxWith(
      [listing({ specialDays: [] })],
      {},
      { now: () => new Date("2026-12-26T12:00:00Z") },
    );
    expect(await listingSpecialHoursMissing.run(page(BAR_LD, TEXT), past.ctx)).toEqual([]);
  });

  it("the venue's time zone decides what 'today' is: late on Dec 25 in Chicago is already Dec 26 in UTC", async () => {
    const late = new Date("2026-12-26T03:00:00Z");
    const chicago = ctxWith(
      [listing({ specialDays: [] })],
      {},
      { now: () => late, expect: { timeZone: "America/Chicago" } },
    );
    expect(await listingSpecialHoursMissing.run(page(BAR_LD, TEXT), chicago.ctx)).toHaveLength(1);
    const utc = ctxWith([listing({ specialDays: [] })], {}, { now: () => late });
    expect(await listingSpecialHoursMissing.run(page(BAR_LD, TEXT), utc.ctx)).toEqual([]);
  });

  it("reads a closure from structured data too", async () => {
    const ld = {
      ...BAR_LD,
      openingHoursSpecification: [
        {
          "@type": "OpeningHoursSpecification",
          opens: "00:00",
          closes: "00:00",
          validFrom: "2026-12-24",
          validThrough: "2026-12-25",
        },
      ],
    };
    const { ctx } = ctxWith([listing({ specialDays: [] })]);
    const found = await listingSpecialHoursMissing.run(page(ld), ctx);
    expect(found[0]?.evidence).toContain("2026-12-24, 2026-12-25");
  });

  it("a source with no special hours is could-not-check, and only when the site has a closure", async () => {
    const { ctx, cannot } = ctxWith([
      listing({ source: "google-business", label: "Google Business Profile" }),
    ]);
    expect(await listingSpecialHoursMissing.run(page(BAR_LD, TEXT), ctx)).toEqual([]);
    expect(cannot[0]).toMatch(/gives Gaugeline no special hours/);
    const none = ctxWith([listing({})]);
    await listingSpecialHoursMissing.run(page(BAR_LD, "<p>Open daily.</p>"), none.ctx);
    expect(none.cannot).toEqual([]);
  });
});

describe("address", () => {
  it("compares the house number and the ZIP only", async () => {
    const { ctx } = ctxWith([
      listing({ address: "412 Alder St, Fairmont Heights, IL 62999" }),
      listing({
        address: "418 Alder St, Fairmont Heights, IL 62999",
        label: "Apple Business Connect",
        source: "apple",
      }),
    ]);
    const found = await listingAddressMismatch.run(page(BAR_LD), ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("medium");
  });
});
