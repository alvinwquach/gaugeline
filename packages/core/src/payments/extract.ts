import { load } from "cheerio/slim";
import { normalisePhone } from "../facts/normalise.js";
import type { PageSnapshot } from "../snapshot.js";
import type { PaymentDetail, PaymentKind } from "./types.js";

/**
 * How near the provider's name must be to a handle written as text, in characters. "@lulas" and
 * "$12" look like ordinary text; requiring "Venmo" or "Cash App" this close, in the same sentence,
 * is what keeps false alarms near zero. Tested at the boundary.
 */
export const ANCHOR_WINDOW = 40;

/** Characters of text kept either side of a handle, for the evidence. */
const CONTEXT_CHARS = 30;

export interface PaymentRule {
  id: string;
  kind: PaymentKind;
  /**
   * link: an address, read from an href or written out in text; it names its provider itself.
   * text: a handle, read only with the provider's name (anchor) nearby.
   */
  form: "link" | "text";
  pattern: RegExp;
  anchor?: RegExp;
  /** The comparable value and the spelling to show, or undefined when the match is not one. */
  read(m: RegExpExecArray): { value: string; raw: string } | undefined;
}

/** venmo.com paths that are pages of Venmo's own site, not profiles. */
const VENMO_RESERVED: ReadonlySet<string> = new Set([
  "about",
  "account",
  "business",
  "careers",
  "help",
  "legal",
  "login",
  "pay",
  "privacy",
  "resources",
  "sign-in",
  "signup",
  "terms",
  "u",
]);

const PROTOCOL = String.raw`(?<![\w.\/-])(?:https?:\/\/)?`;
const CASHTAG = String.raw`[A-Za-z][A-Za-z0-9_-]{0,19}`;
const VENMO_HANDLE = String.raw`[A-Za-z0-9][A-Za-z0-9_-]{1,29}`;
const EMAIL = String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`;
const PHONE = String.raw`(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}`;

/** Every way a payment detail is read, one row each, each with a test. */
export const PAYMENT_RULES: readonly PaymentRule[] = Object.freeze([
  {
    id: "cashapp-link",
    kind: "cashapp",
    form: "link",
    pattern: new RegExp(String.raw`${PROTOCOL}(?:www\.)?cash\.app\/\$(${CASHTAG})(?![\w-])`, "gi"),
    read: (m) => ({ value: (m[1] ?? "").toLowerCase(), raw: `$${m[1] ?? ""}` }),
  },
  {
    id: "cashapp-text",
    kind: "cashapp",
    form: "text",
    // A cashtag starts with a letter, so "$12", "$12.50" and "$5k" are prices, never tags.
    pattern: new RegExp(String.raw`(?<![\w$\/])\$(${CASHTAG})(?![\w-])`, "g"),
    anchor: /\bcash\s?app\b/gi,
    read: (m) => ({ value: (m[1] ?? "").toLowerCase(), raw: `$${m[1] ?? ""}` }),
  },
  {
    id: "venmo-link",
    kind: "venmo",
    form: "link",
    pattern: new RegExp(
      String.raw`${PROTOCOL}(?:www\.|account\.)?venmo\.com\/(?:u\/)?(${VENMO_HANDLE})(?![\w-])`,
      "gi",
    ),
    read: (m) => {
      const h = m[1] ?? "";
      return VENMO_RESERVED.has(h.toLowerCase())
        ? undefined
        : { value: h.toLowerCase(), raw: `@${h}` };
    },
  },
  {
    id: "venmo-text",
    kind: "venmo",
    form: "text",
    // Not the second half of an email address, and not "@example.com".
    pattern: new RegExp(String.raw`(?<![\w@.\/])@(${VENMO_HANDLE})(?![\w@-]|\.\w)`, "g"),
    anchor: /\bvenmo\b/gi,
    read: (m) => ({ value: (m[1] ?? "").toLowerCase(), raw: `@${m[1] ?? ""}` }),
  },
  {
    id: "paypal-link",
    kind: "paypal",
    form: "link",
    pattern: new RegExp(
      String.raw`${PROTOCOL}(?:www\.)?paypal\.(?:me|com\/paypalme)\/([A-Za-z0-9]{1,20})(?![\w-])`,
      "gi",
    ),
    read: (m) => ({ value: (m[1] ?? "").toLowerCase(), raw: `paypal.me/${m[1] ?? ""}` }),
  },
  {
    id: "zelle-phone",
    kind: "zelle",
    form: "text",
    pattern: new RegExp(String.raw`(?<![\d+])(${PHONE})(?!\d)`, "g"),
    anchor: /\bzelle\b/gi,
    read: (m) => {
      const value = normalisePhone(m[1] ?? "");
      return value ? { value, raw: m[1] ?? "" } : undefined;
    },
  },
  {
    id: "zelle-email",
    kind: "zelle",
    form: "text",
    pattern: new RegExp(String.raw`(?<![\w.+-])(${EMAIL})`, "g"),
    anchor: /\bzelle\b/gi,
    read: (m) => ({ value: (m[1] ?? "").toLowerCase(), raw: m[1] ?? "" }),
  },
  {
    id: "square-link",
    kind: "square-link",
    form: "link",
    pattern: new RegExp(String.raw`${PROTOCOL}square\.link\/u\/([A-Za-z0-9]+)`, "gi"),
    read: (m) => {
      const url = `https://square.link/u/${m[1] ?? ""}`;
      return { value: url, raw: url };
    },
  },
  {
    id: "square-checkout",
    kind: "square-link",
    form: "link",
    pattern: new RegExp(
      String.raw`${PROTOCOL}checkout\.square\.site\/((?:[\w-]+\/)*[\w-]+)\/?`,
      "gi",
    ),
    read: (m) => {
      const url = `https://checkout.square.site/${m[1] ?? ""}`;
      return { value: url, raw: url };
    },
  },
  {
    id: "stripe-link",
    kind: "stripe-link",
    form: "link",
    pattern: new RegExp(String.raw`${PROTOCOL}buy\.stripe\.com\/([A-Za-z0-9_-]+)`, "gi"),
    read: (m) => {
      const url = `https://buy.stripe.com/${m[1] ?? ""}`;
      return { value: url, raw: url };
    },
  },
] satisfies PaymentRule[]);

/** A configured value written without its link: "$Tag", "@handle", a PayPal.Me name, a phone or email. */
const PLAIN: Readonly<Record<PaymentKind, (raw: string) => string | undefined>> = {
  cashapp: (raw) => new RegExp(`^\\$?(${CASHTAG})$`).exec(raw)?.[1]?.toLowerCase(),
  venmo: (raw) => new RegExp(`^@?(${VENMO_HANDLE})$`).exec(raw)?.[1]?.toLowerCase(),
  paypal: (raw) => /^([A-Za-z0-9]{1,20})$/.exec(raw)?.[1]?.toLowerCase(),
  zelle: (raw) =>
    new RegExp(`^${EMAIL}$`).test(raw)
      ? raw.toLowerCase()
      : /^[\d\s().+-]+$/.test(raw)
        ? normalisePhone(raw)
        : undefined,
  "square-link": () => undefined,
  "stripe-link": () => undefined,
};

/** A configured value as the comparable value the page's details are read as, or undefined. */
export function configValue(kind: PaymentKind, raw: string): string | undefined {
  const text = raw.trim();
  for (const rule of PAYMENT_RULES) {
    if (rule.kind !== kind || rule.form !== "link") continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""));
    const m = re.exec(text);
    if (m) return rule.read(m)?.value;
  }
  return PLAIN[kind](text);
}

/** HTML elements that end a line of text: a handle never anchors across one. */
const BLOCKS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

/** A sentence end or a list separator ("·", "|", "•", a dash between spaces) ends the window too. */
const SEGMENT_BREAK = /(?<=[.!?;])\s+|\s+[·|•–—]\s+/;

function segments(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .flatMap((line) => line.split(SEGMENT_BREAK))
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function anchored(segment: string, anchor: RegExp, start: number, end: number): boolean {
  for (const a of segment.matchAll(new RegExp(anchor.source, anchor.flags))) {
    const aStart = a.index ?? 0;
    const aEnd = aStart + a[0].length;
    const gap = aEnd <= start ? start - aEnd : aStart >= end ? aStart - end : 0;
    if (gap <= ANCHOR_WINDOW) return true;
  }
  return false;
}

/** The details in one piece of text, in the order they are written. */
function readText(
  segment: string,
  add: (rule: PaymentRule, m: RegExpExecArray, context: string) => void,
): void {
  const hits: { at: number; rule: PaymentRule; m: RegExpExecArray }[] = [];
  for (const rule of PAYMENT_RULES) {
    for (const m of segment.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
      const at = m.index ?? 0;
      if (rule.anchor && !anchored(segment, rule.anchor, at, at + m[0].length)) continue;
      hits.push({ at, rule, m });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  for (const { at, rule, m } of hits) {
    const context = segment
      .slice(Math.max(0, at - CONTEXT_CHARS), at + m[0].length + CONTEXT_CHARS)
      .trim();
    add(rule, m, context);
  }
}

interface PageParts {
  hrefs: string[];
  text: string;
  alts: string[];
  labels: string[];
}

function parts(page: PageSnapshot): PageParts {
  const $ = load(page.hops.at(-1)?.body ?? "");
  $("script, style, noscript, template").remove();
  const attrs = (sel: string, name: string) =>
    $(sel)
      .map((_, el) => $(el).attr(name) ?? "")
      .get()
      .filter((v) => v.trim() !== "");
  const hrefs = attrs("a[href], area[href]", "href");
  const alts = attrs("img[alt], area[alt], input[type=image][alt]", "alt");
  const labels = attrs("[aria-label]", "aria-label");
  $("br").replaceWith("\n");
  $("body *").each((_, el) => {
    $(el).append(BLOCKS.has(el.tagName.toLowerCase()) ? "\n" : " ");
  });
  return { hrefs, text: $("body").text(), alts, labels };
}

const cache = new WeakMap<PageSnapshot, PaymentDetail[]>();

/**
 * Every payment detail a page shows, as sent: links (href), visible text, image descriptions and
 * aria-labels, in that order. Text handles count only next to the provider's name.
 */
export function extractPayments(page: PageSnapshot): PaymentDetail[] {
  const hit = cache.get(page);
  if (hit) return hit;
  const path = new URL(page.finalUrl).pathname;
  const out: PaymentDetail[] = [];
  const { hrefs, text, alts, labels } = parts(page);
  const adder =
    (source: PaymentDetail["source"]) =>
    (rule: PaymentRule, m: RegExpExecArray, context: string) => {
      const read = rule.read(m);
      if (read) out.push({ kind: rule.kind, ...read, path, source, context, rule: rule.id });
    };
  for (const href of hrefs) {
    for (const rule of PAYMENT_RULES) {
      if (rule.form !== "link") continue;
      const m = new RegExp(`^${rule.pattern.source}`, rule.pattern.flags.replace("g", "")).exec(
        href.trim(),
      );
      if (m) adder("link")(rule, m, "");
    }
  }
  for (const s of segments(text)) readText(s, adder("text"));
  for (const alt of alts) for (const s of segments(alt)) readText(s, adder("image description"));
  for (const label of labels) for (const s of segments(label)) readText(s, adder("label"));
  cache.set(page, out);
  return out;
}
