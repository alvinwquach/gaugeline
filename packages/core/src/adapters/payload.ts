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
  PAYLOAD_API_KEY,
  PAYLOAD_DEFAULT_AUTH_COLLECTION,
  PAYLOAD_DESCRIPTION,
  PAYLOAD_ENV_VARS,
  PAYLOAD_LIMITS,
  PAYLOAD_PAGE_SIZE,
  PAYLOAD_URL,
} from "./payload.entry.js";
export {
  PAYLOAD_API_KEY,
  PAYLOAD_DEFAULT_AUTH_COLLECTION,
  PAYLOAD_DESCRIPTION,
  PAYLOAD_ENV_VARS,
  PAYLOAD_LIMITS,
  PAYLOAD_PAGE_SIZE,
  PAYLOAD_URL,
};

/** The page size is never asked smaller than this: a page is made smaller only while the answer is too big, down to this and no further. */
const MIN_PAGE_SIZE = 5;

/** What an API key looks like: printable ASCII with no space. Anything else is a paste mistake, and is never sent. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

/**
 * A collection slug (and the auth collection's) is kebab-case, as Payload's own documentation requires, and at most
 * 64 characters; anything else never goes into an address or a header.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const validSlug = (s: string): boolean => s.length <= 64 && SLUG.test(s);

/** The text Payload answers a refusal with (its English message, `errors[0].message`); another language is not recognised, and is could-not-check. */
const FORBIDDEN_MESSAGE = "You are not allowed to perform this action.";

/**
 * How a collection answered a visitor who sent no key:
 * - `public`: it listed at least one document. A visitor can read it.
 * - `empty`: it answered with no documents. A visitor may read it, but an empty list shows nothing to count.
 * - `closed`: a 403 that carries Payload's own error answer. Payload looks a collection up before it looks at
 *   access, so a collection that does not exist is a 404, never this: the spelling is confirmed.
 * - `unread`: the answer could not be read; `reason` says why.
 */
export type PayloadPublicState = "public" | "empty" | "closed" | "unread";

export interface PayloadPublicCollection {
  type: string;
  state: PayloadPublicState;
  /** Documents the answer counted (`totalDocs`), or 1 when it gave no count and listed one document. */
  listed: number;
  /** True when `listed` is a count the server reported, false when it is "at least this many". */
  exact: boolean;
  reason?: string;
}

/** The Payload adapter, plus the one read the privacy check needs (what a visitor with no key can list). */
export interface PayloadAdapter extends ContentAdapter {
  /** The collections the settings name (under `urls` or `fingerprint`), in order. */
  collections(): string[];
  /** The collections the settings mark private (`privateCollections`), in the order given. */
  privateCollections(): string[];
  /**
   * What a visitor with NO key can list of the collections the settings mark private: one GET each, with `limit=1`
   * and `select[id]=true`, sent with no key. It requests collections that are meant not to be public, so a caller
   * runs it only with the owner's consent (CLAUDE.md rule 14).
   */
  publicCollections(): Promise<PayloadPublicCollection[]>;
}

export interface PayloadAdapterOptions {
  /** PAYLOAD_URL and, optionally, PAYLOAD_API_KEY, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry. Its `urls` and `fingerprint` keys name the collections to read; `authCollection` names the key's user collection. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces PAYLOAD_LIMITS.itemsPerType. For tests. */
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

/**
 * The next smaller page size: the largest proper divisor of the size that is at most half of it (100, 50, 25, 5). It
 * divides the size, so the documents already read are always a whole number of the new pages and `page` stays exact.
 */
function smaller(size: number): number | undefined {
  if (size <= MIN_PAGE_SIZE) return undefined;
  for (let d = Math.floor(size / 2); d >= 1; d--) if (size % d === 0) return d;
  return undefined;
}

/** A document as the adapter keeps it: its id, status and times, and the field data only until it is hashed or counted. */
interface RawDoc {
  id: string;
  /** The `_status` text. null: the field is there and is not text. undefined: the answer has no `_status` field. */
  status: string | null | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
  data: Record<string, unknown>;
}

/** An id is a whole number or a non-empty text (an ObjectId, a UUID); anything else is not a document. */
function idOf(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  if (typeof raw === "string" && raw !== "") return raw;
  return undefined;
}

function parseDoc(raw: unknown): RawDoc {
  const r = isRecord(raw) ? raw : {};
  const id = idOf(r.id);
  if (id === undefined)
    throw new AdapterCouldNotCheck("Payload answered with documents that have no id.");
  // Only a MISSING key means the collection has no drafts. A key with a value that is not text (0, false, an
  // object) is a status Gaugeline cannot read as "published": the document is not live.
  const status = !Object.hasOwn(r, "_status")
    ? undefined
    : typeof r._status === "string"
      ? r._status
      : null;
  return {
    id,
    status,
    createdAt: isoOf(r.createdAt),
    updatedAt: isoOf(r.updatedAt),
    data: r,
  };
}

/** Published is what `_status` says; a collection that answers no `_status` has no drafts to hold back. */
const isLive = (d: RawDoc): boolean => d.status === undefined || d.status === "published";

const slugOf = (d: RawDoc): string | undefined => {
  const s = d.data.slug;
  return typeof s === "string" && s !== "" ? s : undefined;
};

export function createPayloadAdapter(options: PayloadAdapterOptions): PayloadAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? PAYLOAD_PAGE_SIZE, PAYLOAD_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? PAYLOAD_LIMITS.itemsPerType;
  const settings = options.settings;
  const key = (env[PAYLOAD_API_KEY] ?? "").trim();
  const authCollection = settings?.authCollection ?? PAYLOAD_DEFAULT_AUTH_COLLECTION;
  const redact = createRedactor(env, [PAYLOAD_API_KEY]);

  /** The collections the settings name, sorted: the adapter does not ask Payload to list its collections. */
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
          ? `Payload would not let ${PAYLOAD_API_KEY} read this (HTTP ${err.status}). Payload answers this for a key it does not recognise (a wrong key, a key of a user in another collection than "${authCollection}", or a key made before the server's secret changed) and for a user whose access rules do not allow reading the collection: check the key, the authCollection setting and the user's access.`
          : `Payload does not show this collection to a visitor with no key (HTTP ${err.status}).`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `Payload answered HTTP 404: there is no collection with that slug, or nothing is at ${PAYLOAD_URL}. Check the spelling, and that the address includes Payload's API route (normally /api, as in https://cms.client.example/api).`
          : `Payload answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The API's address, or a could-not-check that names the variable. */
  const site = (): URL => {
    const text = (env[PAYLOAD_URL] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${PAYLOAD_URL} is not set.`);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new AdapterCouldNotCheck(
        `${PAYLOAD_URL} is not an address (expected https://cms.client.example/api).`,
      );
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new AdapterCouldNotCheck(
        `${PAYLOAD_URL} must be an http or https address with no user name or password in it.`,
      );
    return url;
  };

  /** The address of one collection's list, with a query made only of Gaugeline's own fixed names and numbers. */
  const listUrl = (base: URL, type: string, params: Record<string, string>): string => {
    const root = base.pathname.replace(/\/+$/, "");
    const query = new URLSearchParams(params).toString();
    return `${base.origin}${root}/${encodeURIComponent(type)}${query === "" ? "" : `?${query}`}`;
  };

  /**
   * One GET of a collection's list, parsed as JSON. The key goes in a header, never in the address, only when
   * `authed`, only over https, and only to the first address's origin (a redirect to another origin is followed
   * without it).
   */
  const get = async (
    type: string,
    params: Record<string, string>,
    authed: boolean,
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    try {
      if (!validSlug(type))
        throw new AdapterCouldNotCheck(
          `"${type}" is not a Payload collection slug (lower-case letters, digits and hyphens).`,
        );
      const base = site();
      const sendKey = authed && key !== "";
      if (sendKey && !validSlug(authCollection))
        throw new AdapterCouldNotCheck(
          `"${authCollection}" is not a Payload collection slug, so authCollection in gaugeline.adapters.json is wrong.`,
        );
      if (sendKey && !KEY_SHAPE.test(key))
        throw new AdapterCouldNotCheck(
          `${PAYLOAD_API_KEY} has a space, a line break or a character that is not plain ASCII in it, so it is not an API key. Copy it again without anything around it.`,
        );
      if (sendKey && base.protocol !== "https:")
        throw new AdapterCouldNotCheck(
          `${PAYLOAD_URL} is an http address, and ${PAYLOAD_API_KEY} is not sent over plain http.`,
        );
      const { body } = await getJson(
        {
          fetcher,
          request: {
            // A request with no key is a visitor's: nothing the fetcher adds per address goes with it.
            ...(sendKey
              ? { authorization: `${authCollection} API-Key ${key}` }
              : { anonymous: true }),
            headers: { accept: "application/json" },
          },
          sleep,
          system: "Payload",
        },
        listUrl(base, type, params),
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Payload answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial(), authed);
    }
  };

  /** The `totalDocs` an answer reports: a whole number, or could-not-check (a count is never guessed). */
  const totalOf = (body: Record<string, unknown>): number => {
    const n = body.totalDocs;
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
    throw new AdapterCouldNotCheck(
      "Payload's answer has no totalDocs count, so the list cannot be checked against it.",
    );
  };

  /** The documents of an answer: a list, or could-not-check. */
  const docsOf = (body: Record<string, unknown>): unknown[] => {
    if (Array.isArray(body.docs)) return body.docs;
    throw new AdapterCouldNotCheck(
      "Payload answered with something that is not a list of documents.",
    );
  };

  /**
   * The documents of one collection a page at a time, until every one is read. The order is fixed (`sort=id`), and
   * `page` is the number of documents already read divided by the page size, plus one: a page that holds fewer than
   * the size asked for while Payload says there is more is could-not-check, so the arithmetic is never off. The end is
   * the reported `totalDocs`: the list is read to exactly that many, and every id is seen once. A `totalDocs` that
   * moves, a repeated id, an empty page before the end, `hasNextPage` that disagrees with the count, or a list longer
   * than `cap` is could-not-check, never the end of the list. An answer over the size limit is asked again with a
   * smaller page, down to five; a `select` Payload refuses (HTTP 400) is dropped once and whole documents asked for.
   */
  async function* docsIn(
    type: string,
    authed: boolean,
    enforceCap: boolean,
    partial: () => unknown,
    opts: { select?: readonly string[] } = {},
  ): AsyncGenerator<RawDoc> {
    const maxPages = Math.ceil(cap / MIN_PAGE_SIZE) + 12;
    let select =
      opts.select !== undefined && opts.select.length > 0 ? [...new Set(opts.select)] : undefined;
    let size = pageSize;
    let read = 0;
    let asked = 0;
    // Ids already delivered in this read: a repeat means the server ignored `page`, or the list moved under us.
    const seen = new Set<string>();
    let firstTotal: number | undefined;
    for (;;) {
      if (++asked > maxPages)
        throw new AdapterCouldNotCheck(
          `Payload needed more than ${maxPages} requests to list one collection, so it was not read to the end.`,
        );
      const page = read / size + 1;
      let body: Record<string, unknown>;
      try {
        body = await get(
          type,
          {
            limit: String(size),
            page: String(page),
            sort: "id",
            depth: "0",
            ...(select !== undefined
              ? Object.fromEntries(select.map((f) => [`select[${f}]`, "true"]))
              : {}),
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
        const next = smaller(size);
        if (next !== undefined) {
          size = next;
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Payload's answer for ${size} documents is larger than the 5 MB Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The collection was not read.`,
        );
      }
      const total = totalOf(body);
      firstTotal ??= total;
      if (total !== firstTotal)
        throw new AdapterCouldNotCheck(
          `The list changed while it was read: Payload reported ${firstTotal} documents and then ${total}.`,
        );
      if (enforceCap && total > cap)
        throw new AdapterCouldNotCheck(
          `The collection has ${total} documents, more than ${cap}, which is as many as Gaugeline reads from one collection.`,
        );
      if (body.page !== page)
        throw new AdapterCouldNotCheck(
          `Payload answered page ${String(body.page)} when page ${page} was asked for, so the list is not reliable.`,
        );
      const hasNext = body.hasNextPage;
      if (typeof hasNext !== "boolean")
        throw new AdapterCouldNotCheck(
          "Payload's answer does not say whether there is another page, so the list cannot be checked.",
        );
      const rows = docsOf(body);
      if (rows.length > size)
        throw new AdapterCouldNotCheck(
          `Payload listed ${rows.length} documents when ${size} were asked for, so the list is not reliable.`,
        );
      if (read + rows.length > cap)
        throw new AdapterCouldNotCheck(
          `Payload listed more documents than the ${cap} Gaugeline reads from one collection, whatever count it reported.`,
        );
      for (const raw of rows) {
        const d = parseDoc(raw);
        if (seen.has(d.id))
          throw new AdapterCouldNotCheck(
            `Payload listed the same document twice (id ${d.id}) while one collection was read, so the list is not reliable: the server may ignore page, or documents were added or removed during the read.`,
          );
        seen.add(d.id);
        yield d;
      }
      read += rows.length;
      if (read > total)
        throw new AdapterCouldNotCheck(
          `The list changed while it was read: Payload reported ${total} documents and ${read} came back.`,
        );
      if (read === total) {
        if (hasNext)
          throw new AdapterCouldNotCheck(
            `Payload says there is another page after all ${total} documents were read, so the list is not reliable.`,
          );
        return;
      }
      if (rows.length === 0 || !hasNext)
        throw new AdapterCouldNotCheck(
          `Payload's list stopped after ${read} of ${total} documents, so the rest was not read.`,
        );
      if (rows.length < size)
        throw new AdapterCouldNotCheck(
          `Payload listed ${rows.length} documents when ${size} were asked for and says there are more, so the list cannot be read page by page.`,
        );
    }
  }

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  /** Every document of a collection is read to count the live ones, so a count and `published()` always agree on what live means. */
  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of named) {
      const partial = () => out.slice();
      let count = 0;
      for await (const d of docsIn(name, true, true, partial, { select: ["_status"] }))
        if (isLive(d)) count++;
      out.push({ name, count });
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
    const select = ["_status", "createdAt", "updatedAt", ...topLevel(fields)];
    for await (const d of docsIn(type, true, true, () => ({}), { select })) {
      if (!isLive(d)) continue;
      for (const f of fields) if (hasValue(valueAt(d.data, f))) out[f] = (out[f] ?? 0) + 1;
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
        "_status",
        ...(wantsSlug ? ["slug"] : []),
        "createdAt",
        "updatedAt",
        ...topLevel(fields),
      ];
      for await (const d of docsIn(type, true, opts.limit === undefined, () => delivered, {
        select,
      })) {
        // Published is what `_status` says; a draft is not live, whatever listed it.
        if (!isLive(d)) continue;
        const updatedAt = d.updatedAt ?? d.createdAt;
        if (updatedAt === undefined)
          throw new AdapterCouldNotCheck(
            "Payload answered with documents that have neither updatedAt nor createdAt, so their update time is unknown.",
          );
        if (since !== undefined && updatedAt < since) continue;
        const slug = slugOf(d);
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(d.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const url = resolveUrl({ id: d.id, type, ...(slug !== undefined ? { slug } : {}) });
        remaining--;
        delivered++;
        yield {
          id: d.id,
          type,
          ...(url !== "" ? { url } : {}),
          ...(slug !== undefined ? { slug } : {}),
          // Payload has no publish date of its own: createdAt (when the document was first saved) is what the
          // recipe for Payload uses too, so the two readings agree. updatedAt is the time that matters for change.
          ...(d.createdAt !== undefined ? { publishedAt: d.createdAt } : {}),
          updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  const needKey = (): void => {
    if (key === "")
      throw new AdapterCouldNotCheck(
        `${PAYLOAD_API_KEY} is not set. Unpublished documents need an API key of a user whose access rules can read them.`,
      );
  };

  /**
   * How many documents of a collection are drafts (`_status` equals draft): one small request (`limit=1`, `select` of
   * the status only), reading the count `totalDocs` and nothing else. A `where` Payload refuses with 400 is a
   * collection with no drafts only if one whole document confirms it has no `_status`; an empty collection, or a
   * document that has one, leaves the refusal standing (could-not-check), so a server that dislikes the query is never
   * read as "no drafts".
   */
  const draftCount = async (
    type: string,
    partial: () => unknown,
  ): Promise<number | "no-status"> => {
    try {
      const body = await get(
        type,
        {
          limit: "1",
          page: "1",
          depth: "0",
          "select[_status]": "true",
          "where[_status][equals]": "draft",
        },
        true,
        partial,
      );
      const n = totalOf(body);
      // A server or proxy that drops the where answers the whole collection's count: the one row asked for must be a draft.
      if (n > 0) {
        const first = docsOf(body)[0];
        if (!isRecord(first) || first._status !== "draft")
          throw new AdapterCouldNotCheck(
            "Payload's count of drafts is not backed by a draft document in the answer, so the filter may have been ignored; drafts could not be told.",
          );
      }
      return n;
    } catch (err) {
      if (!(err instanceof AdapterCouldNotCheck) || !/HTTP 400\b/.test(err.reason)) throw err;
      const first = docsOf(
        await get(type, { limit: "1", page: "1", depth: "0" }, true, partial),
      )[0];
      if (isRecord(first) && !("_status" in first)) return "no-status";
      throw err;
    }
  };

  /**
   * True when the key can read a document that is a draft, in any collection the settings name. One small request per
   * collection, a count only. A collection with no `_status` has no drafts. When a collection could not be asked and
   * no other showed drafts, the answer is could-not-check, never "no".
   */
  const draftsReachable = async (): Promise<boolean> => {
    needKey();
    if (named.length === 0)
      throw new AdapterCouldNotCheck(
        'No collection is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and Gaugeline does not ask Payload to list its collections.',
      );
    let failure: AdapterCouldNotCheck | undefined;
    for (const type of named) {
      try {
        const n = await draftCount(type, () => undefined);
        if (n !== "no-status" && n > 0) return true;
      } catch (err) {
        if (!(err instanceof AdapterCouldNotCheck)) throw err;
        failure ??= err;
      }
    }
    if (failure) throw failure;
    return false;
  };

  /** True when the body is Payload's refusal: `{ errors: [{ message }] }` with Payload's own English message. */
  const isPayloadRefusal = (text: string | undefined): boolean => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text ?? "");
    } catch {
      return false;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return false;
    const first: unknown = parsed.errors[0];
    return isRecord(first) && first.message === FORBIDDEN_MESSAGE;
  };

  /**
   * One keyless GET (the fetcher's `anonymous` request: no key, no cookie, nothing added per address), read directly
   * because the answer's BODY matters: a 403 means "closed" only when it is Payload that sent it (its error answer),
   * never when it is a firewall or CDN page.
   */
  const anonymousProbe = async (
    type: string,
    partial: () => unknown,
  ): Promise<PayloadPublicCollection> => {
    const none = (state: PayloadPublicState, reason?: string): PayloadPublicCollection => ({
      type,
      state,
      listed: 0,
      exact: true,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (!validSlug(type))
      return none(
        "unread",
        `"${type}" is not a Payload collection slug (lower-case letters, digits and hyphens).`,
      );
    const url = listUrl(site(), type, {
      limit: "1",
      page: "1",
      depth: "0",
      "select[id]": "true",
    });
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
      if (!hop) return none("unread", "Payload gave no answer.");
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
      return none("unread", "Payload's answer was larger than a page should be.");
    if (hop.status === 403)
      return isPayloadRefusal(hop.body)
        ? none("closed")
        : none(
            "unread",
            "HTTP 403 that is not Payload's refusal (no Payload error message in it, or one in another language than English): a firewall, a CDN or another server may be answering for Payload.",
          );
    if (hop.status >= 300 && hop.status < 400)
      return none(
        "unread",
        `Payload answered HTTP ${hop.status}, a redirect, which a visitor request does not follow (the place it points to says nothing about this collection). Check ${PAYLOAD_URL}.`,
      );
    if (hop.status === 404)
      return none(
        "unread",
        `HTTP 404: Payload has no collection with this slug, or ${PAYLOAD_URL} is not Payload's API address (it should include the API route, normally /api). Check the spelling in privateCollections.`,
      );
    if (hop.status < 200 || hop.status >= 300)
      return none("unread", `Payload answered HTTP ${hop.status}.`);
    let body: unknown;
    try {
      body = JSON.parse(hop.body ?? "");
    } catch {
      return none("unread", "Payload answered with something that is not JSON.");
    }
    if (!isRecord(body) || !Array.isArray(body.docs))
      return none("unread", "Payload answered with something that is not a list of documents.");
    const rows = body.docs;
    const n =
      typeof body.totalDocs === "number" &&
      Number.isSafeInteger(body.totalDocs) &&
      body.totalDocs >= 0
        ? body.totalDocs
        : undefined;
    if (rows.length === 0 && (n === undefined || n === 0)) return none("empty");
    // A count that disagrees with the rows is not a count: say so rather than pick one.
    if ((rows.length > 0 && n === 0) || (rows.length === 0 && (n ?? 0) > 0))
      return none("unread", "Payload's count and its list disagree, so nothing was counted.");
    return { type, state: "public", listed: Math.max(n ?? 0, rows.length), exact: n !== undefined };
  };

  const publicCollections: PayloadAdapter["publicCollections"] = async () => {
    const out: PayloadPublicCollection[] = [];
    for (const type of priv) {
      try {
        out.push(await anonymousProbe(type, () => out.slice()));
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
    id: "payload",
    describe: () => PAYLOAD_DESCRIPTION,
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
