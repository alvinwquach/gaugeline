import { RENEWAL_CHECK_IDS } from "../renewals/section.js";

/**
 * The five plain-word groups a receipt files a fix under, in the order they are shown. The group is
 * read from the check's id, so a run record (which keeps only the id) is enough. A check that is not
 * listed here (a custom check, a new one) is "Site and content": it is never left out, never guessed
 * to be something it is not.
 */
export const RECEIPT_GROUPS = [
  { id: "booking-payments", name: "Booking and payments" },
  { id: "listings-hours", name: "Listings and hours" },
  { id: "site-content", name: "Site and content" },
  { id: "renewals", name: "Renewals" },
  { id: "security", name: "Security signals" },
] as const;

export type ReceiptGroupId = (typeof RECEIPT_GROUPS)[number]["id"];

/** Words in a check id that make it a security signal: something exposed, loosened or unprotected. */
const SECURITY = new Set([
  "access",
  "csp",
  "secret",
  "spf",
  "dmarc",
  "devtools",
  "introspection",
  "public",
  "private",
  "exposed",
  "reachable",
  "loosened",
  "advisory",
  "supabase",
  "backup",
  "backups",
  "admin",
  "unicode",
  "directive",
  "optimizer",
  "sensitive",
]);
const SECURITY_IDS = new Set([
  // A visitor's details in a log are a privacy leak, not a booking.
  "form-values-in-logs",
  "script-known-bad-host",
  "zero-width-in-text",
  "script-changed",
  "personal-account",
  "route-hidden-not-protected",
  "tracker-in-tag-manager",
  "cutover-mail-changed",
  "cutover-records-changed",
  "cutover-certificate-changed",
  // A webhook address in the source is a secret, not a booking.
  "webhook-url-hardcoded",
  "webhook-signature-compared-plainly",
  "webhook-timestamp-unbounded",
  "webhook-body-read-unsafely",
  "webhook-logs-private-values",
  // An AI provider key in the page, a chat or AI widget nobody listed, and a model route that answers anyone: exposure, not content.
  "ai-endpoint-open",
  "ai-key-in-js",
  "ai-widget-inventory",
  // What a visitor types goes to an AI provider with no notice: a privacy signal, not content.
  "ai-input-no-disclosure",
]);

/** Words that make it a listing, an opening time or an event date. */
const LISTINGS = new Set(["hours", "event", "ics", "quotable"]);

/** Words that make it a booking, a payment, a price, a form or a stock level. */
const BOOKING = new Set([
  "payment",
  "stripe",
  "checkout",
  "webhook",
  "price",
  "prices",
  "printful",
  "squarespace",
  "form",
  "forms",
  "crm",
  "mailto",
  "capacity",
  "switch",
  "sold",
  "unavailable",
  "stock",
  "delivery",
  "gated",
  "paid",
  "subscription",
]);
const BOOKING_ID = /^(plan-(archived|interval|price|trial|missing-on-page)|shopify-product-drift)/;

/** The group a check's findings are filed under. Pure: the same id always gives the same group. */
export function receiptGroupOf(checkId: string): ReceiptGroupId {
  if (RENEWAL_CHECK_IDS.has(checkId)) return "renewals";
  const words = checkId.split("-");
  const has = (set: ReadonlySet<string>) => words.some((w) => set.has(w));
  if (
    SECURITY_IDS.has(checkId) ||
    has(SECURITY) ||
    (words.includes("dev") && ["server", "tools", "build"].some((w) => words.includes(w))) ||
    /^wp-(outdated|users)/.test(checkId) ||
    checkId === "library-with-advisory"
  )
    return "security";
  if (checkId.startsWith("listing-") || has(LISTINGS)) return "listings-hours";
  if (has(BOOKING) || BOOKING_ID.test(checkId)) return "booking-payments";
  return "site-content";
}
