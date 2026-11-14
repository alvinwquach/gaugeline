import { describe, expect, it } from "vitest";
import { daysUntil, expiryPhrase, isoOf, readWrittenDate, urgency, writeDate } from "../dates.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const at = (days: number, hours = 0) =>
  new Date(NOW.getTime() + days * 86_400_000 + hours * 3_600_000).toISOString();

describe("dates: unit", () => {
  it("counts whole days, rounding down, from the injected clock", () => {
    expect(daysUntil(at(24), NOW)).toBe(24);
    expect(daysUntil(at(24, 23), NOW)).toBe(24);
    expect(daysUntil(at(0, 5), NOW)).toBe(0);
    expect(daysUntil(at(-1), NOW)).toBe(-1);
    expect(daysUntil(at(0, -1), NOW)).toBe(-1);
  });

  it("writes the date out in UTC, with no zero padding", () => {
    expect(writeDate("2026-12-03T14:02:11Z")).toBe("3 Dec 2026");
    expect(writeDate("2027-01-01T00:00:00Z")).toBe("1 Jan 2027");
    // 23:30 UTC is still the 3rd, whatever the machine's zone.
    expect(writeDate("2026-12-03T23:30:00Z")).toBe("3 Dec 2026");
  });

  it("reads a written date back, and refuses one that is not a day", () => {
    expect(readWrittenDate("marlowe-bar.example expires 3 Dec 2026, 24 days")).toBe("2026-12-03");
    expect(readWrittenDate("expired 29 Feb 2028, 3 days ago")).toBe("2028-02-29");
    expect(readWrittenDate("expires 31 Feb 2026, 4 days")).toBeUndefined();
    expect(readWrittenDate("no date here")).toBeUndefined();
  });

  it("phrases an expiry with the date written out and the days", () => {
    expect(expiryPhrase("2026-12-03T14:02:11Z", NOW)).toBe("expires 3 Dec 2026, 24 days");
    expect(expiryPhrase(at(1, 3), NOW)).toBe("expires 10 Nov 2026, 1 day");
    expect(expiryPhrase(at(0, 4), NOW)).toBe("expires 9 Nov 2026, less than a day");
    expect(expiryPhrase("2026-11-06T09:00:00Z", NOW)).toBe("expired 6 Nov 2026, 3 days ago");
    expect(expiryPhrase("2026-11-09T11:00:00Z", NOW)).toBe(
      "expired 9 Nov 2026, less than a day ago",
    );
    expect(expiryPhrase("2026-12-03T00:00:00Z", NOW, ["retires", "retired"])).toBe(
      "retires 3 Dec 2026, 23 days",
    );
  });

  it("takes only real dates from a registry", () => {
    expect(isoOf("2026-12-03T14:02:11Z")).toBe("2026-12-03T14:02:11.000Z");
    expect(isoOf("soon")).toBeUndefined();
    expect(isoOf("")).toBeUndefined();
    expect(isoOf(42)).toBeUndefined();
  });
});

describe("urgency: the threshold table with an injected clock", () => {
  // Domain registration: under 30 days is fix soon, under 7 fix first.
  it.each([
    [45, "fine"],
    [30, "fine"],
    [29, "soon"],
    [7, "soon"],
    [6, "first"],
    [0, "first"],
    [-1, "first"],
  ])("a domain with %i days left is %s", (days, level) => {
    expect(urgency(at(days, 1), NOW, 30, 7)).toBe(level);
  });

  // Certificates and tokens: under 21 days soon, under 7 first.
  it.each([
    [21, "fine"],
    [20, "soon"],
    [7, "soon"],
    [6, "first"],
  ])("a certificate with %i days left is %s", (days, level) => {
    expect(urgency(at(days, 1), NOW, 21, 7)).toBe(level);
  });

  it("is first the moment the time has passed, even by a second", () => {
    expect(urgency(new Date(NOW.getTime() - 1000).toISOString(), NOW, 30, 7)).toBe("first");
    expect(urgency(NOW.toISOString(), NOW, 30, 7)).toBe("first");
  });
});

describe("dates: edge cases", () => {
  it("counts a leap day: 28 Feb 2028 to 1 Mar 2028 is 2 days", () => {
    const now = new Date("2028-02-28T00:00:00Z");
    expect(daysUntil("2028-03-01T00:00:00Z", now)).toBe(2);
    expect(daysUntil("2027-03-01T00:00:00Z", new Date("2027-02-28T00:00:00Z"))).toBe(1);
    expect(expiryPhrase("2028-02-29T10:00:00Z", now)).toBe("expires 29 Feb 2028, 1 day");
  });

  it("is not moved by a clock change: a day is 86,400 seconds in UTC", () => {
    // The US clocks went back on 1 Nov 2026 and forward on 8 Mar 2026; neither moves a count.
    expect(daysUntil("2026-11-02T12:00:00Z", new Date("2026-10-31T12:00:00Z"))).toBe(2);
    expect(daysUntil("2026-03-10T00:00:00Z", new Date("2026-03-07T00:00:00Z"))).toBe(3);
  });

  it("crosses the year end", () => {
    expect(daysUntil("2027-01-02T00:00:00Z", new Date("2026-12-30T00:00:00Z"))).toBe(3);
  });
});
