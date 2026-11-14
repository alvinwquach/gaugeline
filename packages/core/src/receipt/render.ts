import { shortDate } from "../digest.js";
import { escapeMarkdown, markdownTable } from "../report/brief.js";
import { escapeHtml } from "../report/html.js";
import { monthName } from "./month.js";
import type { Receipt, ReceiptItem } from "./build.js";

/**
 * The receipt as text: a Markdown block for the client update, the same receipt as JSON, and one
 * printable page. All three are made from the same lines, so they cannot disagree. The wording is
 * the digest's ("fixed by", "first seen", "N daily checks"): nothing here is a new claim, and nothing
 * here is a number the runs do not hold. Text that came from a page is escaped for the format.
 */

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const dateOf = (iso: string): string => shortDate(new Date(`${iso}T00:00:00Z`), "UTC");

/** "31 daily checks" when there was one on each of 31 days, else "3 checks". */
function checksPhrase(r: Receipt): string {
  const { ran, days } = r.checks;
  return ran > 1 && ran === days ? `${ran} daily checks` : plural(ran, "check");
}

/** "3 fixed before your customers did, 1 fixed after you told us and 2 still open". */
function verdict(r: Receipt): string {
  if (r.checks.ran === 0) return "No checks ran this month, so there is nothing to report.";
  if (r.quiet) return `Nothing broke this month. ${checksPhrase(r)} ran.`;
  const { beforeCustomers, afterYouToldUs, stillOpen } = r.counts;
  const parts = [
    beforeCustomers > 0 ? `${beforeCustomers} fixed before your customers did` : "",
    afterYouToldUs > 0 ? `${afterYouToldUs} fixed after you told us` : "",
    stillOpen > 0 ? `${stillOpen} still open` : "",
  ].filter((p) => p !== "");
  if (parts.length === 0) return "Nothing was fixed this month.";
  const last = parts.pop() ?? "";
  return `This month: ${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}.`;
}

/** A line: the finding's title, the page it is on, and the dates after it (the only fixed text in it). */
interface Line {
  lead: string;
  path?: string;
  tail: string;
}

/** The line as Markdown (title and page escaped) or as HTML (every value escaped). */
const lineText = (l: Line, esc: (s: string) => string): string =>
  l.path === undefined ? esc(l.tail) : ` (on ${esc(l.path)}${l.tail}`;
interface Block {
  heading: string;
  /** Lines under the heading itself, or under a sub-heading each. */
  groups: { name?: string; lines: Line[] }[];
  /** Lines left out of the printable page, said in one line. */
  more?: number;
}

const fixedLine = (i: ReceiptItem): Line => ({
  lead: i.title,
  path: i.path,
  tail: `, seen ${dateOf(i.firstSeen)}${i.resolvedOn ? `, fixed by ${dateOf(i.resolvedOn)}` : ""}).`,
});
const openLine = (i: ReceiptItem): Line => ({
  lead: i.title,
  path: i.path,
  tail: `, first seen ${dateOf(i.firstSeen)}).`,
});

/** The sections, shared by all three renderers. `cap` limits each list for the one-page version. */
function blocks(r: Receipt, cap?: { before: number; other: number }): Block[] {
  const out: Block[] = [];
  const before = r.groups.reduce((n, g) => n + g.items.length, 0);
  if (before > 0) {
    let room = cap?.before ?? Infinity;
    const groups: Block["groups"] = [];
    for (const g of r.groups) {
      const items = g.items.slice(0, Math.max(0, room));
      room -= items.length;
      if (items.length > 0) groups.push({ name: g.name, lines: items.map(fixedLine) });
    }
    out.push({
      heading: "Fixed before your customers did",
      groups,
      ...(before > (cap?.before ?? Infinity) ? { more: before - (cap?.before ?? 0) } : {}),
    });
  }
  const list = (
    heading: string,
    items: readonly ReceiptItem[],
    line: (i: ReceiptItem) => Line,
  ): void => {
    if (items.length === 0) return;
    const shown = items.slice(0, cap?.other ?? Infinity);
    out.push({
      heading,
      groups: [{ lines: shown.map(line) }],
      ...(items.length > shown.length ? { more: items.length - shown.length } : {}),
    });
  };
  list("Fixed after you told us", r.afterYouToldUs, fixedLine);
  list("Still open", r.stillOpen, openLine);
  if (r.comingUp.length > 0) {
    const shown = r.comingUp.slice(0, cap?.other ?? Infinity);
    out.push({
      heading: "Coming up",
      groups: [{ lines: shown.map((c) => ({ lead: "", tail: `${c.label}.` })) }],
      ...(r.comingUp.length > shown.length ? { more: r.comingUp.length - shown.length } : {}),
    });
  }
  return out;
}

const title = (r: Receipt): string =>
  `${r.site}: ${monthName(r.month)}${r.partial ? " so far" : ""}`;

/** What was checked, said once, unless the verdict already said it. */
function checked(r: Receipt): string | undefined {
  if (r.quiet || r.checks.ran === 0) return undefined;
  return `${checksPhrase(r)} ran on ${r.site} in ${monthName(r.month)}.${r.partial ? " The month is not over, so this is the month so far." : ""}`;
}

/** The Markdown block for the client update. */
export function receiptMarkdown(r: Receipt): string {
  const out = [`# ${escapeMarkdown(title(r))}`, "", verdict(r), ""];
  if (r.groups.length > 0)
    out.push(
      ...markdownTable(
        ["Area", "Fixed"],
        r.groups.map((g) => [g.name, String(g.items.length)]),
      ),
      "",
    );
  for (const b of blocks(r)) {
    out.push(`## ${b.heading}`, "");
    for (const g of b.groups) {
      if (g.name) out.push(`### ${g.name}`, "");
      for (const l of g.lines)
        out.push(
          `- ${l.lead ? `**${escapeMarkdown(l.lead)}**` : ""}${lineText(l, escapeMarkdown)}`.replace(
            /^- (?= )/,
            "- ",
          ),
        );
      out.push("");
    }
  }
  const note = checked(r);
  if (note) out.push("## What was checked", "", note, "");
  return out.join("\n");
}

/** The same receipt as JSON, with a trailing newline. */
export function receiptJson(r: Receipt): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

/** How many lines of each kind fit on one printed page. */
const PAGE = { before: 10, other: 4 } as const;

/** One self-contained page to print: inline style, no script, no font, no image, no link. Every value escaped. */
export function receiptPrintable(r: Receipt): string {
  const e = escapeHtml;
  const out = [
    "<!doctype html>",
    '<html lang="en">',
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title(r))}</title>`,
    "<style>",
    "@page { size: A4; margin: 14mm; }",
    "body { font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #101828; max-width: 44rem; margin: 0 auto; padding: 0 1rem; }",
    "h1 { font-size: 1.5rem; margin: 1rem 0 .25rem; }",
    "h2 { font-size: 1.05rem; margin: 1.1rem 0 .35rem; border-bottom: 1px solid #d0d5dd; }",
    "h3 { font-size: .95rem; margin: .7rem 0 .2rem; color: #475467; }",
    "ul { margin: 0; padding-left: 1.2rem; }",
    "li { margin: .15rem 0; }",
    ".verdict { font-size: 1.1rem; font-weight: 600; margin: 0 0 .5rem; }",
    "@media print { body { font-size: 11pt; padding: 0; } h2, h3 { break-after: avoid; } li { break-inside: avoid; } }",
    "</style></head>",
    "<body>",
    `<h1>${e(title(r))}</h1>`,
    `<p class="verdict">${e(verdict(r))}</p>`,
  ];
  for (const b of blocks(r, PAGE)) {
    out.push(`<h2>${e(b.heading)}</h2>`);
    for (const g of b.groups) {
      if (g.name) out.push(`<h3>${e(g.name)}</h3>`);
      out.push("<ul>");
      for (const l of g.lines)
        out.push(`<li>${l.lead ? `<strong>${e(l.lead)}</strong>` : ""}${lineText(l, e)}</li>`);
      out.push("</ul>");
    }
    if (b.more) out.push(`<p>and ${b.more} more, in the full receipt.</p>`);
  }
  const note = checked(r);
  if (note) out.push("<h2>What was checked</h2>", `<p>${e(note)}</p>`);
  out.push("</body>", "</html>", "");
  return out.join("\n");
}
