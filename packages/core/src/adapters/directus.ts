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

import {
  DIRECTUS_DESCRIPTION,
  DIRECTUS_ENV_VARS,
  DIRECTUS_LIMITS,
  DIRECTUS_PAGE_SIZE,
  DIRECTUS_TOKEN,
  DIRECTUS_URL,
} from "./directus.entry.js";
export {
  DIRECTUS_DESCRIPTION,
  DIRECTUS_ENV_VARS,
  DIRECTUS_LIMITS,
  DIRECTUS_PAGE_SIZE,
  DIRECTUS_TOKEN,
  DIRECTUS_URL,
};

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A collection name is letters, digits and underscores (Directus's own rule for a table); anything else never goes into an address. */
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Items that are not published: the status is anything but "published", or there is none. Directus's usual
 * status field holds published, draft or archived (a collection can define its own values; here only the
 * word "published" counts as live, and the docs page says so).
 */
const NOT_PUBLISHED = '{"_or":[{"status":{"_neq":"published"}},{"status":{"_null":true}}]}';

/**
 * How a collection answered a visitor who sent no token:
 * - `public`: it listed at least one item. The Public role can read it.
 * - `empty`: it answered with no items. The Public role may read it (Directus answers a forbidden collection
 *   with 403), but an empty list shows nothing to count.
 * - `closed`: 401 or 403, which is what a collection the Public role may not read answers.
 * - `unread`: the answer could not be read; `reason` says why.
 */
export type DirectusPublicState = "public" | "empty" | "closed" | "unread";

export interface DirectusPublicCollection {
  type: string;
  state: DirectusPublicState;
  /** Items the answer counted (`meta.filter_count`), or 1 when it gave no count and listed one item. */
  listed: number;
  /** True when `listed` is a count the server reported, false when it is "at least this many". */
  exact: boolean;
  reason?: string;
}

/** The Directus adapter, plus the one read the privacy check needs (what a visitor with no token can list). */
export interface DirectusAdapter extends ContentAdapter {
  /** The collections the settings name (under `urls` or `fingerprint`), in order. */
  collections(): string[];
  /** The collections the settings mark private (`privateCollections`), in the order given. */
  privateCollections(): string[];
  /**
   * What a visitor with NO token can list of the collections the settings mark private: one GET each, with
   * `limit=1` and `fields=id`, sent with no token. It requests collections that are meant not to be public, so a
   * caller runs it only with the owner's consent (CLAUDE.md rule 14).
   */
  publicCollections(): Promise<DirectusPublicCollection[]>;
}

export interface DirectusAdapterOptions {
  /** DIRECTUS_URL and, optionally, DIRECTUS_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry. Its `urls` and `fingerprint` keys name the collections to read. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces DIRECTUS_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** An item as the adapter keeps it: its id, status and times, and the field data only until it is hashed or counted. */
interface RawItem {
  id: string;
  /** The status field's text. null: the field is there and empty. undefined: the answer has no status field. */
  status: string | null | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
  data: Record<string, unknown>;
}

/** An id is a whole number or a non-empty text (a UUID); anything else is not an item. */
function idOf(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw === "string" && raw !== "") return raw;
  return undefined;
}

function parseItem(raw: unknown): RawItem {
  const r = isRecord(raw) ? raw : {};
  const id = idOf(r.id);
  if (id === undefined)
    throw new AdapterCouldNotCheck("Directus answered with items that have no id.");
  const status = r.status === null ? null : typeof r.status === "string" ? r.status : undefined;
  return {
    id,
    status,
    createdAt: isoOf(r.date_created),
    updatedAt: isoOf(r.date_updated),
    data: r,
  };
}

/** Published is what the status field says; a collection that answers no status field has no drafts to hold back. */
const isLive = (i: RawItem): boolean => i.status === undefined || i.status === "published";

const slugOf = (i: RawItem): string | undefined => {
  const s = i.data.slug;
  return typeof s === "string" && s !== "" ? s : undefined;
};

export function createDirectusAdapter(options: DirectusAdapterOptions): DirectusAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? DIRECTUS_PAGE_SIZE, DIRECTUS_PAGE_SIZE),
  );
  const cap = options.maxItemsPerType ?? DIRECTUS_LIMITS.itemsPerType;
  const settings = options.settings;
  const token = (env[DIRECTUS_TOKEN] ?? "").trim();
  const redact = createRedactor(env, [DIRECTUS_TOKEN]);

  /** The collections the settings name, sorted: the adapter does not ask Directus to list its collections. */
  const named = [
    ...new Set([...Object.keys(settings?.urls ?? {}), ...Object.keys(settings?.fingerprint ?? {})]),
  ].sort();
  const priv = [...new Set(settings?.privateCollections ?? [])];

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown, authed: boolean): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        authed
          ? err.status === 401
            ? `Directus did not accept ${DIRECTUS_TOKEN} (HTTP 401). Check it is a current static token of an active user.`
            : `Directus would not let ${DIRECTUS_TOKEN} read this (HTTP ${err.status}). Directus answers this for a collection the role may not read, for a field it may not read and for a collection that does not exist: check the spelling, and that the role may read the collection and its status and date fields.`
          : `Directus does not show this collection to a visitor with no token (HTTP ${err.status}).`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `Directus answered HTTP 404: nothing is at ${DIRECTUS_URL}. Check the address.`
          : `Directus answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The site's address, or a could-not-check that names the variable. */
  const site = (): URL => {
    const text = (env[DIRECTUS_URL] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${DIRECTUS_URL} is not set.`);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new AdapterCouldNotCheck(
        `${DIRECTUS_URL} is not an address (expected https://cms.client.example).`,
      );
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new AdapterCouldNotCheck(
        `${DIRECTUS_URL} must be an http or https address with no user name or password in it.`,
      );
    return url;
  };

  /**
   * One GET of a collection's items route, parsed as JSON. The token goes in a header, never in the address,
   * only when `authed`, only over https, and only to the first address's origin (a redirect to another origin
   * is followed without it).
   */
  const get = async (
    type: string,
    params: Record<string, string>,
    authed: boolean,
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    try {
      if (!TYPE_NAME.test(type))
        throw new AdapterCouldNotCheck(
          `"${type}" is not a Directus collection name (letters, digits and underscores).`,
        );
      const base = site();
      const sendToken = authed && token !== "";
      if (sendToken && base.protocol !== "https:")
        throw new AdapterCouldNotCheck(
          `${DIRECTUS_URL} is an http address, and ${DIRECTUS_TOKEN} is not sent over plain http.`,
        );
      const root = base.pathname.replace(/\/+$/, "");
      const query = new URLSearchParams(params).toString();
      const { body } = await getJson(
        {
          fetcher,
          request: {
            // A request with no token is a visitor's: nothing the fetcher adds per address goes with it.
            ...(sendToken ? { authorization: `Bearer ${token}` } : { anonymous: true }),
            headers: { accept: "application/json" },
          },
          sleep,
          system: "Directus",
        },
        `${base.origin}${root}/items/${encodeURIComponent(type)}${query === "" ? "" : `?${query}`}`,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Directus answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial(), authed);
    }
  };

  const needToken = (): void => {
    if (token === "")
      throw new AdapterCouldNotCheck(
        `${DIRECTUS_TOKEN} is not set. Unpublished items need a static token of a user whose role can read them.`,
      );
  };

  /** The count `meta.filter_count` reports, or undefined when the answer has none (it is only there when asked for). */
  const filterCount = (body: Record<string, unknown>): number | undefined => {
    const meta = isRecord(body.meta) ? body.meta : {};
    const n = meta.filter_count;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };

  /** The rows of an answer: a list, or the one object of a singleton collection. */
  const rowsOf = (body: Record<string, unknown>): unknown[] => {
    if (Array.isArray(body.data)) return body.data;
    if (isRecord(body.data)) return [body.data];
    throw new AdapterCouldNotCheck("Directus answered with something that is not a list.");
  };

  const isRefusal = (err: unknown): err is AdapterCouldNotCheck =>
    err instanceof AdapterCouldNotCheck &&
    /did not accept|would not let|does not show this collection/.test(err.reason);

  /**
   * The items of one collection a page at a time, until every one is read. `offset` is the number of items
   * already received, so a server that holds an answer below the `limit` asked for (QUERY_LIMIT_MAX) is followed
   * without a guess. The end is the reported count (`meta.filter_count`) when there is one, else an empty page.
   * An answer over the size limit is asked again with half as many, down to ten; a field selection Directus
   * refuses (HTTP 400) is dropped once and whole items asked for. A page that comes back empty before the count
   * is could-not-check, never the end of the list; so is a list longer than `cap`, whatever count the server claims.
   */
  async function* itemsOf(
    type: string,
    authed: boolean,
    enforceCap: boolean,
    partial: () => unknown,
    opts: { filter?: string; select?: readonly string[] } = {},
  ): AsyncGenerator<RawItem> {
    const maxPages = Math.ceil(cap / MIN_PAGE_SIZE) + 12;
    let select =
      opts.select !== undefined && opts.select.length > 0
        ? [...new Set(opts.select)].join(",")
        : undefined;
    let size = pageSize;
    let read = 0;
    let asked = 0;
    for (;;) {
      if (++asked > maxPages)
        throw new AdapterCouldNotCheck(
          `Directus needed more than ${maxPages} requests to list one collection, so it was not read to the end.`,
        );
      let body: Record<string, unknown>;
      try {
        body = await get(
          type,
          {
            limit: String(size),
            offset: String(read),
            sort: "id",
            meta: "filter_count",
            ...(select !== undefined ? { fields: select } : {}),
            ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
          },
          authed,
          partial,
        );
      } catch (err) {
        if (
          select !== undefined &&
          err instanceof AdapterCouldNotCheck &&
          /HTTP 400\b/.test(err.reason)
        ) {
          select = undefined;
          continue;
        }
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Directus's answer for ${size} items is larger than the 5 MB Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The collection was not read.`,
        );
      }
      const total = filterCount(body);
      if (enforceCap && total !== undefined && total > cap)
        throw new AdapterCouldNotCheck(
          `The collection has ${total} items, more than ${cap}, which is as many as Gaugeline reads from one collection.`,
        );
      const rows = rowsOf(body);
      if (read + rows.length > cap)
        throw new AdapterCouldNotCheck(
          `Directus listed more items than the ${cap} Gaugeline reads from one collection, whatever count it reported.`,
        );
      for (const raw of rows) yield parseItem(raw);
      read += rows.length;
      // A singleton answers one item and has no pages.
      if (isRecord(body.data)) return;
      if (total !== undefined) {
        if (read >= total) return;
        if (rows.length === 0)
          throw new AdapterCouldNotCheck(
            `Directus's list stopped after ${read} of ${total} items, so the rest was not read.`,
          );
      } else if (rows.length === 0) return;
    }
  }

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  /**
   * The number of items (matching `filter`): the count one small request reports, else the items counted a
   * page at a time. A filter on the status field that Directus refuses with 400 is a collection that has none.
   */
  const countOf = async (
    type: string,
    authed: boolean,
    filter: string | undefined,
    partial: () => unknown,
  ): Promise<number> => {
    const body = await get(
      type,
      {
        limit: "1",
        fields: "id",
        meta: "filter_count",
        ...(filter !== undefined ? { filter } : {}),
      },
      authed,
      partial,
    );
    const n = filterCount(body);
    if (n !== undefined) return n;
    let counted = 0;
    for await (const i of itemsOf(type, authed, true, partial, {
      ...(filter !== undefined ? { filter } : {}),
      select: ["id"],
    })) {
      void i;
      counted++;
    }
    return counted;
  };

  /**
   * The items that are not published. A filter Directus refuses with 400 is a collection with no status field
   * only if one whole item confirms it has none; an empty collection, or an item that has a status, leaves the
   * refusal standing (could-not-check), so a server that dislikes the filter is never read as "no drafts".
   */
  const unpublishedCount = async (
    type: string,
    partial: () => unknown,
  ): Promise<number | "no-status"> => {
    try {
      return await countOf(type, true, NOT_PUBLISHED, partial);
    } catch (err) {
      if (!(err instanceof AdapterCouldNotCheck) || !/HTTP 400\b/.test(err.reason)) throw err;
      const first = rowsOf(await get(type, { limit: "1" }, true, partial))[0];
      if (isRecord(first) && !("status" in first)) return "no-status";
      throw err;
    }
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of named) {
      const partial = () => out.slice();
      const total = await countOf(name, true, undefined, partial);
      const drafts = await unpublishedCount(name, partial);
      out.push({ name, count: drafts === "no-status" ? total : Math.max(0, total - drafts) });
    }
    return out;
  };

  const topLevel = (fields: readonly string[]): string[] => fields.map((f) => f.split(".")[0] ?? f);

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    if (!named.includes(type)) return out;
    const select = ["id", "status", "date_created", "date_updated", ...topLevel(fields)];
    for await (const i of itemsOf(type, true, true, () => ({}), { select })) {
      if (!isLive(i)) continue;
      for (const f of fields) if (hasValue(valueAt(i.data, f))) out[f] = (out[f] ?? 0) + 1;
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
    for (const type of named.filter((n) => opts.types === undefined || opts.types.includes(n))) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      const select = ["id", "status", "slug", "date_created", "date_updated", ...topLevel(fields)];
      for await (const i of itemsOf(type, true, opts.limit === undefined, () => delivered, {
        select,
      })) {
        // Published is what the status field says; a draft or archived item is not live, whatever listed it.
        if (!isLive(i)) continue;
        const updatedAt = i.updatedAt ?? i.createdAt;
        if (updatedAt === undefined)
          throw new AdapterCouldNotCheck(
            "Directus answered with items that have neither date_updated nor date_created, so their update time is unknown.",
          );
        if (since !== undefined && updatedAt < since) continue;
        const slug = slugOf(i);
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(i.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const url = resolveUrl({ id: i.id, type, ...(slug !== undefined ? { slug } : {}) });
        remaining--;
        delivered++;
        yield {
          id: i.id,
          type,
          ...(url !== "" ? { url } : {}),
          ...(slug !== undefined ? { slug } : {}),
          updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  /**
   * True when the token can read an item that is not published, in any collection the settings name. One
   * small request per collection. A collection with no status field has no unpublished items. When a
   * collection could not be asked and no other showed drafts, the answer is could-not-check, never "no".
   */
  const draftsReachable = async (): Promise<boolean> => {
    needToken();
    if (named.length === 0)
      throw new AdapterCouldNotCheck(
        'No collection is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and Gaugeline does not ask Directus to list its collections.',
      );
    let failure: AdapterCouldNotCheck | undefined;
    for (const type of named) {
      try {
        const n = await unpublishedCount(type, () => undefined);
        if (n !== "no-status" && n > 0) return true;
      } catch (err) {
        if (!(err instanceof AdapterCouldNotCheck)) throw err;
        failure ??= err;
      }
    }
    if (failure) throw failure;
    return false;
  };

  const publicCollections: DirectusAdapter["publicCollections"] = async () => {
    const out: DirectusPublicCollection[] = [];
    const none = (
      type: string,
      state: DirectusPublicState,
      reason?: string,
    ): DirectusPublicCollection => ({
      type,
      state,
      listed: 0,
      exact: true,
      ...(reason !== undefined ? { reason } : {}),
    });
    for (const type of priv) {
      try {
        // No token, one item, its id only: the answer is read as a count and nothing else.
        const body = await get(
          type,
          { limit: "1", fields: "id", meta: "filter_count" },
          false,
          () => out.slice(),
        );
        const rows = rowsOf(body);
        const n = filterCount(body);
        if (rows.length === 0 && (n === undefined || n === 0)) out.push(none(type, "empty"));
        else
          out.push({
            type,
            state: "public",
            listed: n ?? rows.length,
            exact: n !== undefined,
          });
      } catch (err) {
        if (err instanceof AdapterRateLimitedError) throw err;
        if (isRefusal(err)) {
          out.push(none(type, "closed"));
          continue;
        }
        out.push(
          none(
            type,
            "unread",
            err instanceof AdapterCouldNotCheck ? err.reason : "unexpected error",
          ),
        );
      }
    }
    return out;
  };

  return {
    id: "directus",
    describe: () => DIRECTUS_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    collections: () => [...named],
    privateCollections: () => [...priv],
    publicCollections,
  };
}
