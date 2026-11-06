import { BUDGET_KINDS, kindNoun, type BudgetSummary } from "../limits.js";
import {
  AREAS,
  SEVERITIES,
  SEVERITY_LABEL,
  type CheckRegistry,
  type Finding,
  type Severity,
} from "../model.js";
import type { RunResult } from "../run.js";
import type { CouldNotCheck } from "../runner.js";

/** Text and attribute values, escaped for both (OWASP rule #1 and #2: & < > " '). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ReportInput {
  result: RunResult;
  url: string;
  startedAt: Date;
  /** For each finding's why, fix and technical line, and the titles of what passed. */
  registry: CheckRegistry;
  /** The run's budget summary: how much of each kind was found and read. */
  sampled?: BudgetSummary;
  version: string;
  /**
   * For an email body: inline styles on each element and no style element, because many mail
   * clients strip style elements. The content is the same.
   */
  mail?: boolean;
  /** A line shown above the findings (the email's "showing the 50 most urgent" note). */
  note?: string;
}

const COLOR: Readonly<Record<Severity, string>> = {
  high: "#b42318",
  medium: "#b54708",
  low: "#475467",
};

/** Inline styles only: the file must read the same opened from an email, with no network. */
const STYLE = `
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#101828;max-width:52rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}h2 span{color:#667085;font-weight:400}
.meta{color:#667085;margin:0 0 1.5rem}.counts{display:flex;gap:1rem;flex-wrap:wrap;padding:0;list-style:none}
.counts li{border:1px solid #eaecf0;border-radius:.5rem;padding:.5rem .75rem}
.f{border-left:4px solid;padding:.25rem 0 .25rem .75rem;margin:1rem 0}.f h3{font-size:1rem;margin:0}
.f p{margin:.25rem 0}.tech,.id{color:#475467;font-size:.875rem}.tech code{white-space:pre-wrap;word-break:break-word}
ul.ok li{margin:.15rem 0}code{font-family:ui-monospace,Menlo,Consolas,monospace}
`.trim();

/** The same look as STYLE, written onto each element, for mail clients that drop style elements. */
const INLINE: Readonly<Record<string, string>> = Object.freeze({
  body: "font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#101828;max-width:52rem;margin:0 auto;padding:0 1rem",
  h1: "font-size:1.5rem;margin:0 0 .25rem",
  h2: "font-size:1.15rem;margin:2rem 0 .5rem",
  h3: "font-size:1rem;margin:0",
  meta: "color:#667085;margin:0 0 1.5rem",
  counts: "padding:0;list-style:none",
  count:
    "display:inline-block;border:1px solid #eaecf0;border-radius:.5rem;padding:.5rem .75rem;margin:0 .5rem .5rem 0",
  f: "border-left:4px solid;padding:.25rem 0 .25rem .75rem;margin:1rem 0",
  p: "margin:.25rem 0",
  tech: "margin:.25rem 0;color:#475467;font-size:.875rem",
  code: "font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word",
  muted: "color:#667085;font-weight:400",
});

/** class="x" for the file, style="..." for mail. `extra` is inline in both. */
function look(mail: boolean, name: string, cls?: string, extra = ""): string {
  if (mail) return ` style="${INLINE[name] ?? ""}${extra ? `;${extra}` : ""}"`;
  return `${cls ? ` class="${cls}"` : ""}${extra ? ` style="${extra}"` : ""}`;
}

function findingHtml(f: Finding, registry: CheckRegistry, mail = false): string {
  const check = registry.get(f.checkId);
  const e = escapeHtml;
  const p = look(mail, "p");
  return [
    `<article${look(mail, "f", "f", `border-color:${COLOR[f.severity]}`)}>`,
    `<h3 dir="auto"${look(mail, "h3")}>${e(f.title)}</h3>`,
    check ? `<p${p}><strong>Why it matters:</strong> ${e(check.why)}</p>` : "",
    check ? `<p${p}><strong>How to fix:</strong> ${e(check.fix)}</p>` : "",
    `<p${look(mail, "tech", "tech")} dir="auto"><code${look(mail, "code")}>${e(f.evidence)}</code></p>`,
    check ? `<p${look(mail, "tech", "tech")}>${e(check.tech)}</p>` : "",
    `<p${look(mail, "tech", "id")}>${e(f.checkId)} · ${e(f.url)}</p>`,
    "</article>",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The report as one self-contained HTML file: inline CSS, no scripts, no external requests, every
 * interpolated value escaped. Summary counts, findings by level, what looked right, what could not
 * be checked, and how much was sampled.
 */
export function renderReport({
  result,
  url,
  startedAt,
  registry,
  sampled,
  version,
  mail = false,
  note,
}: ReportInput): string {
  const e = escapeHtml;
  const by = (s: Severity) => result.findings.filter((f) => f.severity === s);
  const parts: string[] = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Gaugeline report: ${e(url)}</title>`,
    ...(mail ? [] : [`<style>${STYLE}</style>`]),
    "</head>",
    mail ? `<body><div${look(true, "body")}>` : "<body>",
    `<h1${look(mail, "h1")}>Gaugeline report</h1>`,
    `<p${look(mail, "meta", "meta")}>${e(url)} · ${e(startedAt.toISOString())} · Gaugeline ${e(version)}</p>`,
    `<ul${look(mail, "counts", "counts")}>`,
    ...SEVERITIES.map(
      (s) =>
        `<li${look(mail, "count", undefined, `color:${COLOR[s]}`)}>${e(SEVERITY_LABEL[s])}: <strong>${by(s).length}</strong></li>`,
    ),
    "</ul>",
  ];
  if (note) parts.push(`<p${look(mail, "meta", "meta")}>${e(note)}</p>`);
  if (result.findings.length === 0)
    parts.push(
      `<p${look(mail, "p")}><strong>Nothing to fix.</strong> Every check that ran passed.</p>`,
    );
  for (const s of SEVERITIES) {
    const list = by(s);
    if (list.length === 0) continue;
    parts.push(
      `<h2${look(mail, "h2")}>${e(SEVERITY_LABEL[s])} <span${look(mail, "muted")}>${list.length}</span></h2>`,
    );
    for (const f of list) parts.push(findingHtml(f, registry, mail));
  }
  parts.push(renderLookedRight(result.passed, registry));
  const notChecked: CouldNotCheck[] = [
    ...result.couldNotCheck,
    ...result.failed.map((f) => ({ id: f.id, reason: "the check failed to run", url })),
  ];
  if (sampled) parts.push(renderSampled(sampled, notChecked));
  parts.push(mail ? "</div></body>" : "</body>", "</html>", "");
  return parts.join("\n");
}

/**
 * "What looked right": the checks that passed, grouped by area in the findings' area order, by
 * their plain-English titles. No evidence and no check ids in the visible text. Empty when nothing
 * passed, so no empty heading is written.
 */
export function renderLookedRight(passed: readonly string[], registry: CheckRegistry): string {
  const e = escapeHtml;
  const byArea = new Map<string, string[]>();
  for (const id of passed) {
    const check = registry.get(id);
    if (!check) continue;
    const list = byArea.get(check.area) ?? [];
    list.push(check.title);
    byArea.set(check.area, list);
  }
  if (byArea.size === 0) return "";
  const out = [`<h2>What looked right <span>${passed.length}</span></h2>`];
  for (const area of AREAS) {
    const titles = byArea.get(area);
    if (!titles) continue;
    out.push(
      `<h3>${e(area)}</h3>`,
      '<ul class="ok">',
      ...titles.map((t) => `<li>${e(t)}</li>`),
      "</ul>",
    );
  }
  return out.join("\n");
}

/**
 * "How much was sampled": one line per kind with something found ("30 of 112 links checked", "all
 * 14 links checked"), then what could not be checked, with the reason, when there is any.
 */
export function renderSampled(
  sampled: BudgetSummary,
  couldNotCheck: readonly CouldNotCheck[],
): string {
  const e = escapeHtml;
  const lines: string[] = [];
  for (const kind of BUDGET_KINDS) {
    const { sampled: taken, found } = sampled[kind];
    if (found === 0) continue;
    if (kind === "frameworkAddresses") {
      lines.push(`${found} ${kindNoun(kind, found)} ignored (never requested)`);
      continue;
    }
    const noun = kindNoun(kind, found);
    lines.push(
      taken >= found
        ? found === 1
          ? `the 1 ${noun} checked`
          : `all ${found} ${noun} checked`
        : `${taken} of ${found} ${noun} checked`,
    );
  }
  const out = ["<h2>How much was sampled</h2>"];
  out.push(
    lines.length === 0
      ? "<p>Nothing was sampled: the page had no links, images or other addresses to read.</p>"
      : `<ul>${lines.map((l) => `<li>${e(l)}</li>`).join("")}</ul>`,
  );
  if (couldNotCheck.length > 0) {
    out.push("<h2>Could not check</h2>", "<ul>");
    for (const c of couldNotCheck)
      out.push(`<li><code>${e(c.id)}</code>: ${e(c.reason)} (${e(c.url)})</li>`);
    out.push("</ul>");
  }
  return out.join("\n");
}
