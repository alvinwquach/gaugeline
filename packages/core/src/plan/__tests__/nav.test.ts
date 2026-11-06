import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { ConfigError } from "../../errors.js";
import {
  checkNav,
  distinctiveWords,
  labelKey,
  navLabelRows,
  navTabLine,
  readNav,
  readNavTab,
  type NavItem,
} from "../nav.js";
import { readPlan, type PlanRow } from "../read.js";
import { readWorkbook, type Sheet } from "../workbook.js";

const PLANS = `${SITES_DIR}../plans/`;
const sheet = (name: string, csv: string): Sheet =>
  readWorkbook(`## Sheet name: Pages\nURL\n/a\n## Sheet name: ${name}\n${csv}`).sheets[1] as Sheet;
const page = (line: number, name: string, extra: Partial<PlanRow> = {}): PlanRow => ({
  line,
  url: `/p${line}`,
  path: `/p${line}`,
  page: name,
  raw: { Page: name, Status: "Live" },
  ...extra,
});
const item = (line: number, label: string, extra: Partial<NavItem> = {}): NavItem => ({
  sheet: "Menu",
  line,
  category: "Menu",
  label,
  ...extra,
});
const load = () => {
  const plan = readPlan(readFileSync(`${PLANS}nav-workbook.txt`, "utf8"));
  const tabs = readNav(plan.workbook, { rows: plan.rows });
  const nav = checkNav(
    tabs.flatMap((t) => t.items),
    plan.rows,
    {
      labels: navLabelRows(plan.workbook.chosen, plan.columns.page, plan.columns.url),
      file: "nav.txt",
    },
  );
  return { plan, tabs, nav };
};

describe("menus against pages: unit", () => {
  it("the category fills down; a Popup Column alternates label and description; a Link column is labels only", () => {
    const popup = readNavTab(
      sheet(
        "Who",
        "Main category,Popup Column\nProviders,Hospitals\n,For every department\n,Clinics\n,Small practices\nYellow = No current page\n",
      ),
    );
    expect(
      popup.items.map((i) => [i.category, i.label, i.description ?? "", i.heading ? "H" : ""]),
    ).toEqual([
      ["Providers", "Providers", "", "H"],
      ["Providers", "Hospitals", "For every department", ""],
      ["Providers", "Clinics", "Small practices", ""],
    ]);
    const link = readNavTab(
      sheet("Footer", "Main category,Link\nCompany,About\n,Careers\nLegal,Privacy\n"),
    );
    expect(
      link.items.filter((i) => !i.heading).map((i) => [i.category, i.label, i.description]),
    ).toEqual([
      ["Company", "About", undefined],
      ["Company", "Careers", undefined],
      ["Legal", "Privacy", undefined],
    ]);
    expect(navTabLine(link)).toBe("Footer: 3 items in 2 categories");
  });

  it("labelKey: (ASCs) keeps its words, (anchor) is dropped, & is and", () => {
    expect(labelKey("Ambulatory Surgery Centers (ASCs)")).toBe("ambulatory surgery centers ascs");
    expect(labelKey("Behavioral (anchor)")).toBe("behavioral");
    expect(labelKey("Security & Trust")).toBe(labelKey("Security and Trust"));
    expect(distinctiveWords("Medical Billing & Healthcare Services")).toEqual(["billing"]);
  });

  it("the distinctive-word rule: one candidate is a mismatch, three are missing with the list", () => {
    const rows = [
      page(2, "Security & Compliance"),
      page(3, "Medical billing"),
      page(4, "Billing audits"),
      page(5, "Billing support"),
    ];
    const out = checkNav([item(10, "Security & Trust"), item(11, "Billing analytics")], rows);
    expect(out.findings.map((f) => [f.checkId, f.group?.lines, f.evidence])).toEqual([
      [
        "plan-nav-label-mismatch",
        [10, 2],
        '"Security & Trust" (Menu, line 10) is "Security & Compliance" in the page plan (line 2)',
      ],
      [
        "plan-nav-missing-row",
        [11],
        '"Billing analytics" (Menu, line 11) has no page row in the plan; it shares a word with "Medical billing" (line 3), "Billing audits" (line 4), "Billing support" (line 5)',
      ],
    ]);
  });
});

describe("menus against pages: integration (the invented Harbourline workbook, --nav)", () => {
  it("six menu tabs read, with their counts; Resources yields 0 items and a warning", () => {
    const { tabs } = load();
    expect(tabs.map(navTabLine)).toEqual([
      "Solutions: 4 items in 1 category",
      "Who We Serve: 6 items in 2 categories",
      "Technology: 3 items in 1 category",
      "Resources: 0 items in 0 categories",
      "About Us: 2 items in 1 category",
      "Footer: 5 items in 2 categories",
    ]);
    expect(tabs[3]?.warnings).toEqual(["Resources: no menu items were read."]);
  });

  it("Mental Health and DSOs are missing; Security & Trust is Security & Compliance; Need Page rows are flagged", () => {
    const { plan, nav } = load();
    const by = (id: string) => nav.findings.filter((f) => f.checkId === id);
    const labels = (id: string) => by(id).map((f) => /^"([^"]+)"/.exec(f.evidence)?.[1]);
    expect(labels("plan-nav-missing-row")).toEqual([
      "Providers",
      "Specialties",
      "Mental Health",
      "DSOs",
      "Billing analytics",
      "About Us",
      "Company",
      "Legal",
      "Terms of use",
    ]);
    expect(by("plan-nav-missing-row").filter((f) => f.severity === "high").length).toBe(4);
    expect(by("plan-nav-label-mismatch").map((f) => f.evidence)).toEqual([
      '"Security & Trust" (Technology, line 46) is "Security & Compliance" in the page plan (line 14)',
    ]);
    // The expected Need Page list, built from the sheet itself.
    const needPage = plan.rows.filter((r) => r.raw.Status === "Need Page").map((r) => r.page);
    expect(labels("plan-nav-needs-page")).toEqual(needPage);
  });

  it("a description is never checked as an item", () => {
    const { tabs, nav } = load();
    const all = tabs.flatMap((t) => t.items);
    expect(all.find((i) => i.label === "RCM built for anesthesia complexity")).toBeUndefined();
    expect(all.find((i) => i.label === "Anesthesia billing")?.description).toBe(
      "RCM built for anesthesia complexity",
    );
    expect(nav.findings.some((f) => f.evidence.includes("RCM built"))).toBe(false);
  });
});

describe("menus against pages: edge cases", () => {
  it("a missing description is noticed when the next line is a page name: resynced, with a warning", () => {
    const { tabs } = load();
    const who = tabs.find((t) => t.sheet === "Who We Serve");
    expect(who?.warnings).toEqual([
      'Who We Serve, line 38: "Physician practices" has no description; "Behavioral Health" is read as the next item.',
    ]);
    expect(who?.items.find((i) => i.label === "Behavioral Health")?.description).toBe(
      "Care that takes time",
    );
  });

  it("the same label in two menus: two items, one finding each when it fails", () => {
    const out = checkNav(
      [item(5, "Leadership", { sheet: "About Us" }), item(9, "Leadership", { sheet: "Footer" })],
      [page(2, "Careers")],
    );
    expect(out.findings.map((f) => [f.group?.key, f.group?.lines])).toEqual([
      ["About Us line 5: Leadership", [5]],
      ["Footer line 9: Leadership", [9]],
    ]);
  });

  it("a label that matches two page rows (a page and its anchor) is matched, with no finding", () => {
    const rows = [page(2, "Behavioral Health"), page(3, "Behavioral Health (anchor)")];
    expect(checkNav([item(9, "Behavioral Health")], rows).findings).toEqual([]);
  });

  it("a heading with no page and no nav-label row is missing at medium, with the note; with a label row it passes", () => {
    const heading = item(4, "Providers", { heading: true, category: "Providers" });
    const out = checkNav([heading], [page(2, "Hospitals")]);
    expect(out.findings.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "medium",
        '"Providers" (Menu, line 4) has no page row in the plan (a menu heading: headings often have no page; add a row with no URL if this one has none)',
      ],
    ]);
    expect(
      checkNav([heading], [page(2, "Hospitals")], { labels: [{ line: 7, label: "Providers" }] })
        .findings,
    ).toEqual([]);
  });

  it("no Status column: plan-nav-needs-page is skipped, and the report says so", () => {
    const out = checkNav([item(9, "Portal")], [{ ...page(2, "Portal"), raw: { Page: "Portal" } }]);
    expect(out).toEqual({
      findings: [],
      notes: ["The plan has no Status column: plan-nav-needs-page was skipped."],
    });
  });

  it("--nav naming the page-plan tab, or a one-tab CSV, is a ConfigError", () => {
    const plan = readPlan(readFileSync(`${PLANS}nav-workbook.txt`, "utf8"));
    expect(() => readNav(plan.workbook, { names: ["Page plan"] })).toThrow(
      '--nav: "Page plan" has a URL column: that is the page plan, not a menu.',
    );
    const one = readPlan("URL,Page\n/a,A\n");
    expect(() => readNav(one.workbook)).toThrow(ConfigError);
    expect(() => readNav(one.workbook)).toThrow("--nav: no menu tab was found");
  });

  it("the same file gives the same findings twice, with no request", () => {
    expect(load().nav).toEqual(load().nav);
  });
});
