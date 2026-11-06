import type { Plan, PlanField } from "@gaugeline/core";

const NAMES: Readonly<Record<PlanField, string>> = Object.freeze({
  url: "URL",
  page: "page",
  titleTag: "title tag",
  h1: "H1",
  primaryKeyword: "primary keyword",
  secondaryKeyword: "secondary keyword",
  legacyUrl: "legacy URL",
});

const ORDER: readonly PlanField[] = [
  "url",
  "page",
  "titleTag",
  "h1",
  "primaryKeyword",
  "secondaryKeyword",
  "legacyUrl",
];

/** What was read: how many pages, which column became what, and any warning. */
export function formatPlanSummary(plan: Plan, file: string): string {
  const lines = [
    `Read ${plan.rows.length} page${plan.rows.length === 1 ? "" : "s"} from ${file}${plan.skipped > 0 ? ` (${plan.skipped} row${plan.skipped === 1 ? "" : "s"} without a URL skipped)` : ""}.`,
    `Columns: ${ORDER.filter((f) => plan.columns[f] !== undefined)
      .map((f) => `${NAMES[f]} from "${plan.columns[f] ?? ""}"`)
      .join(", ")}.`,
  ];
  const anchors = plan.rows.filter((r) => r.fragment !== undefined).length;
  if (anchors > 0)
    lines.push(
      `${anchors} row${anchors === 1 ? " is an anchor" : "s are anchors"} (#section) on a page.`,
    );
  for (const w of plan.warnings) lines.push(`! ${w}`);
  return `${lines.join("\n")}\n`;
}
