import { ConfigError } from "../errors.js";
import type { Finding } from "../model.js";
import { normaliseHeader, parseCsv } from "./columns.js";
import { textKey } from "./keys.js";
import type { PlanRow } from "./read.js";
import type { Sheet, Workbook } from "./workbook.js";

/**
 * The menus a plan workbook describes, against its page plan: every menu item should have a page
 * row with the same name. Pure: no request. Menu tabs are read by their columns, in the two layouts
 * real workbooks use; the per-tab count line shows how each was read.
 */
export interface NavItem {
  sheet: string;
  /** The line in the file, as the person sees it. */
  line: number;
  category: string;
  label: string;
  description?: string;
  /** A category heading (the first column), checked like an item but allowed to have no page. */
  heading?: boolean;
}

export interface NavTab {
  sheet: string;
  items: NavItem[];
  categories: number;
  warnings: string[];
}

/** Words too common in this kind of plan to say two labels are about the same page. */
export const NAV_STOP_WORDS: ReadonlySet<string> = new Set([
  "health",
  "healthcare",
  "medical",
  "services",
  "service",
  "management",
]);

/** Bracketed notes a planner adds to a label, not part of its name. */
const NOTE =
  /\s*\((?:anchor|anchor link|page|link|new|tbd|soon|coming soon|optional|dropdown|menu only)\)\s*$/i;

/**
 * The key two labels are compared on: G16's textKey, "&" as "and", a trailing note such as
 * "(anchor)" dropped, any other brackets kept as words ("Centers (ASCs)" keeps "ascs").
 */
export function labelKey(label: string): string {
  return textKey(label.replace(NOTE, ""))
    .replace(/&/g, " and ")
    .replace(/[()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words of five letters or more, not in the stop list: what makes two labels about one page. */
export function distinctiveWords(label: string): string[] {
  return [
    ...new Set(
      labelKey(label)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 5 && !NAV_STOP_WORDS.has(w)),
    ),
  ];
}

const isMenuTab = (sheet: Sheet) => normaliseHeader(sheet.headers[0] ?? "") === "main category";
const FOOTNOTE = /^[^,=]{1,30}\s=\s/;

/**
 * The menu tabs: the ones named (a tab with a URL column is the page plan, and an error), or every
 * tab whose first header is "Main category". None is a ConfigError.
 */
export function navSheets(workbook: Workbook, names: readonly string[] = []): Sheet[] {
  if (names.length > 0)
    return names.map((name) => {
      const sheet = workbook.sheets.find(
        (s) => s.name.trim().toLowerCase() === name.trim().toLowerCase(),
      );
      if (!sheet)
        throw new ConfigError(
          `--nav: there is no tab named "${name}". Tabs: ${workbook.sheets.map((s) => s.name.trim()).join(", ")}.`,
        );
      if (sheet.headers.some((h) => ["url", "address", "new url"].includes(normaliseHeader(h))))
        throw new ConfigError(
          `--nav: "${sheet.name.trim()}" has a URL column: that is the page plan, not a menu.`,
          {
            hint: "Name the menu tabs, or leave --nav empty to read every tab headed Main category.",
          },
        );
      return sheet;
    });
  const menus = workbook.sheets.filter(isMenuTab);
  if (menus.length === 0)
    throw new ConfigError(
      "--nav: no menu tab was found (a tab whose first header is Main category).",
      {
        hint:
          workbook.sheets.length === 1
            ? "The file has one tab, the page plan: export the whole workbook, with its menu tabs."
            : "Name the menu tabs after --nav, comma separated.",
      },
    );
  return menus;
}

/**
 * One menu tab. The first column is the category and fills down. A "Popup Column" alternates
 * label and description; a "Link" column is labels only. Blank lines, lines with no second column
 * and footnotes ("Yellow = No current page") are skipped. A missing description is noticed when
 * the line read as a description is a page name: it is read as the next label, with a warning.
 */
export function readNavTab(sheet: Sheet, pageNames: ReadonlySet<string> = new Set()): NavTab {
  const name = sheet.name.trim();
  const records = parseCsv(sheet.csvText).map((r) => ({ ...r, line: r.line + sheet.lineOffset }));
  const header = records[0]?.cells ?? [];
  const second = normaliseHeader(header[1] ?? "");
  const out: NavTab = { sheet: name, items: [], categories: 0, warnings: [] };
  const layout = second === "popup column" ? "popup" : second === "link" ? "link" : undefined;
  if (!layout) {
    out.warnings.push(
      `${name}: the second column is "${(header[1] ?? "").trim()}"; menus are read from a Popup Column (label, then description) or a Link column. Nothing was read.`,
    );
    return out;
  }
  let category = "";
  let expecting: "label" | "description" = "label";
  let last: NavItem | undefined;
  const seen = new Set<string>();
  for (const record of records.slice(1)) {
    const first = (record.cells[0] ?? "").trim();
    const text = (record.cells[1] ?? "").trim();
    if (text === "" || FOOTNOTE.test(first) || FOOTNOTE.test(text)) continue;
    if (first !== "" && first !== category) {
      category = first;
      expecting = "label";
      if (!seen.has(category)) {
        seen.add(category);
        out.items.push({
          sheet: name,
          line: record.line,
          category,
          label: category,
          heading: true,
        });
      }
    }
    if (layout === "popup" && expecting === "description" && last) {
      // A "description" that is a page name: the description was missing, and this is the next item.
      if (!pageNames.has(labelKey(text))) {
        last.description = text;
        expecting = "label";
        continue;
      }
      out.warnings.push(
        `${name}, line ${record.line}: "${last.label}" has no description; "${text}" is read as the next item.`,
      );
    }
    last = { sheet: name, line: record.line, category, label: text };
    out.items.push(last);
    expecting = layout === "popup" ? "description" : "label";
  }
  out.categories = seen.size;
  if (out.items.length === 0) out.warnings.push(`${name}: no menu items were read.`);
  return out;
}

/** Every menu tab, read in order, with a page-name set for resyncing a missing description. */
export function readNav(
  workbook: Workbook,
  opts: { names?: readonly string[]; rows?: readonly PlanRow[] } = {},
): NavTab[] {
  const pageNames = new Set<string>();
  for (const r of opts.rows ?? []) {
    if (r.page) pageNames.add(labelKey(r.page));
    if (r.h1) pageNames.add(labelKey(r.h1));
  }
  return navSheets(workbook, opts.names).map((s) => readNavTab(s, pageNames));
}

/** A row without a URL that names a section (a nav label row): a heading may match it. */
export interface NavLabelRow {
  line: number;
  label: string;
}

/** The page plan's rows with no URL, by their Page cell: what a menu heading may match. */
export function navLabelRows(
  sheet: Sheet,
  pageHeader: string | undefined,
  urlHeader: string | undefined,
): NavLabelRow[] {
  if (!pageHeader || !urlHeader) return [];
  const records = parseCsv(sheet.csvText).map((r) => ({ ...r, line: r.line + sheet.lineOffset }));
  const header = records.find((r) => r.cells.includes(urlHeader));
  if (!header) return [];
  const pageAt = header.cells.indexOf(pageHeader);
  const urlAt = header.cells.indexOf(urlHeader);
  return records
    .filter((r) => r.line > header.line)
    .flatMap((r) => {
      const label = (r.cells[pageAt] ?? "").trim();
      return label !== "" && (r.cells[urlAt] ?? "").trim() === "" ? [{ line: r.line, label }] : [];
    });
}

export const NAV_TITLES = {
  "plan-nav-missing-row": "A menu item has no page in the plan",
  "plan-nav-label-mismatch": "A menu item and its page are named differently",
  "plan-nav-needs-page": "A menu item links to a page that still needs building",
} as const;
export type NavCheckId = keyof typeof NAV_TITLES;

export interface NavResult {
  findings: Finding[];
  /** Said once: "The plan has no Status column: plan-nav-needs-page was skipped." */
  notes: string[];
}

const statusOf = (row: PlanRow) =>
  Object.entries(row.raw).find(([h]) => normaliseHeader(h) === "status")?.[1];

/**
 * Every menu item against the page plan. A keyed lookup answers most of them; only the leftovers
 * go through the word rule: exactly one page sharing a distinctive word is a label mismatch, none
 * or several is a missing row (with up to three candidates named). Pure: no request.
 */
export function checkNav(
  items: readonly NavItem[],
  rows: readonly PlanRow[],
  opts: { labels?: readonly NavLabelRow[]; file?: string } = {},
): NavResult {
  const file = opts.file ?? "the plan";
  const byKey = new Map<string, { line: number; name: string; row?: PlanRow }[]>();
  const add = (key: string, entry: { line: number; name: string; row?: PlanRow }) => {
    const list = byKey.get(key);
    if (list) list.push(entry);
    else byKey.set(key, [entry]);
  };
  for (const row of rows)
    for (const name of new Set(
      [row.page, row.h1].filter((v): v is string => !!v && v.trim() !== ""),
    ))
      add(labelKey(name), { line: row.line, name, row });
  const labelKeys = new Map<string, NavLabelRow>();
  for (const l of opts.labels ?? []) labelKeys.set(labelKey(l.label), l);
  // Distinctive word -> page names that have it (one entry per page name).
  const byWord = new Map<string, Map<string, { line: number; name: string }>>();
  for (const row of rows) {
    if (!row.page) continue;
    for (const w of distinctiveWords(row.page)) {
      const names = byWord.get(w) ?? new Map<string, { line: number; name: string }>();
      if (!names.has(labelKey(row.page)))
        names.set(labelKey(row.page), { line: row.line, name: row.page });
      byWord.set(w, names);
    }
  }
  const hasStatus = rows.some((r) => statusOf(r) !== undefined);
  const findings: Finding[] = [];
  const where = (i: NavItem) =>
    `${i.sheet}${i.heading || i.category === i.sheet ? "" : ` › ${i.category}`}, line ${i.line}`;
  const finding = (
    id: NavCheckId,
    severity: Finding["severity"],
    i: NavItem,
    evidence: string,
    lines: number[],
  ): Finding => ({
    checkId: id,
    severity,
    title: NAV_TITLES[id],
    evidence,
    url: file,
    group: { key: `${i.sheet} line ${i.line}: ${i.label}`, lines },
  });
  for (const item of items) {
    const key = labelKey(item.label);
    const matches = byKey.get(key) ?? [];
    if (matches.length > 0 || (item.heading && labelKeys.has(key))) {
      if (!hasStatus) continue;
      const unbuilt = matches.find((m) => m.row && /need(?:s)? page/i.test(statusOf(m.row) ?? ""));
      if (unbuilt)
        findings.push(
          finding(
            "plan-nav-needs-page",
            "medium",
            item,
            `"${item.label}" (${where(item)}) links to "${unbuilt.name}", whose Status is "${statusOf(unbuilt.row as PlanRow)?.trim()}" (line ${unbuilt.line})`,
            [item.line, unbuilt.line],
          ),
        );
      continue;
    }
    const candidates = new Map<string, { line: number; name: string }>();
    for (const w of distinctiveWords(item.label))
      for (const [k, c] of byWord.get(w) ?? []) candidates.set(k, c);
    const list = [...candidates.values()].sort((a, b) => a.line - b.line);
    const only = list.length === 1 ? list[0] : undefined;
    if (only) {
      findings.push(
        finding(
          "plan-nav-label-mismatch",
          "medium",
          item,
          `"${item.label}" (${where(item)}) is "${only.name}" in the page plan (line ${only.line})`,
          [item.line, only.line],
        ),
      );
      continue;
    }
    const named =
      list.length > 1
        ? `; it shares a word with ${list
            .slice(0, 3)
            .map((c) => `"${c.name}" (line ${c.line})`)
            .join(", ")}${list.length > 3 ? ` and ${list.length - 3} more` : ""}`
        : "";
    findings.push(
      finding(
        "plan-nav-missing-row",
        item.heading ? "medium" : "high",
        item,
        `"${item.label}" (${where(item)}) has no page row in the plan${named}${item.heading ? " (a menu heading: headings often have no page; add a row with no URL if this one has none)" : ""}`,
        [item.line],
      ),
    );
  }
  return {
    findings,
    notes: hasStatus ? [] : ["The plan has no Status column: plan-nav-needs-page was skipped."],
  };
}

/** "Who We Serve: 8 items in 2 categories", per tab, so a misread layout shows at once. */
export function navTabLine(tab: NavTab): string {
  const items = tab.items.filter((i) => !i.heading).length;
  return `${tab.sheet}: ${items} item${items === 1 ? "" : "s"} in ${tab.categories} categor${tab.categories === 1 ? "y" : "ies"}`;
}
