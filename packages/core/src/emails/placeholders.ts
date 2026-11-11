/**
 * Template variables and leftovers that were never filled in, found in the text of a rendered
 * email. A table of rules, so each one has a test and the list can grow without code changes.
 * The email is data: nothing here runs it, and every match is escaped before it is printed.
 */
export interface PlaceholderRule {
  id: string;
  /** What the person fixing it should call it. */
  label: string;
  /** Global, so every match is found. */
  pattern: RegExp;
}

export const PLACEHOLDER_RULES: readonly PlaceholderRule[] = Object.freeze([
  {
    id: "handlebars-triple",
    label: "Handlebars {{{ }}}",
    pattern: /\{\{\{[^{}\n]{1,80}?\}\}\}/g,
  },
  {
    // Handlebars, Mustache and Liquid output tags look the same: {{ name }}, {{#if paid}}, {{> footer}}.
    id: "double-braces",
    label: "Handlebars or Liquid {{ }}",
    pattern: /\{\{[^{}\n]{1,80}?\}\}/g,
  },
  {
    id: "liquid-tag",
    label: "Liquid {% %}",
    pattern: /\{%-?[^{}\n]{1,80}?-?%\}/g,
  },
  {
    id: "erb-tag",
    label: "ERB or EJS <% %>",
    pattern: /<%[=#-]?[^%\n]{0,80}%>/g,
  },
  {
    id: "template-literal",
    label: "JavaScript ${ }",
    pattern: /\$\{[^{}\n]{1,80}\}/g,
  },
  {
    // JSX and message-format leftovers: {props.name}, {orderId}. Not {{ }} and not ${ }.
    id: "single-braces",
    label: "JSX or message {name}",
    pattern: /(?<![{$])\{[A-Za-z_$][\w$]*(?:\.[\w$]+)*\}(?!\})/g,
  },
  {
    id: "object-object",
    label: "[object Object]",
    pattern: /\[object Object\]/g,
  },
  {
    // Mailchimp merge tags: *|FNAME|*.
    id: "merge-tag",
    label: "Merge tag *|NAME|*",
    pattern: /\*\|[A-Z][A-Z0-9_:]{0,40}\|\*/g,
  },
  {
    id: "js-undefined",
    label: "undefined or NaN",
    pattern: /(?<![\w.-])(?:undefined|NaN)(?![\w-])/g,
  },
  {
    // "null" alone as a text node, or after a greeting: "Hi null,". Never inside a word.
    id: "js-null",
    label: "null",
    pattern: /(?<=>\s*)null(?=\s*<)|\b(?:Hi|Hello|Hey|Dear)\s+null\b/g,
  },
]);

export interface PlaceholderMatch {
  rule: string;
  label: string;
  /** As written. */
  text: string;
  /** Character offset in the text that was scanned. */
  index: number;
}

/**
 * Every placeholder in `text`, in order. A match inside an earlier, longer one is dropped, so
 * {{{html}}} is one finding and not two.
 */
export function findPlaceholders(text: string): PlaceholderMatch[] {
  const all: PlaceholderMatch[] = [];
  for (const rule of PLACEHOLDER_RULES) {
    for (const m of text.matchAll(rule.pattern))
      all.push({ rule: rule.id, label: rule.label, text: m[0], index: m.index ?? 0 });
  }
  all.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const out: PlaceholderMatch[] = [];
  let end = -1;
  for (const m of all) {
    if (m.index < end) continue;
    out.push(m);
    end = m.index + m.text.length;
  }
  return out;
}
