/**
 * What happened last night, without a database (X63, part 3): how sites are grouped and how the opening
 * sentence reads.
 */
import { describe, expect, it } from "vitest";
import { trendOf, type Counts } from "../../lib/web/dashboard.js";
import { groupNight, nightSentence, type NightSite } from "../../lib/web/last-night.js";
import { nightBody } from "../../lib/web/last-night-view.js";

const c = (high: number, medium: number): Counts => ({ high, medium, low: 0 });
const night = (
  name: string,
  now: Counts | null,
  prev: Counts | null,
  changes: NightSite["changes"] = null,
): NightSite => ({
  id: name,
  name,
  url: `https://${name.toLowerCase().replace(/\W+/g, "-")}.test`,
  timezone: "Europe/London",
  lastRun: now ? { id: `r-${name}`, startedAt: new Date("2026-11-12T03:00:00Z") } : null,
  counts: now,
  previous: prev,
  trend: trendOf(now, prev),
  newest: null,
  changes,
});
const item = (title: string, severity: "high" | "medium" | "low" = "high") => ({
  severity,
  title,
  evidence: "e",
});
const ch = (
  n: number,
  still: number,
  closed: number,
  opened = [item("New one")],
  gone = [item("Gone one")],
): NonNullable<NightSite["changes"]> => ({
  opened: n ? opened : [],
  openedTotal: n,
  stillOpen: still,
  closed: closed ? gone : [],
  closedTotal: closed,
});

describe("groups", () => {
  it("puts a site with a new problem first, then closed-only, then quiet, then first check, then not checked", () => {
    const g = groupNight([
      night("Quiet", c(0, 1), c(0, 1), ch(0, 1, 0)),
      night("Never", null, null),
      night("Fixed", c(0, 0), c(0, 1), ch(0, 0, 1)),
      night("Fresh", c(1, 0), null),
      night("Bad", c(1, 0), c(0, 0), ch(1, 0, 0)),
      night("Mixed", c(1, 0), c(1, 0), ch(1, 1, 1)),
    ]);
    expect(g.map((x) => [x.key, x.sites.map((s) => s.name)])).toEqual([
      ["new", ["Bad", "Mixed"]],
      ["closed", ["Fixed"]],
      ["quiet", ["Quiet"]],
      ["first", ["Fresh"]],
      ["unchecked", ["Never"]],
    ]);
  });

  it("an empty group is left out, and no sites at all gives no groups", () => {
    expect(groupNight([night("Quiet", c(0, 0), c(0, 0), ch(0, 0, 0))]).map((x) => x.key)).toEqual([
      "quiet",
    ]);
    expect(groupNight([])).toEqual([]);
  });
});

describe("the opening sentence", () => {
  it("counts each kind of night in words", () => {
    const s = nightSentence([
      night("Bad", c(1, 0), c(0, 0), ch(1, 0, 0)),
      night("Fixed", c(0, 0), c(0, 1), ch(0, 0, 1)),
      night("Quiet", c(0, 1), c(0, 1), ch(0, 1, 0)),
      night("Never", null, null),
    ]);
    expect(s).toBe(
      "4 sites. 1 has new problems, 1 had problems closed, 1 is unchanged, 1 has not been checked yet.",
    );
    expect(nightSentence([night("Quiet", c(0, 0), c(0, 0), ch(0, 0, 0))])).toBe(
      "1 site. 1 is unchanged.",
    );
  });
});

describe("the page", () => {
  it("lists new and closed problems by name with their level, counts the rest, and shows page text as text", () => {
    const hostile = night(
      "Bad",
      c(1, 0),
      c(0, 0),
      ch(3, 2, 1, [item("<b>Menu</b> PDF gone"), item("Two", "medium")]),
    );
    const html = nightBody([hostile], "owner").toString();
    expect(html).toContain("3 new");
    expect(html).toContain("2 still open");
    expect(html).toContain("1 closed");
    expect(html).toContain("&lt;b&gt;Menu&lt;/b&gt; PDF gone");
    expect(html).toContain("Fix this first");
    expect(html).toContain("and 1 more");
  });

  it("says what to do when there are no sites", () => {
    expect(nightBody([], "owner").toString()).toContain("No sites yet");
  });
});
