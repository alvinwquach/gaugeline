/**
 * What a page prints that is new on every visit and means nothing, removed before two visits are
 * compared: a nonce a content security policy needs, a CSRF value a form carries, the scrambled address
 * Cloudflare writes for an email. Two visits that differ only by these are the same page to a cache, so
 * they are not a cost. Each rule is a row here and a row in the test, so the list can grow without
 * hiding a real change: a rule blanks one value and nothing around it.
 */
export interface VolatileRule {
  id: string;
  /** What it removes, in a sentence. */
  what: string;
  apply(html: string): string;
}

/** The form fields and meta tags that carry a per-visit request token, lower case. */
const CSRF_NAMES: ReadonlySet<string> = new Set([
  "csrf-token",
  "xsrf-token",
  "_csrf",
  "csrf",
  "csrf_token",
  "csrftoken",
  "csrfmiddlewaretoken",
  "authenticity_token",
  "__requestverificationtoken",
  "_token",
  "_wpnonce",
]);

/** Blank `attr` inside every `<tag ...>` whose name attribute is in `names`. */
function blankTagValue(html: string, tag: "meta" | "input", attr: "content" | "value"): string {
  const tags = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const named = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  const valued = new RegExp(`(\\b${attr}\\s*=\\s*)(?:"[^"]*"|'[^']*')`, "i");
  return html.replace(tags, (t) => {
    const name = named.exec(t);
    const value = (name?.[1] ?? name?.[2] ?? "").toLowerCase();
    return CSRF_NAMES.has(value) ? t.replace(valued, '$1""') : t;
  });
}

export const VOLATILE_RULES: readonly VolatileRule[] = Object.freeze([
  {
    id: "nonce-attribute",
    what: "The value of a nonce attribute, which a content security policy makes new on every response.",
    apply: (html) => html.replace(/(\s(?:data-)?nonce\s*=\s*)(?:"[^"]*"|'[^']*')/gi, '$1""'),
  },
  {
    id: "csp-nonce",
    what: "A 'nonce-...' source in a content security policy written into the page.",
    apply: (html) => html.replace(/'nonce-[A-Za-z0-9+/=_-]+'/g, "'nonce-'"),
  },
  {
    id: "csrf-meta",
    what: "The content of a csrf-token meta tag.",
    apply: (html) => blankTagValue(html, "meta", "content"),
  },
  {
    id: "csrf-input",
    what: "The value of a hidden form field that carries a CSRF or request token.",
    apply: (html) => blankTagValue(html, "input", "value"),
  },
  {
    id: "cloudflare-email",
    what: "Cloudflare's scrambled email address, which it rewrites with a new key on every response.",
    apply: (html) =>
      html
        .replace(/(\bdata-cfemail\s*=\s*)(?:"[^"]*"|'[^']*')/gi, '$1""')
        .replace(/(\/cdn-cgi\/l\/email-protection#)[0-9a-f]*/gi, "$1"),
  },
]);

/** The page as a cache sees it: the volatile values blanked, whitespace collapsed and trimmed. */
export function stripVolatile(html: string): string {
  let text = html;
  for (const rule of VOLATILE_RULES) text = rule.apply(text);
  return text.replace(/\s+/g, " ").trim();
}

export type DifferenceKind = "time" | "id" | "number" | "other";

export interface Difference {
  /** The text just before the first difference, at most 40 characters. */
  context: string;
  first: string;
  second: string;
  kind: DifferenceKind;
}

const DELIMITER = /[\s"'<>=,]/;
const TOKEN_MAX = 80;
const CONTEXT_MAX = 40;

function kindOf(a: string, b: string): DifferenceKind {
  const both = [a, b];
  if (
    both.some(
      (t) =>
        /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t) ||
        /(?:^|[^\d])\d{1,2}:\d{2}(?::\d{2})?(?:$|[^\d])/.test(t) ||
        /^\d{10}(?:\d{3})?$/.test(t),
    )
  )
    return "time";
  if (
    both.every(
      (t) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t) ||
        (/^[A-Za-z0-9_-]{16,}$/.test(t) && /\d/.test(t)),
    )
  )
    return "id";
  if (both.every((t) => /^\d+$/.test(t))) return "number";
  return "other";
}

/** The text just before a difference: the last 40 characters, started at a tag when one is in them so it does not open mid-word. */
function contextOf(before: string): string {
  if (before.length <= CONTEXT_MAX) return before.trimStart();
  const tail = before.slice(-CONTEXT_MAX);
  const tag = tail.indexOf("<");
  return tag >= 0 ? tail.slice(tag) : `\u2026${tail.trimStart()}`;
}

/**
 * The first place two already-stripped pages differ, as the whole words around it: what the first visit
 * had, what the second had, the text before it and what kind of value it looks like. Undefined when they
 * are the same. Pure: the same two texts give the same answer.
 */
export function firstDifference(a: string, b: string): Difference | undefined {
  if (a === b) return undefined;
  let prefix = 0;
  const limit = Math.min(a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  let start = prefix;
  while (start > 0 && !DELIMITER.test(a[start - 1] ?? " ")) start--;
  const word = (text: string): string => {
    let end = text.length - suffix;
    while (end < text.length && !DELIMITER.test(text[end] ?? " ")) end++;
    return text.slice(start, end);
  };
  const first = word(a);
  const second = word(b);
  const before = a.slice(0, start).trimEnd();
  return {
    context: contextOf(before),
    first: first.slice(0, TOKEN_MAX),
    second: second.slice(0, TOKEN_MAX),
    kind: kindOf(first, second),
  };
}
