import { jsonLdNodes, type PageButton, type PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/**
 * What the three paid-file checks share. Everything here reads the page snapshot and nothing else:
 * no request is made, so the same page always gives the same findings. The link on the page is the
 * evidence. The file itself is never asked for.
 */

// ---- the file --------------------------------------------------------------------------------

/** The file types people sell. Images are not here on purpose. A Set: one lookup per link. */
const SELLABLE: ReadonlySet<string> = new Set(["pdf", "zip", "epub", "mp3", "mp4", "docx", "xlsx"]);

/** A path rule: does this path on a store's host hold a public file? */
type PathRule = (path: string) => boolean;
const anyPath: PathRule = () => true;

/**
 * Stores whose host is one fixed name. A Map from host to its path rule, so a host that only ends
 * with the same letters ("notcdn.sanity.io.example") finds nothing.
 */
const EXACT_HOSTS: ReadonlyMap<string, PathRule> = new Map([
  ["cdn.sanity.io", (p: string) => p.startsWith("/files/")],
  ["storage.googleapis.com", anyPath],
  ["firebasestorage.googleapis.com", anyPath],
  ["res.cloudinary.com", (p: string) => p.includes("/upload/")],
  ["utfs.io", anyPath],
  ["ucarecdn.com", anyPath],
]);

/** Stores that give each customer a subdomain: a bucket, a project, an account. Matched on a label boundary. */
const HOST_SUFFIXES: readonly { suffix: string; path: PathRule }[] = [
  { suffix: ".storage.googleapis.com", path: anyPath },
  { suffix: ".blob.core.windows.net", path: anyPath },
  { suffix: ".r2.dev", path: anyPath },
  { suffix: ".digitaloceanspaces.com", path: anyPath },
  { suffix: ".backblazeb2.com", path: anyPath },
  { suffix: ".public.blob.vercel-storage.com", path: anyPath },
  { suffix: ".ufs.sh", path: anyPath },
  { suffix: ".ucarecdn.com", path: anyPath },
  { suffix: ".supabase.co", path: (p) => p.startsWith("/storage/v1/object/public/") },
];

/** Amazon S3 in every spelling: bucket.s3.amazonaws.com, s3.eu-west-2.amazonaws.com, bucket.s3-eu-west-2.amazonaws.com. */
const S3_HOST = /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/;

function parse(address: string): URL | undefined {
  try {
    const u = new URL(address);
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
}

function fileType(pathname: string): string | undefined {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // keep the path as written
  }
  return /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
}

/**
 * Is this address a downloadable file (pdf, zip, epub, mp3, mp4, docx, xlsx) on a public asset
 * store: Sanity's file CDN, a storage bucket, or a common upload CDN? The query string and the
 * fragment are not read. An address on the site's own domain is not a store, and neither is a
 * relative one.
 */
export function isAssetStoreFile(address: string): boolean {
  const u = parse(address);
  if (!u) return false;
  const type = fileType(u.pathname);
  if (type === undefined || !SELLABLE.has(type)) return false;
  const host = u.hostname.replace(/\.$/, "");
  const exact = EXACT_HOSTS.get(host);
  if (exact) return exact(u.pathname);
  if (S3_HOST.test(host)) return true;
  return HOST_SUFFIXES.some((s) => host.endsWith(s.suffix) && s.path(u.pathname));
}

/** Names of the parameters that say when a signed address stops working, and that carry the signature, lower case. */
const EXPIRY_PARAMS: ReadonlySet<string> = new Set([
  "expires",
  "x-amz-expires",
  "x-goog-expires",
  "expiry",
  "expires-at",
  "exp",
  "se",
]);
const SIGNATURE_PARAMS: ReadonlySet<string> = new Set([
  "signature",
  "sig",
  "x-amz-signature",
  "x-goog-signature",
]);

/**
 * A signed address with an expiry: CloudFront (Expires and Signature), S3 (X-Amz-Expires and
 * X-Amz-Signature), Google Cloud Storage (X-Goog-Expires and X-Goog-Signature), Azure (se and sig).
 * It needs both, with a value: an expiry nobody signed protects nothing. Gaugeline does not read
 * the clock, so it cannot say whether the expiry has passed.
 */
export function isSignedLink(address: string): boolean {
  const u = parse(address);
  if (!u) return false;
  let expiry = false;
  let signature = false;
  for (const [name, value] of u.searchParams) {
    if (value.trim() === "") continue;
    const key = name.toLowerCase();
    if (EXPIRY_PARAMS.has(key)) expiry = true;
    if (SIGNATURE_PARAMS.has(key)) signature = true;
  }
  return expiry && signature;
}

/** What a report prints for a file: its host and path, with no query string (it may carry a signature) and no fragment. */
export function publicFileAddress(address: string): string {
  const u = parse(address);
  if (!u) return escapeInvisible(address.split(/[?#]/)[0] ?? "", 160);
  return escapeInvisible(`${u.host}${u.pathname}`, 160);
}

/** Link text that says the file is a legal page, not a product. */
const LEGAL_TEXT = /\b(?:terms|privacy|polic(?:y|ies))\b/i;

/** One distinct file a page links to on a public asset store. */
export interface PublicFile {
  /** Its host and path, as printed. */
  address: string;
  /** The text of every link to it, in document order. */
  texts: string[];
  /** Every link to it says terms, privacy or policy. */
  legalOnly: boolean;
}

/**
 * The files the page links to on public asset stores, once each, in document order. A signed
 * address with an expiry is left out: it is not a world-readable address.
 */
export function publicFiles(page: PageSnapshot): PublicFile[] {
  const byAddress = new Map<string, PublicFile>();
  for (const link of page.links) {
    if (!isAssetStoreFile(link.href) || isSignedLink(link.href)) continue;
    const address = publicFileAddress(link.href);
    const known = byAddress.get(address);
    if (known) {
      known.texts.push(link.text);
      known.legalOnly = known.legalOnly && LEGAL_TEXT.test(link.text);
    } else {
      byAddress.set(address, {
        address,
        texts: [link.text],
        legalOnly: LEGAL_TEXT.test(link.text),
      });
    }
  }
  return [...byAddress.values()];
}

// ---- the price -------------------------------------------------------------------------------

const SYMBOLS = String.raw`[$\u20AC\u00A3\u00A5\u20B9]`;
const CODES = "USD|EUR|GBP|CAD|AUD|NZD|JPY|CHF|SEK|NOK|DKK|MXN|INR|BRL|ZAR";
/** 48, 9.50, 1,200 or 48,00: the whole part, then up to two decimals. Not followed by another digit. */
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d{1,2}))?(?!\d)`;
/** A symbol or a code, then the number: "$48", "from 9.50 with a pound sign", "USD 12". */
const BEFORE = new RegExp(String.raw`(?:${SYMBOLS}|\b(?:${CODES})\b)\s?${NUMBER}`, "gu");
/** The number, then a symbol or a code: "48 USD", "48,00 with a euro sign". */
const AFTER = new RegExp(String.raw`(?<![\d.,])${NUMBER}\s?(?:${SYMBOLS}|\b(?:${CODES})\b)`, "gu");

/** Is any digit of the amount not zero? "$0" and "0.00 USD" are not prices. */
const isAmount = (whole: string | undefined, cents: string | undefined): boolean =>
  /[1-9]/.test(`${whole ?? ""}${cents ?? ""}`);

function textPrice(text: string): boolean {
  for (const re of [BEFORE, AFTER]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) if (isAmount(m[1], m[2])) return true;
  }
  return false;
}

/** A price field of an Offer: a number, or a string such as "48.00" or "1,200". Above zero. */
function positive(value: unknown): boolean {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[,\s]/g, ""))
        : Number.NaN;
  return Number.isFinite(n) && n > 0;
}

const OFFER_TYPE = /^(?:Offer|AggregateOffer)$/;

/** Walk a parsed JSON-LD value for an Offer (or whatever sits under "offers") with a price above zero. */
function offerHasPrice(value: unknown, inOffer: boolean, depth: number): boolean {
  if (depth > 12 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => offerHasPrice(v, inOffer, depth + 1));
  const o = value as Record<string, unknown>;
  const types = Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]];
  const offer =
    inOffer ||
    types.some((t) => typeof t === "string" && OFFER_TYPE.test(t.replace(/^.*[/#]/, "")));
  if (offer) {
    if (positive(o["price"]) || positive(o["lowPrice"])) return true;
    const spec = o["priceSpecification"];
    for (const s of Array.isArray(spec) ? spec : [spec]) {
      if (s !== null && typeof s === "object" && positive((s as Record<string, unknown>)["price"]))
        return true;
    }
  }
  return Object.entries(o).some(([key, v]) =>
    offerHasPrice(v, key === "offers" || key === "offer", depth + 1),
  );
}

/**
 * Does the page show a price? A currency symbol or code next to a number in the text a visitor can
 * read ("$48", "48 USD", a pound or euro sign beside a number), or an Offer with a price above zero in the
 * structured data. A phone number or a year has no currency beside it. Codes are read in capitals.
 */
export function showsPrice(page: PageSnapshot): boolean {
  if (textPrice(page.visibleText ?? "")) return true;
  return jsonLdNodes(page).some((node) => offerHasPrice(node, false, 0));
}

// ---- the buy button --------------------------------------------------------------------------

/** What a buy button says. The word has to stand alone: "Forget it" and "Buyer's guide" are not buttons. */
const BUY_TEXT = /\b(?:buy|add to (?:cart|bag|basket)|checkout|get it|purchase|download now)\b/i;
/** A longer text is a card or a paragraph that happens to be a link, not a button. */
const BUTTON_TEXT_MAX = 60;

/** A button, or a link, that says to buy, and whether anything behind it can be linked to. */
export interface BuyButton {
  kind: PageButton["kind"];
  text: string;
  /** An anchor with a real address, or a submit button inside a form that has an action. */
  linkable: boolean;
  /** What it is, in a few words, for the evidence. */
  how: string;
}

/** An address that goes somewhere: not empty, not "#", not a script, an email or a phone number. */
function hasAddress(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v !== "" && !/^(?:#|javascript:|mailto:|tel:|data:)/i.test(v);
}

function describe(b: PageButton): { linkable: boolean; how: string } {
  if (b.kind === "a")
    return hasAddress(b.href)
      ? { linkable: true, how: "a link" }
      : { linkable: false, how: "a link with no address" };
  if (b.kind === "other")
    return {
      linkable: false,
      how: b.onclick ? "an element with a click handler" : "an element marked as a button",
    };
  if (!b.form) return { linkable: false, how: "a button that is not in a form" };
  const submits = b.type === "submit" || b.type === "image";
  if (!submits) return { linkable: false, how: "a button that does not submit its form" };
  return hasAddress(b.formAction) || hasAddress(b.form.action)
    ? { linkable: true, how: "a submit button in a form with an address" }
    : { linkable: false, how: "a button in a form with no action" };
}

/**
 * The buttons and links whose text says buy, add to cart, checkout, get it, purchase or download
 * now, in document order, each marked linkable or not. Hidden elements are not in the snapshot's
 * list. The words are English.
 */
export function buyButtons(page: PageSnapshot): BuyButton[] {
  const out: BuyButton[] = [];
  for (const b of page.buttons ?? []) {
    const text = b.text.trim();
    if (text === "" || text.length > BUTTON_TEXT_MAX || !BUY_TEXT.test(text)) continue;
    out.push({ kind: b.kind, text, ...describe(b) });
  }
  return out;
}

/** Hosted payment pages: a link to one is something to link to, whatever its text says. */
const PAYMENT_HOSTS: ReadonlySet<string> = new Set([
  "buy.stripe.com",
  "checkout.stripe.com",
  "square.link",
  "checkout.square.site",
  "paypal.me",
]);

/** Does the page link to a hosted payment page (a Stripe payment link, a Square link, PayPal.me)? */
export function linksToPaymentPage(page: PageSnapshot): boolean {
  return page.links.some((l) => {
    const u = parse(l.href);
    return u !== undefined && PAYMENT_HOSTS.has(u.hostname.replace(/\.$/, ""));
  });
}
