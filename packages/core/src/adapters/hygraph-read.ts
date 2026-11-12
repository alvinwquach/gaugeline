import type { Fetcher } from "../fetcher.js";
import { type PartialRead } from "./collect.js";
import type { HygraphAdapter, UnpublishedRead } from "./hygraph.js";
import { HYGRAPH_LIMITS } from "./hygraph.entry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { askPage, bare, type PageRead } from "./webflow-read.js";

/** One unpublished entry's page and how the live site answered for it. */
export type HygraphPageRead = PageRead;

/**
 * What the Hygraph check needs, read once: for each model the settings name, which entries are in the DRAFT stage
 * and not in the PUBLISHED stage, and how the live site answered for the page each of them would have. Ids, slugs,
 * addresses and statuses only: never a field or a name.
 */
export interface HygraphReading {
  /** The origin of the live site that was asked. */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Without it nothing is asked. */
  ownerConsent: boolean;
  /** The settings say (`readDraftStage`) the DRAFT stage may be read. Without it nothing is asked. */
  draftStageAllowed: boolean;
  /** The settings name no model, so nothing was read: the check is could-not-check, not a pass. */
  nothingNamed: boolean;
  models: UnpublishedRead[];
  pages: HygraphPageRead[];
  /** Unpublished entries whose page was not asked, and why (no address pattern, no slug, the address is shared with a published entry, or another site's). */
  unaddressed: { type: string; id: string; reason: string }[];
  /**
   * Unpublished entries the adapter found and did not hand on (more than the run's cap per model, or an id Gaugeline
   * will not name): never asked, so never a pass. One row per model, with the number.
   */
  unlisted: { type: string; count: number }[];
  /** Unpublished entries with an address that were not asked for, because the page budget was used. */
  pagesSkipped: number;
  pageBudget: number;
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadHygraphOptions {
  adapter: HygraphAdapter;
  /** The same fetcher the adapter uses, or another: it only asks the live site's own pages here. */
  fetcher: Fetcher;
  /** The address of the live site being checked, such as https://pennywhistle-bakehouse.example. */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
  /** Replaces HYGRAPH_LIMITS.pages. For tests. */
  maxPages?: number;
}

/** A path that is one site's own page: a single leading slash, no `//`, no dot segment (written or encoded), no control character. */
function plainPath(path: string): boolean {
  if (path === "" || path.length > 500 || path[0] !== "/" || path.startsWith("//")) return false;
  if (path.includes("\\") || /%(2e|2f|5c|00)/i.test(path) || path.includes("//")) return false;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return !path.split("/").some((s) => s === "." || s === "..");
}

/**
 * Read a Hygraph project for the draft-stage check. Only with the owner's consent (CLAUDE.md rule 14), only when the
 * settings say `readDraftStage: true`, and only for the models the settings name: per model, the PUBLISHED list and
 * the DRAFT list as ids and slugs, and for each unpublished entry the settings give an address for, one GET of that
 * page on the live site. A model Hygraph will not give is recorded with its reason and the others are still read; a
 * rate limit that stays ends the read and marks it partial.
 */
export async function readHygraph(options: ReadHygraphOptions): Promise<HygraphReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const budget = options.maxPages ?? HYGRAPH_LIMITS.pages;
  const reading: HygraphReading = {
    site: origin,
    ownerConsent: options.ownerConsent === true,
    draftStageAllowed: adapter.draftStageAllowed(),
    nothingNamed: adapter.collections().length === 0,
    models: [],
    pages: [],
    unaddressed: [],
    unlisted: [],
    pagesSkipped: 0,
    pageBudget: budget,
  };
  // Nothing is asked without the owner's consent, without the settings entry, or when there is nothing to ask about.
  if (!reading.ownerConsent || !reading.draftStageAllowed || reading.nothingNamed) return reading;
  try {
    reading.models = await adapter.unpublishedReading();
  } catch (err) {
    if (err instanceof AdapterRateLimitedError) {
      const had = Array.isArray(err.partial) ? (err.partial as UnpublishedRead[]) : [];
      reading.models = had;
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: had.length,
      };
    } else if (err instanceof AdapterCouldNotCheck) {
      reading.models = adapter.collections().map((type) => ({
        type,
        state: "unread",
        published: 0,
        unpublished: 0,
        entries: [],
        sharedSlugs: [],
        reason: err.reason,
      }));
    } else throw err;
  }

  const todo: Omit<HygraphPageRead, "answer">[] = [];
  for (const m of reading.models) {
    if (m.state !== "read") continue;
    if (m.unpublished > m.entries.length)
      reading.unlisted.push({ type: m.type, count: m.unpublished - m.entries.length });
    for (const e of m.entries) {
      if (e.slug !== undefined && m.sharedSlugs.includes(e.slug)) {
        reading.unaddressed.push({
          type: m.type,
          id: e.id,
          reason:
            "its address is the same as a published entry's, so a live page there says nothing about this one",
        });
        continue;
      }
      const given = adapter.resolveUrl?.({
        id: e.id,
        type: m.type,
        ...(e.slug !== undefined ? { slug: e.slug } : {}),
      });
      if (given === undefined || given === "") {
        reading.unaddressed.push({
          type: m.type,
          id: e.id,
          reason:
            e.slug === undefined
              ? "it has no slug and the settings give no address for it"
              : "the settings give no urls pattern for its type",
        });
        continue;
      }
      let url: URL;
      try {
        url = new URL(given, origin);
      } catch {
        reading.unaddressed.push({ type: m.type, id: e.id, reason: "its address is not one" });
        continue;
      }
      if (bare(url.host) !== bare(new URL(origin).host)) {
        reading.unaddressed.push({
          type: m.type,
          id: e.id,
          reason: `its address pattern points to another site (${url.host}), which is not the site being checked`,
        });
        continue;
      }
      // The path as written, before the URL parser tidies away a dot segment: `/a/../b` is not a plain path.
      const written =
        /^https?:\/\/[^/?#]*(\/[^?#]*)?$/i.exec(given)?.[1] ?? (given.startsWith("/") ? given : "");
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        !plainPath(written === "" ? "/" : written) ||
        /[?#]/.test(given)
      ) {
        reading.unaddressed.push({
          type: m.type,
          id: e.id,
          reason: "its address is not a plain path on the site",
        });
        continue;
      }
      // The address is built again from the checked site's own origin and a path that passed the rules above.
      const at = new URL(url.pathname, origin);
      todo.push({
        id: e.id,
        type: m.type,
        ...(e.slug !== undefined ? { slug: e.slug } : {}),
        url: at.href,
        path: at.pathname,
      });
    }
  }
  const asked = todo.slice(0, budget);
  reading.pagesSkipped = todo.length - asked.length;
  reading.pages = await Promise.all(
    asked.map(async (p): Promise<HygraphPageRead> => ({
      ...p,
      answer: await askPage(fetcher, p.url, { sameAddress: true }),
    })),
  );
  return reading;
}
