import { CheckRegistry, defineCheck, type Check, type Finding } from "../model.js";
import type { EmailImage, EmailLink } from "../emails/parse.js";
import { findPlaceholders } from "../emails/placeholders.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/** A placeholder found in an email's HTML or in its text version. */
export interface EmailPlaceholder {
  rule: string;
  label: string;
  text: string;
  /** The file it is in: the email, or its .txt. */
  file: string;
  line: number;
}

/** What the four email checks read: one rendered email, as the files say it. Nothing is run or requested. */
export interface EmailInput {
  /** The email's path as it is shown (the folder as typed, then the path inside it). */
  file: string;
  links: readonly EmailLink[];
  images: readonly EmailImage[];
  placeholders: readonly EmailPlaceholder[];
  /** A .txt with the same name sits beside the .html. */
  hasTextPart: boolean;
  /** gaugeline.emails.json says every email has one. */
  textExpected: boolean;
}

const SHOWN = 100;
const LISTED = 3;

/** The address without its query and fragment (those hold a customer's token), and with a mark when it had one. */
function shown(address: string): string {
  const cut = address.search(/[?#]/);
  const bare =
    cut === -1 ? address : `${address.slice(0, cut)}${address[cut] === "?" ? "?\u2026" : ""}`;
  return escapeInvisible(bare, SHOWN);
}

/** "line 4 /orders/9, line 9 http://localhost:3000/x and 2 more". */
function listLines(items: readonly { line: number; text: string }[]): string {
  const listed = items.slice(0, LISTED).map((i) => `line ${i.line} ${i.text}`);
  const more = items.length > LISTED ? ` and ${items.length - LISTED} more` : "";
  return `${listed.join(", ")}${more}`;
}

const noun = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Hosts that only the developer's own machine or network can open. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

export type HrefKind = "relative" | "local";

/**
 * Why an address will not open from an inbox, or undefined when it is fine or not for this check:
 * an anchor, a mailto: or tel: link, any other scheme, and a template variable (which
 * email-preview-placeholder reports).
 */
export function badHref(href: string): HrefKind | undefined {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#")) return undefined;
  if (findPlaceholders(raw).length > 0) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === undefined) return "relative";
  if (scheme !== "http" && scheme !== "https") return undefined;
  try {
    return isLocalHost(new URL(raw).hostname) ? "local" : undefined;
  } catch {
    return undefined;
  }
}

/** Why an image's address will not load in an inbox, or undefined. cid: and data: images travel inside the message. */
function badImage(src: string): "relative" | "local" | "http" | undefined {
  const raw = src.trim();
  if (raw === "" || findPlaceholders(raw).length > 0) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === undefined) return "relative";
  if (scheme !== "http" && scheme !== "https") return undefined;
  try {
    if (isLocalHost(new URL(raw).hostname)) return "local";
  } catch {
    return undefined;
  }
  return scheme === "http" ? "http" : undefined;
}

function at(input: EmailInput, line: number): string {
  return `${input.file}:${line}`;
}

export const emailRelativeLink = defineCheck<EmailInput>({
  id: "email-relative-link",
  size: "S",
  done: "Every link in the email is a full https:// address on your live site, and the re-exported file shows it.",
  estimateChanges:
    "One site address missing from the email build is a single setting. Links typed into a template by hand are edited one by one.",
  area: "Sales & prices",
  severity: "high",
  title: "A link in an email only works on the developer's computer",
  what: "A link in a rendered email is a relative path such as /orders/1001, or points at localhost or another address that only a computer on your own network can open.",
  why: "An inbox has no website to resolve a relative path against, and a customer cannot open your laptop. The button they need most (view my order, confirm my booking) does nothing, in every inbox.",
  fix: "Build the email with the site's full public address, https://example.com/orders/1001, taken from a setting your production build sets, then export the emails again.",
  tech: "a[href] in the rendered HTML with no scheme (a path, ../path or //host), or an http(s) address on localhost, *.localhost, *.local, 0.0.0.0, ::1, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or 169.254.0.0/16, after a tracking wrapper with a known pattern is unwrapped; an anchor, a mailto: or tel: link, another scheme and a template variable are not read here; the address is shown without its query, which can hold a customer's token; one finding for each email, at the first line",
  run(input) {
    const bad = input.links.flatMap((l) => {
      const kind = badHref(l.href);
      return kind === undefined ? [] : [{ line: l.line, kind, text: shown(l.href) }];
    });
    const first = bad[0];
    if (first === undefined) return [];
    const local = bad.filter((b) => b.kind === "local").length;
    const relative = bad.length - local;
    const parts = [
      ...(relative > 0 ? [noun(relative, "relative link", "relative links")] : []),
      ...(local > 0
        ? [
            noun(
              local,
              "link to this computer or a private network",
              "links to this computer or a private network",
            ),
          ]
        : []),
    ];
    return [
      {
        checkId: "email-relative-link",
        severity: "high",
        title: this.title,
        evidence: `${at(input, first.line)} ${parts.join(" and ")}: ${listLines(bad)}`,
        url: input.file,
        source: { file: input.file, line: first.line },
      },
    ];
  },
});

export const emailPreviewPlaceholder = defineCheck<EmailInput>({
  id: "email-preview-placeholder",
  size: "S",
  done: "The re-exported email has a real value wherever the template has a variable, and no placeholder is left in the HTML or the text version.",
  estimateChanges:
    "A variable the email build never receives is one fix. A template that renders before its data arrives needs the render moved.",
  area: "Sales & prices",
  severity: "medium",
  title: "An email still has template variables in it",
  what: "A rendered email still holds a variable that was never filled in, such as {{order_id}}, {% if paid %}, {name} or [object Object].",
  why: 'The customer reads "Order {{order_id}} is confirmed" or "Hi undefined", which looks broken and hides the one detail (which order, which booking) they opened the email for.',
  fix: "Pass the missing value to the template, or delete the variable. For a preview that was exported before the data was merged, export the email from the real send path or with sample data.",
  tech: "Handlebars and Mustache {{ }} and {{{ }}}, Liquid {% %}, ERB and EJS <% %>, JavaScript ${ }, JSX and message {name} and {props.name}, [object Object], Mailchimp *|MERGE|* tags, undefined and NaN as words, and null alone or after a greeting; read in the text a recipient sees and in attributes (style and script bodies and comments are left out, JSON-LD is not), and in the .txt beside it; one finding for each file, at the first line",
  run(input) {
    const byFile = new Map<string, EmailPlaceholder[]>();
    for (const p of input.placeholders) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
    const out: Finding[] = [];
    for (const [file, found] of byFile) {
      const first = found[0];
      if (first === undefined) continue;
      out.push({
        checkId: "email-preview-placeholder",
        severity: "medium",
        title: this.title,
        evidence: `${file}:${first.line} ${noun(found.length, "placeholder", "placeholders")} left in: ${listLines(found.map((f) => ({ line: f.line, text: escapeInvisible(f.text, 60) })))}`,
        url: file,
        source: { file, line: first.line },
      });
    }
    return out;
  },
});

export const emailNoTextPart = defineCheck<EmailInput>({
  id: "email-no-text-part",
  size: "S",
  done: "Each .html email has a .txt with the same name beside it, and the export writes both.",
  estimateChanges:
    "Most email tools export a plain-text version with one option. A hand-written template needs the text written.",
  area: "Security & email",
  severity: "low",
  title: "An email has no plain-text version",
  what: "An .html email has no .txt file with the same name beside it, and gaugeline.emails.json says every email should have one.",
  why: "A message with only an HTML part is more likely to be treated as bulk mail, and anyone whose mail client shows text only, or reads aloud, gets nothing.",
  fix: "Export or write the plain-text version (order.html and order.txt), and send both as one multipart message.",
  tech: 'only when gaugeline.emails.json sets "textVersion": true; an .html or .htm email with no .txt of the same name in the same folder (order.es.html wants order.es.txt); without that setting the check says it could not run and passes nothing',
  run(input, ctx) {
    if (!input.textExpected) {
      ctx.couldNotCheck?.(
        input.file,
        'gaugeline.emails.json does not say a text version is expected (set "textVersion": true)',
      );
      return [];
    }
    if (input.hasTextPart) return [];
    return [
      {
        checkId: "email-no-text-part",
        severity: "low",
        title: this.title,
        evidence: `${input.file} has no ${escapeInvisible(input.file.replace(/\.html?$/i, ".txt"), 120)} beside it`,
        url: input.file,
        source: { file: input.file, line: 1 },
      },
    ];
  },
});

export const emailImageNotAbsolute = defineCheck<EmailInput>({
  id: "email-image-not-absolute",
  size: "S",
  done: "Every image in the email is an https:// address on a public host, or travels inside the message (cid:).",
  estimateChanges:
    "Images served from one setting are a single change. Images pasted in by hand are edited one by one.",
  area: "Security & email",
  severity: "medium",
  title: "An image in an email will not load in an inbox",
  what: "An image in a rendered email is on a relative path, on localhost or a private address, or on plain http://.",
  why: "A relative or local image is a broken box in every inbox, and many mail apps block or warn about plain http images, so the logo or the product photo is missing exactly where the customer is looking.",
  fix: "Serve the images from your live site over https and write their full addresses into the email (https://example.com/mail/logo.png), or attach them inline.",
  tech: "img[src] in the rendered HTML with no scheme, with http:, or with an http(s) address on a local or private host (the list is the one email-relative-link uses); cid: and data: images are not read; the address is shown without its query; one finding for each email, at the first line",
  run(input) {
    const bad = input.images.flatMap((img) => {
      const kind = badImage(img.src);
      return kind === undefined ? [] : [{ line: img.line, kind, text: shown(img.src) }];
    });
    const first = bad[0];
    if (first === undefined) return [];
    return [
      {
        checkId: "email-image-not-absolute",
        severity: "medium",
        title: this.title,
        evidence: `${at(input, first.line)} ${noun(bad.length, "image", "images")} will not load: ${listLines(bad.map((b) => ({ line: b.line, text: `${b.text} (${b.kind === "relative" ? "relative path" : b.kind === "local" ? "private address" : "http"})` })))}`,
        url: input.file,
        source: { file: input.file, line: first.line },
      },
    ];
  },
});

/** The four checks of `gaugeline emails`, in report order. */
export const EMAIL_CHECKS: readonly Check<EmailInput>[] = [
  emailRelativeLink,
  emailPreviewPlaceholder,
  emailNoTextPart,
  emailImageNotAbsolute,
];

export function createEmailRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of EMAIL_CHECKS) registry.register(c);
  return registry;
}

/**
 * The page checks that also run on each email, by the number of the branch that made them: links
 * (G10) and images (G10a), payment details (N05), facts (X23) and language parity (N03). An email
 * is read as a page whose address is its file.
 */
export const EMAIL_PAGE_CHECKS: readonly string[] = Object.freeze([
  "broken-links",
  "links-via-redirect",
  "images-broken",
  "payment-handle-mismatch",
  "payment-handle-unknown",
  "payment-handle-inconsistent",
  "payment-link-dead",
  "facts-match",
  "facts-present",
  "facts-payment-link",
  "lang-twin-missing",
  "lang-attr-mismatch",
  "lang-price-mismatch",
  "lang-untranslated",
]);

/** Of those, the ones that ask the network, so they run only with --base. */
export const EMAIL_NETWORK_CHECKS: readonly string[] = Object.freeze([
  "broken-links",
  "links-via-redirect",
  "images-broken",
  "payment-link-dead",
]);
