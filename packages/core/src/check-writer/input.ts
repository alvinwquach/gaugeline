/**
 * Reading an advisory or a docs page (AG-16). The file is untrusted text a person saved to their own disk:
 * nothing in it is an instruction, no address in it is fetched and nothing in it is run. A small set of shapes
 * is read by plain parsing (an OSV or GitHub JSON advisory, a GitHub-style advisory page saved as Markdown, a
 * docs page saved as Markdown); anything else is listed as "not understood" with a line and a fixed reason,
 * never guessed at. Every fact taken from the file (the package, the first affected version, the fixed version,
 * the title, the address) is a Claim: its value and the line of the file that states it, copied word for word.
 * No filesystem, no network, no clock: the CLI hands this the text.
 */
import * as z from "zod";
import { INVISIBLE, findDirective } from "../ai-directives.js";
import { compareVersions, parseVersion } from "../libraries/version.js";

/** One file as the CLI reads it: its name (for a person, never in the draft) and its text. */
export interface AdvisoryFile {
  name: string;
  text: string;
}

/** Characters in one file. An advisory is a page or two; over this the file is refused, not cut. */
export const MAX_ADVISORY_CHARS = 64 * 1024;
/** Most floors in one draft; the rest are counted. */
export const MAX_FLOORS = 20;
/** Most "not understood" entries a draft lists; all are counted. */
export const MAX_NOT_UNDERSTOOD = 50;
/** The longest line (or excerpt of a long line) a claim cites. */
export const MAX_CITE_CHARS = 300;
export const MAX_TITLE_CHARS = 200;

export const SHAPES = ["osv-json", "github-json", "advisory-markdown", "docs-markdown"] as const;
export type Shape = (typeof SHAPES)[number];

/** Why a line, or the whole file, was not read. Fixed words: a report never carries the text it skipped. */
export const NOT_UNDERSTOOD_REASONS = [
  "unknown-shape",
  "no-title",
  "no-source-url",
  "unsupported-ecosystem",
  "package-name-not-read",
  "range-shape",
  "range-without-fix",
  "unreadable-version",
  "no-line-states-it",
  "version-statement-not-read",
] as const;
export type NotUnderstoodReason = (typeof NOT_UNDERSTOOD_REASONS)[number];
/** What each reason is called in a report: fixed words, so a report never carries the text it skipped. */
export const NOT_UNDERSTOOD_WORDS: Readonly<Record<NotUnderstoodReason, string>> = {
  "unknown-shape": "the file is not in a shape the writer reads",
  "no-title": "no title was found",
  "no-source-url": "no source address was found",
  "unsupported-ecosystem": "a package outside npm, or with no ecosystem given",
  "package-name-not-read": "a package name that is not an npm name",
  "range-shape": "a range the writer does not read",
  "range-without-fix": "a range with no fixed version",
  "unreadable-version": "a version the writer cannot read",
  "no-line-states-it": "a fact with no line of the file that states it",
  "version-statement-not-read": "a statement about versions in a shape the writer does not read",
};
export interface NotUnderstood {
  /** The line of the file, from 1, or null for the whole file. */
  line: number | null;
  reason: NotUnderstoodReason;
}

export type AdvisoryInputKind =
  "not-a-file" | "oversized-file" | "malformed" | "empty" | "hidden-characters";

/** The file cannot be read at all. The message is fixed words and the file's name: never its text. */
export class AdvisoryInputError extends Error {
  readonly kind: AdvisoryInputKind;
  constructor(kind: AdvisoryInputKind, message: string) {
    super(message);
    this.name = "AdvisoryInputError";
    this.kind = kind;
  }
}

/** The line of the file that states a fact (from 1) and its text, word for word. */
export interface Cite {
  line: number;
  text: string;
}
/** One fact from the file, with the line that supports it. */
export interface Claim {
  value: string;
  cite: Cite;
}
export interface ParsedFloor {
  package: Claim;
  /** The first affected version, or null when every earlier version is affected. */
  introduced: Claim | null;
  /** The first version that is not affected: the floor. */
  fixed: Claim;
}
export interface ParsedAdvisory {
  shape: Shape | null;
  title: Claim | null;
  url: Claim | null;
  id: Claim | null;
  floors: ParsedFloor[];
  omittedFloors: number;
  notUnderstood: NotUnderstood[];
  notUnderstoodCount: number;
  /** Lines (anywhere in the file) that give an order to an assistant. They are never used or copied. */
  instructionLines: number;
  /** The text as read: line endings made "\n". Cited lines are found in it word for word. */
  text: string;
}

const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const HIDDEN = new RegExp(INVISIBLE.source, "u");
const clip = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, 80) || "the file";

/** The text of a file as the reader sees it: no byte order mark, line endings made "\n". */
export const normaliseAdvisoryText = (text: string): string =>
  text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

function validate(file: unknown): AdvisoryFile {
  const o = file as { name?: unknown; text?: unknown } | null;
  if (!o || typeof o.name !== "string" || typeof o.text !== "string")
    throw new AdvisoryInputError("not-a-file", "The advisory must be a file name and its text.");
  const shown = clip(o.name);
  if (o.text.length > MAX_ADVISORY_CHARS)
    throw new AdvisoryInputError(
      "oversized-file",
      `${shown} is longer than ${MAX_ADVISORY_CHARS} characters: save only the advisory or the page, and run again.`,
    );
  // eslint-disable-next-line no-control-regex -- binary data is the thing being refused
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(o.text) || UNPAIRED.test(o.text))
    throw new AdvisoryInputError(
      "malformed",
      `${shown} is not plain text: it holds control or broken characters.`,
    );
  if (HIDDEN.test(o.text.replace(/^\uFEFF/, "")))
    throw new AdvisoryInputError(
      "hidden-characters",
      `${shown} holds hidden characters (zero-width, direction or tag characters): remove them and run again.`,
    );
  if (o.text.trim() === "")
    throw new AdvisoryInputError("empty", `${shown} is empty: there is nothing to read.`);
  return { name: o.name, text: o.text };
}

/** An npm package name: lower case, with an optional scope. */
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const isNpmName = (s: string): boolean => s.length <= 214 && NPM_NAME.test(s);
const GHSA = "GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}";
const ID_RE = new RegExp(`\\b(${GHSA}|CVE-\\d{4}-\\d{4,7})\\b`, "i");
const URL_RE = /https?:\/\/[^\s<>)\]"'`]+/i;
const isVersion = (v: string): boolean => parseVersion(v) !== undefined;
/** "0", "0.0" and "0.0.0" mean every version before the fixed one. */
const isZero = (v: string): boolean => /^0(?:\.0){0,2}$/.test(v);

/** Collects what was not understood, bounded. */
class Pending {
  list: NotUnderstood[] = [];
  count = 0;
  add(line: number | null, reason: NotUnderstoodReason): void {
    this.count += 1;
    if (this.list.length < MAX_NOT_UNDERSTOOD) this.list.push({ line, reason });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Citing: finding the line of the file that states a fact.
// ---------------------------------------------------------------------------------------------------------

/** The offsets at which each line starts (the text has "\n" line endings). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/**
 * The cite for text at [index, index + length): its line, and the line trimmed (up to MAX_CITE_CHARS) or, on a
 * longer line (minified JSON is one line), an excerpt of it that holds the whole match. undefined when the
 * match is too long to quote.
 */
function citeAt(
  text: string,
  starts: readonly number[],
  index: number,
  length: number,
): Cite | undefined {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  const start = starts[lo] ?? 0;
  const end = lo + 1 < starts.length ? (starts[lo + 1] ?? text.length) - 1 : text.length;
  const whole = text.slice(start, end);
  if (whole.trim().length <= MAX_CITE_CHARS) return { line: lo + 1, text: whole.trim() };
  // An excerpt of a long line starts and ends between tokens (after a comma, a brace or a space), so a cut
  // address or word is never quoted.
  let from = Math.max(start, index - 30);
  if (from > start) {
    const k = text.slice(from, index).search(/[,{\s]/);
    from = k < 0 ? index : from + k + 1;
  }
  let to = Math.min(end, index + length + 40);
  if (to - from > MAX_CITE_CHARS) return undefined;
  if (to < end) {
    const tail = text.slice(index + length, to);
    const k = Math.max(tail.lastIndexOf(","), tail.lastIndexOf("}"), tail.lastIndexOf(" "));
    to = k < 0 ? index + length : index + length + k;
  }
  return { line: lo + 1, text: text.slice(from, to).trim() };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------------------------------------
// Ranges.
// ---------------------------------------------------------------------------------------------------------

type Range =
  | { ok: true; introduced?: string; fixed?: string }
  | { ok: false; reason: "range-shape" | "unreadable-version" };

/**
 * ">= 2.0.0, < 2.4.3", "< 3.2.0", ">=1.0.0 <1.9.9". A lower bound with ">=" (or zero), an upper bound with "<".
 * An upper bound with "<=" or a bound with ">" or "=" names no fixed version and is not read.
 */
export function parseRange(text: string): Range {
  const bounds = [...text.matchAll(/(>=|<=|>|<|=)\s*v?([0-9][0-9A-Za-z.+-]*)/g)];
  const rest = text.replace(/(>=|<=|>|<|=)\s*v?([0-9][0-9A-Za-z.+-]*)/g, "").replace(/[\s,]/g, "");
  if (bounds.length === 0 || bounds.length > 2 || rest !== "")
    return { ok: false, reason: "range-shape" };
  let introduced: string | undefined;
  let fixed: string | undefined;
  for (const m of bounds) {
    const op = m[1];
    const v = m[2] ?? "";
    if (op === ">=" && introduced === undefined) {
      if (!isZero(v)) introduced = v;
      else introduced = "";
    } else if (op === "<" && fixed === undefined) fixed = v;
    else return { ok: false, reason: "range-shape" };
  }
  for (const v of [introduced, fixed])
    if (v !== undefined && v !== "" && !isVersion(v))
      return { ok: false, reason: "unreadable-version" };
  return {
    ok: true,
    ...(introduced ? { introduced } : {}),
    ...(fixed !== undefined ? { fixed } : {}),
  };
}

/** True when the first affected version is before the fixed one (a range that names both must be a range). */
const ordered = (introduced: string | undefined, fixed: string): boolean =>
  introduced === undefined || (compareVersions(introduced, fixed) ?? 0) < 0;

// ---------------------------------------------------------------------------------------------------------
// JSON advisories.
// ---------------------------------------------------------------------------------------------------------

const ecosystem = z.string().max(40);
const osvSchema = z.object({
  id: z.string().min(1).max(64),
  summary: z.string().max(500).optional(),
  affected: z
    .array(
      z.object({
        package: z.object({ ecosystem, name: z.string().max(214) }).optional(),
        ranges: z
          .array(
            z.object({
              type: z.string().max(20),
              events: z.array(z.record(z.string(), z.unknown())).max(100),
            }),
          )
          .max(20)
          .optional(),
      }),
    )
    .max(50),
  references: z
    .array(z.object({ type: z.string().max(40).optional(), url: z.string().max(500).optional() }))
    .max(100)
    .optional(),
});
const githubSchema = z.object({
  ghsa_id: z.string().min(1).max(64),
  summary: z.string().max(500).optional(),
  html_url: z.string().max(500).optional(),
  vulnerabilities: z
    .array(
      z.object({
        package: z.object({ ecosystem, name: z.string().max(214) }).nullish(),
        vulnerable_version_range: z.string().max(100).nullish(),
        first_patched_version: z
          .union([z.string().max(60), z.object({ identifier: z.string().max(60) }), z.null()])
          .optional(),
      }),
    )
    .max(50),
});

/**
 * Finds `"key": "literal"` in the raw text (the literal quoted as the file quotes it) and cites it. The claim's
 * value is the literal, or, when a range's text is cited for one version in it, that version.
 */
function jsonCiter(text: string) {
  const starts = lineStarts(text);
  return (key: string, literal: string, value: string = literal): Claim | undefined => {
    const re = new RegExp(`"${escapeRe(key)}"\\s*:\\s*${escapeRe(JSON.stringify(literal))}`);
    const m = re.exec(text);
    if (!m) return undefined;
    const cite = citeAt(text, starts, m.index, m[0].length);
    return cite ? { value, cite } : undefined;
  };
}

const httpUrl = (u: string | undefined): u is string => u !== undefined && /^https?:\/\//i.test(u);

function readJson(text: string, out: ParsedAdvisory, pending: Pending): void {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AdvisoryInputError(
      "malformed",
      "The file looks like JSON but cannot be parsed as JSON.",
    );
  }
  const cite = jsonCiter(text);
  const github = githubSchema.safeParse(data);
  const osv = github.success ? undefined : osvSchema.safeParse(data);
  // Neither shape: readAdvisory lists the file as in no shape the writer reads.
  if (!github.success && !osv?.success) return;
  const isGithub = github.success;
  const summary = github.success ? github.data.summary : osv?.data?.summary;
  out.shape = isGithub ? "github-json" : "osv-json";
  if (summary !== undefined && summary.length > 0 && summary.length <= MAX_TITLE_CHARS) {
    out.title = cite("summary", summary) ?? null;
    if (!out.title) pending.add(null, "no-line-states-it");
  } else pending.add(null, "no-title");
  const idValue = github.success ? github.data.ghsa_id : osv?.data?.id;
  if (idValue !== undefined) out.id = cite(github.success ? "ghsa_id" : "id", idValue) ?? null;
  let url: string | undefined;
  if (github.success) url = github.data.html_url;
  else {
    const refs = osv?.data?.references ?? [];
    url = (refs.find((r) => r.type === "ADVISORY" && r.url) ?? refs.find((r) => r.url))?.url;
  }
  out.url = httpUrl(url) ? (cite(isGithub ? "html_url" : "url", url) ?? null) : null;
  if (!out.url) pending.add(null, "no-source-url");

  /** One floor, from what the file says of it. The callers say how to cite the two versions. */
  const add = (f: {
    name: string;
    eco: string | undefined;
    introduced: string | undefined;
    fixed: string | undefined;
    introducedCite: () => Claim | undefined;
    fixedCite: () => Claim | undefined;
  }): void => {
    if (f.eco?.toLowerCase() !== "npm") return void pending.add(null, "unsupported-ecosystem");
    if (!isNpmName(f.name)) return void pending.add(null, "package-name-not-read");
    if (f.fixed === undefined) return void pending.add(null, "range-without-fix");
    if (!isVersion(f.fixed) || (f.introduced !== undefined && !isVersion(f.introduced)))
      return void pending.add(null, "unreadable-version");
    if (!ordered(f.introduced, f.fixed)) return void pending.add(null, "range-shape");
    const package_ = cite("name", f.name);
    const fixed = f.fixedCite();
    const introduced = f.introduced === undefined ? null : (f.introducedCite() ?? undefined);
    if (!package_ || !fixed || introduced === undefined)
      return void pending.add(null, "no-line-states-it");
    out.floors.push({ package: package_, introduced, fixed });
  };

  if (github.success) {
    for (const v of github.data.vulnerabilities) {
      const rangeText = v.vulnerable_version_range ?? undefined;
      const range = rangeText === undefined ? undefined : parseRange(rangeText);
      if (range && !range.ok) {
        pending.add(null, range.reason);
        continue;
      }
      const raw = v.first_patched_version;
      const patched = typeof raw === "string" ? raw : (raw?.identifier ?? undefined);
      const bound = range?.fixed;
      if (patched !== undefined && bound !== undefined && patched !== bound) {
        pending.add(null, "range-shape");
        continue;
      }
      const fixed = patched ?? bound;
      const introduced = range?.introduced;
      add({
        name: v.package?.name ?? "",
        eco: v.package?.ecosystem,
        introduced,
        fixed,
        introducedCite: () =>
          rangeText === undefined || introduced === undefined
            ? undefined
            : cite("vulnerable_version_range", rangeText, introduced),
        fixedCite: () =>
          patched !== undefined
            ? cite(typeof raw === "string" ? "first_patched_version" : "identifier", patched)
            : rangeText === undefined || fixed === undefined
              ? undefined
              : cite("vulnerable_version_range", rangeText, fixed),
      });
    }
    return;
  }
  for (const a of osv?.data?.affected ?? []) {
    for (const r of a.ranges ?? []) {
      if (r.type !== "SEMVER" && r.type !== "ECOSYSTEM") {
        pending.add(null, "range-shape");
        continue;
      }
      let introduced: string | undefined;
      let open = false;
      for (const e of r.events) {
        if (typeof e.introduced === "string") {
          introduced = isZero(e.introduced) ? undefined : e.introduced;
          open = true;
        } else if (typeof e.fixed === "string") {
          const from = introduced;
          const to = e.fixed;
          add({
            name: a.package?.name ?? "",
            eco: a.package?.ecosystem,
            introduced: from,
            fixed: to,
            introducedCite: () => (from === undefined ? undefined : cite("introduced", from)),
            fixedCite: () => cite("fixed", to),
          });
          introduced = undefined;
          open = false;
        } else {
          pending.add(null, "range-without-fix");
          open = false;
        }
      }
      if (open) pending.add(null, "range-without-fix");
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Markdown: an advisory page, or a docs page.
// ---------------------------------------------------------------------------------------------------------

const HEADING1 = /^\s{0,3}#\s+(.+?)\s*#*\s*$/;
const KEYED_URL = /^\s*(?:[-*]\s+)?\**(?:source|url|link|advisory|reference)\**\s*:\s*(.*)$/i;
const KEYED =
  /^\s*(?:[-*]\s+)?\**(package|affected versions?|patched versions?|first patched version|fixed in)\**\s*:\s*\**\s*(.+?)\s*$/i;
const FENCE = /^\s*(```|~~~)/;
const unquote = (s: string): string => s.replace(/[`*]/g, "").trim();

/** "name (npm)" from a table cell or a keyed line. */
function packageCell(cell: string): { name: string; eco: string | undefined } | undefined {
  const m = /^([^\s(]+)\s*(?:\(([^)]+)\))?$/.exec(unquote(cell));
  return m ? { name: m[1] ?? "", eco: m[2]?.trim().toLowerCase() } : undefined;
}

function readMarkdown(text: string, out: ParsedAdvisory, pending: Pending): void {
  const lines = text.split("\n");
  const hostile = new Set<number>();
  const fenced = new Set<number>();
  let inFence = false;
  for (const [i, l] of lines.entries()) {
    if (FENCE.test(l)) {
      fenced.add(i + 1);
      inFence = !inFence;
    } else if (inFence) fenced.add(i + 1);
    if (findDirective(l) !== undefined) hostile.add(i + 1);
  }
  out.instructionLines = hostile.size;
  const usable = (n: number): boolean =>
    !hostile.has(n) && !fenced.has(n) && (lines[n - 1] ?? "").trim() !== "";
  const cite = (n: number, value: string): Claim | undefined => {
    const t = (lines[n - 1] ?? "").trim();
    return t.length <= MAX_CITE_CHARS && t.toLowerCase().includes(value.toLowerCase())
      ? { value, cite: { line: n, text: t } }
      : undefined;
  };
  const consumed = new Set<number>();

  for (let n = 1; n <= lines.length && !out.title; n++) {
    const m = usable(n) ? HEADING1.exec(lines[n - 1] ?? "") : null;
    if (m?.[1] !== undefined && m[1].length <= MAX_TITLE_CHARS) out.title = cite(n, m[1]) ?? null;
  }
  if (!out.title) pending.add(null, "no-title");
  for (let n = 1; n <= lines.length && !out.url; n++) {
    const m = usable(n) ? KEYED_URL.exec(lines[n - 1] ?? "") : null;
    const raw = m?.[1] !== undefined ? URL_RE.exec(m[1])?.[0] : undefined;
    if (raw !== undefined) out.url = cite(n, raw.replace(/[.,;:!?]+$/, "")) ?? null;
  }
  if (!out.url) pending.add(null, "no-source-url");
  for (let n = 1; n <= lines.length && !out.id; n++) {
    const m = usable(n) ? ID_RE.exec(lines[n - 1] ?? "") : null;
    if (m?.[1] !== undefined) out.id = cite(n, m[1]) ?? null;
  }

  const floor = (
    n: number,
    pkgCell: string,
    affected: string,
    patched: string | undefined,
    nAffected: number,
    nPatched: number,
  ): void => {
    const pkg = packageCell(pkgCell);
    if (!pkg || !isNpmName(pkg.name)) return void pending.add(n, "package-name-not-read");
    if (pkg.eco !== "npm") return void pending.add(n, "unsupported-ecosystem");
    const range = parseRange(unquote(affected));
    if (!range.ok) return void pending.add(nAffected, range.reason);
    const patchedText = patched === undefined ? undefined : unquote(patched);
    if (patchedText !== undefined && !isVersion(patchedText.replace(/^v/, "")))
      return void pending.add(
        nPatched,
        /^(none|n\/a|-|no fix)/i.test(patchedText) ? "range-without-fix" : "unreadable-version",
      );
    const fixedValue = patchedText?.replace(/^v/, "") ?? range.fixed;
    if (fixedValue === undefined) return void pending.add(nAffected, "range-without-fix");
    if (range.fixed !== undefined && range.fixed !== fixedValue)
      return void pending.add(nAffected, "range-shape");
    if (!ordered(range.introduced, fixedValue)) return void pending.add(nAffected, "range-shape");
    const p = cite(n, pkg.name);
    const f = cite(patchedText === undefined ? nAffected : nPatched, fixedValue);
    const i =
      range.introduced === undefined ? null : (cite(nAffected, range.introduced) ?? undefined);
    if (!p || !f || i === undefined) return void pending.add(n, "no-line-states-it");
    out.floors.push({ package: p, introduced: i, fixed: f });
    for (const k of [n, nAffected, nPatched]) consumed.add(k);
  };

  // A page's table: a header with Package and Affected or Patched, a rule, then one row per package.
  let columns: { pkg: number; affected: number; patched: number } | undefined;
  let advisory = out.id !== null;
  for (let n = 1; n <= lines.length; n++) {
    const raw = lines[n - 1] ?? "";
    if (!usable(n) || !raw.trim().startsWith("|")) {
      columns = undefined;
      continue;
    }
    const cells = raw
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    const lower = cells.map((c) => c.toLowerCase());
    if (
      lower.some((c) => c === "package") &&
      lower.some((c) => /affected|vulnerable|patched|fixed/.test(c))
    ) {
      advisory = true;
      columns = {
        pkg: lower.indexOf("package"),
        affected: lower.findIndex((c) => /affected|vulnerable/.test(c)),
        patched: lower.findIndex((c) => /patched|fixed/.test(c)),
      };
      consumed.add(n);
    } else if (columns && !cells.every((c) => /^:?-+:?$/.test(c))) {
      const patched = columns.patched >= 0 ? cells[columns.patched] : undefined;
      floor(
        n,
        cells[columns.pkg] ?? "",
        columns.affected >= 0 ? (cells[columns.affected] ?? "") : "",
        patched,
        n,
        n,
      );
    }
  }
  // Keyed lines: Package: kiln-forms (npm) / Affected versions: ... / Patched versions: ...
  let block:
    | {
        n: number;
        pkg: string;
        affected?: { n: number; v: string };
        patched?: { n: number; v: string };
      }
    | undefined;
  const flush = (): void => {
    if (block?.affected)
      floor(
        block.n,
        block.pkg,
        block.affected.v,
        block.patched?.v,
        block.affected.n,
        block.patched?.n ?? block.affected.n,
      );
    block = undefined;
  };
  for (let n = 1; n <= lines.length; n++) {
    const m = usable(n) ? KEYED.exec(lines[n - 1] ?? "") : null;
    if (!m) continue;
    advisory = true;
    const key = (m[1] ?? "").toLowerCase();
    const v = m[2] ?? "";
    if (key === "package") {
      flush();
      block = { n, pkg: v };
      consumed.add(n);
    } else if (block && key.startsWith("affected")) {
      block.affected = { n, v };
      consumed.add(n);
    } else if (block) {
      block.patched = { n, v };
      consumed.add(n);
    }
  }
  flush();

  if (advisory) {
    out.shape = "advisory-markdown";
    for (let n = 1; n <= lines.length; n++)
      if (
        usable(n) &&
        !consumed.has(n) &&
        /\b(?:affected|patched|vulnerable) versions?\b|\bfixed in\b|\bpatched in\b/i.test(
          lines[n - 1] ?? "",
        )
      )
        pending.add(n, "version-statement-not-read");
    return;
  }

  // A docs page: a package in backticks with a version "or later", or `name@>=1.2.3`, or `name` >= 1.2.3.
  out.shape = "docs-markdown";
  const NAME = "(@?[a-z0-9][a-z0-9._~-]*(?:/[a-z0-9._~-]+)?)";
  const VER = "v?(\\d+\\.\\d+(?:\\.\\d+)?)";
  const patterns = [
    new RegExp(
      `\`${NAME}\`\\s+(?:version\\s+)?${VER}\\s+(?:or|and)\\s+(?:later|newer|higher|above)\\b`,
      "gi",
    ),
    new RegExp(`\`${NAME}@>=\\s*${VER}\``, "gi"),
    new RegExp(`\`${NAME}\`\\s*(?:>=|\\u2265)\\s*${VER}`, "gi"),
  ];
  const seen = new Set<string>();
  for (let n = 1; n <= lines.length; n++) {
    if (!usable(n)) continue;
    const raw = lines[n - 1] ?? "";
    let found = false;
    for (const re of patterns)
      for (const m of raw.matchAll(re)) {
        const name = m[1] ?? "";
        const v = m[2] ?? "";
        found = true;
        if (!isNpmName(name)) {
          pending.add(n, "package-name-not-read");
          continue;
        }
        if (!isVersion(v) || seen.has(`${name}@${v}`)) continue;
        seen.add(`${name}@${v}`);
        const p = cite(n, name);
        const f = cite(n, v);
        if (p && f) out.floors.push({ package: p, introduced: null, fixed: f });
        else pending.add(n, "no-line-states-it");
      }
    if (
      !found &&
      /\b(?:or later|or newer|minimum version|at least version|upgrade to|patched in|fixed in)\b/i.test(
        raw,
      ) &&
      /\d+\.\d+/.test(raw)
    )
      pending.add(n, "version-statement-not-read");
  }
}

/**
 * Reads the file. Throws AdvisoryInputError for a file that cannot be read at all (too long, not text, hidden
 * characters, JSON that does not parse). Anything readable but not in a shape this reads is returned with what
 * was not understood, and no floor.
 */
export function readAdvisory(file: unknown): ParsedAdvisory {
  const input = validate(file);
  const text = normaliseAdvisoryText(input.text);
  const out: ParsedAdvisory = {
    shape: null,
    title: null,
    url: null,
    id: null,
    floors: [],
    omittedFloors: 0,
    notUnderstood: [],
    notUnderstoodCount: 0,
    instructionLines: 0,
    text,
  };
  const pending = new Pending();
  if (/^\s*[{[]/.test(text)) readJson(text, out, pending);
  else readMarkdown(text, out, pending);
  // Nothing read and nothing listed: the file is not in a shape the writer reads.
  if (out.floors.length === 0 && pending.count === 0) pending.add(null, "unknown-shape");
  if (out.floors.length > MAX_FLOORS) {
    out.omittedFloors = out.floors.length - MAX_FLOORS;
    out.floors = out.floors.slice(0, MAX_FLOORS);
  }
  out.notUnderstood = pending.list;
  out.notUnderstoodCount = pending.count;
  return out;
}
