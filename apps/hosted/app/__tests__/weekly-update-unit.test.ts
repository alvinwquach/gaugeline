/** The weekly client update's wording from a week of runs (X66): plain rules, the same week gives the same text. */
import { describe, expect, it } from "vitest";
import { checkDraftPayload } from "../../inbox/kinds.js";
import {
  composeWeeklyUpdate,
  siteWeek,
  sortClientsWorstFirst,
  type WeekInput,
} from "../../agency/weekly-update.js";

const f = (fingerprint: string, title: string, severity: "high" | "medium" | "low" = "medium") => ({
  fingerprint,
  title,
  url: `https://tidewater-bar.test/${fingerprint.slice(0, 4)}`,
  severity,
});

const base: WeekInput = {
  agencyName: "Northgate Studio",
  clientName: "Tidewater Hospitality",
  weekStart: "2026-11-09",
  sites: [
    {
      name: "The Tidewater Bar",
      url: "https://tidewater-bar.test",
      before: [
        f("aaaa000000000000", "Broken link on the menu page", "high"),
        f("bbbb000000000000", "No canonical address"),
      ],
      runs: [
        {
          startedAt: "2026-11-10T03:00:00Z",
          findings: [
            f("aaaa000000000000", "Broken link on the menu page", "high"),
            f("bbbb000000000000", "No canonical address"),
            f("cccc000000000000", "An image has no description", "low"),
          ],
        },
        {
          startedAt: "2026-11-12T03:00:00Z",
          findings: [
            f("bbbb000000000000", "No canonical address"),
            f("cccc000000000000", "An image has no description", "low"),
          ],
        },
      ],
    },
  ],
};

/** True when `text` has a control character other than newline, or a bidirectional control. */
const hasControl = (text: string): boolean =>
  [...text].some((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      (c < 0x20 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });

describe("the weekly update's wording", () => {
  it("says what was checked, what is new, what was fixed and what is still waiting", () => {
    const u = composeWeeklyUpdate(base);
    expect(u.subject).toBe("Tidewater Hospitality: your sites, week of Mon 9 Nov");
    expect(u.body).toBe(
      [
        "Hello from Northgate Studio. Here is what we checked on your site this week.",
        "",
        "The Tidewater Bar (tidewater-bar.test)",
        "Checked 2 times between Tue 10 Nov and Thu 12 Nov.",
        "This week: 1 new thing to fix, 1 fixed and 1 older one still open.",
        "",
        "New this week:",
        "- An image has no description",
        "Fixed this week:",
        "- Broken link on the menu page",
        "Still waiting:",
        "- No canonical address",
        "",
        "Northgate Studio",
      ].join("\n"),
    );
  });

  it("a client with nothing found this week still gets a short 'all checked, nothing found'", () => {
    const u = composeWeeklyUpdate({
      ...base,
      sites: [
        {
          ...base.sites[0]!,
          before: [],
          runs: [{ startedAt: "2026-11-13T03:00:00Z", findings: [] }],
        },
      ],
    });
    expect(u.body).toContain("Checked once, on Fri 13 Nov.\nAll checked, nothing found.");
    expect(u.body).not.toContain("New this week");
  });

  it("a site with no run this week says so instead of claiming it was checked", () => {
    const week = siteWeek({ ...base.sites[0]!, runs: [] });
    expect(week.lines).toEqual([
      "The Tidewater Bar (tidewater-bar.test)",
      "Not checked this week.",
    ]);
  });

  it("is deterministic: the same week in any order gives the same text", () => {
    const shuffled: WeekInput = {
      ...base,
      sites: [{ ...base.sites[0]!, runs: [...base.sites[0]!.runs].reverse() }],
    };
    expect(composeWeeklyUpdate(shuffled)).toEqual(composeWeeklyUpdate(base));
  });

  it("a finding new this week and gone by the last run counts as fixed, not new", () => {
    const week = siteWeek({
      ...base.sites[0]!,
      before: [],
      runs: [
        {
          startedAt: "2026-11-10T03:00:00Z",
          findings: [f("dddd000000000000", "Opening hours missing")],
        },
        { startedAt: "2026-11-11T03:00:00Z", findings: [] },
      ],
    });
    expect(week.counts).toEqual({ new: 0, fixed: 1, waiting: 0 });
  });

  it("titles from a checked site are kept to one line (plain text; pages escape it)", () => {
    const week = siteWeek({
      ...base.sites[0]!,
      before: [],
      runs: [
        {
          startedAt: "2026-11-10T03:00:00Z",
          findings: [f("eeee000000000000", "Line one\nLine two <b>")],
        },
      ],
    });
    expect(week.lines.join("\n")).toContain("- Line one Line two <b>");
  });

  it("orders clients worst first: high findings, then open, then what changed, then name", () => {
    const order = sortClientsWorstFirst([
      { name: "Calm Cafe", high: 0, open: 1, changed: 0 },
      { name: "Busy Bar", high: 1, open: 1, changed: 0 },
      { name: "Alder Clinic", high: 0, open: 1, changed: 2 },
      { name: "Birch Barber", high: 0, open: 1, changed: 2 },
    ]);
    expect(order.map((c) => c.name)).toEqual([
      "Busy Bar",
      "Alder Clinic",
      "Birch Barber",
      "Calm Cafe",
    ]);
  });

  it("names with a line break, a control or a bidirectional control still make a valid one-line email draft", () => {
    const u = composeWeeklyUpdate({
      ...base,
      agencyName: "Northgate\u202eStudio",
      clientName: "Tidewater\nHospitality",
      sites: [{ ...base.sites[0]!, name: "The Tidewater\u0007Bar" }],
    });
    expect(checkDraftPayload("email", u).ok).toBe(true);
    expect(hasControl(u.subject) || u.subject.includes("\n")).toBe(false);
    expect(hasControl(u.body)).toBe(false);
  });
});
