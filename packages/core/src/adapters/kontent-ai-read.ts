import type { Fetcher } from "../fetcher.js";
import { type PartialRead } from "./collect.js";
import type { KontentAdapter, KontentUnpublishedRead } from "./kontent-ai.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "./types.js";
import { askPage, bare, type PageRead } from "./webflow-read.js";

/** One unpublished item's page and how the live site answered for it. */
export type KontentPageRead = PageRead & { step: string };

/**
 * What the Kontent.ai check needs, read once: which items the Preview API lists that the Delivery API does not, and
 * how the live site answered for the page each of them would have. Ids, types, slugs, workflow steps, addresses and
 * statuses only: never a name or an element.
 */
export interface KontentReading {
  /** The origin of the live site that was asked. */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Without it nothing is asked. */
  ownerConsent: boolean;
  /** The settings say (`readPreview`) the Preview API may be read. Without it nothing is asked. */
  previewAllowed: boolean;
  /** The settings give an address pattern (`urls`) for no type, so no page could be asked about: could-not-check, not a pass. */
  nothingNamed: boolean;
  /** What the two lists showed. Absent when nothing was asked. */
  read?: KontentUnpublishedRead;
  pages: KontentPageRead[];
  /** Unpublished items whose page was not asked, and why (no slug, the address is shared with a published item, or another site's). */
  unaddressed: { type: string; id: string; reason: string }[];
  /** Present when a rate limit stopped the read: what is listed is not everything. */
  partial?: PartialRead;
}

export interface ReadKontentOptions {
  adapter: KontentAdapter;
  /** The fetcher for the live site's own pages (the adapter has its own for Kontent.ai). */
  fetcher: Fetcher;
  /** The address of the live site being checked, such as https://fernhill-cycles.example. */
  site: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Default: no. */
  ownerConsent?: boolean;
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
 * Read a Kontent.ai project for the preview check. Only with the owner's consent (CLAUDE.md rule 14), only when the
 * settings say `readPreview: true`, and only for the types the settings give an address pattern for: the Delivery and
 * Preview lists as ids, types, slugs and steps, and for each unpublished item the settings give an address for, one GET
 * of that page on the live site. A list Kontent.ai will not give is recorded with its reason; a rate limit that stays
 * ends the read and marks it partial.
 */
export async function readKontent(options: ReadKontentOptions): Promise<KontentReading> {
  const { adapter, fetcher } = options;
  const origin = new URL(options.site).origin;
  const reading: KontentReading = {
    site: origin,
    ownerConsent: options.ownerConsent === true,
    previewAllowed: adapter.readPreviewAllowed(),
    nothingNamed: adapter.patternTypes().length === 0,
    pages: [],
    unaddressed: [],
  };
  // Nothing is asked without the owner's consent, without the settings entry, or when there is nothing to ask about.
  if (!reading.ownerConsent || !reading.previewAllowed || reading.nothingNamed) return reading;
  try {
    reading.read = await adapter.unpublishedReading();
  } catch (err) {
    if (err instanceof AdapterRateLimitedError) {
      reading.partial = {
        reason: "rate-limited",
        ...(err.retry !== undefined ? { retry: err.retry } : {}),
        delivered: 0,
      };
      return reading;
    }
    if (!(err instanceof AdapterCouldNotCheck)) throw err;
    reading.read = {
      state: "unread",
      published: 0,
      entries: [],
      unlisted: 0,
      withoutPattern: [],
      unclear: 0,
      sharedSlugs: [],
      reason: err.reason,
    };
  }
  const read = reading.read;
  if (read.state !== "read") return reading;

  const todo: Omit<KontentPageRead, "answer">[] = [];
  for (const e of read.entries) {
    if (
      e.slug !== undefined &&
      read.sharedSlugs.some((s) => s.type === e.type && s.slug === e.slug)
    ) {
      reading.unaddressed.push({
        type: e.type,
        id: e.id,
        reason:
          "its address is the same as a published item's, so a live page there says nothing about this one",
      });
      continue;
    }
    const given = adapter.resolveUrl?.({
      id: e.id,
      type: e.type,
      ...(e.slug !== undefined ? { slug: e.slug } : {}),
    });
    if (given === undefined || given === "") {
      reading.unaddressed.push({
        type: e.type,
        id: e.id,
        reason: "it has no slug and the settings give no address for it",
      });
      continue;
    }
    let url: URL;
    try {
      url = new URL(given, origin);
    } catch {
      reading.unaddressed.push({ type: e.type, id: e.id, reason: "its address is not one" });
      continue;
    }
    if (bare(url.host) !== bare(new URL(origin).host)) {
      reading.unaddressed.push({
        type: e.type,
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
        type: e.type,
        id: e.id,
        reason: "its address is not a plain path on the site",
      });
      continue;
    }
    // The address is built again from the checked site's own origin and a path that passed the rules above.
    const at = new URL(url.pathname, origin);
    todo.push({
      id: e.id,
      type: e.type,
      step: e.step,
      ...(e.slug !== undefined ? { slug: e.slug } : {}),
      url: at.href,
      path: at.pathname,
    });
  }
  // The adapter already holds the list to its page budget, so every address in it is asked.
  reading.pages = await Promise.all(
    todo.map(async (p): Promise<KontentPageRead> => ({
      ...p,
      answer: await askPage(fetcher, p.url, { sameAddress: true }),
    })),
  );
  return reading;
}
