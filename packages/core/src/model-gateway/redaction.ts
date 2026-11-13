/**
 * The privacy gate's redaction rules and its page-shape check (AG-23). Twelve kinds, one rule each, in a fixed
 * order; every rule is a pure function from text to text and a count. Every pattern is bounded or anchored, so a
 * hostile string is scanned once and never backed into. What these rules cannot see (personal names, street
 * addresses, a secret in a shape none of them knows) is listed in privacy.ts as `NOT_DETECTED`.
 */
import { EMAIL_PATTERN, PHONE_PATTERN, redactSecretShapes } from "../agent-trace.js";

/** The kinds of redaction, in the order they run. Each has one rule and one fixture in the tests. */
export const REDACTION_KINDS = [
  "hidden-characters",
  "private-key",
  "url-credentials",
  "cookie",
  "url-parameter",
  "credential-field",
  "secret",
  "iban",
  "card",
  "email",
  "network-address",
  "phone",
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/** One redaction: text in, text out, and how many times it replaced something. */
export interface RedactionRule {
  readonly kind: RedactionKind;
  apply(text: string): { text: string; count: number };
}

const rule = (
  kind: RedactionKind,
  apply: (text: string) => { text: string; count: number },
): RedactionRule => Object.freeze({ kind, apply });
const counting = (re: RegExp, change: (m: string, ...g: string[]) => string) => (text: string) => {
  let count = 0;
  const out = text.replace(new RegExp(re.source, re.flags), (m: string, ...g: string[]) => {
    const r = change(m, ...g);
    if (r !== m) count += 1;
    return r;
  });
  return { text: out, count };
};

/** Format characters, controls (not tab, line feed, carriage return), private use, fillers, selectors. */
const HIDDEN = new RegExp(
  `(?:${[
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]",
    "\\p{Cf}",
    "\\p{Co}",
    "\\p{Cs}",
    // Each mark or filler is its own alternative: a class that holds a combining mark next to another
    // character is flagged by the lint rule, and means something else to a reader.
    "\\u034F",
    "[\\u115F\\u1160]",
    "\\u17B4",
    "\\u17B5",
    "[\\u180B-\\u180D]",
    "[\\u2800\\u3164\\uFFA0\\uFFFC]",
    "[\\uFE00-\\uFE0F]",
    "[\\u{E0100}-\\u{E01EF}]",
  ].join("|")})+`,
  "gu",
);
/** A combining mark that follows an ASCII letter or digit: the way a key is split without changing how it reads. */
const MARK_AFTER_ASCII = /(?<=[A-Za-z0-9])\p{M}+/gu;

/** Cyrillic and Greek letters that read as Latin ones, by code point. Used only inside a token that has an ASCII letter. */
const LOOKALIKES: ReadonlyMap<string, string> = new Map(
  (
    [
      [0x0430, "a"],
      [0x0435, "e"],
      [0x043e, "o"],
      [0x0440, "p"],
      [0x0441, "c"],
      [0x0443, "y"],
      [0x0445, "x"],
      [0x0456, "i"],
      [0x0458, "j"],
      [0x0455, "s"],
      [0x0501, "d"],
      [0x04bb, "h"],
      [0x04cf, "l"],
      [0x051b, "q"],
      [0x051d, "w"],
      [0x0410, "A"],
      [0x0412, "B"],
      [0x0415, "E"],
      [0x041a, "K"],
      [0x041c, "M"],
      [0x041d, "H"],
      [0x041e, "O"],
      [0x0420, "P"],
      [0x0421, "C"],
      [0x0422, "T"],
      [0x0425, "X"],
      [0x0406, "I"],
      [0x0408, "J"],
      [0x0405, "S"],
      [0x03b1, "a"],
      [0x03bf, "o"],
      [0x03bd, "v"],
      [0x03c1, "p"],
      [0x03c7, "x"],
      [0x03b9, "i"],
      [0x03ba, "k"],
      [0x03c5, "u"],
      [0x03c4, "t"],
      [0x0391, "A"],
      [0x0392, "B"],
      [0x0395, "E"],
      [0x0396, "Z"],
      [0x0397, "H"],
      [0x0399, "I"],
      [0x039a, "K"],
      [0x039c, "M"],
      [0x039d, "N"],
      [0x039f, "O"],
      [0x03a1, "P"],
      [0x03a4, "T"],
      [0x03a5, "Y"],
      [0x03a7, "X"],
    ] as const
  ).map(([cp, latin]) => [String.fromCodePoint(cp), latin]),
);
const LOOKALIKE_SET = `[${[...LOOKALIKES.keys()].join("")}]`;
const HAS_LOOKALIKE = new RegExp(LOOKALIKE_SET, "u");
const LOOKALIKE_CHARS = new RegExp(LOOKALIKE_SET, "gu");

const strip = (text: string) => {
  let count = 0;
  const out = text.replace(HIDDEN, () => ((count += 1), ""));
  return { out, count };
};

const MARKERS = /\[secret:[A-Za-z0-9_-]+\]|\[redacted(?:-jwt)?\]/g;
const marks = (t: string) => t.match(MARKERS)?.length ?? 0;
const digitsOf = (t: string) => t.replace(/\D/g, "");

/** The Luhn checksum: what separates a card number from any other run of digits. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/** An IBAN is 15 to 34 characters long (the shortest national one is 15) and holds at least 10 digits. */
const IBAN_LENGTH = [15, 34] as const;
const IBAN_MIN_DIGITS = 10;

const CREDENTIAL_NAMES =
  "password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|x-api-key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|token|authorization";
/** Query and cookie parameter names that carry a credential or a signature (an S3 or CDN signed address, a login code). */
const SECRET_PARAMS =
  "x-amz-[a-z0-9-]+|signature|sig|token|key|access_token|id_token|refresh_token|auth|authorization|code|session|sid|password|secret|apikey|api_key|jwt|credential|client_secret";

/** Whether `part` is one to four hexadecimal digits. */
const hex4 = (part: string) => /^[0-9A-Fa-f]{1,4}$/.test(part);
/** Whether `body` is an IPv6 address: groups of hex digits, "::" at most once, eight groups or fewer with one "::". */
function isIPv6(body: string): boolean {
  const doubles = body.split("::").length - 1;
  if (doubles > 1 || body.includes(":::")) return false;
  const groups = body.split(":");
  if (doubles === 1) {
    const real = groups.filter((g) => g !== "");
    return real.length <= 7 && real.every(hex4);
  }
  return groups.length === 8 && groups.every(hex4);
}
const octets = (m: string) => m.split(".").every((p) => Number(p) <= 255);

export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
  // 1. Normalise (full-width letters become ASCII, accents on an ASCII letter are dropped, so a key split by a
  //    combining mark is whole), remove every character a reader cannot see, and read a Cyrillic or Greek
  //    look-alike inside a word that has Latin letters as the Latin letter.
  rule("hidden-characters", (text) => {
    let count = 0;
    let t = text.normalize("NFKD").replace(MARK_AFTER_ASCII, () => ((count += 1), ""));
    t = t.normalize("NFKC");
    const a = strip(t);
    count += a.count;
    t = a.out.replace(/\S+/gu, (token) => {
      if (!/[A-Za-z]/.test(token) || !HAS_LOOKALIKE.test(token)) return token;
      count += 1;
      return token.replace(LOOKALIKE_CHARS, (c) => LOOKALIKES.get(c) ?? c);
    });
    return { text: t, count };
  }),
  // 2. A private key block, to its end line or the end of the text.
  rule(
    "private-key",
    counting(
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
      () => "[private key]",
    ),
  ),
  // 3. A login in a web address: scheme://user:password@host.
  rule(
    "url-credentials",
    counting(
      /\b([A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/)[^\s/@:?#]{1,64}:[^\s/@?#]{1,128}@/g,
      (_m, scheme) => `${scheme}[redacted]@`,
    ),
  ),
  // 4. A cookie: the rest of a Cookie or Set-Cookie header line, and what a script assigns to document.cookie.
  rule(
    "cookie",
    counting(
      /\b((?:Set-)?Cookie\s*:\s*|document\.cookie\s*=\s*)("[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\n]{1,512})/gi,
      (_m, head) => `${head}[redacted]`,
    ),
  ),
  // 5. A secret or signature in a web address or a form: ?token=, &X-Amz-Signature=, ;sid=
  rule(
    "url-parameter",
    counting(
      new RegExp(`([?&;](?:${SECRET_PARAMS})=)[^&#\\s"';]{1,512}`, "gi"),
      (_m, head) => `${head}[redacted]`,
    ),
  ),
  // 6. A named credential and its value: "password": "...", token=..., Authorization: Bearer ...
  rule(
    "credential-field",
    counting(
      new RegExp(
        `(["']?\\b(?:${CREDENTIAL_NAMES})["']?\\s*[:=]\\s*)(?:(?:Bearer|Basic|Digest|Token)\\s+)?("[^"\\n]{1,512}"|'[^'\\n]{1,512}'|[^\\s"',;&}\\])]{6,512})`,
        "gi",
      ),
      (_m, head) => `${head}[redacted]`,
    ),
  ),
  // 7. Every key and token shape the core redaction, the key patterns and the leak detectors know.
  rule("secret", (text) => {
    const out = redactSecretShapes(text);
    return { text: out, count: Math.max(0, marks(out) - marks(text)) };
  }),
  // 8. An IBAN, in either case: two letters, two digits and a run of letters and digits, 15 to 34 long, 10 digits or more.
  rule(
    "iban",
    counting(/(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}[A-Za-z0-9 -]{11,40}(?![A-Za-z0-9])/g, (m) => {
      const body = m.replace(/[ -]+$/, "");
      const compact = body.replace(/[ -]/g, "");
      const n = compact.length;
      if (n < IBAN_LENGTH[0] || n > IBAN_LENGTH[1] || digitsOf(compact).length < IBAN_MIN_DIGITS)
        return m;
      return `[iban]${m.slice(body.length)}`;
    }),
  ),
  // 9. A card number: 13 to 19 digits, spaces or hyphens between them allowed, and a valid Luhn checksum.
  rule(
    "card",
    counting(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, (m) => {
      const d = digitsOf(m);
      return d.length >= 13 && d.length <= 19 && luhn(d) ? "[card]" : m;
    }),
  ),
  // 10. An email address.
  rule(
    "email",
    counting(EMAIL_PATTERN, () => "[email]"),
  ),
  // 11. A network address: IPv4 or IPv6 (with a port), localhost, and a host on a private name (.local, .internal, .lan).
  //     Before the phone rule, so 203.0.113.9 is an address and not a phone number.
  rule("network-address", (text) => {
    let count = 0;
    const hit = (m: string, ok: boolean) => (ok ? ((count += 1), "[address]") : m);
    let t = text.replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?!\w)(?!\.\d)/g, (m) =>
      hit(m, octets(m.split(":")[0]!)),
    );
    t = t.replace(
      /(?<![\w:.])\[?(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\]?(?::\d{1,5})?(?![\w:])/g,
      (m) => hit(m, isIPv6(m.replace(/^\[/, "").replace(/\](?::\d{1,5})?$/, ""))),
    );
    t = t.replace(
      /\b(?:localhost|[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.(?:local|localdomain|internal|intranet|lan|home|corp))(?::\d{1,5})?(?![\w.-])/gi,
      (m) => hit(m, true),
    );
    return { text: t, count };
  }),
  // 12. A phone number: 8 to 15 digits with the usual separators. A date or a time that starts the run is not one.
  rule(
    "phone",
    counting(PHONE_PATTERN, (m) => {
      const n = digitsOf(m).length;
      return n < 8 || n > 15 || /^\d{4}-\d{2}-\d{2}(?!\d)/.test(m) ? m : "[phone]";
    }),
  ),
]);

// ---------------------------------------------------------------------------------------------------------
// The page-shape check.

/** Most tags in one field, and in all of them: a quoted element or two is evidence, more is markup. */
export const MAX_TAGS_PER_FIELD = 3;
export const MAX_TAGS_TOTAL = 8;

/**
 * A page's own structure: a doctype or comment, the document elements, and the elements that wrap the body of a
 * page or run code (main, article, section, nav, header, footer, aside, script, style, svg, iframe, template).
 */
const PAGE_TAG =
  /<\s*!\s*doctype\b|<!--|<\s*\/?\s*(?:html|head|body|main|article|section|nav|header|footer|aside|script|style|svg|iframe|template|noscript)(?![A-Za-z0-9])/i;
const TAG = /<[!/]?[A-Za-z!-][^<>]{0,300}>/g;
/** A bracket written as an entity (with or without its semicolon), a percent escape or a script escape. */
const ENCODED_LT = /&(?:lt|#0*60|#x0*3c);?|%3c|\\u003c|\\x3c|\\074/gi;
const ENCODED_GT = /&(?:gt|#0*62|#x0*3e);?|%3e|\\u003e|\\x3e|\\076/gi;
/** A run that could be Base64 or Base64url: decoded and read as text, so an encoded page is read as the page it is. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;
const MAX_BASE64_RUNS = 20;

export interface PageVerdict {
  reason: "whole-page" | "many-tags" | null;
  tags: number;
}

const decodeBrackets = (text: string) => text.replace(ENCODED_LT, "<").replace(ENCODED_GT, ">");

/** Whether `text` is shaped like a page: a page element, a page hidden in Base64, or more than a few tags. */
export function pageShape(text: string): PageVerdict {
  const t = decodeBrackets(text);
  const tags = t.match(TAG)?.length ?? 0;
  if (PAGE_TAG.test(t)) return { reason: "whole-page", tags };
  let runs = 0;
  for (const m of t.matchAll(BASE64_RUN)) {
    if ((runs += 1) > MAX_BASE64_RUNS) break;
    const decoded = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "latin1",
    );
    if (PAGE_TAG.test(decodeBrackets(decoded))) return { reason: "whole-page", tags };
  }
  return { reason: tags > MAX_TAGS_PER_FIELD ? "many-tags" : null, tags };
}
