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

import { CONTENTSTACK_DESCRIPTION } from "./contentstack.entry.js";
export { CONTENTSTACK_DESCRIPTION };

import { CONTENTSTACK_TOKEN } from "./contentstack.entry.js";
export { CONTENTSTACK_TOKEN };

/** TODO(new:adapter) the platform's API base, from its documentation (the date you checked it goes on the docs page). */
export const CONTENTSTACK_API = "https://api.contentstack.example/v1";

/** Items asked for in one request: the API's own maximum. TODO(new:adapter) confirm it. */
export const CONTENTSTACK_PAGE_SIZE = 100;

/** Bounds a run keeps to, in the platform's terms. There are no flags to raise them. */
export const CONTENTSTACK_LIMITS = {
  /** Items read from one type. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
} as const;

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** Every address is built from this origin and no other: a key is never sent anywhere else. */
const API_ORIGIN = new URL(CONTENTSTACK_API).origin;

export interface ContentstackAdapterOptions {
  /** CONTENTSTACK_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is hashed. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces CONTENTSTACK_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value the platform gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field's value by name; a dotted name goes into objects. */
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

/** An item as the adapter keeps it: ids, state and times, and the field data only until it is hashed or counted. */
interface RawItem {
  id: string;
  slug?: string;
  published: boolean;
  publishedAt?: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

/**
 * TODO(new:adapter) map the platform's item to RawItem: where its id, slug, state, times and field data are.
 * Throw AdapterCouldNotCheck for an item that has no id or no time; never make one up.
 */
function parseItem(raw: unknown): RawItem {
  const r = isRecord(raw) ? raw : {};
  const publishedAt = isoOf(r.publishedAt);
  const updatedAt = isoOf(r.updatedAt) ?? publishedAt;
  if (typeof r.id !== "string" || r.id === "" || updatedAt === undefined)
    throw new AdapterCouldNotCheck(
      "Contentstack answered with items that have no id or no update time.",
    );
  return {
    id: r.id,
    ...(typeof r.slug === "string" && r.slug !== "" ? { slug: r.slug } : {}),
    published: r.status === "published",
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    updatedAt,
    data: isRecord(r.fields) ? r.fields : {},
  };
}

export function createContentstackAdapter(options: ContentstackAdapterOptions): ContentAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? CONTENTSTACK_PAGE_SIZE, CONTENTSTACK_PAGE_SIZE),
  );
  const cap = options.maxItemsPerType ?? CONTENTSTACK_LIMITS.itemsPerType;
  const settings = options.settings;
  const redact = createRedactor(env, [CONTENTSTACK_TOKEN]);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        err.status === 401
          ? "Contentstack did not accept CONTENTSTACK_TOKEN (HTTP 401). Check that it is a current key."
          : `Contentstack did not let the key read this (HTTP ${err.status}). TODO(new:adapter) name the permission the key needs.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? "Contentstack answered HTTP 404: it has no such type or item."
          : `Contentstack answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const keyOrThrow = (): string => {
    const key = (env[CONTENTSTACK_TOKEN] ?? "").trim();
    if (key === "")
      throw new AdapterCouldNotCheck(
        `${CONTENTSTACK_TOKEN} is not set. Contentstack's content needs a key.`,
      );
    return key;
  };

  /**
   * One GET, parsed as a JSON object, to this API's origin and no other.
   * The key goes in a header, never in the address.
   */
  const get = async (address: string, partial: () => unknown): Promise<Record<string, unknown>> => {
    if (new URL(address).origin !== API_ORIGIN)
      throw new AdapterCouldNotCheck(
        "Contentstack pointed at another address, which is not asked.",
      );
    const key = keyOrThrow();
    try {
      const { body } = await getJson(
        {
          fetcher,
          request: {
            authorization: `Bearer ${key}`,
            headers: { accept: "application/json" },
          },
          sleep,
          system: "Contentstack",
        },
        address,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck(
          "Contentstack answered with something that is not an object.",
        );
      return body;
    } catch (err) {
      throw translate(err, partial());
    }
  };

  /**
   * TODO(new:adapter) the platform's real read endpoints. Every one is a GET. Add each to the table in
   * docs/integrations/contentstack.md with its documentation link.
   *
   * POST is allowed only for a documented read-only query endpoint, through ADR-0006's allowlist
   * (branch adr/read-only-post; not merged yet). TODO(new:adapter, after ADR-0006 has merged) add the
   * `queryAllow` entry (method, path pattern, body shape) in this adapter's registry row. Until then this
   * adapter sends GET and HEAD only.
   */
  const typesAddress = (): string => `${CONTENTSTACK_API}/types`;
  const itemsAddress = (
    type: string,
    status: "published" | "all",
    limit: number,
    offset: number,
  ): string =>
    `${CONTENTSTACK_API}/types/${encodeURIComponent(type)}/items?status=${status}&limit=${limit}&offset=${offset}`;

  const typeNames = async (partial: () => unknown): Promise<string[]> => {
    const body = await get(typesAddress(), partial);
    return namesOf(body.types);
  };

  const pageOf = async (
    type: string,
    status: "published" | "all",
    limit: number,
    offset: number,
    partial: () => unknown,
  ): Promise<{ items: unknown[]; total: number }> => {
    const body = await get(itemsAddress(type, status, limit, offset), partial);
    return { items: itemsOf(body.items), total: totalOf(body.total) };
  };

  const namesOf = (list: unknown): string[] => {
    if (!Array.isArray(list))
      throw new AdapterCouldNotCheck(
        "Contentstack answered with something that is not a list of types.",
      );
    const names = list.map((t) => {
      const slug = isRecord(t) ? t.slug : undefined;
      if (typeof slug !== "string" || slug === "")
        throw new AdapterCouldNotCheck("Contentstack answered with a type that has no slug.");
      return slug;
    });
    return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };

  const itemsOf = (list: unknown): unknown[] => {
    if (!Array.isArray(list))
      throw new AdapterCouldNotCheck(
        "Contentstack answered with something that is not a list of items.",
      );
    return list;
  };

  const totalOf = (total: unknown): number => {
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new AdapterCouldNotCheck(
        "Contentstack answered with something that is not a count of items.",
      );
    return total;
  };

  /**
   * The items of one type, a page at a time, until every one is read. An answer over the size limit is
   * asked again with half as many items, down to ten; a page that comes back short is not the end, and
   * one that comes back empty before the total is could-not-check. `status` "published" asks for what
   * is live; "all" asks for everything the key can see.
   */
  async function* itemsOfType(
    type: string,
    status: "published" | "all",
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawItem> {
    let offset = 0;
    let size = pageSize;
    for (;;) {
      let page: { items: unknown[]; total: number };
      try {
        page = await pageOf(type, status, size, offset, partial);
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Contentstack's answer for ${size} items is larger than Gaugeline reads at once, even after asking for fewer items at a time (down to ${MIN_PAGE_SIZE}). The type was not read.`,
        );
      }
      if (enforceCap && page.total > cap)
        throw new AdapterCouldNotCheck(
          `The type has ${page.total} items, more than ${cap} item${cap === 1 ? "" : "s"}, which is as many as Gaugeline reads from one type.`,
        );
      for (const raw of page.items) yield parseItem(raw);
      offset += page.items.length;
      if (offset >= page.total) return;
      if (page.items.length === 0)
        throw new AdapterCouldNotCheck(
          `Contentstack's list stopped after ${offset} of ${page.total} items, so the rest was not read.`,
        );
    }
  }

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const chosen = async (names: readonly string[] | undefined): Promise<string[]> => {
    const all = await typeNames(() => []);
    return names === undefined ? all : all.filter((n) => names.includes(n));
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of await typeNames(() => [])) {
      const page = await pageOf(name, "published", 1, 0, () => out.slice());
      out.push({ name, count: page.total });
    }
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for (const name of await chosen([type]))
      for await (const item of itemsOfType(name, "published", true, () => ({}))) {
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
    for (const type of await chosen(opts.types)) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      const read = itemsOfType(type, "published", opts.limit === undefined, () => delivered);
      for await (const item of read) {
        if (!item.published) continue;
        if (since !== undefined && Date.parse(item.updatedAt) < Date.parse(since)) continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(item.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const url = resolveUrl({
          id: item.id,
          type,
          ...(item.slug !== undefined ? { slug: item.slug } : {}),
        });
        remaining--;
        delivered++;
        yield {
          id: item.id,
          type,
          ...(url !== "" ? { url } : {}),
          ...(item.slug !== undefined ? { slug: item.slug } : {}),
          ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
          updatedAt: item.updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  /**
   * True when the list of everything the key can see holds an item the published list does not: a draft
   * or an item never published. Two counts per type and no item is asked for beyond the first.
   */
  const draftsReachable = async (): Promise<boolean> => {
    for (const name of await typeNames(() => undefined)) {
      const every = (await pageOf(name, "all", 1, 0, () => undefined)).total;
      const live = (await pageOf(name, "published", 1, 0, () => undefined)).total;
      if (every > live) return true;
    }
    return false;
  };

  return {
    id: "contentstack",
    describe: () => CONTENTSTACK_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
  };
}
