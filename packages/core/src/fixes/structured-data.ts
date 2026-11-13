/**
 * Fixer 2 (X70): correct a structured-data (JSON-LD) value that disagrees with the page. The run says
 * which value is wrong and what the page shows; this finds the one place in the project's files where
 * that wrong value is written as the whole value of a JSON-LD property, and replaces it, in the file's own
 * quote style. It is certain only when the wrong value is written in exactly one place in the whole
 * project, once, in a file that is JSON-LD (a `.json` file with a schema.org context, or a page, template
 * or script that carries a JSON-LD block). Anywhere it is also visible copy, or written twice, it makes no
 * proposal: the value may be fed from somewhere else, and a person knows where.
 */
import {
  buildProposal,
  isRefusal,
  type FileChange,
  type Proposal,
  type Refusal,
} from "./proposal.js";
import type { RepoFile } from "./redirect.js";

export interface Disagreement {
  /** The value the structured data has now. */
  found: string;
  /** The value the page shows. */
  expected: string;
  /** The JSON-LD property, when the finding names it ("telephone"); otherwise any property holding `found`. */
  property?: string;
}

const refuse = (refused: string): Refusal => ({ refused });

/** Folders a file is never taken from. */
const SKIPPED = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.vercel|\.netlify)\//;
const SOURCE = /\.(html?|json|jsonld|[cm]?[jt]sx?|astro|vue|svelte|mdx?|php|liquid|njk|hbs)$/i;

/** True when the file carries JSON-LD: a block of that type, or a schema.org context. */
function isJsonLd(file: RepoFile): boolean {
  return (
    /application\/ld\+json/i.test(file.text) ||
    /["']?@context["']?\s*:\s*["'`]https?:\/\/schema\.org/i.test(file.text)
  );
}

/** A replacement written inside quotes of this kind, or undefined when it would need escaping beyond JSON's. */
function quoted(value: string, quote: string): string | undefined {
  if (value.length === 0 || value.length > 200) return undefined;
  const plain = [...value].every((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 0x20 && c !== 0x7f && ch !== "\\";
  });
  if (!plain || value.includes("${") || value.includes("</")) return undefined;
  if (quote === "`") return undefined;
  if (quote === "'") return value.includes("'") ? undefined : value;
  return value.replace(/"/g, '\\"');
}

/**
 * Where `found` is the whole value of a property: after `key:` (quoted key or bare), inside matching
 * quotes. Returns every such place in `text`, with the quote used.
 */
function places(
  text: string,
  found: string,
  property?: string,
): { start: number; end: number; quote: string }[] {
  const out: { start: number; end: number; quote: string }[] = [];
  const key =
    property === undefined ? "[\\w@$-]+" : property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escaped = found.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\\\?"');
  for (const quote of ['"', "'"]) {
    const re = new RegExp(`(["']?)\\b${key}\\1\\s*:\\s*(${quote})(${escaped})\\2`, "g");
    for (const m of text.matchAll(re)) {
      const value = m[3] ?? "";
      const start = (m.index ?? 0) + m[0].length - 1 - value.length;
      out.push({ start, end: start + value.length, quote });
    }
  }
  return out;
}

/**
 * The change that makes the structured data's value the page's, or why the fixer is not certain.
 * `files` are the project's files.
 */
export function fixStructuredData(
  files: readonly RepoFile[],
  d: Disagreement,
): FileChange | Refusal {
  if (d.found === d.expected) return refuse("The structured data and the page already agree.");
  if (d.found.length === 0)
    return refuse("The structured data's value is empty: there is nothing to find.");
  const candidates = files.filter(
    (f) => !SKIPPED.test(f.path) && SOURCE.test(f.path) && f.text.includes(d.found),
  );
  const asValue = candidates
    .filter(isJsonLd)
    .flatMap((f) => places(f.text, d.found, d.property).map((p) => ({ f, ...p })));
  if (asValue.length === 0)
    return refuse(
      `The value "${d.found}" was not found as a JSON-LD property value in the project's files.`,
    );
  const mentions = candidates.reduce((n, f) => n + f.text.split(d.found).length - 1, 0);
  if (asValue.length > 1 || mentions > 1)
    return refuse(
      `The value "${d.found}" is written in more than one place (${[...new Set(candidates.map((c) => c.path))].join(", ")}): a person says which one the page is fed from.`,
    );
  const hit = asValue[0] as (typeof asValue)[number];
  const written = quoted(d.expected, hit.quote);
  if (written === undefined)
    return refuse(
      `The value "${d.expected}" cannot be written exactly inside ${hit.quote}quotes, so it is left to a person.`,
    );
  const text = hit.f.text;
  return {
    path: hit.f.path,
    before: text,
    after: `${text.slice(0, hit.start)}${written}${text.slice(hit.end)}`,
  };
}

/** A facts-match finding's evidence: `phone: declared "X"; /a has "Y" (structured data), /b has "Z" (text)`. */
const DECLARED = /^[^:]+: declared "([^"]*)"/;
const OCCURRENCE = /(\S+) has "([^"]*)" \(([a-z ]+)\)/g;

/**
 * Proposals for the structured-data values a facts-match finding names as different from the declared
 * one. Values in visible text, links or image descriptions are not structured data and get none; neither
 * does evidence this cannot read exactly. One entry per value: a proposal, or the reason there is none.
 */
export function structuredDataProposals(
  files: readonly RepoFile[],
  finding: Proposal["finding"],
  options: { repository?: string | null; property?: string } = {},
): (Proposal | Refusal)[] {
  if (finding.checkId !== "facts-match") return [];
  const declared = DECLARED.exec(finding.evidence)?.[1];
  if (declared === undefined) return [];
  const out: (Proposal | Refusal)[] = [];
  const seen = new Set<string>();
  for (const m of finding.evidence.matchAll(OCCURRENCE)) {
    const [, path, found, source] = m;
    if (source !== "structured data" || found === undefined || seen.has(found)) continue;
    seen.add(found);
    const change = fixStructuredData(files, {
      found,
      expected: declared,
      ...(options.property ? { property: options.property } : {}),
    });
    if (isRefusal(change)) {
      out.push(change);
      continue;
    }
    out.push(
      buildProposal({
        ...change,
        fixer: "structured-data",
        summary: `Correct "${found}" to "${declared}" in the structured data of ${path ?? "the page"}`,
        finding,
        target: { repository: options.repository ?? null, path: change.path },
        recheck: {
          checkId: "facts-match",
          how: `Run gaugeline on the pull request's preview: the structured data of ${path ?? "the page"} must read "${declared}" and facts-match must not report it.`,
        },
      }),
    );
  }
  return out;
}
