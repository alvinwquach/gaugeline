import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RENEWAL_CHECK_IDS } from "../../renewals/section.js";
import {
  RECEIPT_GROUPS,
  buildReceipt,
  parseReceiptMonth,
  receiptGroupOf,
  receiptJson,
  receiptMarkdown,
  receiptPrintable,
  type ReceiptRun,
} from "../index.js";

/** Marlowe Bar is an invented bar (rule 12). Runs are one a day at 06:00 UTC unless a test says otherwise. */
const SITE = "marlowe-bar.example";
const HOURS = "A listing shows different opening hours";
const PHONE = "A listing shows a different phone number";
const DOMAIN = "The domain's registration runs out soon";
const LINKS = "Links on this page go nowhere";
const PAY = "A payment link no longer works";

const PAGES = ["/", "/visit"];
type F = readonly [checkId: string, path: string, title: string];

const at = (day: string) => `${day}T06:00:00.000Z`;
const run = (
  day: string,
  findings: readonly F[] = [],
  pages: readonly string[] = PAGES,
): ReceiptRun => ({
  takenAt: at(day),
  pages,
  findings: findings.map(([checkId, path, title]) => ({ checkId, path, title })),
});
const days = (from: string, to: string, findings: (day: string) => readonly F[] = () => []) => {
  const out: ReceiptRun[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push(run(d, findings(d)));
  }
  return out;
};
const NOW = new Date("2026-11-13T09:00:00.000Z");

/** October 2026: two listing fixes and a domain renewal, one a day for 31 days. */
function october(): ReceiptRun[] {
  return days("2026-10-01", "2026-10-31", (d) => [
    ...(d >= "2026-10-06" && d < "2026-10-08"
      ? ([["listing-hours-mismatch", "/", HOURS]] as F[])
      : []),
    ...(d >= "2026-10-14" && d < "2026-10-15"
      ? ([["listing-phone-mismatch", "/visit", PHONE]] as F[])
      : []),
    ...(d >= "2026-10-20" && d < "2026-10-24"
      ? ([["domain-expires-soon", "/", DOMAIN]] as F[])
      : []),
  ]);
}

const build = (
  runs: readonly ReceiptRun[],
  extra: Partial<Parameters<typeof buildReceipt>[0]> = {},
) => buildReceipt({ site: SITE, month: "2026-10", runs, now: NOW, ...extra });

describe("receipt: counting from the runs", () => {
  it("counts a finding opened and resolved in the month, with its first-seen and resolved dates", () => {
    const r = build(october());
    const hours = r.groups
      .flatMap((g) => g.items)
      .find((i) => i.checkId === "listing-hours-mismatch");
    expect(hours).toMatchObject({
      path: "/",
      title: HOURS,
      firstSeen: "2026-10-06",
      resolvedOn: "2026-10-08",
      reportedByClient: false,
    });
    expect(r.counts).toEqual({ opened: 3, beforeCustomers: 3, afterYouToldUs: 0, stillOpen: 0 });
  });

  it("counts a finding opened last month and resolved this month, with the earlier first-seen date", () => {
    const runs = [
      ...days("2026-09-28", "2026-10-02", () => [["broken-links", "/visit", LINKS]]),
      ...days("2026-10-03", "2026-10-31"),
    ];
    const r = build(runs);
    expect(r.counts).toMatchObject({ opened: 0, beforeCustomers: 1, stillOpen: 0 });
    expect(r.groups.flatMap((g) => g.items)[0]).toMatchObject({
      firstSeen: "2026-09-28",
      resolvedOn: "2026-10-03",
    });
  });

  it("a finding that was fixed before the month began is not in the month", () => {
    const runs = [
      ...days("2026-09-10", "2026-09-12", () => [["broken-links", "/", LINKS]]),
      ...days("2026-09-13", "2026-10-31"),
    ];
    expect(build(runs).counts).toEqual({
      opened: 0,
      beforeCustomers: 0,
      afterYouToldUs: 0,
      stillOpen: 0,
    });
  });

  it("lists a finding that is still open at the end of the month, and one fixed only the month after", () => {
    const runs = [
      ...days("2026-10-01", "2026-10-31", (d) => [
        ...(d >= "2026-10-02" ? ([["payment-link-dead", "/visit", PAY]] as F[]) : []),
        ...(d >= "2026-10-20" ? ([["broken-links", "/", LINKS]] as F[]) : []),
      ]),
      // November: both are fixed on the 2nd. The October receipt must not claim them.
      ...days("2026-11-01", "2026-11-05", (d) =>
        d < "2026-11-02" ? ([["broken-links", "/", LINKS]] as F[]) : [],
      ),
    ];
    const r = build(runs);
    expect(r.counts).toEqual({ opened: 2, beforeCustomers: 0, afterYouToldUs: 0, stillOpen: 2 });
    expect(r.stillOpen.map((i) => [i.checkId, i.firstSeen])).toEqual([
      ["payment-link-dead", "2026-10-02"],
      ["broken-links", "2026-10-20"],
    ]);
  });

  it("a run that did not read the page cannot say the finding is gone", () => {
    const runs = [
      run("2026-10-04", [["listing-hours-mismatch", "/visit", HOURS]]),
      run("2026-10-05", [], ["/"]), // /visit was not read
      run("2026-10-06", [["listing-hours-mismatch", "/visit", HOURS]]),
      run("2026-10-07", []),
    ];
    const items = build(runs).groups.flatMap((g) => g.items);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ firstSeen: "2026-10-04", resolvedOn: "2026-10-07" });
  });

  it("a finding that comes back is a second one: the first is fixed, the second is open", () => {
    const runs = [
      run("2026-10-02", [["broken-links", "/", LINKS]]),
      run("2026-10-03", []),
      run("2026-10-04", [["broken-links", "/", LINKS]]),
    ];
    const r = build(runs);
    expect(r.counts).toEqual({ opened: 2, beforeCustomers: 1, afterYouToldUs: 0, stillOpen: 1 });
  });

  it("only restates the runs: the same input gives the same receipt and the input is not changed", () => {
    const runs = october();
    const copy = JSON.stringify(runs);
    const a = build(runs);
    expect(JSON.stringify(build([...runs].reverse()))).toBe(JSON.stringify(a));
    expect(JSON.stringify(runs)).toBe(copy);
  });
});

describe("receipt: before customers did", () => {
  const runs = () => [
    ...days("2026-10-01", "2026-10-31", (d) => [
      ...(d >= "2026-10-06" && d < "2026-10-08"
        ? ([["listing-hours-mismatch", "/", HOURS]] as F[])
        : []),
      ...(d >= "2026-10-14" && d < "2026-10-15"
        ? ([["payment-link-dead", "/visit", PAY]] as F[])
        : []),
    ]),
  ];

  it("never counts a client-reported finding as caught before customers did", () => {
    const r = build(runs(), { clientReported: [{ checkId: "payment-link-dead", path: "/visit" }] });
    expect(r.counts).toEqual({ opened: 2, beforeCustomers: 1, afterYouToldUs: 1, stillOpen: 0 });
    expect(r.groups.flatMap((g) => g.items).map((i) => i.checkId)).toEqual([
      "listing-hours-mismatch",
    ]);
    expect(r.afterYouToldUs.map((i) => i.checkId)).toEqual(["payment-link-dead"]);
    const md = receiptMarkdown(r);
    const before = md.slice(
      md.indexOf("## Fixed before your customers did"),
      md.indexOf("## Fixed after you told us"),
    );
    expect(before).toContain(HOURS);
    expect(before).not.toContain(PAY);
    expect(md.slice(md.indexOf("## Fixed after you told us"))).toContain(PAY);
    expect(md).toContain("1 fixed before your customers did");
  });

  it("a report with no page covers that check on every page; one with a page covers only it", () => {
    const wide = build(runs(), { clientReported: [{ checkId: "payment-link-dead" }] });
    expect(wide.counts.afterYouToldUs).toBe(1);
    const other = build(runs(), {
      clientReported: [{ checkId: "payment-link-dead", path: "/menu" }],
    });
    expect(other.counts).toMatchObject({ beforeCustomers: 2, afterYouToldUs: 0 });
  });

  it("with every fix client-reported there is no 'before your customers did' claim at all", () => {
    const r = build(runs(), {
      clientReported: [{ checkId: "payment-link-dead" }, { checkId: "listing-hours-mismatch" }],
    });
    const text = [receiptMarkdown(r), receiptPrintable(r), receiptJson(r)].join("\n");
    expect(r.counts.beforeCustomers).toBe(0);
    expect(text).not.toMatch(/before your customers did/);
  });
});

describe("receipt: plain-word groups", () => {
  it("groups by what the owner cares about, in a fixed order, and leaves empty groups out", () => {
    expect(RECEIPT_GROUPS.map((g) => g.name)).toEqual([
      "Booking and payments",
      "Listings and hours",
      "Site and content",
      "Renewals",
      "Security signals",
    ]);
    const r = build(october());
    expect(r.groups.map((g) => [g.name, g.items.length])).toEqual([
      ["Listings and hours", 2],
      ["Renewals", 1],
    ]);
  });

  it.each([
    ["payment-link-dead", "booking-payments"],
    ["stripe-test-mode", "booking-payments"],
    ["form-destination-changed", "booking-payments"],
    ["listing-hours-mismatch", "listings-hours"],
    ["listing-phone-mismatch", "listings-hours"],
    ["document-hours-mismatch", "listings-hours"],
    ["event-past-upcoming", "listings-hours"],
    ["broken-links", "site-content"],
    ["images-alt-missing", "site-content"],
    ["noindex", "site-content"],
    ["domain-expires-soon", "renewals"],
    ["certificate-expiring", "renewals"],
    ["token-expires-soon", "renewals"],
    ["secret-in-js", "security"],
    ["email-dmarc-missing", "security"],
    ["supabase-rls-off", "security"],
    ["access-public-read", "security"],
    ["some-custom-check", "site-content"],
  ])("%s is %s", (checkId, group) => {
    expect(receiptGroupOf(checkId)).toBe(group);
  });

  it("every check Gaugeline ships lands in one of the five groups, and every renewal check in Renewals", () => {
    const data = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../../docs/checks.data.json", import.meta.url)),
        "utf8",
      ),
    ) as { id: string; area: string }[];
    expect(data.length).toBeGreaterThan(300);
    const ids = new Set(RECEIPT_GROUPS.map((g) => g.id));
    for (const c of data) expect(ids.has(receiptGroupOf(c.id)), c.id).toBe(true);
    for (const id of RENEWAL_CHECK_IDS) expect(receiptGroupOf(id), id).toBe("renewals");
    // The two areas the owner reads as "money in" and "security" keep to their groups.
    for (const c of data.filter((c) => c.area === "Sales & prices"))
      expect(["booking-payments", "security"], c.id).toContain(receiptGroupOf(c.id));
    for (const c of data.filter(
      (c) => c.area === "Security & email" && !RENEWAL_CHECK_IDS.has(c.id),
    ))
      expect(["security", "site-content", "booking-payments"], c.id).toContain(
        receiptGroupOf(c.id),
      );
  });
});

describe("receipt: coming up (F-01 renewals in the next 60 days)", () => {
  const rows = [
    { kind: "domain" as const, subject: SITE, date: "2026-12-20T00:00:00.000Z" },
    { kind: "certificate" as const, subject: SITE, date: "2026-11-25T00:00:00.000Z" },
    {
      kind: "domain" as const,
      subject: "marlowe-bar.example.test",
      date: "2027-03-01T00:00:00.000Z",
    },
    {
      kind: "token" as const,
      subject: "GitHub token (GITHUB_TOKEN)",
      date: "2026-11-01T00:00:00.000Z",
    },
    { kind: "token" as const, subject: "Vercel token (VERCEL_TOKEN)" },
  ];

  it("lists what lapses within 60 days of now, soonest first, with the date written out", () => {
    const r = build(october(), { renewals: rows });
    expect(r.comingUp.map((c) => [c.label, c.date, c.days])).toEqual([
      [`Certificate for ${SITE}: expires 25 Nov 2026, 12 days`, "2026-11-25", 12],
      [`Domain ${SITE}: expires 20 Dec 2026, 37 days`, "2026-12-20", 37],
    ]);
    expect(receiptMarkdown(r)).toContain("## Coming up");
  });

  it("includes the 60th day and leaves out the 61st", () => {
    const r = build([], {
      renewals: [
        { kind: "domain", subject: "a.example", date: "2027-01-12T09:00:00.000Z" },
        { kind: "domain", subject: "b.example", date: "2027-01-13T09:00:00.000Z" },
      ],
    });
    expect(r.comingUp.map((c) => c.days)).toEqual([60]);
  });

  it("has no Coming up section when nothing is due", () => {
    const r = build(october());
    expect(r.comingUp).toEqual([]);
    expect(receiptMarkdown(r)).not.toContain("Coming up");
    expect(receiptPrintable(r)).not.toContain("Coming up");
  });
});

describe("receipt: no money or traffic wording", () => {
  const FORBIDDEN =
    /[$€£¥%]|\b(money|saved|saving|savings|revenue|sales|profit|income|earn\w*|traffic|visitors?|visits|clicks|conversions?|rankings?|dollars?|euros?|pounds?|worth|roi|lost)\b/i;

  const scenarios = () => [
    build(october(), {
      renewals: [{ kind: "domain", subject: SITE, date: "2026-12-20T00:00:00.000Z" }],
    }),
    build(october(), { clientReported: [{ checkId: "listing-phone-mismatch" }] }),
    build(days("2026-10-01", "2026-10-31")),
    build([]),
    build(days("2026-10-01", "2026-10-10", () => [["broken-links", "/", "A link is broken"]])),
  ];

  it("none of the three outputs says money, saved, traffic or visitors", () => {
    for (const r of scenarios())
      for (const text of [receiptMarkdown(r), receiptPrintable(r), receiptJson(r)]) {
        const visible = text.replace(/<style>[\s\S]*?<\/style>/, "");
        expect(visible.match(FORBIDDEN)?.[0], visible).toBeUndefined();
      }
  });

  it("the strings the renderer owns carry no such word either", () => {
    const here = fileURLToPath(new URL("../render.ts", import.meta.url));
    const source = readFileSync(here, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const strings = [...source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2] ?? "");
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) expect(s.match(FORBIDDEN)?.[0], s).toBeUndefined();
  });
});

describe("receipt: a quiet month", () => {
  it("says 'Nothing broke this month. 31 daily checks ran.' and nothing else is claimed", () => {
    const r = build(days("2026-10-01", "2026-10-31"));
    expect(r.quiet).toBe(true);
    expect(r.checks).toEqual({ ran: 31, days: 31 });
    const md = receiptMarkdown(r);
    expect(md).toContain("Nothing broke this month. 31 daily checks ran.");
    expect(md).not.toMatch(/before your customers did|Fixed|Still open|Coming up/);
    expect(receiptPrintable(r)).toContain("Nothing broke this month. 31 daily checks ran.");
    expect(JSON.parse(receiptJson(r))).toMatchObject({
      quiet: true,
      checks: { ran: 31, days: 31 },
    });
  });

  it("counts only the checks that ran in the month, and says 'daily' only when there was one a day", () => {
    const runs = [
      ...days("2026-09-25", "2026-09-30"),
      run("2026-10-05"),
      run("2026-10-12"),
      run("2026-10-12"),
      ...days("2026-11-01", "2026-11-03"),
    ];
    const r = build(runs);
    expect(r.checks).toEqual({ ran: 3, days: 2 });
    expect(receiptMarkdown(r)).toContain("Nothing broke this month. 3 checks ran.");
    expect(receiptMarkdown(r)).not.toContain("daily");
  });

  it("says one check in the singular", () => {
    expect(receiptMarkdown(build([run("2026-10-05")]))).toContain(
      "Nothing broke this month. 1 check ran.",
    );
  });

  it("never claims a quiet month when no check ran", () => {
    const r = build([]);
    expect(r.quiet).toBe(false);
    const md = receiptMarkdown(r);
    expect(md).toContain("No checks ran this month, so there is nothing to report.");
    expect(md).not.toContain("Nothing broke");
  });

  it("is not quiet when only an older problem is still open: it says so after the quiet line", () => {
    const runs = days("2026-09-20", "2026-10-31", () => [["broken-links", "/", LINKS]]);
    const r = build(runs);
    expect(r.counts).toEqual({ opened: 0, beforeCustomers: 0, afterYouToldUs: 0, stillOpen: 1 });
    const md = receiptMarkdown(r);
    expect(md).toContain("Nothing broke this month. 31 daily checks ran.");
    expect(md).toContain("## Still open");
    expect(md).toContain("first seen Sun 20 Sep");
  });
});

describe("receipt: months", () => {
  it("reads yyyy-mm, in UTC, and refuses anything else", () => {
    expect(parseReceiptMonth("2026-10")).toEqual({
      month: "2026-10",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    });
    expect(parseReceiptMonth("2026-12")?.to).toBe("2027-01-01T00:00:00.000Z");
    for (const bad of [
      "2026-13",
      "2026-00",
      "2026-1",
      "26-10",
      "2026-10-01",
      "October",
      "",
      " 2026-10",
    ])
      expect(parseReceiptMonth(bad), bad).toBeUndefined();
  });

  it("a month in progress says so, counts only the runs so far and is not a full month", () => {
    const r = buildReceipt({
      site: SITE,
      month: "2026-11",
      runs: days("2026-11-01", "2026-11-12"),
      now: NOW,
    });
    expect(r.partial).toBe(true);
    expect(r.checks.ran).toBe(12);
    expect(receiptMarkdown(r)).toContain("November 2026 so far");
  });

  it("refuses a month that has not started", () => {
    expect(() => buildReceipt({ site: SITE, month: "2026-12", runs: [], now: NOW })).toThrow(
      RangeError,
    );
  });

  it("a run is in the month by its UTC time", () => {
    const r = build([
      { takenAt: "2026-09-30T23:59:59.000Z", pages: PAGES, findings: [] },
      { takenAt: "2026-10-01T00:00:00.000Z", pages: PAGES, findings: [] },
      { takenAt: "2026-10-31T23:59:59.000Z", pages: PAGES, findings: [] },
      { takenAt: "2026-11-01T00:00:00.000Z", pages: PAGES, findings: [] },
    ]);
    expect(r.checks.ran).toBe(2);
  });
});

describe("receipt: the block, the JSON and the printable page agree", () => {
  const r = build(october(), {
    renewals: [{ kind: "domain", subject: SITE, date: "2026-12-20T00:00:00.000Z" }],
  });

  it("three resolved findings and one renewal due appear in all three, with the same counts and dates", () => {
    const md = receiptMarkdown(r);
    const html = receiptPrintable(r);
    const json = JSON.parse(receiptJson(r)) as typeof r & { schema: number };
    expect(json.schema).toBe(1);
    expect(json.counts.beforeCustomers).toBe(3);
    expect(json.comingUp).toHaveLength(1);
    for (const text of [md, html]) {
      expect(text).toContain("3 fixed before your customers did");
      for (const title of [HOURS, PHONE, DOMAIN]) expect(text).toContain(title);
      expect(text).toContain("seen Tue 6 Oct, fixed by Thu 8 Oct");
      expect(text).toContain("seen Wed 14 Oct, fixed by Thu 15 Oct");
      expect(text).toContain("seen Tue 20 Oct, fixed by Sat 24 Oct");
      expect(text).toContain(`Domain ${SITE}: expires 20 Dec 2026, 37 days`);
      expect(text).toContain("31 daily checks");
    }
    expect(
      json.groups.flatMap((g) => g.items.map((i) => [i.title, i.firstSeen, i.resolvedOn])),
    ).toEqual([
      [HOURS, "2026-10-06", "2026-10-08"],
      [PHONE, "2026-10-14", "2026-10-15"],
      [DOMAIN, "2026-10-20", "2026-10-24"],
    ]);
  });

  it("the JSON holds only integers for counts and ISO strings for dates", () => {
    const json = JSON.parse(receiptJson(r)) as Record<string, unknown>;
    for (const v of Object.values(json.counts as Record<string, number>))
      expect(Number.isInteger(v)).toBe(true);
    expect(json.from).toBe("2026-10-01T00:00:00.000Z");
    expect(json.to).toBe("2026-11-01T00:00:00.000Z");
    expect(json.asOf).toBe(NOW.toISOString());
    expect(receiptJson(r).endsWith("\n")).toBe(true);
  });

  it("the printable page is one self-contained page: no script, no request, a print style, a page size", () => {
    const html = receiptPrintable(r);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("@page");
    expect(html).toContain("@media print");
    expect(html).not.toMatch(/<script|<link|<img|src=|href=|https?:\/\//i);
  });

  it("says 'and N more' rather than run past a page", () => {
    const many = days("2026-10-01", "2026-10-31", (d) =>
      d < "2026-10-10"
        ? Array.from({ length: 30 }, (_, i): F => [
            "broken-links",
            `/p${i}`,
            `Links on page ${i} go nowhere`,
          ])
        : [],
    );
    const big = build(many);
    expect(big.counts.beforeCustomers).toBe(30);
    expect(receiptMarkdown(big)).toContain("Links on page 29 go nowhere");
    const html = receiptPrintable(big);
    expect(html).toMatch(/and \d+ more/);
    expect(html.match(/<li>/g)!.length).toBeLessThanOrEqual(20);
  });
});

describe("receipt: text from a page is data", () => {
  const hostile = "<img src=x onerror=alert(1)> **bold** [x](https://evil.example) | a\nb";
  const r = build([run("2026-10-02", [["broken-links", "/<b>", hostile]]), run("2026-10-03", [])]);

  it("is escaped in the Markdown and in the HTML", () => {
    const md = receiptMarkdown(r);
    expect(md).not.toContain("<img");
    expect(md).not.toContain("[x](");
    expect(md.split("\n").filter((l) => l.includes("bold"))).toHaveLength(1);
    const html = receiptPrintable(r);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
  });
});
