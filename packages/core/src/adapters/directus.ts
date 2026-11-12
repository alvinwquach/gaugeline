import {
  MAX_RETRY_SECONDS,
  ResponseTooLargeError,
  getJson,
  isRecord,
} from "../connectors/get-json.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  describeRetry,
  retryAfterSeconds,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { fillUrlTemplate, hasValue, hashValue, valueAt } from "./fingerprint.js";
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

/** What a token looks like: printable ASCII with no space. Anything else is a paste mistake, and is never sent. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

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
 * - `closed`: a 401 or 403 that carries Directus's own error envelope (FORBIDDEN or INVALID_CREDENTIALS), which is
 *   what a collection the Public role may not read answers. Directus also answers it for a collection that does not
 *   exist (uncited), so `exists` says whether the token could read the collection: when it could not, the
 *   spelling is unconfirmed.
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
  /** Only meaningful when `state` is `closed`: the token could read the collection, so it exists and the 403 is real. */
  exists?: boolean;
  /** Only when `state` is `closed` and `exists` is false: why the spelling could not be confirmed, in words that name the variable when it is the token. */
  unconfirmed?: string;
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
  // Only a MISSING key means the collection has no status field. A key with a value that is not text (0, false,
  // an object) is a status Gaugeline cannot read as "published": the item is not live.
  const status = !Object.hasOwn(r, "status")
    ? undefined
    : typeof r.status === "string"
      ? r.status
      : null;
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
      if (sendToken && !TOKEN_SHAPE.test(token))
        throw new AdapterCouldNotCheck(
          `${DIRECTUS_TOKEN} has a space, a line break or a character that is not plain ASCII in it, so it is not a token. Copy it again without anything around it.`,
        );
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
    // Ids already delivered in this read: a repeat means the server ignored `offset`, or the list moved under us.
    const seen = new Set<string>();
    let firstTotal: number | undefined;
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
      if (total !== undefined) {
        firstTotal ??= total;
        if (total !== firstTotal)
          throw new AdapterCouldNotCheck(
            `The list changed while it was read: Directus reported ${firstTotal} items and then ${total}.`,
          );
      }
      if (enforceCap && total !== undefined && total > cap)
        throw new AdapterCouldNotCheck(
          `The collection has ${total} items, more than ${cap}, which is as many as Gaugeline reads from one collection.`,
        );
      const rows = rowsOf(body);
      if (read + rows.length > cap)
        throw new AdapterCouldNotCheck(
          `Directus listed more items than the ${cap} Gaugeline reads from one collection, whatever count it reported.`,
        );
      // A singleton answers one item and has no pages.
      const singleton = isRecord(body.data);
      for (const raw of rows) {
        const item = parseItem(raw);
        if (!singleton) {
          if (seen.has(item.id))
            throw new AdapterCouldNotCheck(
              `Directus listed the same item twice (id ${item.id}) while one collection was read, so the list is not reliable: the server may ignore offset, or items were added or removed during the read.`,
            );
          seen.add(item.id);
        }
        yield item;
      }
      read += rows.length;
      if (singleton) return;
      if (total !== undefined) {
        if (read >= total) {
          if (read !== total)
            throw new AdapterCouldNotCheck(
              `The list changed while it was read: Directus reported ${total} items and ${read} came back.`,
            );
          return;
        }
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
      // The slug is asked for only when the collection's address pattern uses it.
      const wantsSlug = (templateFor(type) ?? "").includes("{slug}");
      const select = [
        "id",
        "status",
        ...(wantsSlug ? ["slug"] : []),
        "date_created",
        "date_updated",
        ...topLevel(fields),
      ];
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

  /** Directus's own error codes for a request that is refused: what a collection the Public role may not read answers. */
  const REFUSAL_CODES: readonly string[] = ["FORBIDDEN", "INVALID_CREDENTIALS"];

  /** True when the body is Directus's error envelope with one of its refusal codes: `{ errors: [{ extensions: { code } }] }`. */
  const isDirectusRefusal = (text: string | undefined): boolean => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text ?? "");
    } catch {
      return false;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return false;
    const first: unknown = parsed.errors[0];
    const ext = isRecord(first) && isRecord(first.extensions) ? first.extensions : {};
    return typeof ext.code === "string" && REFUSAL_CODES.includes(ext.code);
  };

  /**
   * One tokenless GET (the fetcher's `anonymous` request: no token, no cookie, nothing added per address), read
   * directly because the answer's BODY matters: a 401 or 403 means "closed" only when it is Directus that sent it
   * (its error envelope), never when it is a firewall or CDN page.
   */
  const anonymousProbe = async (
    type: string,
    partial: () => unknown,
  ): Promise<DirectusPublicCollection> => {
    const none = (state: DirectusPublicState, reason?: string): DirectusPublicCollection => ({
      type,
      state,
      listed: 0,
      exact: true,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (!TYPE_NAME.test(type))
      return none(
        "unread",
        `"${type}" is not a Directus collection name (letters, digits and underscores).`,
      );
    const base = site();
    const root = base.pathname.replace(/\/+$/, "");
    const query = new URLSearchParams({ limit: "1", fields: "id", meta: "filter_count" });
    const url = `${base.origin}${root}/items/${encodeURIComponent(type)}?${query.toString()}`;
    let hop;
    for (let attempt = 0; ; attempt++) {
      let hops;
      try {
        hops = await fetcher.get(url, {
          headers: { accept: "application/json" },
          headersSameOrigin: true,
          anonymous: true,
          // A redirect is not followed: the answer of another server (or another path) says nothing about this collection.
          maxRedirects: 0,
          ...(attempt > 0 ? { fresh: true } : {}),
        });
      } catch (err) {
        return none("unread", redact(err instanceof Error ? err.message : String(err)));
      }
      hop = hops.at(-1);
      if (!hop) return none("unread", "Directus gave no answer.");
      if (hop.status === 429) {
        const secs = retryAfterSeconds(hop.headers);
        if (attempt === 0 && secs !== undefined && secs <= MAX_RETRY_SECONDS) {
          await sleep(secs * 1000);
          continue;
        }
        throw new AdapterRateLimitedError(partial(), describeRetry(hop.headers));
      }
      break;
    }
    if (hop.truncated === true)
      return none("unread", "Directus's answer was larger than a page should be.");
    if (hop.status === 401 || hop.status === 403)
      return isDirectusRefusal(hop.body)
        ? none("closed")
        : none(
            "unread",
            `HTTP ${hop.status} that is not a Directus answer (no Directus error code in it): a firewall, a CDN or another server may be answering for Directus.`,
          );
    if (hop.status >= 300 && hop.status < 400)
      return none(
        "unread",
        `Directus answered HTTP ${hop.status}, a redirect, which a visitor request does not follow (the place it points to says nothing about this collection). Check ${DIRECTUS_URL}.`,
      );
    if (hop.status < 200 || hop.status >= 300)
      return none("unread", `Directus answered HTTP ${hop.status}.`);
    let body: unknown;
    try {
      body = JSON.parse(hop.body ?? "");
    } catch {
      return none("unread", "Directus answered with something that is not JSON.");
    }
    if (!isRecord(body))
      return none("unread", "Directus answered with something that is not an object.");
    const rows = rowsOf(body);
    const n = filterCount(body);
    if (rows.length === 0 && (n === undefined || n === 0)) return none("empty");
    // A count that disagrees with the rows is not a count: say so rather than pick one.
    if ((rows.length > 0 && n === 0) || (rows.length === 0 && (n ?? 0) > 0))
      return none("unread", "Directus's count and its list disagree, so nothing was counted.");
    return { type, state: "public", listed: Math.max(n ?? 0, rows.length), exact: n !== undefined };
  };

  const publicCollections: DirectusAdapter["publicCollections"] = async () => {
    const out: DirectusPublicCollection[] = [];
    for (const type of priv) {
      try {
        const got = await anonymousProbe(type, () => out.slice());
        if (got.state === "closed") {
          // Directus answers 403 for a collection that does not exist too (uncited). The token, when it can read
          // the collection, shows that it exists, so the 403 is a real refusal and the spelling is right.
          let exists = false;
          let unconfirmed = `${DIRECTUS_TOKEN} is not set, so the token could not show that the collection exists.`;
          if (token !== "") {
            try {
              await get(type, { limit: "1", fields: "id" }, true, () => out.slice());
              exists = true;
            } catch (err) {
              if (err instanceof AdapterRateLimitedError) throw err;
              const reason = err instanceof AdapterCouldNotCheck ? err.reason : "";
              unconfirmed = /HTTP 401\b/.test(reason)
                ? `Directus did not accept ${DIRECTUS_TOKEN} (HTTP 401), so the token could not show that the collection exists.`
                : "the token could not read the collection either.";
            }
          }
          out.push({ ...got, exists, ...(exists ? {} : { unconfirmed }) });
        } else out.push(got);
      } catch (err) {
        if (err instanceof AdapterRateLimitedError) throw err;
        out.push({
          type,
          state: "unread",
          listed: 0,
          exact: true,
          reason: err instanceof AdapterCouldNotCheck ? err.reason : "unexpected error",
        });
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
