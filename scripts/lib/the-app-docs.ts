import { blockTitle, toTree, type Node } from "../../packages/app/src/search/tree.js";
import { toLeaksModel } from "../../packages/app/src/leaks/model.js";
import { toRows } from "../../packages/app/src/pages/rows.js";
import type { Checked, Result } from "../../packages/app/src/types.js";
import type { PageData } from "../../packages/core/src/run-view.js";
import type { RequestRow } from "../../packages/core/src/request-log.js";

/**
 * The text of the Pages checked and Search data examples in docs/the-app.md, made from the same
 * code the app uses (toRows, toTree, blockTitle) so the page and the app cannot drift apart.
 * The fixture's address is shown as the page's address, the way the other docs do.
 */
const KIND = {
  page: "Page",
  link: "Link",
  image: "Image",
  sitemap: "Sitemap page",
  feed: "Feed",
  script: "JavaScript file",
  "extra-page": "Other page",
  other: "Other",
} as const;

export const SHOWN_ORIGIN = "https://studio.example";

const show = (text: string, origin: string) => text.replaceAll(origin, SHOWN_ORIGIN);

/** One line per row: kind, request, address, answer. The time is left out: it differs on every run. */
export function pagesCheckedText(requests: readonly RequestRow[], origin: string): string {
  const rows = toRows(requests).map((r) => [
    KIND[r.kind],
    r.method,
    show(r.address, origin),
    show(r.answer, origin),
  ]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => [...widths.map((w, i) => (r[i] ?? "").padEnd(w)), r[3]].join("  "))
    .join("\n");
}

function treeLines(nodes: Node[], depth: number, origin: string): string[] {
  return nodes.flatMap((n) => [
    `${"  ".repeat(depth)}${n.key}${n.value === undefined ? "" : `: ${show(n.value, origin)}`}`,
    ...treeLines(n.children ?? [], depth + 1, origin),
  ]);
}

/** The title, canonical, words and every structured data block as the app lists them. */
export function searchDataText(page: PageData, origin: string): string {
  const words = page.firstWords.split(" ");
  const lines = [
    `Title: ${page.title === undefined ? "Not set" : page.title === "" ? "Empty" : page.title}`,
    `Canonical: ${
      page.canonical === undefined
        ? "Not set"
        : page.canonical === ""
          ? "Empty"
          : show(page.canonical, origin)
    }`,
    `Readable words: ${page.words}`,
    `First ${Math.min(words.length, 8)} of them: ${words.slice(0, 8).join(" ")}`,
  ];
  page.blocks.forEach((b, i) => {
    lines.push("");
    if (b.ok) {
      lines.push(`Block ${i + 1}: ${blockTitle(b.value)}`);
      lines.push(...treeLines(toTree(b.value), 1, origin));
    } else {
      lines.push(`Block ${i + 1}: Could not be read`, `  ${b.error}`, `  ${b.raw}`);
    }
  });
  return lines.join("\n");
}

/** The fixture's logical host and scheme, shown as a site on the .example domain. */
const showLeaks = (text: string) =>
  text.replaceAll("http://", "https://").replaceAll("moth-lantern.test", "moth-lantern.example");

/**
 * The four panels of the Leaks & access view as text, made from the model the view uses (toLeaksModel),
 * so the page and the app cannot drift apart. The fixture's host is shown as moth-lantern.example.
 */
export function leaksAccessText(result: Result, checked: Checked): string {
  const m = toLeaksModel(result, checked);
  const lines: string[] = ["Sanity dataset"];
  const open = m.dataset.datasets.filter((d) => d.visibility === "public");
  if (!m.dataset.availability.ran) lines.push(`  Not checked: ${m.dataset.availability.reason}`);
  else if (m.dataset.datasets.length === 0) lines.push("  This page does not use Sanity.");
  for (const d of m.dataset.datasets)
    lines.push(
      `  Project ${d.projectId}, dataset ${d.dataset}: ${
        d.visibility === "public"
          ? "Public (it answers questions without a token)"
          : d.visibility === "private"
            ? "Private (it asked for a token)"
            : "Could not be read"
      }`,
    );
  if (open.length > 0) {
    lines.push("", "Types it holds");
    for (const d of open)
      lines.push(
        `  ${d.documentCount} documents in ${d.types.length} types`,
        ...d.types.map((t) => `    ${t}`),
      );
  }
  lines.push("", "JavaScript scanned for keys");
  if (!m.scripts.availability.ran) lines.push(`  Not checked: ${m.scripts.availability.reason}`);
  else {
    const width = Math.max(0, ...m.scripts.rows.map((r) => r.address.length));
    for (const r of m.scripts.rows)
      lines.push(
        `  ${r.address.padEnd(width)}  ${
          r.keys.length > 0
            ? r.keys.map((k) => `${k.kind} ${k.masked}`).join("; ")
            : r.state === "scanned"
              ? "Nothing found"
              : `Not scanned. ${r.note ?? ""}`.trim()
        }`,
      );
    lines.push(`  ${m.scripts.scanned} of up to ${m.scripts.limit} JavaScript files scanned`);
  }
  lines.push("", "Staging copies");
  if (!m.staging.availability.ran) lines.push(`  Not checked: ${m.staging.availability.reason}`);
  else if (m.staging.rows.length === 0)
    lines.push("  No preview links were found, and no staging address answers publicly.");
  for (const r of m.staging.rows) lines.push(`  ${r.address}  ${r.answer}`);
  return showLeaks(lines.join("\n"));
}
