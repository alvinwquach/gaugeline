import { ResponseTooLargeError, getJson, isRecord } from "../connectors/get-json.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { fillUrlTemplate, hashValue } from "./fingerprint.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

import { WEBFLOW_DESCRIPTION } from "./meta.js";
export { WEBFLOW_DESCRIPTION };

export const WEBFLOW_TOKEN = "WEBFLOW_TOKEN";
export const WEBFLOW_SITE_ID = "WEBFLOW_SITE_ID";

/** Webflow's Data API, version 2. */
export const WEBFLOW_API = "https://api.webflow.com/v2";

/** Items asked for in one request: the API's own maximum. */
export const WEBFLOW_PAGE_SIZE = 100;

/** Bounds a run keeps to, in the platform's terms. There are no flags to raise them. */
export const WEBFLOW_LIMITS = {
  /** Items read from one collection. A bigger one is could-not-check, never a count of part of it. */
  itemsPerCollection: 10_000,
} as const;

/**
 * An edit stamped within this long after the publish still counts as the published version: the
 * platform may stamp `lastUpdated` a moment after `lastPublished` when it publishes. Proposed.
 */
export const WEBFLOW_STAGED_TOLERANCE_MS = 2000;

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A Webflow id is a run of letters and digits; anything else never goes into an address. */
const SITE_ID = /^[A-Za-z0-9]{8,64}$/;

export interface WebflowCollection {
  id: string;
  /** The collection's slug, which is the type name everywhere else. */
  slug: string;
}

/**
 * Where an item stands, from the staged list alone:
 * - `archived`: taken down on purpose.
 * - `draft`: deliberately not published.
 * - `staged`: ready (not a draft) and never published.
 * - `changed`: published once and saved again since; the live site still has the old version.
 * - `live`: published and not changed since.
 */
export type WebflowItemState = "archived" | "draft" | "staged" | "changed" | "live";

/** One item of a collection as a fingerprint: where it stands, never what it says. */
export interface WebflowStagedItem {
  id: string;
  type: string;
  slug?: string;
  state: WebflowItemState;
  /** ISO 8601, UTC. */
  lastUpdated: string;
  /** ISO 8601, UTC. Absent for an item that was never published. */
  lastPublished?: string;
}

/**
 * The Webflow adapter: ContentAdapter, plus the two reads the Webflow checks need that no other CMS
 * has an equivalent for (the list of collections, and every item's state, staged ones included).
 */
export interface WebflowAdapter extends ContentAdapter {
  collections(): Promise<WebflowCollection[]>;
  staged(options?: { types?: readonly string[] }): AsyncIterable<WebflowStagedItem>;
}

export interface WebflowAdapterOptions {
  /** WEBFLOW_TOKEN and, optionally, WEBFLOW_SITE_ID, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is hashed. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces WEBFLOW_LIMITS.itemsPerCollection. For tests. */
  maxItemsPerCollection?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value Webflow gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field's value by name; a dotted name goes into objects. Webflow's own field names are flat. */
function valueAt(data: Record<string, unknown>, path: string): unknown {
  if (path in data) return data[path];
  let at: unknown = data;
  for (const part of path.split(".")) {
    if (!isRecord(at)) return undefined;
    at = at[part];
  }
  return at;
}

/** A field counts as present when it has a value: not missing, null, an empty string, an empty list or an empty object. */
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** An item as the adapter keeps it: its ids, its state and its times, and the field data only until it is hashed or counted. */
interface RawItem {
  id: string;
  isDraft: boolean;
  isArchived: boolean;
  lastPublished?: string;
  lastUpdated: string;
  data: Record<string, unknown>;
}

function parseItem(raw: unknown): RawItem {
  const r = isRecord(raw) ? raw : {};
  const id = r.id;
  const flag = (v: unknown): boolean => v === true;
  const lastPublished = isoOf(r.lastPublished);
  const lastUpdated = isoOf(r.lastUpdated) ?? lastPublished ?? isoOf(r.createdOn);
  if (typeof id !== "string" || id === "" || lastUpdated === undefined)
    throw new AdapterCouldNotCheck(
      "Webflow answered with items that have no id or no update time.",
    );
  return {
    id,
    isDraft: flag(r.isDraft),
    isArchived: flag(r.isArchived),
    ...(lastPublished !== undefined ? { lastPublished } : {}),
    lastUpdated,
    data: isRecord(r.fieldData) ? r.fieldData : {},
  };
}

const slugOf = (item: RawItem): string | undefined => {
  const s = item.data.slug;
  return typeof s === "string" && s !== "" ? s : undefined;
};

function stateOf(item: RawItem): WebflowItemState {
  if (item.isArchived) return "archived";
  if (item.isDraft) return "draft";
  if (item.lastPublished === undefined) return "staged";
  return Date.parse(item.lastUpdated) - Date.parse(item.lastPublished) > WEBFLOW_STAGED_TOLERANCE_MS
    ? "changed"
    : "live";
}

export function createWebflowAdapter(options: WebflowAdapterOptions): WebflowAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? WEBFLOW_PAGE_SIZE, WEBFLOW_PAGE_SIZE));
  const cap = options.maxItemsPerCollection ?? WEBFLOW_LIMITS.itemsPerCollection;
  const settings = options.settings;
  const redact = createRedactor(env, [WEBFLOW_TOKEN]);
  let known: WebflowCollection[] | undefined;

  type Scope = "sites:read" | "cms:read";

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown, scope: Scope): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        err.status === 401
          ? "Webflow did not accept WEBFLOW_TOKEN (HTTP 401). Check that it is a current site token for this site."
          : `Webflow did not let the token read this (HTTP ${err.status}). ${
              scope === "sites:read"
                ? "Finding the site needs the sites:read scope; set WEBFLOW_SITE_ID to skip that step."
                : "Reading collections and items needs the cms:read scope, and a collection may be closed to the token."
            }`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? "Webflow answered HTTP 404: it has no such site or collection for this token. Check WEBFLOW_SITE_ID, and that the token belongs to this site."
          : `Webflow answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const tokenOrThrow = (): string => {
    const token = (env[WEBFLOW_TOKEN] ?? "").trim();
    if (token === "")
      throw new AdapterCouldNotCheck(
        `${WEBFLOW_TOKEN} is not set. Webflow's content needs a site token with the sites:read and cms:read scopes.`,
      );
    return token;
  };

  /** One GET of the Data API, parsed as a JSON object. The token goes in a header, never in the address. */
  const get = async (
    path: string,
    scope: Scope,
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    const token = tokenOrThrow();
    try {
      const { body } = await getJson(
        {
          fetcher,
          request: { authorization: `Bearer ${token}`, headers: { accept: "application/json" } },
          sleep,
          system: "Webflow",
        },
        `${WEBFLOW_API}${path}`,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Webflow answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial(), scope);
    }
  };

  const siteId = async (): Promise<string> => {
    tokenOrThrow();
    const named = (env[WEBFLOW_SITE_ID] ?? "").trim();
    if (named !== "") {
      if (!SITE_ID.test(named))
        throw new AdapterCouldNotCheck(
          `${WEBFLOW_SITE_ID} is not a Webflow site id (letters and digits, as shown in the site's settings).`,
        );
      return named;
    }
    const body = await get("/sites", "sites:read", () => undefined);
    const sites = Array.isArray(body.sites) ? body.sites : undefined;
    if (sites === undefined)
      throw new AdapterCouldNotCheck(
        "Webflow answered with something that is not a list of sites.",
      );
    const ids = sites.flatMap((s) =>
      isRecord(s) && typeof s.id === "string" && s.id !== "" ? [s.id] : [],
    );
    if (ids.length === 1 && SITE_ID.test(ids[0] ?? "")) return ids[0] ?? "";
    throw new AdapterCouldNotCheck(
      ids.length === 0
        ? "The token can see no Webflow site. Make it a site token for the site, with the sites:read scope."
        : `The token can see ${ids.length} Webflow sites, and Gaugeline will not guess which. Set ${WEBFLOW_SITE_ID} to the one to read.`,
    );
  };

  const collections = async (): Promise<WebflowCollection[]> => {
    if (known) return known;
    const id = await siteId();
    const body = await get(`/sites/${encodeURIComponent(id)}/collections`, "cms:read", () => []);
    const list = Array.isArray(body.collections) ? body.collections : undefined;
    if (list === undefined)
      throw new AdapterCouldNotCheck(
        "Webflow answered with something that is not a list of collections.",
      );
    const out = list.map((c): WebflowCollection => {
      const r = isRecord(c) ? c : {};
      if (typeof r.id !== "string" || r.id === "" || typeof r.slug !== "string" || r.slug === "")
        throw new AdapterCouldNotCheck(
          "Webflow answered with a collection that has no id or no slug.",
        );
      return { id: r.id, slug: r.slug };
    });
    out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    known = out;
    return out;
  };

  const totalOf = (body: Record<string, unknown>): number => {
    const p = isRecord(body.pagination) ? body.pagination : {};
    const total = p.total;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new AdapterCouldNotCheck(
        "Webflow answered with something that is not a count of items.",
      );
    return total;
  };

  const path = (
    collection: WebflowCollection,
    live: boolean,
    limit: number,
    offset: number,
  ): string =>
    `/collections/${encodeURIComponent(collection.id)}/items${live ? "/live" : ""}?limit=${limit}&offset=${offset}`;

  /**
   * The items of one collection, a page at a time, until every one is read. An answer over the size
   * limit (a page of long posts) is asked again with half as many items, down to ten; a page that
   * comes back short is not the end, and one that comes back empty before the total is could-not-check.
   * `live` asks for what is published; otherwise every item.
   */
  async function* itemsOf(
    collection: WebflowCollection,
    live: boolean,
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawItem> {
    let offset = 0;
    let size = pageSize;
    for (;;) {
      let body: Record<string, unknown>;
      try {
        body = await get(path(collection, live, size, offset), "cms:read", partial);
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Webflow's answer for ${size} items is larger than the 5 MB Gaugeline reads at once, even after asking for fewer items at a time (down to ${MIN_PAGE_SIZE} items). The collection was not read.`,
        );
      }
      const total = totalOf(body);
      if (enforceCap && total > cap)
        throw new AdapterCouldNotCheck(
          `The collection has ${total} items, more than ${cap} item${cap === 1 ? "" : "s"}, which is as many as Gaugeline reads from one collection.`,
        );
      if (!Array.isArray(body.items))
        throw new AdapterCouldNotCheck(
          "Webflow answered with something that is not a list of items.",
        );
      for (const raw of body.items) yield parseItem(raw);
      offset += body.items.length;
      if (offset >= total) return;
      if (body.items.length === 0)
        throw new AdapterCouldNotCheck(
          `Webflow's list stopped after ${offset} of ${total} items, so the rest was not read.`,
        );
    }
  }

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const c of await collections()) {
      const body = await get(path(c, true, 1, 0), "cms:read", () => out.slice());
      out.push({ name: c.slug, count: totalOf(body) });
    }
    return out;
  };

  const chosen = async (names: readonly string[] | undefined): Promise<WebflowCollection[]> => {
    const all = await collections();
    return names === undefined ? all : all.filter((c) => names.includes(c.slug));
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for (const c of await chosen([type]))
      for await (const item of itemsOf(c, true, true, () => ({}))) {
        for (const f of fields) if (hasValue(valueAt(item.data, f))) out[f] = (out[f] ?? 0) + 1;
      }
    return out;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = isoOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const c of await chosen(opts.types)) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[c.slug] ?? settings?.fingerprint?.[c.slug] ?? [];
      for await (const item of itemsOf(c, true, opts.limit === undefined, () => delivered)) {
        if (item.isDraft || item.isArchived) continue;
        if (since !== undefined && Date.parse(item.lastUpdated) < Date.parse(since)) continue;
        const slug = slugOf(item);
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(item.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const url = resolveUrl({
          id: item.id,
          type: c.slug,
          ...(slug !== undefined ? { slug } : {}),
        });
        remaining--;
        delivered++;
        yield {
          id: item.id,
          type: c.slug,
          ...(url !== "" ? { url } : {}),
          ...(slug !== undefined ? { slug } : {}),
          ...(item.lastPublished !== undefined ? { publishedAt: item.lastPublished } : {}),
          updatedAt: item.lastUpdated,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  async function* staged(
    opts: { types?: readonly string[] } = {},
  ): AsyncGenerator<WebflowStagedItem> {
    let delivered = 0;
    for (const c of await chosen(opts.types))
      for await (const item of itemsOf(c, false, true, () => delivered)) {
        const slug = slugOf(item);
        delivered++;
        yield {
          id: item.id,
          type: c.slug,
          ...(slug !== undefined ? { slug } : {}),
          state: stateOf(item),
          lastUpdated: item.lastUpdated,
          ...(item.lastPublished !== undefined ? { lastPublished: item.lastPublished } : {}),
        };
      }
  }

  /**
   * True when the staged list holds an item the live list does not: a draft, an archived item or one
   * that was never published. Two counts per collection and no item is asked for beyond the first.
   */
  const draftsReachable = async (): Promise<boolean> => {
    for (const c of await collections()) {
      const every = totalOf(await get(path(c, false, 1, 0), "cms:read", () => undefined));
      const live = totalOf(await get(path(c, true, 1, 0), "cms:read", () => undefined));
      if (every > live) return true;
    }
    return false;
  };

  return {
    id: "webflow",
    describe: () => WEBFLOW_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    collections,
    staged,
  };
}
