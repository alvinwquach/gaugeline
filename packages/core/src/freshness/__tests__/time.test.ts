import { describe, expect, it } from "vitest";
import { isActive, parseDuration, parseMoment, type Moment } from "../time.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0); // 10 Nov 2026, 12:00 UTC
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function moment(raw: string, timeZone?: string): Moment {
  const got = parseMoment(raw, { now: NOW, ...(timeZone ? { timeZone } : {}) });
  if (!got.ok) throw new Error(`${raw}: ${got.reason}`);
  return got.moment;
}
const refused = (raw: string, timeZone?: string): string => {
  const got = parseMoment(raw, { now: NOW, ...(timeZone ? { timeZone } : {}) });
  if (got.ok) throw new Error(`${raw} should not be understood`);
  return got.reason;
};

describe("parseDuration: unit", () => {
  it.each([
    ["6h", 6 * HOUR],
    ["2d", 2 * DAY],
    ["90m", 90 * 60_000],
    ["1w", 7 * DAY],
    ["45s", 45_000],
    ["6 hours", 6 * HOUR],
    ["1 day", DAY],
    ["30 minutes", 30 * 60_000],
    [" 12H ", 12 * HOUR],
  ])("%s is %i ms", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["", "6", "h", "0h", "-2h", "1.5h", "6 parsecs", "1h30m", "NaNh", "99999999999999d"])(
    "%j is not a duration",
    (text) => {
      expect(parseDuration(text)).toBeUndefined();
    },
  );
});

describe("isActive: the window across the year boundary", () => {
  const season = { months: [10, 11, 12, 1, 2, 3, 4, 5, 6] };
  const at = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h);

  it("no window means always active", () => {
    expect(isActive(undefined, at(2026, 7, 4), "UTC")).toBe(true);
  });

  it("October to June is active in December and January, and not in July, August or September", () => {
    for (const m of [10, 11, 12, 1, 2, 3, 4, 5, 6])
      expect(isActive(season, at(2026, m, 15), "UTC"), `month ${m}`).toBe(true);
    for (const m of [7, 8, 9])
      expect(isActive(season, at(2026, m, 15), "UTC"), `month ${m}`).toBe(false);
  });

  it("changes at midnight in the site's own time zone, not UTC", () => {
    // 1 Jul 03:00 UTC is still 30 Jun 23:00 in New York: June is in the season there.
    const instant = Date.UTC(2026, 6, 1, 3, 0);
    expect(isActive(season, instant, "UTC")).toBe(false);
    expect(isActive(season, instant, "America/New_York")).toBe(true);
    // 1 Jan 03:00 UTC is 31 Dec in New York; a December-only window is still on.
    expect(isActive({ months: [12] }, Date.UTC(2027, 0, 1, 3, 0), "America/New_York")).toBe(true);
    expect(isActive({ months: [12] }, Date.UTC(2027, 0, 1, 3, 0), "UTC")).toBe(false);
  });
});

describe("parseMoment: stamps with a time zone", () => {
  it("reads ISO times with Z, an offset or a space", () => {
    expect(moment("2026-11-10T09:30:00Z")).toEqual({
      earliest: Date.UTC(2026, 10, 10, 9, 30),
      latest: Date.UTC(2026, 10, 10, 9, 30),
      kind: "exact",
    });
    expect(moment("2026-11-10T04:30:00-05:00").earliest).toBe(Date.UTC(2026, 10, 10, 9, 30));
    expect(moment("2026-11-10T15:00:00+0530").earliest).toBe(Date.UTC(2026, 10, 10, 9, 30));
    expect(moment("2026-11-10 09:30:00+00").earliest).toBe(Date.UTC(2026, 10, 10, 9, 30));
    expect(moment("2026-11-10T09:30:00.123Z").kind).toBe("exact");
  });

  it("reads HTTP and RFC 2822 dates, epoch seconds and epoch milliseconds", () => {
    expect(moment("Tue, 10 Nov 2026 09:30:00 GMT").earliest).toBe(Date.UTC(2026, 10, 10, 9, 30));
    expect(moment("1794303000").earliest).toBe(1794303000 * 1000);
    expect(moment("1794303000000").earliest).toBe(1794303000000);
  });

  it("reads English dates with a 12-hour clock and a zone", () => {
    const want = Date.UTC(2026, 10, 9, 21, 30); // 4:30 PM in New York (EST, UTC-5)
    expect(moment("Nov 9, 2026 4:30 PM EST").earliest).toBe(want);
    expect(moment("November 9, 2026 at 4:30 pm EST").earliest).toBe(want);
    expect(moment("9 November 2026, 16:30 -05:00").earliest).toBe(want);
    expect(moment("Monday, Nov 9th, 2026 12:00 AM UTC").earliest).toBe(Date.UTC(2026, 10, 9, 0, 0));
    expect(moment("Nov 9 2026 12:15 AM UTC").earliest).toBe(Date.UTC(2026, 10, 9, 0, 15));
  });

  it("ignores a leading label like 'Updated:' and 'Last updated'", () => {
    expect(moment("Updated: 2026-11-10T09:30:00Z").earliest).toBe(Date.UTC(2026, 10, 10, 9, 30));
    expect(moment("Last updated Nov 9, 2026 4:30 PM EST").earliest).toBe(
      Date.UTC(2026, 10, 9, 21, 30),
    );
  });
});

describe("parseMoment: time zones the stamp does not state", () => {
  it("reads a time with no zone in the configured zone", () => {
    const m = moment("2026-11-10 07:30", "America/New_York");
    expect(m).toEqual({
      earliest: Date.UTC(2026, 10, 10, 12, 30),
      latest: Date.UTC(2026, 10, 10, 12, 30),
      kind: "exact",
    });
  });

  it("follows daylight saving: the same wall time is a different instant in July", () => {
    const winter = moment("2026-01-15 09:00", "America/New_York").earliest;
    const summer = moment("2026-07-15 09:00", "America/New_York").earliest;
    expect(winter).toBe(Date.UTC(2026, 0, 15, 14, 0));
    expect(summer).toBe(Date.UTC(2026, 6, 15, 13, 0));
  });

  it("a date alone is the whole day in the configured zone", () => {
    const m = moment("2026-11-09", "America/New_York");
    expect(m.kind).toBe("date");
    expect(m.earliest).toBe(Date.UTC(2026, 10, 9, 5, 0));
    expect(m.latest).toBe(Date.UTC(2026, 10, 10, 5, 0) - 1);
  });

  it("without a configured zone a time with no zone could be any zone from UTC-12 to UTC+14", () => {
    const m = moment("2026-11-10 07:30");
    expect(m.kind).toBe("no-zone");
    expect(m.earliest).toBe(Date.UTC(2026, 10, 10, 7, 30) - 14 * HOUR);
    expect(m.latest).toBe(Date.UTC(2026, 10, 10, 7, 30) + 12 * HOUR);
  });

  it("a stated zone wins over the configured one", () => {
    expect(moment("2026-11-10T07:30:00Z", "Asia/Tokyo").earliest).toBe(
      Date.UTC(2026, 10, 10, 7, 30),
    );
  });
});

describe("parseMoment: relative words", () => {
  it("'3 hours ago' means between 3 and 4 hours before the run", () => {
    expect(moment("3 hours ago")).toEqual({
      earliest: NOW - 4 * HOUR,
      latest: NOW - 3 * HOUR,
      kind: "relative",
    });
  });

  it.each([
    ["an hour ago", 1 * HOUR, 2 * HOUR],
    ["a minute ago", 60_000, 120_000],
    ["45 minutes ago", 45 * 60_000, 46 * 60_000],
    ["2 days ago", 2 * DAY, 3 * DAY],
    ["1 week ago", 7 * DAY, 14 * DAY],
    ["about 5 hrs ago", 5 * HOUR, 6 * HOUR],
    ["3h ago", 3 * HOUR, 4 * HOUR],
    ["5m ago", 5 * 60_000, 6 * 60_000],
    ["Updated 2 days ago", 2 * DAY, 3 * DAY],
    ["2 months ago", 60 * DAY, 90 * DAY],
  ])("%s", (text, youngest, oldest) => {
    const m = moment(text);
    expect(m.kind).toBe("relative");
    expect(NOW - m.latest).toBe(youngest);
    expect(NOW - m.earliest).toBe(oldest);
  });

  it("'just now' is under a minute", () => {
    const m = moment("just now");
    expect(NOW - m.latest).toBe(0);
    expect(NOW - m.earliest).toBe(60_000);
  });

  it("'yesterday' and 'today' are days in the configured zone", () => {
    const y = moment("yesterday", "America/New_York");
    expect(y.earliest).toBe(Date.UTC(2026, 10, 9, 5, 0));
    expect(y.latest).toBe(Date.UTC(2026, 10, 10, 5, 0) - 1);
    const t = moment("today", "America/New_York");
    expect(t.earliest).toBe(Date.UTC(2026, 10, 10, 5, 0));
  });

  it("other English words are not guessed at", () => {
    for (const text of ["recently", "a while ago", "lately", "in 3 hours", "3 fortnights ago"])
      expect(refused(text), text).toContain("could not read");
  });
});

describe("parseMoment: what it refuses", () => {
  it.each([
    "",
    "   ",
    "TBD",
    "03/04/2026",
    "2026-13-01",
    "2026-02-30",
    "2026-11-10T25:00:00Z",
    "Nov 31, 2026",
    "Smarch 4, 2026",
  ])("%j is not a date", (text) => {
    expect(refused(text)).toMatch(/could not read|empty/);
  });

  it("never prints raw page text: control and invisible characters are escaped in the reason", () => {
    const reason = refused("soon\u202E\u0000 maybe");
    expect(reason).not.toContain("\u202E");
    expect(reason).not.toContain("\u0000");
  });
});
