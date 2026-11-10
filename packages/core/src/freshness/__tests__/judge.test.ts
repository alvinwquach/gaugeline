import { describe, expect, it } from "vitest";
import { describeMonths, judgeAge, judgeLag, passedBy } from "../judge.js";
import type { Moment } from "../time.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0);
const exact = (at: number): Moment => ({ earliest: at, latest: at, kind: "exact" });

describe("judgeAge: unit", () => {
  it("is stale only when even the latest the stamp could be is older than allowed", () => {
    expect(judgeAge(exact(NOW - 7 * HOUR), NOW, 6 * HOUR)).toBe("stale");
    expect(judgeAge(exact(NOW - 6 * HOUR), NOW, 6 * HOUR)).toBe("fresh");
    expect(judgeAge(exact(NOW - 1 * HOUR), NOW, 6 * HOUR)).toBe("fresh");
  });

  it("a stamp in the future (a clock a little ahead) is fresh", () => {
    expect(judgeAge(exact(NOW + 2 * HOUR), NOW, 6 * HOUR)).toBe("fresh");
  });

  it("a span that straddles the limit is not decided", () => {
    const span: Moment = { earliest: NOW - 8 * HOUR, latest: NOW - 5 * HOUR, kind: "relative" };
    expect(judgeAge(span, NOW, 6 * HOUR)).toBe("unsure");
    expect(judgeAge({ ...span, latest: NOW - 7 * HOUR }, NOW, 6 * HOUR)).toBe("stale");
    expect(judgeAge({ ...span, earliest: NOW - 6 * HOUR }, NOW, 6 * HOUR)).toBe("fresh");
  });
});

describe("judgeLag: the page's stamp against the source's time", () => {
  const source = NOW - 10 * 60_000;
  it("is behind when the page is older than the source by more than maxLag", () => {
    expect(judgeLag(exact(source - 2 * HOUR), source, HOUR)).toBe("behind");
    expect(judgeLag(exact(source - HOUR), source, HOUR)).toBe("level");
  });
  it("a page newer than the source is level, not behind", () => {
    expect(judgeLag(exact(source + 5 * HOUR), source, HOUR)).toBe("level");
  });
  it("a span that straddles the limit is not decided", () => {
    const span: Moment = {
      earliest: source - 3 * HOUR,
      latest: source - 30 * 60_000,
      kind: "no-zone",
    };
    expect(judgeLag(span, source, HOUR)).toBe("unsure");
  });
});

describe("passedBy: how long ago, as the fewest and the most it could be", () => {
  it("is exact for a stamp with a zone and 'at least' for a span", () => {
    expect(passedBy(exact(NOW - 31 * HOUR), NOW)).toBe("31 hours");
    expect(
      passedBy({ earliest: NOW - 4 * HOUR, latest: NOW - 3 * HOUR, kind: "relative" }, NOW),
    ).toBe("at least 3 hours");
  });
  it("never goes below zero", () => {
    expect(passedBy(exact(NOW + HOUR), NOW)).toBe("0 seconds");
  });
});

describe("describeMonths: unit", () => {
  it("names a run of months, across the year boundary too", () => {
    expect(describeMonths([10, 11, 12, 1, 2, 3, 4, 5, 6])).toBe("October to June");
    expect(describeMonths([1, 2, 3])).toBe("January to March");
    expect(describeMonths([6])).toBe("June");
    expect(describeMonths([6, 7])).toBe("June and July");
    expect(describeMonths([12, 1])).toBe("December and January");
  });
  it("names several runs", () => {
    expect(describeMonths([1, 2, 9, 10, 11])).toBe("January to February and September to November");
    expect(describeMonths([3, 7, 11])).toBe("March, July and November");
  });
  it("all twelve is every month", () => {
    expect(describeMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe("every month");
  });
});
