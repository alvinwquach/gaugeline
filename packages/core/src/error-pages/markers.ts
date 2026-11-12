import type { PageSnapshot } from "../snapshot.js";

/**
 * Error pages that answer 200. A pure classifier over a page the run already fetched: no request,
 * no clock, no model. The same page gives the same answer.
 *
 * What it reads, and only this:
 *  - the framework error pages' own markup or text (a short table below, each from the framework's
 *    source), and
 *  - a title or first heading that is, as a whole, an error phrase ("Page not found", "404",
 *    "Something went wrong") on a page with few words.
 * The result names a kind from a fixed list, never a word of the page.
 */
export type ShellKind =
  | "next-error-page"
  | "next-client-exception"
  | "nuxt-error-page"
  | "sveltekit-error-page"
  | "react-router-error-boundary"
  | "error-title"
  | "error-heading";

/** What a finding says the page is. Fixed text: nothing from the page is ever put in it. */
export const SHELL_LABEL: Readonly<Record<ShellKind, string>> = Object.freeze({
  "next-error-page": "the Next.js error page (an html element with the id __next_error__)",
  "next-client-exception": "the Next.js client-side exception message",
  "nuxt-error-page": "the Nuxt error page (a status title and its go-back-home link)",
  "sveltekit-error-page":
    "the SvelteKit error page (a status and the error message as the heading)",
  "react-router-error-boundary": "the React Router and Remix default error boundary message",
  "error-title": "a page title that says the page is an error or is not found",
  "error-heading": "a main heading that says the page is an error or is not found",
});

export interface ShellRead {
  /** The marker found. Absent when none was. */
  kind?: ShellKind;
  /** Set when the body was cut at the size cap and no marker was found in what was read. */
  unread?: true;
}

/** Characters of body scanned for markup markers. An error page is small; the rest is not read. */
export const ERROR_SHELL_BODY_MAX = 200_000;
/** Text markers, titles and headings count only on a page with fewer words than this. */
export const ERROR_SHELL_MAX_WORDS = 150;
/** The longest title or heading looked at. */
const TEXT_MAX = 300;
/** The most segments looked at in a title. */
const SEGMENTS_MAX = 6;

/** The exact phrases, lower case, with the status and punctuation taken off. A Set: one lookup each. */
const PHRASES: ReadonlySet<string> = new Set([
  "page not found",
  "not found",
  "file not found",
  "page cannot be found",
  "page could not be found",
  "this page could not be found",
  "this page doesn't exist",
  "this page does not exist",
  "page doesn't exist",
  "page does not exist",
  "we can't find that page",
  "we couldn't find that page",
  "something went wrong",
  "an error occurred",
  "an error has occurred",
  "internal server error",
  "server error",
  "application error",
  "unexpected application error",
  "p\u00E1gina no encontrada",
  "pagina no encontrada",
  "p\u00E1gina no existe",
  "page introuvable",
  "page non trouv\u00E9e",
  "page non trouvee",
  "seite nicht gefunden",
  "pagina non trovata",
  "p\u00E1gina n\u00E3o encontrada",
  "pagina nao encontrada",
  "pagina niet gevonden",
]);

const SEPARATORS = /\s+[|\u2013\u2014\u00B7\u2022-]\s+/;
const STATUS_PREFIX = /^(?:error\s+)?[45]\d\d\b[\s:.\u2013\u2014-]{0,4}/;
const NUXT_TITLE = /^[45]\d\d - [^|]{1,60}(?: \| .{1,100})?$/;
const SVELTEKIT_STATUS = /<span class="status">\s{0,4}[45]\d\d\s{0,4}<\/span>/;
const NEXT_HTML_ID = /<html\b[^>]{0,400}?\bid\s*=\s*["']?__next_error__/i;

function normalise(text: string): string {
  return text
    .slice(0, TEXT_MAX)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** One segment, with a leading status, "oops" and trailing punctuation off, is an error phrase. */
function isErrorSegment(segment: string): boolean {
  let s = segment.replace(/^oops[!.,]?\s*/, "");
  const status = STATUS_PREFIX.exec(s);
  const hadStatus = status !== null;
  if (status) s = s.slice(status[0].length);
  s = s.replace(/[!.\s]+$/, "");
  if (s === "") return hadStatus;
  return PHRASES.has(s);
}

/** True when the title or heading, as a whole or in one of its " | " parts, is an error phrase. */
function isErrorText(raw: string): boolean {
  const text = normalise(raw);
  if (text === "") return false;
  if (isErrorSegment(text)) return true;
  const parts = text.split(SEPARATORS, SEGMENTS_MAX);
  return parts.length > 1 && parts.some(isErrorSegment);
}

/** Classify one fetched page. Pure and bounded: at most ERROR_SHELL_BODY_MAX characters are scanned. */
export function classifyErrorShell(page: PageSnapshot): ShellRead {
  const hop = page.hops.at(-1);
  const body = (hop?.body ?? "").slice(0, ERROR_SHELL_BODY_MAX);
  const small = page.contentWordCount < ERROR_SHELL_MAX_WORDS;
  const title = page.title ?? "";

  // The Next.js error page puts its id on the html element, in the first bytes.
  if (NEXT_HTML_ID.test(body.slice(0, 4096))) return { kind: "next-error-page" };

  if (small) {
    const text = (page.visibleText ?? "").slice(0, 2000).toLowerCase();
    if (text.includes("application error: a client-side exception has occurred"))
      return { kind: "next-client-exception" };
    if (text.includes("unexpected application error!"))
      return { kind: "react-router-error-boundary" };
    if (title.length <= TEXT_MAX && NUXT_TITLE.test(title) && body.includes("data-back-home"))
      return { kind: "nuxt-error-page" };
    const h1 = page.headings.find((h) => h.level === 1)?.text;
    if (h1 !== undefined && h1 === title && title !== "" && SVELTEKIT_STATUS.test(body))
      return { kind: "sveltekit-error-page" };
    if (isErrorText(title)) return { kind: "error-title" };
    if (h1 !== undefined && isErrorText(h1)) return { kind: "error-heading" };
  }
  return hop?.truncated ? { unread: true } : {};
}
