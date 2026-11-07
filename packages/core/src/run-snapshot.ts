import { load } from "cheerio/slim";
import type { Severity } from "./model.js";
import { readRegions, type NavEntry } from "./nav/read-regions.js";
import { jsonLdNodes, type PageSnapshot } from "./snapshot.js";
import type { ContentSnapshot } from "./snapshot/page-snapshot.js";

/**
 * What one run remembers about a page, so the next run can say what changed. Hosts, amounts and
 * provider names only: never field values, page text or keys. Keyed maps, so the diff is one
 * pass of "same key, different value" and reordering is not change.
 */
export interface RunSnapshot {
  schema: 1;
  url: string;
  takenAt: string;
  /** Product key ("<sku or name> <currency>") -> price in integer minor units, from JSON-LD offers. */
  prices: Record<string, number>;
  /** Form key -> where it posts. */
  forms: Record<string, { provider: string; actionHost: string }>;
  /**
   * The header and footer menus: region, parent, text, destination, order (nav-changed). Absent
   * in a snapshot written before navigation was saved: nav-changed is then could not check.
   */
  nav?: NavEntry[];
  /**
   * What each page read held, by path (page-lost-content and the other page checks): counts,
   * headings and item addresses, never body text. Absent in a snapshot written before pages were.
   */
  pages?: Record<string, ContentSnapshot>;
}

export const RUN_SNAPSHOT_SCHEMA = 1;

/** Keys are cut to this length: an id is not a place to store anything long. */
const KEY_MAX = 60;

/** "48.00" or 48 -> 4800. Anything else ("1.234,50", "$48", "48.005") is undefined, never guessed. */
export function parseMinorUnits(value: unknown): number | undefined {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string") return undefined;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** Form services, by the host a form posts to. A frozen table; anything else is "unknown". */
const PROVIDERS: readonly [RegExp, string][] = Object.freeze([
  [/(?:^|\.)(?:hsforms\.com|hubspot\.com|hs-sites\.com)$/, "HubSpot"],
  [/(?:^|\.)pardot\.com$/, "Pardot"],
  [/(?:^|\.)formstack\.com$/, "Formstack"],
  [/(?:^|\.)(?:kit\.com|convertkit\.com)$/, "Kit"],
  [/(?:^|\.)beehiiv\.com$/, "beehiiv"],
  [/(?:^|\.)list-manage\.com$/, "Mailchimp"],
  [/(?:^|\.)formspree\.io$/, "Formspree"],
  [/(?:^|\.)typeform\.com$/, "Typeform"],
  [/(?:^|\.)jotform\.com$/, "Jotform"],
  [/(?:^|\.)marketo\.com$/, "Marketo"],
  [/(?:^|\.)klaviyo\.com$/, "Klaviyo"],
  [/^docs\.google\.com$/, "Google Forms"],
] as [RegExp, string][]);

export function providerFor(host: string): string {
  const h = host.toLowerCase();
  return PROVIDERS.find(([re]) => re.test(h))?.[1] ?? "unknown";
}

export function buildRunSnapshot(
  page: PageSnapshot,
  now: () => Date = () => new Date(),
  contents?: Record<string, ContentSnapshot>,
): RunSnapshot {
  const prices: Record<string, number> = {};
  for (const n of jsonLdNodes(page)) {
    const id = typeof n.sku === "string" ? n.sku : typeof n.name === "string" ? n.name : undefined;
    if (!id) continue;
    const offers = Array.isArray(n.offers) ? n.offers : n.offers ? [n.offers] : [];
    for (const o of offers as Record<string, unknown>[]) {
      const amount = parseMinorUnits(o?.price);
      if (amount === undefined) continue;
      const currency = typeof o.priceCurrency === "string" ? o.priceCurrency.toUpperCase() : "";
      const key = `${id.trim().slice(0, KEY_MAX)}${currency ? ` ${currency}` : ""}`;
      if (!(key in prices)) prices[key] = amount;
    }
  }
  const forms: RunSnapshot["forms"] = {};
  const $ = load(page.hops.at(-1)?.body ?? "");
  $("form").each((i, el) => {
    const id = $(el).attr("id")?.trim();
    const name = $(el).attr("name")?.trim();
    const key = id ? `#${id}` : name ? `name:${name}` : `form ${i + 1}`;
    let actionHost: string;
    try {
      actionHost = new URL($(el).attr("action") ?? "", page.finalUrl).hostname;
    } catch {
      return;
    }
    forms[key.slice(0, KEY_MAX)] = { provider: providerFor(actionHost), actionHost };
  });
  const nav = readRegions(page).entries.filter((e) => e.region !== "body");
  return {
    schema: 1,
    url: page.finalUrl,
    takenAt: now().toISOString(),
    prices,
    forms,
    nav,
    ...(contents ? { pages: contents } : {}),
  };
}

export interface SnapshotChange {
  checkId: "price-changed" | "form-provider-changed" | "form-destination-changed";
  severity: Severity;
  evidence: string;
}

const money = (minor: number) =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/** The change one form made between runs, if any: a new provider outranks a new host. */
export function formChanged(
  prev: RunSnapshot["forms"][string],
  next: RunSnapshot["forms"][string],
): SnapshotChange["checkId"] | undefined {
  if (prev.provider !== next.provider) return "form-provider-changed";
  if (prev.actionHost !== next.actionHost) return "form-destination-changed";
  return undefined;
}

/** What changed between two runs of one page. Pure: added or removed keys are not changes. */
export function diffSnapshots(prev: RunSnapshot, next: RunSnapshot): SnapshotChange[] {
  const out: SnapshotChange[] = [];
  for (const [key, amount] of Object.entries(next.prices)) {
    const before = prev.prices[key];
    if (before === undefined || before === amount) continue;
    const space = key.lastIndexOf(" ");
    const [name, currency] = space > 0 ? [key.slice(0, space), key.slice(space + 1)] : [key, ""];
    const unit = currency ? ` ${currency}` : "";
    out.push({
      checkId: "price-changed",
      severity: "low",
      evidence: `${name}: ${money(before)}${unit} last run, ${money(amount)}${unit} now`,
    });
  }
  for (const [key, form] of Object.entries(next.forms)) {
    const before = prev.forms[key];
    if (!before) continue;
    const change = formChanged(before, form);
    if (change === "form-provider-changed")
      out.push({
        checkId: change,
        severity: "high",
        evidence: `${key} posts to ${form.provider} (${form.actionHost}) now; last run it was ${before.provider} (${before.actionHost})`,
      });
    else if (change === "form-destination-changed")
      out.push({
        checkId: change,
        severity: "medium",
        evidence: `${key} posts to ${form.actionHost} now; last run it was ${before.actionHost} (both ${form.provider})`,
      });
  }
  return out;
}
