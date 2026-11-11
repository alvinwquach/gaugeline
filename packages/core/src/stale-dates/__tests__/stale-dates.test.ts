import { describe, expect, it } from "vitest";
import { dayNumber, findDates, isoOfDay, resolveEnd, todayIn } from "../parse.js";
import { staleCopy } from "../judge.js";

const day = (y: number, m: number, d: number) => dayNumber(y, m, d) as number;
const kinds = (text: string, langs = ["en"]) =>
  findDates(text, langs).map((f) => [f.raw, f.kind] as const);

describe("unit: the date parser", () => {
  const today = day(2026, 11, 12);
  const table: [string, string, string, string?][] = [
    // text, kind, last day it covers (resolved on 12 Nov 2026), language
    ["Oct 31", "month-day", "2026-10-31"],
    ["October 31, 2025", "full", "2025-10-31"],
    ["31 October 2025", "full", "2025-10-31"],
    ["Oct. 31st", "month-day", "2026-10-31"],
    ["10/31", "numeric", "2026-10-31"],
    ["31/10/2025", "numeric", "2025-10-31"],
    ["2025-10-31", "numeric", "2025-10-31"],
    ["Summer 2025", "season-year", "2025-08-31"],
    ["Fall '25", "season-year", "2025-11-30"],
    ["Winter 2025", "season-year", "2026-02-28"],
    ["Winter 2027", "season-year", "2028-02-29"],
    ["November 2025", "month-year", "2025-11-30"],
    ["February 2028", "month-year", "2028-02-29"],
    ["through Nov 2", "month-day", "2026-11-02"],
    ["through September", "month", "2026-09-30"],
    ["hasta el 31 de octubre", "month-day", "2026-10-31", "es"],
    ["verano de 2025", "season-year", "2025-08-31", "es"],
    ["jusqu'au 2 novembre", "month-day", "2026-11-02", "fr"],
  ];
  it.each(table)("reads %s as %s ending %s", (text, kind, end, lang = "en") => {
    const found = findDates(text, ["en", lang]).find((f) => f.kind === kind);
    expect(found, text).toBeDefined();
    expect(isoOfDay(resolveEnd(found!, today) as number)).toBe(end);
  });

  it("does not read years alone, fractions or impossible dates", () => {
    for (const t of [
      "since 1998",
      "Est. 2004",
      "1/2 price",
      "3/4 cup",
      "Feb 30",
      "13/13/2025",
      "10/11",
      "may I help",
      "open 24/7",
    ])
      expect(kinds(t), t).toEqual([]);
  });

  it("puts a month-day with no year at the nearest occurrence, across New Year", () => {
    const jan3 = findDates("until Jan 3", ["en"])[0]!;
    // Late December: the 3rd of January is ahead, in the new year.
    expect(isoOfDay(resolveEnd(jan3, day(2026, 12, 20)) as number)).toBe("2027-01-03");
    // Early January: the 3rd of January is just behind.
    expect(isoOfDay(resolveEnd(jan3, day(2027, 1, 6)) as number)).toBe("2027-01-03");
    // March: it is two months behind, not ten ahead.
    expect(isoOfDay(resolveEnd(jan3, day(2027, 3, 5)) as number)).toBe("2027-01-03");
    const dec31 = findDates("through Dec 31", ["en"])[0]!;
    expect(isoOfDay(resolveEnd(dec31, day(2027, 1, 2)) as number)).toBe("2026-12-31");
  });

  it("handles 29 February", () => {
    const feb29 = findDates("until Feb 29", ["en"])[0]!;
    expect(isoOfDay(resolveEnd(feb29, day(2028, 3, 10)) as number)).toBe("2028-02-29");
    // 2026 has no 29 February: the nearest real one is in 2028.
    expect(isoOfDay(resolveEnd(feb29, day(2027, 6, 1)) as number)).toBe("2028-02-29");
  });

  it("reads today in the venue's time zone, not the machine's", () => {
    const instant = new Date("2026-11-12T03:30:00Z");
    expect(isoOfDay(todayIn(instant, "UTC"))).toBe("2026-11-12");
    expect(isoOfDay(todayIn(instant, "America/Los_Angeles"))).toBe("2026-11-11");
    expect(isoOfDay(todayIn(instant, "Pacific/Auckland"))).toBe("2026-11-12");
  });

  it("does not throw on lone surrogates, hostile input or a prototype-looking word", () => {
    const hostile = `\uD800 __proto__ constructor ${"Oct ".repeat(50_000)}${"9".repeat(50_000)} \uDC00`;
    expect(() => findDates(hostile, ["en"])).not.toThrow();
    expect(() => findDates("__proto__ 5", ["en"])).not.toThrow();
  });
});

describe("unit: the context rule", () => {
  const opts = { langs: ["en"], today: day(2026, 11, 12), graceDays: 1, ignore: [] as string[] };
  const hits = (text: string, over: Partial<typeof opts> = {}) =>
    staleCopy(text, { ...opts, ...over });

  it("flags a past end date next to an offer", () => {
    const [hit] = hits("Happy hour through Oct 31, 4 to 6 pm.");
    expect(hit?.date).toBe("2026-10-31");
    expect(hit?.sentence).toContain("Happy hour through Oct 31");
  });
  it("flags a season, a month and a holiday notice", () => {
    expect(hits("Our Summer 2025 menu is here")).toHaveLength(1);
    expect(hits("Closed for the holidays until Jan 3", { today: day(2027, 3, 5) })).toHaveLength(1);
    expect(hits("Every Thursday through September")).toHaveLength(1);
  });
  it("does not flag a past date alone", () => {
    expect(hits("We were at the farmers market on Oct 31.")).toEqual([]);
    expect(hits("Photos from Oct 31, 2025")).toEqual([]);
  });
  it("does not flag 'since', 'established' or 'founded'", () => {
    expect(hits("Serving great menu items since Oct 2019")).toEqual([]);
    expect(hits("Founded June 2010, we have a menu for everyone")).toEqual([]);
    expect(hits("Established in March 2012, our special coffee")).toEqual([]);
    expect(hits("Serving the neighborhood since 1998")).toEqual([]);
  });
  it("does not flag a date still ahead", () => {
    expect(hits("Holiday special through Dec 31")).toEqual([]);
    expect(hits("Holiday special through Dec 31, 2026")).toEqual([]);
    expect(hits("Holiday special through January 3", { today: day(2026, 12, 20) })).toEqual([]);
  });
  it("keeps one finding per sentence, and none when the sentence also names a date ahead", () => {
    const both = hits("Summer 2025 menu: every Thursday through September 2025.");
    expect(both).toHaveLength(1);
    expect(both[0]?.date).toBe("2025-09-30");
    expect(hits("Summer 2025 menu, now through Dec 31")).toEqual([]);
  });
  it("flags the end of a range", () => {
    expect(hits("Fall tasting menu Sep 1 - Oct 31")).toHaveLength(1);
  });
  it("reads Spanish, and only when the language is on", () => {
    const text = "Oferta de la casa hasta el 31 de octubre";
    expect(staleCopy(text, { ...opts, langs: ["en", "es"] })).toHaveLength(1);
    expect(hits(text)).toEqual([]);
  });
  it("skips sentences matching the ignore list", () => {
    expect(hits("Happy hour through Oct 31", { ignore: ["happy hour through"] })).toEqual([]);
  });
});

describe("edge cases: the grace period", () => {
  const base = { langs: ["en"], today: day(2026, 11, 12), ignore: [] as string[] };
  const text = "Weekend special ends Nov 10";
  it("waits graceDays before flagging", () => {
    // It ended two days ago.
    expect(staleCopy(text, { ...base, graceDays: 1 })).toHaveLength(1);
    expect(staleCopy(text, { ...base, graceDays: 2 })).toEqual([]);
    expect(staleCopy(text, { ...base, graceDays: 0 })).toHaveLength(1);
  });
  it("an offer ending yesterday is not flagged with a grace of 2", () => {
    expect(staleCopy("Weekend special ends Nov 11", { ...base, graceDays: 2 })).toEqual([]);
    expect(staleCopy("Weekend special ends Nov 11", { ...base, graceDays: 1 })).toEqual([]);
    expect(staleCopy("Weekend special ends Nov 11", { ...base, graceDays: 0 })).toHaveLength(1);
  });
});
