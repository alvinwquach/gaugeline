import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { placeholderText } from "../checks/placeholder-text.js";
import { NetworkError } from "../errors.js";
import type { Fetcher, Hop } from "../fetcher.js";
import type { Finding } from "../model.js";
import { formatMoney } from "../products/money.js";
import { classifyHop, describeRefusal } from "../refusal.js";
import { sanitiseFinding } from "../runner.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import { spendByCurrency, type Destination } from "./export.js";
import { withoutQuery, type TagProbe } from "./tags.js";

/**
 * What the ads command says about the landing pages it already asked for. Everything here reads the
 * hops that ads/check.ts recorded (one GET per destination), so a page is never fetched twice. The
 * one request this file makes is the stock read of a Shopify product (readStock): the product's own
 * public endpoint, GET, through the run's fetcher, once per product page.
 */

// ---- is the page there ----------------------------------------------------------------------------

/** What a landing page's answer was. */
export type Landing =
  /** The visitor gets a page (a 2xx or a redirect that went nowhere, read as it is). */
  | { kind: "loads"; hop: Hop }
  /** The visitor gets an error, or nothing. */
  | { kind: "dead"; why: string; status?: number }
  /** Gaugeline could not tell: a site that refuses automated readers, a password page, an address it will not ask for. */
  | { kind: "unreadable"; why: string };

const NOT_ASKED = new Set(["private-address-refused", "blocked-address"]);

/** A Shopify storefront that is closed with a password answers with this form (and sends visitors to /password). */
const PASSWORD_FORM = /value\s*=\s*["']storefront_password["']/i;

function isPasswordPage(hop: Hop): boolean {
  let path = "";
  try {
    path = new URL(hop.url).pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    path = "";
  }
  return path === "/password" || PASSWORD_FORM.test(hop.body ?? "");
}

/**
 * The verdict on one landing page, from the hops alone. A 4xx or 5xx at the end, or a request that
 * failed, is dead. A refusal (401, 403, 429, a bot challenge), a closed storefront and an address
 * Gaugeline will not ask for are unreadable: the site may be fine, so they are never called dead.
 */
export function classifyLanding(probe: TagProbe): Landing {
  const last = probe.hops.at(-1);
  if (last?.error === "private-address-refused" || NOT_ASKED.has(probe.errorReason ?? ""))
    return {
      kind: "unreadable",
      why: "it is not a public address, so Gaugeline did not ask for it (--allow-private allows it)",
    };
  if (probe.error !== undefined || last === undefined)
    return { kind: "dead", why: probe.error ?? "there was no answer", ...statusOf(last) };
  const refusal = classifyHop(last);
  if (refusal.kind === "refused")
    return { kind: "unreadable", why: `the site ${describeRefusal(refusal)}` };
  if (last.status >= 400)
    return { kind: "dead", why: `it answers ${last.status}`, status: last.status };
  if (isPasswordPage(last))
    return {
      kind: "unreadable",
      why: "the store is closed with a password, so its pages cannot be read",
    };
  return { kind: "loads", hop: last };
}

const statusOf = (hop: Hop | undefined): { status?: number } =>
  hop === undefined ? {} : { status: hop.status };

/** An address from the checked site for one line of evidence: no query, escaped, cut. */
export const shown = (address: string, max = 120): string =>
  escapeInvisible(withoutQuery(address), max);

/** "3 ads send people to this page, with 150.75 USD spent on it." */
export function adsLine(probe: TagProbe): string {
  const money = probe.spend.map((s) => formatMoney({ amount: s.amount, currency: s.currency }));
  return `${probe.ads} ${probe.ads === 1 ? "ad sends" : "ads send"} people to this page${money.length > 0 ? `, with ${money.join(" + ")} spent on it` : ""}.`;
}

/** The page of a deeper address that ended on the same site's home page: the ad no longer lands where it was written to. */
export function endsAtHomePage(probe: TagProbe): Hop | undefined {
  const landing = classifyLanding(probe);
  if (landing.kind !== "loads" || probe.hops.length < 2) return undefined;
  if (landing.hop.status < 200 || landing.hop.status >= 300) return undefined;
  try {
    const from = new URL(probe.url);
    const to = new URL(landing.hop.url);
    const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
    const home = (u: URL) => u.pathname.replace(/\/+$/, "") === "";
    return host(from) === host(to) && !home(from) && home(to) ? landing.hop : undefined;
  } catch {
    return undefined;
  }
}

// ---- Shopify stock --------------------------------------------------------------------------------

/**
 * What a Shopify storefront puts in its pages: its content network, its script object, the
 * checkout and wallet meta tags. One is enough; a page with none is not read as Shopify, however it
 * is named. (Not taken from Shopify's documentation, which could not be reached: see the PR.)
 */
const SHOPIFY_MARKERS =
  /cdn\.shopify\.com|\bwindow\.Shopify\b|\bShopify\.(?:shop|theme|routes|currency)\b|name\s*=\s*["']shopify-(?:checkout-api-token|digital-wallet)["']|[a-z0-9-]+\.myshopify\.com/i;

const HANDLE = /^[A-Za-z0-9_%-]+$/;

export interface ProductPage {
  handle: string;
  /** The product's public endpoint: /products/<handle>.js on the host the visitor ended on. */
  endpoint: string;
}

const snapshots = new WeakMap<TagProbe, PageSnapshot>();
/** The page the visitor ends on, parsed once for every check that reads it. */
export function snapshotOf(probe: TagProbe): PageSnapshot {
  let snap = snapshots.get(probe);
  if (snap === undefined) {
    snap = buildSnapshot(probe.hops);
    snapshots.set(probe, snap);
  }
  return snap;
}

/**
 * The product a landing page shows, when it is a Shopify product page: its address ends
 * /products/<handle> (a language folder or a collection may come before) and its HTML carries
 * Shopify's markers. Anything else, including a page under /products/ on another platform, is
 * undefined, and nothing is asked for.
 */
export function shopifyProduct(probe: TagProbe): ProductPage | undefined {
  const landing = classifyLanding(probe);
  if (landing.kind !== "loads") return undefined;
  const { hop } = landing;
  if (hop.status < 200 || hop.status >= 300) return undefined;
  if (!/html/i.test(hop.headers["content-type"] ?? "text/html")) return undefined;
  if (!SHOPIFY_MARKERS.test(hop.body ?? "")) return undefined;
  let url: URL;
  try {
    url = new URL(hop.url);
  } catch {
    return undefined;
  }
  const parts = url.pathname.replace(/\/+$/, "").split("/");
  const handle = parts.at(-1);
  if (parts.length < 3 || parts.at(-2) !== "products" || handle === undefined) return undefined;
  if (!HANDLE.test(handle)) return undefined;
  try {
    // A percent-encoded slash, dot or the like is not a handle: it would change the path we ask for.
    if (!/^[^/.\\?#]+$/.test(decodeURIComponent(handle))) return undefined;
  } catch {
    return undefined;
  }
  return { handle, endpoint: `${url.origin}/products/${handle}.js` };
}

export type Availability =
  /** No variant can be bought. */
  | { kind: "sold-out"; variants: number; names: string[] }
  /** Some can, some cannot: the ones that cannot. */
  | { kind: "partial"; variants: number; unavailable: string[] }
  | { kind: "in-stock"; variants: number }
  /** The answer did not say (not the endpoint, no variants, a variant without the flag). */
  | { kind: "unknown"; why: string };

const unknown = (why: string): Availability => ({ kind: "unknown", why });

/**
 * Availability from the text of a product endpoint (/products/<handle>.js): its `variants`, each
 * with a boolean `available`. Sold out means every variant says false. An empty list, a variant
 * that does not say, or anything that is not that JSON is unknown, and unknown is never a finding.
 */
export function parseAvailability(text: string): Availability {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return unknown("the answer is not the product's data");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return unknown("the answer is not the product's data");
  const variants = (data as { variants?: unknown }).variants;
  if (!Array.isArray(variants)) return unknown("the answer lists no variants");
  if (variants.length === 0) return unknown("the product has no variants listed");
  const named: { name: string; available: boolean }[] = [];
  for (const v of variants) {
    if (typeof v !== "object" || v === null) return unknown("a variant is not readable");
    const { available, title, id } = v as { available?: unknown; title?: unknown; id?: unknown };
    if (typeof available !== "boolean")
      return unknown("a variant does not say if it can be bought");
    const name =
      typeof title === "string" && title.trim() !== ""
        ? title.trim()
        : typeof id === "number" || typeof id === "string"
          ? `variant ${String(id)}`
          : "an unnamed variant";
    named.push({ name, available });
  }
  const gone = named.filter((v) => !v.available).map((v) => v.name);
  if (gone.length === named.length)
    return { kind: "sold-out", variants: named.length, names: gone };
  if (gone.length > 0) return { kind: "partial", variants: named.length, unavailable: gone };
  return { kind: "in-stock", variants: named.length };
}

export type StockRead =
  | { kind: "read"; handle: string; availability: Exclude<Availability, { kind: "unknown" }> }
  | { kind: "unreadable"; handle: string; why: string };

async function readOne(product: ProductPage, fetcher: Fetcher): Promise<StockRead> {
  const { handle } = product;
  let hops: Hop[];
  try {
    hops = await fetcher.get(product.endpoint);
  } catch (err) {
    if (err instanceof NetworkError)
      return { kind: "unreadable", handle, why: "the product endpoint could not be reached" };
    throw err;
  }
  const last = hops.at(-1);
  if (last === undefined)
    return { kind: "unreadable", handle, why: "the product endpoint did not answer" };
  if (last.status !== 200)
    return { kind: "unreadable", handle, why: `the product endpoint answered ${last.status}` };
  const availability = parseAvailability(last.body ?? "");
  if (availability.kind === "unknown")
    return {
      kind: "unreadable",
      handle,
      why: `the product endpoint's answer is unusable: ${availability.why}`,
    };
  return { kind: "read", handle, availability };
}

/**
 * One GET of the product endpoint for each landing page that is a Shopify product page, keyed by
 * the destination. No key, no login: the endpoint is the one the storefront's own pages use.
 * The fetcher shares an answer between two asks for one address, so two destinations that end on
 * one product read it once.
 */
export async function readStock(
  probes: readonly TagProbe[],
  fetcher: Fetcher,
): Promise<Map<string, StockRead>> {
  const asked = probes.flatMap((p) => {
    const product = shopifyProduct(p);
    return product === undefined ? [] : [{ url: p.url, product }];
  });
  const reads = await Promise.all(asked.map((a) => readOne(a.product, fetcher)));
  return new Map(asked.map((a, i) => [a.url, reads[i] as StockRead]));
}

// ---- sample text ----------------------------------------------------------------------------------

/**
 * The placeholder check of the page checks (placeholder-text), run over the page each destination
 * ends on. Only the address on the finding changes: it names the destination from the export, so
 * the summary can place it, and the evidence adds the ads and the spend behind the page.
 */
export async function placeholderFindings(
  probes: readonly TagProbe[],
): Promise<{ findings: Finding[]; read: number; failed: boolean }> {
  const findings: Finding[] = [];
  let read = 0;
  let failed = false;
  for (const probe of probes) {
    const landing = classifyLanding(probe);
    if (landing.kind !== "loads") continue;
    const page = snapshotOf(probe);
    if (page.status < 200 || page.status >= 300) continue;
    read += 1;
    try {
      const found = await placeholderText.run(page, { warn: () => undefined });
      for (const f of found)
        findings.push(
          sanitiseFinding({ ...f, url: probe.url, evidence: `${f.evidence}. ${adsLine(probe)}` }),
        );
    } catch {
      failed = true;
    }
  }
  return { findings, read, failed };
}

// ---- the summary ----------------------------------------------------------------------------------

export interface DestinationSummary {
  url: string;
  ads: number;
  /** Minor units, in this summary's currency. */
  spend: number;
  /** The ids of the checks that found something on this page, once each. */
  findings: string[];
}

/** The spend of one currency: what was spent, and how much of it went to pages with a finding. */
export interface AdsSummary {
  /** An upper-case ISO 4217 code, or null when the export names none. */
  currency: string | null;
  totalSpend: number;
  spendOnProblemPages: number;
  /** Highest spend on pages with problems first, then highest spend, then by address. */
  byDestination: DestinationSummary[];
}

function add(total: number, amount: number): number {
  const next = total + amount;
  if (!Number.isSafeInteger(next))
    throw new RangeError("The spend in this export is too large to add up exactly.");
  return next;
}

/**
 * Total spend, and the spend on pages with problems, per currency, as integers in minor units. A
 * page has a problem when a finding of high or medium severity names it, however many do; its spend
 * is counted once. A low note (some sizes sold out, an ad that lands on the home page) is listed on
 * the page but does not make it a problem page. Currencies are never added together: each gets its
 * own summary, the main currency first.
 */
export function summarise(
  groups: ReadonlyMap<string, Destination>,
  findings: readonly Pick<Finding, "url" | "checkId" | "severity">[],
): AdsSummary[] {
  const byUrl = new Map<string, { ids: Set<string>; problem: boolean }>();
  for (const f of findings) {
    const entry = byUrl.get(f.url) ?? { ids: new Set<string>(), problem: false };
    entry.ids.add(f.checkId);
    if (f.severity !== "low") entry.problem = true;
    byUrl.set(f.url, entry);
  }
  return spendByCurrency(groups).map((table) => {
    let totalSpend = 0;
    let spendOnProblemPages = 0;
    const problemPages = new Set<string>();
    const byDestination = table.destinations.map((d): DestinationSummary => {
      const entry = byUrl.get(d.url);
      totalSpend = add(totalSpend, d.spend);
      if (entry?.problem) {
        spendOnProblemPages = add(spendOnProblemPages, d.spend);
        problemPages.add(d.url);
      }
      return { url: d.url, ads: d.ads, spend: d.spend, findings: [...(entry?.ids ?? [])] };
    });
    const problem = (d: DestinationSummary) => (problemPages.has(d.url) ? d.spend : 0);
    byDestination.sort(
      (a, b) =>
        problem(b) - problem(a) ||
        b.spend - a.spend ||
        (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
    );
    return { currency: table.currency, totalSpend, spendOnProblemPages, byDestination };
  });
}

/**
 * The line for the report: "<amount> of <total> went to pages with problems." Undefined when no
 * spend did, so a clean export prints nothing under its lines.
 */
export function summarySentence(summary: AdsSummary): string | undefined {
  if (summary.spendOnProblemPages === 0) return undefined;
  const money = (amount: number) => formatMoney({ amount, currency: summary.currency ?? "" });
  return `${money(summary.spendOnProblemPages)} of ${money(summary.totalSpend)} went to pages with problems.`;
}
