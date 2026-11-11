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
  type AdapterDescription,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

/**
 * Strapi lets an administrator make an API token of type "Read-only": it can find and read the
 * content types it is given and cannot create, update or delete anything. Gaugeline asks for that
 * type and nothing wider. The page is Gaugeline's own: it lists the endpoints used and how to make
 * the token.
 */
export const STRAPI_DESCRIPTION: AdapterDescription = {
  name: "Strapi",
  docsUrl: "https://gaugeline.dev/docs/integrations/strapi",
  keyKind: "read-only",
};

export const STRAPI_URL = "STRAPI_URL";
export const STRAPI_TOKEN = "STRAPI_TOKEN";

/** Every variable the Strapi adapter may read. Only the token is a key. */
export const STRAPI_ENV_VARS = [STRAPI_URL, STRAPI_TOKEN] as const;

/** Entries asked for in one request: Strapi's default maximum page size. */
export const STRAPI_PAGE_SIZE = 100;

/** Bounds a run keeps to, in the platform's terms. There are no flags to raise them. */
export const STRAPI_LIMITS = {
  /** Entries read from one collection. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Ids read from each list when looking for unpublished entries a visitor can reach. Past it the count stands and the ids are left out. */
  publicIds: 500,
} as const;

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A collection's API id (its plural name) is letters, digits, hyphens and underscores; anything else never goes into an address. */
const TYPE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * How a collection answered a visitor who sent no token and asked for what is not published:
 * - `reachable`: it listed entries that have no published version.
 * - `nothing`: it answered, and every entry it showed is published.
 * - `refused`: it published its entries to visitors and refused the draft list (the safe answer).
 * - `private`: it did not publish its entries to visitors at all (401, 403 or 404).
 * - `unread`: the answer could not be read; `reason` says why.
 */
export type StrapiPublicState = "reachable" | "nothing" | "refused" | "private" | "unread";

export interface StrapiPublicDrafts {
  type: string;
  state: StrapiPublicState;
  /** Entries a visitor can list that have no published version. */
  unpublished: number;
  /** Their ids (the document id in Strapi 5, the numeric id in Strapi 4), at most STRAPI_LIMITS.publicIds read from each list. Empty when the lists were longer. */
  ids: string[];
  reason?: string;
}

/** The Strapi adapter: ContentAdapter, plus the one read the draft check needs (what a visitor with no token can reach). */
export interface StrapiAdapter extends ContentAdapter {
  /** The collections the settings name (under `urls` or `fingerprint`), in order. */
  collections(): string[];
  /**
   * What a visitor with NO token can list of the collections' unpublished entries. Every request
   * here is sent without the token. It asks for work the owner did not publish, so a caller runs it
   * only with the owner's consent (CLAUDE.md rule 14).
   */
  publicDrafts(options?: { types?: readonly string[] }): Promise<StrapiPublicDrafts[]>;
}

export interface StrapiAdapterOptions {
  /** STRAPI_URL and, optionally, STRAPI_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry. Its `urls` and `fingerprint` keys name the collections to read. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces STRAPI_LIMITS.itemsPerType. For tests. */
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

/** An entry as the adapter keeps it: its ids and times, and the field data only until it is hashed or counted. */
interface RawEntry {
  id: string;
  /** Strapi 5's document id when it has one, else the numeric id. The same entry has the same key in every list. */
  key: string;
  /** Present and null: the row is a draft. Absent: the platform did not say. */
  publishedAt: string | null | undefined;
  updatedAt: string | undefined;
  data: Record<string, unknown>;
}

/**
 * One row of a list. Strapi 5 answers flat rows (`{ id, documentId, title, ... }`); Strapi 4 wraps the
 * fields (`{ id, attributes: { title, ... } }`). Both are read the same way.
 */
function parseEntry(raw: unknown): RawEntry {
  const r = isRecord(raw) ? raw : {};
  const data = isRecord(r.attributes) ? r.attributes : r;
  const numeric = typeof r.id === "number" && Number.isSafeInteger(r.id) ? String(r.id) : undefined;
  const id = numeric ?? (typeof r.id === "string" && r.id !== "" ? r.id : undefined);
  const doc = typeof r.documentId === "string" && r.documentId !== "" ? r.documentId : undefined;
  if (id === undefined && doc === undefined)
    throw new AdapterCouldNotCheck("Strapi answered with entries that have no id.");
  return {
    id: doc ?? id ?? "",
    key: doc ?? id ?? "",
    publishedAt: data.publishedAt === null ? null : isoOf(data.publishedAt),
    updatedAt: isoOf(data.updatedAt),
    data,
  };
}

const slugOf = (e: RawEntry): string | undefined => {
  const s = e.data.slug;
  return typeof s === "string" && s !== "" ? s : undefined;
};

export function createStrapiAdapter(options: StrapiAdapterOptions): StrapiAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? STRAPI_PAGE_SIZE, STRAPI_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? STRAPI_LIMITS.itemsPerType;
  const settings = options.settings;
  const token = (env[STRAPI_TOKEN] ?? "").trim();
  const redact = createRedactor(env, [STRAPI_TOKEN]);

  /** The collections the settings name, sorted: Strapi's REST API does not list them to an API token. */
  const named = [
    ...new Set([...Object.keys(settings?.urls ?? {}), ...Object.keys(settings?.fingerprint ?? {})]),
  ].sort();

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown, authed: boolean): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        authed
          ? `Strapi did not accept ${STRAPI_TOKEN}, or the token may not read this (HTTP ${err.status}). Check it is a current API token, and that its permissions include find and findOne on this collection.`
          : `Strapi does not show this collection to a visitor with no token (HTTP ${err.status}). Set ${STRAPI_TOKEN} to a read-only API token.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `Strapi answered HTTP 404: it has no such collection at ${STRAPI_URL}. Check the address and that the name under "urls" or "fingerprint" is the collection's API ID (its plural name, such as events).`
          : `Strapi answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The site's address, or a could-not-check that names the variable. */
  const site = (): URL => {
    const text = (env[STRAPI_URL] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${STRAPI_URL} is not set.`);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new AdapterCouldNotCheck(
        `${STRAPI_URL} is not an address (expected https://cms.client.example).`,
      );
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new AdapterCouldNotCheck(
        `${STRAPI_URL} must be an http or https address with no user name or password in it.`,
      );
    return url;
  };

  /**
   * One GET of a collection's route, parsed as JSON. The token goes in a header, never in the address,
   * only when `authed`, only over https, and only to the first address's origin (a redirect to
   * another origin is followed without it).
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
          `"${type}" is not a Strapi collection API ID (letters, digits, hyphens and underscores).`,
        );
      const base = site();
      const sendToken = authed && token !== "";
      if (sendToken && base.protocol !== "https:")
        throw new AdapterCouldNotCheck(
          `${STRAPI_URL} is an http address, and ${STRAPI_TOKEN} is not sent over plain http.`,
        );
      const root = base.pathname.replace(/\/+$/, "");
      const query = new URLSearchParams(params).toString();
      const { body } = await getJson(
        {
          fetcher,
          request: {
            ...(sendToken ? { authorization: `Bearer ${token}` } : {}),
            headers: { accept: "application/json" },
          },
          sleep,
          system: "Strapi",
        },
        `${base.origin}${root}/api/${encodeURIComponent(type)}${query === "" ? "" : `?${query}`}`,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Strapi answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial(), authed);
    }
  };

  const needToken = (): void => {
    if (token === "")
      throw new AdapterCouldNotCheck(
        `${STRAPI_TOKEN} is not set. Strapi's unpublished entries need an API token of type Read-only.`,
      );
  };

  /** The entry total a list reports, or the one entry of a single type. */
  const totalOf = (body: Record<string, unknown>): number => {
    if (isRecord(body.data)) return 1;
    if (body.data === null) return 0;
    const meta = isRecord(body.meta) ? body.meta : {};
    const p = isRecord(meta.pagination) ? meta.pagination : {};
    const total = p.total;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new AdapterCouldNotCheck(
        "Strapi answered with something that is not a count of entries.",
      );
    return total;
  };

  const listParams = (
    size: number,
    page: number,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    "pagination[page]": String(page),
    "pagination[pageSize]": String(size),
    "pagination[withCount]": "true",
    sort: "id:asc",
    ...extra,
  });

  /**
   * The entries of one collection a page at a time, until every one is read. An answer over the size
   * limit is asked again with half as many, down to ten. A page that comes back empty before the total
   * is could-not-check, never the end of the list.
   */
  async function* entriesOf(
    type: string,
    authed: boolean,
    enforceCap: boolean,
    partial: () => unknown,
    extra: Record<string, string> = {},
  ): AsyncGenerator<RawEntry> {
    let page = 1;
    let size = pageSize;
    let read = 0;
    for (;;) {
      let body: Record<string, unknown>;
      try {
        body = await get(type, listParams(size, page, extra), authed, partial);
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          // Pages are counted in entries, so the page number is kept in step with the new size.
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          page = Math.floor(read / size) + 1;
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Strapi's answer for ${size} entries is larger than the 5 MB Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The collection was not read.`,
        );
      }
      const total = totalOf(body);
      if (enforceCap && total > cap)
        throw new AdapterCouldNotCheck(
          `The collection has ${total} entries, more than ${cap}, which is as many as Gaugeline reads from one collection.`,
        );
      // A single type answers one entry, not a list.
      const rows: unknown[] | undefined = Array.isArray(body.data)
        ? body.data
        : isRecord(body.data)
          ? [body.data]
          : body.data === null
            ? []
            : undefined;
      if (rows === undefined)
        throw new AdapterCouldNotCheck("Strapi answered with something that is not a list.");
      // The rows after the ones already read, in case the page size changed under us.
      const skip = Math.max(0, read - (page - 1) * size);
      for (const raw of rows.slice(skip)) yield parseEntry(raw);
      read = (page - 1) * size + rows.length;
      if (read >= total || isRecord(body.data)) return;
      if (rows.length === 0)
        throw new AdapterCouldNotCheck(
          `Strapi's list stopped after ${read} of ${total} entries, so the rest was not read.`,
        );
      page++;
    }
  }

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  /** One request for one entry: its total, nothing else. `fields[0]=updatedAt` keeps the answer small. */
  const countOf = async (
    type: string,
    authed: boolean,
    extra: Record<string, string>,
    partial: () => unknown,
  ): Promise<number> =>
    totalOf(
      await get(type, { ...listParams(1, 1, extra), "fields[0]": "updatedAt" }, authed, partial),
    );

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of named)
      out.push({ name, count: await countOf(name, true, {}, () => out.slice()) });
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    if (!named.includes(type)) return out;
    for await (const e of entriesOf(type, true, true, () => ({}))) {
      if (e.publishedAt === null) continue;
      for (const f of fields) if (hasValue(valueAt(e.data, f))) out[f] = (out[f] ?? 0) + 1;
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
      for await (const e of entriesOf(type, true, opts.limit === undefined, () => delivered)) {
        // Published is what Strapi lists by default; a row marked as a draft is not published, whatever listed it.
        if (e.publishedAt === null) continue;
        const updatedAt = e.updatedAt ?? e.publishedAt;
        if (updatedAt === undefined)
          throw new AdapterCouldNotCheck("Strapi answered with entries that have no update time.");
        if (since !== undefined && updatedAt < since) continue;
        const slug = slugOf(e);
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(e.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const url = resolveUrl({ id: e.id, type, ...(slug !== undefined ? { slug } : {}) });
        remaining--;
        delivered++;
        yield {
          id: e.id,
          type,
          ...(url !== "" ? { url } : {}),
          ...(slug !== undefined ? { slug } : {}),
          ...(e.publishedAt !== undefined ? { publishedAt: e.publishedAt } : {}),
          updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  /**
   * Strapi 5 lists drafts with `status=draft`; Strapi 4 with `publicationState=preview`. Strapi 5
   * refuses a parameter it does not know with HTTP 400, so the Strapi 5 spelling is asked first and
   * the Strapi 4 one only after that answer.
   */
  const DRAFT_PARAMS: readonly Record<string, string>[] = [
    { status: "draft" },
    { publicationState: "preview" },
  ];

  /** The entry total of the draft list, in whichever spelling this Strapi understands. */
  const draftTotal = async (
    type: string,
    authed: boolean,
    partial: () => unknown,
  ): Promise<{ total: number; extra: Record<string, string> }> => {
    let last: unknown;
    for (const extra of DRAFT_PARAMS) {
      try {
        return { total: await countOf(type, authed, extra, partial), extra };
      } catch (err) {
        if (err instanceof AdapterCouldNotCheck && /HTTP 400\b/.test(err.reason)) {
          last = err;
          continue;
        }
        throw err;
      }
    }
    throw last instanceof Error ? last : new AdapterCouldNotCheck("Strapi did not list drafts.");
  };

  /**
   * True when the token's draft list holds an entry the published list does not. Two counts per
   * collection and no entry is asked for beyond the first. A collection whose draft list the token is
   * refused (and whose published list it may read) has no draft the token can reach.
   */
  const draftsReachable = async (): Promise<boolean> => {
    needToken();
    let asked = 0;
    let failure: Error | undefined;
    let seen = false;
    for (const type of named) {
      try {
        const live = await countOf(type, true, {}, () => undefined);
        try {
          const { total } = await draftTotal(type, true, () => undefined);
          if (total > live) seen = true;
        } catch (err) {
          if (
            !(err instanceof AdapterCouldNotCheck) ||
            !/did not accept|may not read/.test(err.reason)
          )
            throw err;
        }
        asked++;
      } catch (err) {
        if (!(err instanceof AdapterCouldNotCheck)) throw err;
        failure ??= err;
      }
    }
    if (asked === 0) {
      if (failure) throw failure;
      throw new AdapterCouldNotCheck(
        'No collection is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and Strapi does not list its collections to an API token.',
      );
    }
    return seen;
  };

  const idsOf = async (
    type: string,
    extra: Record<string, string>,
    total: number,
  ): Promise<Set<string> | undefined> => {
    if (total > STRAPI_LIMITS.publicIds) return undefined;
    const out = new Set<string>();
    for await (const e of entriesOf(type, false, false, () => undefined, {
      ...extra,
      "fields[0]": "updatedAt",
    }))
      out.add(e.key);
    return out;
  };

  const publicDrafts: StrapiAdapter["publicDrafts"] = async (opts = {}) => {
    const out: StrapiPublicDrafts[] = [];
    const none = (type: string, state: StrapiPublicState, reason?: string): StrapiPublicDrafts => ({
      type,
      state,
      unpublished: 0,
      ids: [],
      ...(reason !== undefined ? { reason } : {}),
    });
    for (const type of named.filter((n) => opts.types === undefined || opts.types.includes(n))) {
      const partial = () => out.slice();
      let live: number;
      try {
        live = await countOf(type, false, {}, partial);
      } catch (err) {
        if (err instanceof AdapterRateLimitedError) throw err;
        if (
          err instanceof AdapterCouldNotCheck &&
          /does not show this collection|HTTP 404/.test(err.reason)
        ) {
          out.push(none(type, "private"));
          continue;
        }
        out.push(
          none(
            type,
            "unread",
            err instanceof AdapterCouldNotCheck ? err.reason : "unexpected error",
          ),
        );
        continue;
      }
      try {
        const { total, extra } = await draftTotal(type, false, partial);
        const unpublished = Math.max(0, total - live);
        if (unpublished === 0) {
          out.push(none(type, "nothing"));
          continue;
        }
        const drafts = await idsOf(type, extra, total);
        const livers = await idsOf(type, {}, live);
        const ids =
          drafts !== undefined && livers !== undefined
            ? [...drafts].filter((k) => !livers.has(k)).sort()
            : [];
        out.push({ type, state: "reachable", unpublished, ids });
      } catch (err) {
        if (err instanceof AdapterRateLimitedError) throw err;
        if (
          err instanceof AdapterCouldNotCheck &&
          /does not show this collection/.test(err.reason)
        ) {
          out.push(none(type, "refused"));
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
    id: "strapi",
    describe: () => STRAPI_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    collections: () => [...named],
    publicDrafts,
  };
}
