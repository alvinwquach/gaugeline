/**
 * The dashboard's ordering, its worse / better / still labels, and how a site's row is drawn (X63, part 2).
 * No database: the rows are invented summaries.
 */
import { describe, expect, it } from "vitest";
import { sortSites, trendOf, type Counts, type SiteSummary } from "../../lib/web/dashboard.js";
import { dashboardBody, formatWhen } from "../../lib/web/dashboard-view.js";

const c = (high: number, medium: number, low = 0): Counts => ({ high, medium, low });
const site = (name: string, now: Counts | null, prev: Counts | null = null): SiteSummary => ({
  id: name,
  name,
  url: `https://${name.toLowerCase().replace(/\W+/g, "-")}.test`,
  timezone: "Europe/London",
  lastRun: now ? { id: `run-${name}`, startedAt: new Date("2026-11-12T03:00:00Z") } : null,
  counts: now,
  previous: prev,
  trend: trendOf(now, prev),
  newest: null,
});

describe("worse, better, still", () => {
  it("compares Fix this first, then Fix soon; Worth knowing does not count", () => {
    expect(trendOf(c(2, 0), c(1, 5))).toBe("worse");
    expect(trendOf(c(0, 3), c(0, 2))).toBe("worse");
    expect(trendOf(c(0, 2), c(0, 3))).toBe("better");
    expect(trendOf(c(0, 9), c(1, 0))).toBe("better");
    expect(trendOf(c(1, 2, 0), c(1, 2, 7))).toBe("still");
    expect(trendOf(c(0, 0, 4), c(0, 0, 0))).toBe("still");
  });

  it("a site with one run has no trend yet, and a site never checked says so", () => {
    expect(trendOf(c(3, 3), null)).toBe("first");
    expect(trendOf(null, null)).toBe("unchecked");
    expect(trendOf(null, c(1, 1))).toBe("unchecked");
  });
});

describe("worst first", () => {
  it("orders by Fix this first, then Fix soon, then name; sites never checked go last", () => {
    const list = sortSites([
      site("Linden Bakery", null),
      site("Juniper", c(0, 1), c(0, 2)),
      site("Harbour Yoga", c(0, 3), c(0, 3)),
      site("Tidewater", c(2, 1), c(1, 0)),
      site("Apple Cafe", c(0, 1), c(0, 1)),
      site("Zed Gym", c(2, 1), c(2, 1)),
    ]).map((s) => s.name);
    expect(list).toEqual([
      "Tidewater",
      "Zed Gym",
      "Harbour Yoga",
      "Apple Cafe",
      "Juniper",
      "Linden Bakery",
    ]);
  });

  it("does not change its input, gives the same order for the same input, and handles none", () => {
    const input = [site("B", c(1, 0)), site("A", c(1, 0))];
    const copy = [...input];
    expect(sortSites(input).map((s) => s.name)).toEqual(["A", "B"]);
    expect(input).toEqual(copy);
    expect(sortSites([])).toEqual([]);
  });

  it("many findings do not overflow: counts are integers compared as integers", () => {
    expect(sortSites([site("A", c(9, 0)), site("B", c(10, 0))]).map((s) => s.name)).toEqual([
      "B",
      "A",
    ]);
  });
});

describe("the page body", () => {
  it("shows words for the trend (colour is never the only signal), counts, and the time in the site's timezone", () => {
    const html = dashboardBody([site("Tidewater", c(2, 1), c(1, 0))], "owner").toString();
    expect(html).toContain("Worse");
    expect(html).toMatch(/Fix this first[\s\S]*Fix soon/);
    expect(html).toContain("12 Nov 2026, 03:00");
    expect(html).toContain("<caption");
  });

  it("formats in the site's timezone, and falls back to UTC for one that does not exist", () => {
    const t = new Date("2026-11-12T03:00:00Z");
    expect(formatWhen(t, "America/Toronto")).toBe("11 Nov 2026, 22:00");
    expect(formatWhen(t, "Not/AZone")).toBe("12 Nov 2026, 03:00 UTC");
  });

  it("the newest finding is shown as text: hidden characters removed, markup escaped, long evidence cut", () => {
    const s = site("Tidewater", c(1, 0), c(0, 0));
    s.newest = {
      severity: "high",
      title: "Menu <img src=x onerror=alert(1)> broken\u{E0041}",
      evidence: `/menu links to ${"x".repeat(400)}`,
    };
    const html = dashboardBody([s], "owner").toString();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; broken");
    expect(html).not.toContain("\u{E0041}");
    expect(html).toContain("[cut]");
    expect(html).toContain("Fix this first");
  });

  it("says what to do when there are no sites, and when a site has not been checked", () => {
    const none = dashboardBody([], "owner").toString();
    expect(none).toContain("No sites yet");
    expect(none).toMatch(/runs API|upload|first run/i);
    expect(dashboardBody([site("Linden Bakery", null)], "owner").toString()).toContain(
      "Not checked yet",
    );
    expect(dashboardBody([], "client").toString()).toContain(
      "No site has been shared with you yet",
    );
  });

  it("a site with one run says it is the first, not 'still'", () => {
    expect(dashboardBody([site("Maple", c(0, 1))], "owner").toString()).toContain("First check");
  });
});
