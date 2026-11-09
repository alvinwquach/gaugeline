import { blockTitle, toTree, type Node } from "../../packages/app/src/search/tree.js";
import { toRows } from "../../packages/app/src/pages/rows.js";
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
