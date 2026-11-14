import { SEVERITY_LABEL } from "../model.js";
import { writeDate } from "../renewals/dates.js";
import { STYLE, escapeHtml } from "../report/html.js";
import { formatCurrency } from "../report/brief.js";
import { joinNames, type AuditPack, type PackFinding, type PackRange } from "./pack.js";

/** The two files `gaugeline audit --pack` writes, in order. */
export const AUDIT_PACK_FILES = ["audit-pack.html", "audit-pack.md"] as const;

export interface AuditPackFile {
  name: string;
  text: string;
}

/**
 * The pack is written once, as blocks of plain text, and the two renderers below turn the blocks into
 * Markdown and HTML. Every string in a block is plain text: the renderers escape it, so a business
 * name, a package's name or a line of evidence cannot start a heading, a list, a link or markup.
 */
type Span = string | { b: string } | { code: string };
interface Item {
  spans: Span[];
  sub?: Span[][];
}
type Block =
  | { t: "h1" | "h2" | "h3"; text: string }
  | { t: "p"; spans: Span[]; quiet?: boolean }
  | { t: "ul" | "ol"; items: Item[] }
  | { t: "img"; url: string; alt: string };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "a", "a and b", "a, b and c". */
function andList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

/** A sentence that ends in a full stop (the check's sentences already do). */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?\u2026]$/u.test(t) ? t : `${t}.`;
}

function money(r: PackRange, currency: string): string {
  return r.low === r.high
    ? formatCurrency(r.low, currency)
    : `${formatCurrency(r.low, currency)}\u2013${formatCurrency(r.high, currency)}`;
}

function hoursOf(r: PackRange): string {
  return r.low === r.high ? plural(r.low, "hour") : `${r.low}\u2013${r.high} hours`;
}

const LEVEL_WORD = { high: "to fix first", medium: "to fix soon", low: "worth knowing" } as const;

/**
 * One finding as a list item. "title" is its name and level; "full" adds what is wrong and what done
 * looks like. A finding from a check this version does not have has neither, so it is only its name.
 */
function finding(f: PackFinding, mode: "title" | "full"): Item {
  const label = SEVERITY_LABEL[f.severity];
  if (f.wrong === "") return { spans: [{ b: f.title }] };
  if (mode === "title") return { spans: [{ b: f.title }, ` (${label})`] };
  return {
    spans: [
      { b: f.title },
      ` (${label}). ${sentence(f.wrong)}`,
      ...(f.done === "" ? [] : [` Done looks like: ${f.done.trim()}`]),
    ],
  };
}

function places(f: PackFinding): Span[][] {
  const lines: Span[][] = f.evidence.map((e) => [e]);
  if (f.moreEvidence > 0) lines.push([`and ${plural(f.moreEvidence, "more place")} like it`]);
  return lines;
}

/** The line that adds the packages up, and says what the total leaves out. */
function totalsBlock(pack: AuditPack): Block | undefined {
  const t = pack.totals;
  if (!t) return undefined;
  const have = [
    ...(t.price ? [money(t.price, pack.currency)] : []),
    ...(t.hours ? [hoursOf(t.hours)] : []),
  ];
  const notes = [
    ...(t.withoutPrice.length > 0
      ? [
          `${joinNames(t.withoutPrice)} ${t.withoutPrice.length === 1 ? "has" : "have"} no price, so ${t.withoutPrice.length === 1 ? "it is" : "they are"} left out of the price.`,
        ]
      : []),
    ...(t.withoutHours.length > 0
      ? [
          `${joinNames(t.withoutHours)} ${t.withoutHours.length === 1 ? "has" : "have"} no hours, so ${t.withoutHours.length === 1 ? "it is" : "they are"} left out of the hours.`,
        ]
      : []),
    ...(pack.groups.some((g) => g.kind === "other")
      ? ["The other findings are not included."]
      : []),
  ];
  return {
    t: "p",
    spans: [
      { b: "Total for the packages above:" },
      ` ${have.join(", ")}.${notes.map((n) => ` ${n}`).join("")}`,
    ],
  };
}

/** The whole pack as blocks. */
export function packBlocks(pack: AuditPack): Block[] {
  const date = writeDate(pack.checkedAt);
  const name = pack.business ?? pack.host;
  const by = pack.brand?.name;
  const blocks: Block[] = [{ t: "h1", text: `Site audit: ${name}` }];

  if (pack.brand?.logoUrl !== undefined)
    blocks.push({ t: "img", url: pack.brand.logoUrl, alt: by ?? "Logo" });
  if (by !== undefined || pack.brand?.contact !== undefined)
    blocks.push({
      t: "p",
      quiet: true,
      spans: [
        ...(by !== undefined ? ["Prepared by ", { b: by }] : []),
        ...(by !== undefined && pack.brand?.contact !== undefined ? [". "] : []),
        ...(pack.brand?.contact !== undefined ? [pack.brand.contact] : []),
      ],
    });
  blocks.push({ t: "p", quiet: true, spans: [`Checked ${pack.url} on ${date}.`] });

  blocks.push({ t: "h2", text: "Summary" });
  if (pack.healthy) {
    blocks.push(
      { t: "p", spans: [`Gaugeline checked ${pack.host} on ${date} and found nothing to fix.`] },
      {
        t: "p",
        spans: [
          `The pages it looked at are in good shape, so there is no work to propose today. Running Gaugeline again after each release (npx gaugeline ${pack.host}) keeps it that way.`,
        ],
      },
    );
  } else {
    const parts = (["high", "medium", "low"] as const)
      .filter((l) => pack.levels[l] > 0)
      .map((l) => `${pack.levels[l]} ${LEVEL_WORD[l]}`);
    blocks.push({
      t: "p",
      spans: [
        `Gaugeline checked ${pack.host} on ${date} and found ${plural(pack.total, "thing")} worth fixing${parts.length > 0 ? `: ${andList(parts)}` : ""}.`,
      ],
    });
    const risks = [...new Set(pack.top.map((f) => f.why.trim()).filter((w) => w !== ""))];
    if (risks.length > 0)
      blocks.push(
        { t: "h3", text: "What is at risk" },
        { t: "ul", items: risks.map((r) => ({ spans: [r] })) },
      );
    if (pack.top.length > 0)
      blocks.push(
        {
          t: "h3",
          text:
            pack.top.length === 1
              ? "Where to start"
              : `The ${pack.top.length === 5 ? "five" : pack.top.length} to start with`,
        },
        {
          t: "ol",
          items: pack.top.map((f) => ({ ...finding(f, "title"), sub: places(f) })),
        },
      );
  }

  const packages = pack.groups.filter((g) => g.kind === "package");
  if (packages.length > 0) blocks.push({ t: "h2", text: "What we would fix, and what it costs" });
  else if (pack.groups.some((g) => g.kind === "area"))
    blocks.push({ t: "h2", text: "What we found, by area" });
  let totalDone = false;
  for (const g of pack.groups) {
    if (g.kind === "other") {
      // The total belongs with the packages, before the findings no package covers.
      const total = totalsBlock(pack);
      if (total) blocks.push(total);
      totalDone = true;
      blocks.push({ t: "h2", text: "Other findings" });
      blocks.push({
        t: "p",
        spans: [
          packages.length > 0
            ? "No package above covers these, so they have no price here. We can quote them separately."
            : "These come from checks this version of Gaugeline does not have, so they have no description here.",
        ],
      });
    } else blocks.push({ t: "h3", text: g.name });
    if (g.price !== undefined || g.hours !== undefined)
      blocks.push({
        t: "p",
        spans: [
          ...(g.price ? [{ b: "Price:" }, ` ${money(g.price, pack.currency)}`] : []),
          ...(g.price && g.hours ? [". "] : []),
          ...(g.hours ? [{ b: "Time:" }, ` ${hoursOf(g.hours)}`] : []),
          ".",
        ],
      });
    blocks.push({
      t: "ul",
      items: g.items.map((f) => ({
        ...finding(f, "full"),
        ...(g.kind === "other" ? { sub: places(f) } : {}),
      })),
    });
    if (g.notIncluded.length > 0)
      blocks.push(
        { t: "p", spans: [{ b: "Not included:" }] },
        { t: "ul", items: g.notIncluded.map((n) => ({ spans: [n] })) },
      );
    if (g.recheck !== "")
      blocks.push({ t: "p", spans: [{ b: "How we would check it worked:" }, ` ${g.recheck}`] });
  }

  if (!totalDone) {
    const total = totalsBlock(pack);
    if (total) blocks.push(total);
  }

  blocks.push({ t: "h2", text: "What this audit does not include" });
  const left: string[] = [
    "Gaugeline looked at the site's public pages the way a visitor or a search engine does. It did not log in, fill in a form or change anything.",
    pack.probing
      ? "Because the site's owner agreed to it, it also asked the routes that should be private for what they protect, without logging in."
      : "It did not ask for private or admin paths.",
    ...(pack.dns ? [] : ["The email records (SPF and DMARC) were not read."]),
    ...(pack.couldNotCheck > 0
      ? [
          `${plural(pack.couldNotCheck, "check")} could not read part of the site, so this list may be missing something.`,
        ]
      : []),
  ];
  blocks.push({ t: "ul", items: left.map((l) => ({ spans: [l] })) });
  return blocks;
}

/**
 * What a Markdown line needs escaped so that text from outside cannot start a heading, a list, a link,
 * an image or markup of its own: the characters Markdown reads, but not brackets that make a link only
 * when they follow a square bracket, which is escaped already. Invisible characters arrive as `\u{HEX}`
 * escapes, which are kept as they are.
 */
const MD_CHARS = /\\u\{[0-9A-F]+\}|[\\`*_[\]<>#~|&]/gu;

/** Text made safe for one Markdown line: runs of white space become one space, and the outer spaces are kept. */
function mdText(text: string): string {
  const lead = /^\s/u.test(text) ? " " : "";
  const trail = /\s$/u.test(text) ? " " : "";
  const inner = text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(MD_CHARS, (m) => (m.startsWith("\\u{") ? m : `\\${m}`));
  return inner === "" ? (lead || trail ? " " : "") : `${lead}${inner}${trail}`;
}

/** As `mdText`, for text that starts a list item: a leading marker or number would start a list of its own. */
const mdStart = (text: string): string =>
  mdText(text)
    .replace(/^([-+=])/u, "\\$1")
    .replace(/^(\d+)([.)])/u, "$1\\$2");

function mdSpans(spans: readonly Span[], starts: boolean): string {
  return spans
    .map((s, i) => {
      if (typeof s === "string") return starts && i === 0 ? mdStart(s) : mdText(s);
      if ("b" in s) return `**${mdText(s.b).trim()}**`;
      return `\`${mdText(s.code).trim()}\``;
    })
    .join("");
}

/** A URL that is safe inside Markdown's `(...)`: brackets and spaces are percent-encoded. */
const mdUrl = (url: string): string => url.replace(/\(/gu, "%28").replace(/\)/gu, "%29");

/** The pack as Markdown. */
export function renderPackMarkdown(pack: AuditPack): string {
  const out: string[] = [];
  for (const b of packBlocks(pack)) {
    if (out.length > 0) out.push("");
    switch (b.t) {
      case "h1":
        out.push(`# ${mdText(b.text).trim()}`);
        break;
      case "h2":
        out.push(`## ${mdText(b.text).trim()}`);
        break;
      case "h3":
        out.push(`### ${mdText(b.text).trim()}`);
        break;
      case "p":
        out.push(mdSpans(b.spans, false));
        break;
      case "img":
        out.push(`![${mdText(b.alt).trim()}](${mdUrl(b.url)})`);
        break;
      case "ul":
      case "ol":
        b.items.forEach((item, i) => {
          out.push(`${b.t === "ol" ? `${i + 1}.` : "-"} ${mdSpans(item.spans, true)}`);
          for (const sub of item.sub ?? [])
            out.push(`${b.t === "ol" ? "   " : "  "}- ${mdSpans(sub, true)}`);
        });
        break;
    }
  }
  return `${out.join("\n")}\n`;
}

const e = escapeHtml;

function htmlSpans(spans: readonly Span[]): string {
  return spans
    .map((s) =>
      typeof s === "string"
        ? e(s)
        : "b" in s
          ? `<strong>${e(s.b)}</strong>`
          : `<code>${e(s.code)}</code>`,
    )
    .join("");
}

const EXTRA =
  ".brand img{max-height:3rem;max-width:12rem;margin:0 0 .5rem}p.quiet{color:#475467;margin:.25rem 0}li{margin:.4rem 0}ul ul{margin:.2rem 0;color:#475467;font-size:.9rem}";

/**
 * The pack as one self-contained HTML file: inline styles, no script, and a content security policy that
 * allows nothing but the styles in the file and an https logo, so it reads the same wherever it is opened.
 */
export function renderPackHtml(pack: AuditPack): string {
  const body: string[] = [];
  for (const b of packBlocks(pack)) {
    switch (b.t) {
      case "h1":
      case "h2":
      case "h3":
        body.push(`<${b.t} dir="auto">${e(b.text)}</${b.t}>`);
        break;
      case "p":
        body.push(`<p${b.quiet ? ' class="quiet"' : ""} dir="auto">${htmlSpans(b.spans)}</p>`);
        break;
      case "img":
        body.push(`<p class="brand"><img src="${e(b.url)}" alt="${e(b.alt)}"></p>`);
        break;
      case "ul":
      case "ol":
        body.push(
          `<${b.t}>`,
          ...b.items.map((item) => {
            const sub =
              item.sub && item.sub.length > 0
                ? `<ul>${item.sub.map((s) => `<li dir="auto">${htmlSpans(s)}</li>`).join("")}</ul>`
                : "";
            return `<li dir="auto">${htmlSpans(item.spans)}${sub}</li>`;
          }),
          `</${b.t}>`,
        );
        break;
    }
  }
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https:">`,
    `<title>${e(`Site audit: ${pack.business ?? pack.host}`)}</title>`,
    `<style>${STYLE}${EXTRA}</style>`,
    "</head>",
    "<body>",
    ...body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The two files `gaugeline audit --pack` writes, in order: the HTML to send or print, and the Markdown to edit. */
export function auditPackFiles(pack: AuditPack): AuditPackFile[] {
  return [
    { name: AUDIT_PACK_FILES[0], text: renderPackHtml(pack) },
    { name: AUDIT_PACK_FILES[1], text: renderPackMarkdown(pack) },
  ];
}
