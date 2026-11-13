/**
 * The privacy gate's redaction rules and its page-shape check (AG-23). Twelve kinds, one rule each, in a fixed
 * order; every rule is a pure function from text to text and a count. Every pattern is bounded or anchored, so a
 * hostile string is scanned once and never backed into. What these rules cannot see (personal names, street
 * addresses, a secret in a shape none of them knows) is listed in privacy.ts as `NOT_DETECTED`.
 */
import { EMAIL_PATTERN, PHONE_PATTERN, redactSecretShapes } from "../agent-trace.js";

/** The kinds of redaction, in the order they run. Each has one rule and one fixture in the tests. */
export const REDACTION_KINDS = [
  "encoding",
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
export const LOOKALIKES: ReadonlyMap<string, string> = new Map(
  (
    [
      [0x043a, "k"],
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

/** Thrown by a rule that cannot make a text safe to send. The gate turns it into a refusal: nothing is sent. */
export class FailClosed extends Error {}

/** Named entities worth decoding: the punctuation a credential is written with. Others are left as written. */
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  equals: "=",
  commat: "@",
  period: ".",
  sol: "/",
  bsol: "\\",
  lpar: "(",
  rpar: ")",
  lbrack: "[",
  rbrack: "]",
  lsqb: "[",
  rsqb: "]",
  lcub: "{",
  rcub: "}",
  num: "#",
  excl: "!",
  quest: "?",
  percnt: "%",
  plus: "+",
  comma: ",",
  semi: ";",
  lowbar: "_",
  hyphen: "-",
  dash: "-",
  ast: "*",
  dollar: "$",
  grave: "`",
  hat: "^",
  vert: "|",
  tilde: "~",
  Tab: " ",
  NewLine: " ",
};
/** The few names that browsers read with no semicolon; every other name needs its semicolon to count. */
const LEGACY = new Set(["amp", "lt", "gt", "quot", "nbsp"]);
const MAX_ROUNDS = 3;

const codePoint = (n: number) =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : null;

/** One round of decoding: entities, percent escapes and JSON string escapes. */
function decodeOnce(text: string): { text: string; count: number } {
  let count = 0;
  let t = text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/g,
    (m, dec: string | undefined, hexa: string | undefined, name: string | undefined) => {
      let out: string | null | undefined;
      if (dec !== undefined) out = codePoint(Number(dec));
      else if (hexa !== undefined) out = codePoint(parseInt(hexa, 16));
      else if (name !== undefined && Object.hasOwn(NAMED, name))
        out = m.endsWith(";") || LEGACY.has(name) ? NAMED[name] : undefined;
      if (out === null || out === undefined) return m;
      count += 1;
      return out;
    },
  );
  t = t.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    let out: string;
    try {
      out = decodeURIComponent(run);
    } catch {
      // Not valid UTF-8 as a whole: read the plain ASCII ones, leave the rest.
      out = run.replace(/%([0-7][0-9A-Fa-f])/g, (_m, h: string) =>
        String.fromCharCode(parseInt(h, 16)),
      );
    }
    if (out !== run) count += 1;
    return out;
  });
  t = t.replace(
    /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(["'\\/])|([nrt]))/g,
    (_m, u: string | undefined, x: string | undefined, q: string | undefined) => {
      count += 1;
      if (u !== undefined) return String.fromCharCode(parseInt(u, 16));
      if (x !== undefined) return String.fromCharCode(parseInt(x, 16));
      return q ?? " ";
    },
  );
  return { text: t, count };
}

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

/** Names a credential is written under. No leading boundary: `x_api_key` and `myApiKey` count too. */
const CREDENTIAL_NAMES =
  "password|passwd|pwd|passphrase|secret[_-]?key|secret|client[_-]?secret|api[_-]?key|x-api-key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key[_-]?id|private[_-]?key|credentials?|session[_-]?id|token|authorization|auth";
/** Query and cookie parameter names that carry a credential or a signature (an S3 or CDN signed address, a login code). */
const SECRET_PARAMS =
  "x-amz-[a-z0-9-]+|signature|sig|token|key|access_token|id_token|refresh_token|auth|authorization|code|session|sid|password|secret|apikey|api_key|jwt|credential|client_secret|private_key|private_key_id|access_key|secret_key|passwd|pwd";
/** A value that is not quoted: up to six words, ending at a quote, a comma, a semicolon, an ampersand, a bracket or the end of the line. */
const VALUE_WORD = "[^\\s\"'&<>,;]{1,256}";
const VALUE_PHRASE = `${VALUE_WORD}(?:[ \\t]+${VALUE_WORD}){0,5}`;
const FORM_NAMES = `(?:${CREDENTIAL_NAMES}|current-password|new-password)`;

/** Provider key shapes, each with a name for the marker. Checked before the core rules so the count is theirs. */
const PROVIDER_KEYS: readonly (readonly [string, RegExp])[] = [
  ["model-provider-key", /\bsk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{30,}/g],
  ["slack-token", /\bxox[a-z]-[A-Za-z0-9-]{10,}/g],
  [
    "source-host-token",
    /\bgh[a-z]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}/g,
  ],
  ["package-token", /\bnpm_[A-Za-z0-9]{20,}/g],
  ["mail-api-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ["generic-prefixed-key", /\b(?:key|hf|ya29|pk_live|pk_test)[-_.][A-Za-z0-9_-]{24,}/g],
  ["cloud-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
];

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
  // 0. Decode what a page can hide a value behind: HTML entities (with or without the semicolon), percent
  //    escapes and JSON string escapes, up to three layers deep. The rules below run on the decoded text, and the
  //    decoded text is what is sent, never the original. A text that is still encoded after three rounds is not
  //    cleaned: it is refused.
  rule("encoding", (text) => {
    // Hidden characters can split an entity or an escape ("&#6" + zero-width space + "5;"), so they are read out
    // of the copy that is decoded. When nothing needs decoding the text goes on untouched, and the next rule
    // removes and counts them as before.
    let t = strip(text).out;
    let count = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = decodeOnce(t);
      if (r.text === t) return count === 0 ? { text, count: 0 } : { text: t, count };
      t = r.text;
      count += r.count;
    }
    if (decodeOnce(t).text !== t) throw new FailClosed("encoded more than three layers deep");
    return { text: t, count };
  }),
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
      new RegExp(`([?&;](?:${SECRET_PARAMS})=)[^&#\\s"';<>]{1,512}`, "gi"),
      (_m, head) => `${head}[redacted]`,
    ),
  ),
  // 6. A named credential and the whole of its value: "password": "...", token=..., Authorization: Bearer ...,
  //    password = four words in a row, and the value of an input field named like one.
  rule("credential-field", (text) => {
    let count = 0;
    const withTags = text.replace(
      /<(?:input|textarea|select|option|button)\b[^<>]{0,600}>/gi,
      (tag) => {
        const named = new RegExp(
          `(?:name|id|type|autocomplete)\\s*=\\s*["']?${FORM_NAMES}|type\\s*=\\s*["']?password`,
          "i",
        );
        if (!named.test(tag)) return tag;
        const cleaned = tag.replace(
          /(\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
          (_m, head: string) => `${head}"[redacted]"`,
        );
        if (cleaned !== tag) count += 1;
        return cleaned;
      },
    );
    const field = counting(
      new RegExp(
        `(["']?(?:${CREDENTIAL_NAMES})["']?\\s*[:=]\\s*)(?:(?:Bearer|Basic|Digest|Token)\\s+)?("[^"\\n]{1,512}"|'[^'\\n]{1,512}'|${VALUE_PHRASE})`,
        "gi",
      ),
      (_m, head) => `${head}[redacted]`,
    )(withTags);
    return { text: field.text, count: count + field.count };
  }),
  // 7. Every key and token shape the core redaction, the key patterns and the leak detectors know.
  rule("secret", (text) => {
    let count = 0;
    let t = text;
    for (const [name, re] of PROVIDER_KEYS)
      t = t.replace(new RegExp(re.source, re.flags), () => ((count += 1), `[secret:${name}]`));
    const out = redactSecretShapes(t);
    return { text: out, count: count + Math.max(0, marks(out) - marks(t)) };
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
 * A page's own structure and what runs code or reaches out: a doctype or comment; the document elements; the
 * elements that wrap the body of a page, embed another document or run code; forms and password fields;
 * `meta`, `base` and `link`; and an event-handler attribute (`onerror=`).
 */
const PAGE_TAG =
  /<\s*!\s*doctype\b|<!--|<\s*\/?\s*(?:html|head|body|main|article|section|nav|header|footer|aside|script|style|svg|iframe|template|noscript|object|embed|frameset|frame|meta|base|link|form|applet)(?![A-Za-z0-9])|[\s"'/]on[a-z]{3,20}\s*=|type\s*=\s*["']?password/i;
const TAG = /<[!/]?[A-Za-z!-][^<>]{0,300}>/g;
/** A bracket written as an entity (with or without its semicolon), a percent escape or a script escape. */
const ENCODED_LT = /&(?:lt|#0*60|#x0*3c);?|%3c|\\u003c|\\x3c|\\074/gi;
const ENCODED_GT = /&(?:gt|#0*62|#x0*3e);?|%3e|\\u003e|\\x3e|\\076/gi;
/** A run that could be Base64 or Base64url, long enough to hold a doctype. Every run is decoded and read. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
/** An opening tag, a closing tag, a declaration or an instruction. */
const TAG_OPENER = /<[A-Za-z!/?]/;

export interface PageVerdict {
  reason: "whole-page" | "many-tags" | null;
  tags: number;
}

const decodeBrackets = (text: string) => text.replace(ENCODED_LT, "<").replace(ENCODED_GT, ">");

/** Whether `bytes` read as text: mostly printable ASCII. Random bytes from a word that only looks like Base64 do not. */
function readsAsText(bytes: string): boolean {
  let printable = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes.charCodeAt(i);
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) printable += 1;
  }
  return bytes.length > 0 && printable / bytes.length >= 0.85;
}

/**
 * Whether `text` is shaped like a page: a page element, a page hidden in Base64 (every long run is decoded, and a
 * decode that reads as text and holds a tag is a page), or more than a few tags.
 */
export function pageShape(text: string): PageVerdict {
  const t = decodeBrackets(text);
  const tags = t.match(TAG)?.length ?? 0;
  if (PAGE_TAG.test(t)) return { reason: "whole-page", tags };
  for (const m of t.matchAll(BASE64_RUN)) {
    const decoded = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "latin1",
    );
    if (!readsAsText(decoded)) continue;
    const readable = decodeBrackets(decoded);
    if (PAGE_TAG.test(readable) || TAG_OPENER.test(readable)) return { reason: "whole-page", tags };
  }
  return { reason: tags > MAX_TAGS_PER_FIELD ? "many-tags" : null, tags };
}
