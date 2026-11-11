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

import {
  CONTENTSTACK_API_KEY,
  CONTENTSTACK_DELIVERY_TOKEN,
  CONTENTSTACK_ENVIRONMENT,
  CONTENTSTACK_REGION,
} from "./contentstack.entry.js";
export {
  CONTENTSTACK_API_KEY,
  CONTENTSTACK_DELIVERY_TOKEN,
  CONTENTSTACK_ENVIRONMENT,
  CONTENTSTACK_REGION,
};

/**
 * The Content Delivery API's hosts, one per region: the allowlist. A region is a name from this table and
 * never a host the person types, so the key can only go to a Contentstack delivery host. au and the two gcp
 * hosts are from memory (uncited: the vendor's page was not reachable when this was written).
 */
export const CONTENTSTACK_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  us: "cdn.contentstack.io",
  eu: "eu-cdn.contentstack.com",
  au: "au-cdn.contentstack.com",
  "azure-na": "azure-na-cdn.contentstack.com",
  "azure-eu": "azure-eu-cdn.contentstack.com",
  "gcp-na": "gcp-na-cdn.contentstack.com",
  "gcp-eu": "gcp-eu-cdn.contentstack.com",
});

/** Entries asked for in one request: the API's own maximum (uncited: 100). */
export const CONTENTSTACK_PAGE_SIZE = 100;

/** Bounds a run keeps to, in the platform's terms. There are no flags to raise them. */
export const CONTENTSTACK_LIMITS = {
  /** Entries read from one content type. A bigger one is could-not-check, never a count of part of it. */
  entriesPerType: 10_000,
  /** Content types read. A stack has a few hundred at most; a longer list is could-not-check, not read to its end. */
  contentTypes: 1000,
  /** Pages of content types asked for, so a server that sends one a page cannot keep a run going. */
  contentTypePages: 40,
  /** Requests in one run (one adapter), retries included: a server that answers one entry a page cannot cost more. */
  requestsPerRun: 3000,
} as const;

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A header value Gaugeline sends: letters, digits, hyphen and underscore. Nothing that could split a header. */
const HEADER_VALUE = /^[A-Za-z0-9_-]{8,200}$/;
/** An environment name: it goes into an address, so only plain characters. */
const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A uid or slug used as a part of an address: it starts with a letter or digit and holds only letters,
 * digits, dot, hyphen and underscore, up to 128 characters. Nothing else can become `..`, a path or a query.
 */
const ADDRESS_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A path from an entry's URL field: one leading slash, plain characters, no empty or dot segment. */
const ENTRY_PATH = /^\/(?:[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*\/?)?$/;

/** A lone surrogate half: `encodeURIComponent` throws on one, so text that has one is never put in an address. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (text: string): boolean => !LONE_SURROGATE.test(text);

/** A content type, with the uids of its fields (the names `only[BASE][]` may use). */
export interface ContentstackType {
  uid: string;
  fields: readonly string[];
}

export interface ContentstackAdapterOptions {
  /** CONTENTSTACK_API_KEY, CONTENTSTACK_DELIVERY_TOKEN, CONTENTSTACK_ENVIRONMENT and, optionally, CONTENTSTACK_REGION. */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is hashed. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces CONTENTSTACK_LIMITS.entriesPerType. For tests. */
  maxEntriesPerType?: number | undefined;
  /** Replaces CONTENTSTACK_LIMITS.requestsPerRun. For tests. */
  maxRequests?: number | undefined;
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

/** The part of a field name `only[BASE][]` can name: the field's uid, not a path inside it. */
const topLevel = (field: string): string => field.split(".")[0] ?? field;

/** The last part of a page path, when it is a plain address part: the entry's slug. */
function slugOf(path: string | undefined): string | undefined {
  const last = path
    ?.split("/")
    .filter((s) => s !== "")
    .at(-1);
  return last !== undefined && ADDRESS_PART.test(last) ? last : undefined;
}

interface RawEntry {
  id: string;
  updatedAt: string;
  /** The entry's URL field when it is one plain path (one leading slash); never a host. */
  path?: string;
  data: Record<string, unknown>;
}

function parseEntry(raw: unknown): RawEntry {
  const r = isRecord(raw) ? raw : {};
  const id = r.uid;
  const createdAt = isoOf(r.created_at);
  const updatedAt = isoOf(r.updated_at) ?? createdAt;
  if (typeof id !== "string" || id === "" || updatedAt === undefined)
    throw new AdapterCouldNotCheck(
      "Contentstack answered with entries that have no uid or no update time.",
    );
  if (!wellFormed(id) || !ADDRESS_PART.test(id))
    throw new AdapterCouldNotCheck("Contentstack answered with an entry uid that is not valid.");
  const url = r.url;
  const path =
    typeof url === "string" &&
    url.length <= 512 &&
    ENTRY_PATH.test(url) &&
    !/%2f|%5c/i.test(url) &&
    !url.split("/").some((s) => /^(?:\.|%2e){1,2}$/i.test(s))
      ? url
      : undefined;
  return {
    id,
    updatedAt,
    ...(path !== undefined ? { path } : {}),
    data: r,
  };
}

export function createContentstackAdapter(options: ContentstackAdapterOptions): ContentAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? CONTENTSTACK_PAGE_SIZE, CONTENTSTACK_PAGE_SIZE),
  );
  const cap = options.maxEntriesPerType ?? CONTENTSTACK_LIMITS.entriesPerType;
  const maxRequests = options.maxRequests ?? CONTENTSTACK_LIMITS.requestsPerRun;
  let requests = 0;
  const settings = options.settings;
  const redact = createRedactor(env, [CONTENTSTACK_API_KEY, CONTENTSTACK_DELIVERY_TOKEN]);
  let known: ContentstackType[] | undefined;

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check in fixed words. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        err.status === 401
          ? `Contentstack did not accept ${CONTENTSTACK_DELIVERY_TOKEN} or ${CONTENTSTACK_API_KEY} (HTTP 401). Check that the token is a current delivery token for this stack, made under Settings, Tokens, Delivery Tokens.`
          : `Contentstack did not let the delivery token read this (HTTP ${err.status}). A delivery token reads only what is published to its own environment: check that it is for the environment named in ${CONTENTSTACK_ENVIRONMENT}.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404 || err.status === 422
          ? `Contentstack answered HTTP ${err.status}: it has no such content type or environment for this delivery token. Check ${CONTENTSTACK_ENVIRONMENT}, ${CONTENTSTACK_REGION} and that the token is for that environment.`
          : `Contentstack answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The delivery host for the configured region, from the allowlist; no other host is ever used. */
  const hostOrThrow = (): string => {
    const region = (env[CONTENTSTACK_REGION] ?? "").trim().toLowerCase() || "us";
    const host = Object.hasOwn(CONTENTSTACK_HOSTS, region) ? CONTENTSTACK_HOSTS[region] : undefined;
    if (host === undefined)
      throw new AdapterCouldNotCheck(
        `${CONTENTSTACK_REGION} is not a Contentstack region Gaugeline knows. Use one of: ${Object.keys(CONTENTSTACK_HOSTS).join(", ")}.`,
      );
    return host;
  };

  const environmentOrThrow = (): string => {
    const name = (env[CONTENTSTACK_ENVIRONMENT] ?? "").trim();
    if (name === "")
      throw new AdapterCouldNotCheck(
        `${CONTENTSTACK_ENVIRONMENT} is not set. It is the environment the delivery token is for, such as production; Gaugeline does not guess it.`,
      );
    if (!ENVIRONMENT_NAME.test(name))
      throw new AdapterCouldNotCheck(
        `${CONTENTSTACK_ENVIRONMENT} is not a Contentstack environment name (letters, digits, hyphen, underscore, dot).`,
      );
    return name;
  };

  /** The two header values, or could-not-check naming the variable that is missing or malformed. */
  const credentialsOrThrow = (): { apiKey: string; token: string } => {
    const out = { apiKey: "", token: "" };
    for (const [name, slot] of [
      [CONTENTSTACK_API_KEY, "apiKey"],
      [CONTENTSTACK_DELIVERY_TOKEN, "token"],
    ] as const) {
      const value = (env[name] ?? "").trim();
      if (value === "")
        throw new AdapterCouldNotCheck(
          `${name} is not set. Contentstack's content needs the stack's API key and a delivery token.`,
        );
      if (!HEADER_VALUE.test(value))
        throw new AdapterCouldNotCheck(`${name} is not a Contentstack key (letters and digits).`);
      out[slot] = value;
    }
    return out;
  };

  /**
   * One GET, to the region's delivery host over https and no other. The stack's API key and the delivery
   * token go in headers (`api_key`, `access_token`), never in the address; the fetcher sends them to the
   * first address's origin only, so a redirect elsewhere carries neither.
   */
  const get = async (path: string, partial: () => unknown): Promise<Record<string, unknown>> => {
    const { apiKey, token } = credentialsOrThrow();
    if (requests >= maxRequests)
      throw translate(
        new AdapterCouldNotCheck(
          `A run reads at most ${maxRequests} requests from Contentstack; this one needed more, so the rest was not read.`,
        ),
        partial(),
      );
    requests++;
    const url = `https://${hostOrThrow()}${path}`;
    try {
      const { body } = await getJson(
        {
          fetcher,
          request: {
            headers: { accept: "application/json", api_key: apiKey, access_token: token },
          },
          sleep,
          system: "Contentstack",
        },
        url,
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

  const countOf = (body: Record<string, unknown>): number => {
    const total = body.count;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new AdapterCouldNotCheck(
        "Contentstack answered with something that is not a count of entries.",
      );
    return total;
  };

  /** Every content type, a page at a time stepped by what came back, sorted by uid. */
  const contentTypes = async (): Promise<ContentstackType[]> => {
    if (known) return known;
    const out: ContentstackType[] = [];
    let skip = 0;
    let pages = 0;
    for (;;) {
      pages++;
      const body = await get(
        `/v3/content_types?include_count=true&limit=100&skip=${skip}`,
        () => [],
      );
      const list = body.content_types;
      if (!Array.isArray(list))
        throw new AdapterCouldNotCheck(
          "Contentstack answered with something that is not a list of content types.",
        );
      for (const t of list) {
        const r = isRecord(t) ? t : {};
        const uid = r.uid;
        if (typeof uid !== "string" || uid === "")
          throw new AdapterCouldNotCheck(
            "Contentstack answered with a content type that has no uid.",
          );
        if (!wellFormed(uid) || !ADDRESS_PART.test(uid))
          throw new AdapterCouldNotCheck(
            "Contentstack answered with a content type uid that is not valid.",
          );
        const fields = Array.isArray(r.schema)
          ? r.schema.flatMap((f) => (isRecord(f) && typeof f.uid === "string" ? [f.uid] : []))
          : [];
        if (fields.some((f) => !wellFormed(f) || !ADDRESS_PART.test(f)))
          throw new AdapterCouldNotCheck(
            "Contentstack answered with a field uid that is not valid.",
          );
        out.push({ uid, fields });
      }
      skip += list.length;
      if (skip >= countOf(body)) break;
      if (list.length === 0)
        throw new AdapterCouldNotCheck(
          `Contentstack's list of content types stopped after ${skip}, so the rest was not read.`,
        );
      if (skip >= CONTENTSTACK_LIMITS.contentTypes || pages >= CONTENTSTACK_LIMITS.contentTypePages)
        throw new AdapterCouldNotCheck(
          `Contentstack has more than ${skip} content types, more than Gaugeline reads (${CONTENTSTACK_LIMITS.contentTypes}), so none was read.`,
        );
    }
    out.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    known = out;
    return out;
  };

  const chosen = async (names: readonly string[] | undefined): Promise<ContentstackType[]> => {
    const all = await contentTypes();
    if (names === undefined) return all;
    const missing = names.filter((n) => !all.some((t) => t.uid === n));
    if (missing.length > 0)
      throw new AdapterCouldNotCheck(
        `The stack has no content type named ${missing.join(", ")}, or the delivery token cannot see it. Its content types are: ${all.map((t) => t.uid).join(", ") || "none"}.`,
      );
    return all.filter((t) => names.includes(t.uid));
  };

  /**
   * `only[BASE][]` names what comes back besides the system fields: the URL field (when the type has one) and
   * only the fields asked for. A field the type does not have is not asked for. No `include[]`, so
   * referenced entries and assets are never expanded into the answer. `asc=created_at` keeps skip paging
   * stable while the list is read.
   */
  const entriesPath = (
    type: ContentstackType,
    fields: readonly string[],
    limit: number,
    skip: number,
  ): string => {
    const wanted = [...new Set(fields.map(topLevel))].filter((f) => type.fields.includes(f));
    if (type.fields.includes("url") && !wanted.includes("url")) wanted.push("url");
    const only = wanted.map((f) => `&only%5BBASE%5D%5B%5D=${encodeURIComponent(f)}`).join("");
    return `/v3/content_types/${encodeURIComponent(type.uid)}/entries?environment=${encodeURIComponent(environmentOrThrow())}&include_count=true&asc=created_at&limit=${limit}&skip=${skip}${only}`;
  };

  /**
   * The published entries of one content type, a page at a time, until every one is read. The next page
   * starts after the entries that came back, not after the page size asked for, so a server that clamps the
   * page never silently shortens the list. An answer over the size limit is asked again with half as many
   * entries, down to ten; a list that comes back empty before its count is could-not-check.
   */
  async function* entriesOf(
    type: ContentstackType,
    fields: readonly string[],
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawEntry> {
    let skip = 0;
    let size = pageSize;
    let pages = 0;
    const pageCap = Math.ceil(cap / MIN_PAGE_SIZE) + 1;
    const seen = new Set<string>();
    for (;;) {
      let body: Record<string, unknown>;
      try {
        body = await get(entriesPath(type, fields, size, skip), partial);
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Contentstack's answer for ${size} entries is larger than Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The content type was not read.`,
        );
      }
      const total = countOf(body);
      if (enforceCap && total > cap)
        throw new AdapterCouldNotCheck(
          `The content type has ${total} entries, more than ${cap}, which is as many as Gaugeline reads from one content type.`,
        );
      if (!Array.isArray(body.entries))
        throw new AdapterCouldNotCheck(
          "Contentstack answered with something that is not a list of entries.",
        );
      pages++;
      const batch = body.entries.map(parseEntry);
      // A server that answers the same entries for every page is never counted or yielded twice.
      for (const entry of batch) {
        if (seen.has(entry.id))
          throw new AdapterCouldNotCheck(
            "Contentstack sent the same entry more than once while a list was read, so the list was not trusted.",
          );
        seen.add(entry.id);
      }
      for (const entry of batch) yield entry;
      skip += batch.length;
      if (skip >= total) return;
      if (body.entries.length === 0)
        throw new AdapterCouldNotCheck(
          `Contentstack's list stopped after ${skip} of ${total} entries, so the rest was not read.`,
        );
      // However the server counts, the read stops at the bound.
      if (skip >= cap)
        throw new AdapterCouldNotCheck(
          `The content type has more than ${cap} entries to read, which is as many as Gaugeline reads from one content type.`,
        );
      if (pages >= pageCap)
        throw new AdapterCouldNotCheck(
          `Contentstack sent its entries in pages too small to read ${total} entries in ${pageCap} pages, so the rest was not read.`,
        );
    }
  }

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    if (template === undefined) return "";
    // An id or slug that could change the address (`..`, a slash) or throw in the encoder makes no address.
    if (!wellFormed(doc.id) || !ADDRESS_PART.test(doc.id)) return "";
    if (doc.slug !== undefined && !ADDRESS_PART.test(doc.slug)) return "";
    try {
      return fillUrlTemplate(template, doc);
    } catch {
      return "";
    }
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const t of await contentTypes()) {
      // A type the token may not read is could-not-check by name, never a count of 0 ("nothing published").
      let body: Record<string, unknown>;
      try {
        body = await get(entriesPath(t, [], 1, 0), () => out.slice());
      } catch (err) {
        if (err instanceof AdapterCouldNotCheck)
          throw new AdapterCouldNotCheck(`${t.uid}: ${err.reason}`);
        throw err;
      }
      out.push({ name: t.uid, count: countOf(body) });
    }
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for (const t of await chosen([type]))
      for await (const entry of entriesOf(t, fields, true, () => ({})))
        for (const f of fields) if (hasValue(valueAt(entry.data, f))) out[f] = (out[f] ?? 0) + 1;
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
    for (const t of await chosen(opts.types)) {
      if (remaining <= 0) return;
      const hashed = opts.fields?.[t.uid] ?? settings?.fingerprint?.[t.uid] ?? [];
      for await (const entry of entriesOf(t, hashed, opts.limit === undefined, () => delivered)) {
        if (since !== undefined && Date.parse(entry.updatedAt) < Date.parse(since)) continue;
        const slug = slugOf(entry.path);
        const fieldHashes: Record<string, string> = {};
        for (const f of hashed) {
          const h = hashValue(valueAt(entry.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        // A configured pattern wins; otherwise the entry's own URL field, a path on the live site.
        const templated = resolveUrl({
          id: entry.id,
          type: t.uid,
          ...(slug !== undefined ? { slug } : {}),
        });
        const url = templated !== "" ? templated : (entry.path ?? "");
        remaining--;
        delivered++;
        yield {
          id: entry.id,
          type: t.uid,
          ...(url !== "" ? { url } : {}),
          ...(slug !== undefined ? { slug } : {}),
          updatedAt: entry.updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  /**
   * Can the key reach unpublished work? A delivery token is made for one environment and the Content
   * Delivery API serves only what is published to it, so the answer is no; the read that proves it is a
   * list of the content types, which fails (could-not-check) when the token or the stack key is not
   * accepted. The Preview API is never asked: Gaugeline takes no preview token.
   */
  const draftsReachable = async (): Promise<boolean> => {
    await contentTypes();
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
