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

import { CONTENTFUL_DESCRIPTION } from "./contentful.entry.js";
export { CONTENTFUL_DESCRIPTION };

import {
  CONTENTFUL_DELIVERY_TOKEN,
  CONTENTFUL_ENVIRONMENT,
  CONTENTFUL_PREVIEW_TOKEN,
  CONTENTFUL_SPACE_ID,
} from "./contentful.entry.js";
export {
  CONTENTFUL_DELIVERY_TOKEN,
  CONTENTFUL_ENVIRONMENT,
  CONTENTFUL_PREVIEW_TOKEN,
  CONTENTFUL_SPACE_ID,
};

/** The Content Delivery API (published content) and the Content Preview API (drafts too). */
export const CONTENTFUL_CDA = "https://cdn.contentful.com";
export const CONTENTFUL_CPA = "https://preview.contentful.com";

/** Entries asked for in one request. The API's maximum is 1000; 100 keeps an answer well under its size limit. */
export const CONTENTFUL_PAGE_SIZE = 100;

/** Bounds a run keeps to, in the platform's terms. There are no flags to raise them. */
export const CONTENTFUL_LIMITS = {
  /** Entries read from one content type. A bigger one is could-not-check, never a count of part of it. */
  entriesPerType: 10_000,
  /** Content types read. A space has a few hundred at most; a longer list is could-not-check, not read to its end. */
  contentTypes: 1000,
  /** Pages of content types asked for, so a server that sends one item a page cannot keep a run going. */
  contentTypePages: 20,
} as const;

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A Contentful space id is 12 lower-case letters and digits; accept a little more, nothing that could change an address. */
const SPACE_ID = /^[A-Za-z0-9]{6,32}$/;
/** An environment id: letters, digits, underscore, hyphen and dot. */
const ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/**
 * A slug or an id used as a part of an address: it starts with a letter or digit and holds only letters,
 * digits, dot, hyphen and underscore, up to 128 characters. Nothing else can become `..`, a path or a query.
 */
const ADDRESS_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A lone surrogate half: `encodeURIComponent` throws on one, so text that has one is never put in an address. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (text: string): boolean => !LONE_SURROGATE.test(text);

/** A content type, with the ids of its fields (the names a `select` may use). */
export interface ContentfulType {
  id: string;
  fields: readonly string[];
}

export interface ContentfulAdapterOptions {
  /** CONTENTFUL_SPACE_ID, CONTENTFUL_DELIVERY_TOKEN and, optionally, CONTENTFUL_ENVIRONMENT and CONTENTFUL_PREVIEW_TOKEN. */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is hashed. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces CONTENTFUL_LIMITS.entriesPerType. For tests. */
  maxEntriesPerType?: number | undefined;
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

/** The part of a field name a `select` can name: Contentful selects `fields.<id>`, not a path inside it. */
const topLevel = (field: string): string => field.split(".")[0] ?? field;

interface RawEntry {
  id: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

function parseEntry(raw: unknown): RawEntry {
  const r = isRecord(raw) ? raw : {};
  const sys = isRecord(r.sys) ? r.sys : {};
  const id = sys.id;
  const updatedAt = isoOf(sys.updatedAt) ?? isoOf(sys.createdAt);
  if (typeof id !== "string" || id === "" || updatedAt === undefined)
    throw new AdapterCouldNotCheck(
      "Contentful answered with entries that have no id or no update time.",
    );
  if (!wellFormed(id))
    throw new AdapterCouldNotCheck("Contentful answered with an entry id that is not valid text.");
  return { id, updatedAt, data: isRecord(r.fields) ? r.fields : {} };
}

export function createContentfulAdapter(options: ContentfulAdapterOptions): ContentAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? CONTENTFUL_PAGE_SIZE, CONTENTFUL_PAGE_SIZE),
  );
  const cap = options.maxEntriesPerType ?? CONTENTFUL_LIMITS.entriesPerType;
  const settings = options.settings;
  const redact = createRedactor(env, [CONTENTFUL_DELIVERY_TOKEN, CONTENTFUL_PREVIEW_TOKEN]);
  let known: ContentfulType[] | undefined;

  type Api = "delivery" | "preview";

  const translate = (err: unknown, partial: unknown, api: Api): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    const token = api === "delivery" ? CONTENTFUL_DELIVERY_TOKEN : CONTENTFUL_PREVIEW_TOKEN;
    const name = api === "delivery" ? "delivery" : "preview";
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        `Contentful did not accept ${token} (HTTP ${err.status}). Check that it is a current ${name} token for this space, made under Settings, API keys.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `Contentful answered HTTP 404: it has no such space, environment or content type for this ${name} token. Check ${CONTENTFUL_SPACE_ID} and ${CONTENTFUL_ENVIRONMENT}, and that the token is enabled for that environment.`
          : `Contentful answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const tokenOrThrow = (api: Api): string => {
    const name = api === "delivery" ? CONTENTFUL_DELIVERY_TOKEN : CONTENTFUL_PREVIEW_TOKEN;
    const token = (env[name] ?? "").trim();
    if (token === "")
      throw new AdapterCouldNotCheck(
        `${name} is not set. Contentful's content needs a ${api === "delivery" ? "Content Delivery API access" : "Content Preview API access"} token.`,
      );
    return token;
  };

  /** The base address of the space and environment, or could-not-check when the settings are not usable. */
  const base = (api: Api): string => {
    const space = (env[CONTENTFUL_SPACE_ID] ?? "").trim();
    if (space === "")
      throw new AdapterCouldNotCheck(
        `${CONTENTFUL_SPACE_ID} is not set. It is the space's id, shown under Settings, General settings.`,
      );
    if (!SPACE_ID.test(space))
      throw new AdapterCouldNotCheck(
        `${CONTENTFUL_SPACE_ID} is not a Contentful space id (letters and digits).`,
      );
    const environment = (env[CONTENTFUL_ENVIRONMENT] ?? "").trim() || "master";
    if (!ENVIRONMENT_ID.test(environment))
      throw new AdapterCouldNotCheck(
        `${CONTENTFUL_ENVIRONMENT} is not a Contentful environment id (letters, digits, hyphen, underscore, dot).`,
      );
    return `${api === "delivery" ? CONTENTFUL_CDA : CONTENTFUL_CPA}/spaces/${encodeURIComponent(space)}/environments/${encodeURIComponent(environment)}`;
  };

  /** One GET. The token goes in an Authorization header, never in the address (not as access_token). */
  const get = async (
    api: Api,
    path: string,
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    const token = tokenOrThrow(api);
    const url = `${base(api)}${path}`;
    try {
      const { body } = await getJson(
        {
          fetcher,
          request: { authorization: `Bearer ${token}`, headers: { accept: "application/json" } },
          sleep,
          system: "Contentful",
        },
        url,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Contentful answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial(), api);
    }
  };

  const totalOf = (body: Record<string, unknown>): number => {
    const total = body.total;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new AdapterCouldNotCheck(
        "Contentful answered with something that is not a count of entries.",
      );
    return total;
  };

  /** Every content type, 1000 a page (the API's maximum), sorted by id. */
  const contentTypes = async (): Promise<ContentfulType[]> => {
    if (known) return known;
    const out: ContentfulType[] = [];
    let skip = 0;
    let pages = 0;
    for (;;) {
      pages++;
      const body = await get("delivery", `/content_types?limit=1000&skip=${skip}`, () => []);
      const items = body.items;
      if (!Array.isArray(items))
        throw new AdapterCouldNotCheck(
          "Contentful answered with something that is not a list of content types.",
        );
      for (const t of items) {
        const r = isRecord(t) ? t : {};
        const id = isRecord(r.sys) ? r.sys.id : undefined;
        if (typeof id !== "string" || id === "")
          throw new AdapterCouldNotCheck("Contentful answered with a content type that has no id.");
        if (!wellFormed(id))
          throw new AdapterCouldNotCheck(
            "Contentful answered with a content type id that is not valid text.",
          );
        const fields = Array.isArray(r.fields)
          ? r.fields.flatMap((f) => (isRecord(f) && typeof f.id === "string" ? [f.id] : []))
          : [];
        out.push({ id, fields });
      }
      skip += items.length;
      if (skip >= totalOf(body)) break;
      if (items.length === 0)
        throw new AdapterCouldNotCheck(
          `Contentful's list of content types stopped after ${skip}, so the rest was not read.`,
        );
      if (skip >= CONTENTFUL_LIMITS.contentTypes || pages >= CONTENTFUL_LIMITS.contentTypePages)
        throw new AdapterCouldNotCheck(
          `Contentful has more than ${skip} content types, more than Gaugeline reads (${CONTENTFUL_LIMITS.contentTypes}), so none was read.`,
        );
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    known = out;
    return out;
  };

  const chosen = async (names: readonly string[] | undefined): Promise<ContentfulType[]> => {
    const all = await contentTypes();
    if (names === undefined) return all;
    const missing = names.filter((n) => !all.some((t) => t.id === n));
    if (missing.length > 0)
      throw new AdapterCouldNotCheck(
        `The space has no content type named ${missing.join(", ")}. Its content types are: ${all.map((t) => t.id).join(", ") || "none"}.`,
      );
    return all.filter((t) => names.includes(t.id));
  };

  /**
   * `select` names what comes back: the system part and only the fields asked for. A field the
   * content type does not have is not selected, so the API is never asked for a name it does not know.
   * `include=0` keeps linked entries and assets (with their field values) out of the answer; `since`
   * becomes `sys.updatedAt[gte]`, so Contentful does the filtering and a limit counts what matches.
   * The content type's id was checked to be well-formed text when the list of types was read.
   */
  const entriesPath = (
    type: ContentfulType,
    fields: readonly string[],
    limit: number,
    skip: number,
    since?: string,
  ): string => {
    const selected = [...new Set(fields.map(topLevel))].filter((f) => type.fields.includes(f));
    const select = ["sys", ...selected.map((f) => `fields.${f}`)].join(",");
    return `/entries?content_type=${encodeURIComponent(type.id)}&select=${encodeURIComponent(select)}&include=0&order=sys.createdAt&limit=${limit}&skip=${skip}${since !== undefined ? `&sys.updatedAt%5Bgte%5D=${encodeURIComponent(since)}` : ""}`;
  };

  /**
   * The published entries of one content type, a page at a time, until every one is read. An answer
   * over the size limit is asked again with half as many entries, down to ten; a list that comes back
   * empty before its total is could-not-check.
   */
  async function* entriesOf(
    type: ContentfulType,
    fields: readonly string[],
    enforceCap: boolean,
    partial: () => unknown,
    since?: string,
  ): AsyncGenerator<RawEntry> {
    let skip = 0;
    let size = pageSize;
    for (;;) {
      let body: Record<string, unknown>;
      try {
        body = await get("delivery", entriesPath(type, fields, size, skip, since), partial);
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Contentful's answer for ${size} entries is larger than the 5 MB Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The content type was not read.`,
        );
      }
      const total = totalOf(body);
      if (enforceCap && total > cap)
        throw new AdapterCouldNotCheck(
          `The content type has ${total} entries, more than ${cap}, which is as many as Gaugeline reads from one content type.`,
        );
      if (!Array.isArray(body.items))
        throw new AdapterCouldNotCheck(
          "Contentful answered with something that is not a list of entries.",
        );
      for (const raw of body.items) yield parseEntry(raw);
      skip += body.items.length;
      if (skip >= total) return;
      if (body.items.length === 0)
        throw new AdapterCouldNotCheck(
          `Contentful's list stopped after ${skip} of ${total} entries, so the rest was not read.`,
        );
      // However the read was asked for (a limit, a since the server might ignore), it stops at the bound.
      if (skip >= cap)
        throw new AdapterCouldNotCheck(
          `The content type has more than ${cap} entries to read, which is as many as Gaugeline reads from one content type.`,
        );
    }
  }

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    if (template === undefined) return "";
    // An id or slug that could change the address (`..`, a slash) or throw in the encoder makes no address.
    if (!wellFormed(doc.id) || (doc.slug !== undefined && !ADDRESS_PART.test(doc.slug))) return "";
    if (!ADDRESS_PART.test(doc.id)) return "";
    try {
      return fillUrlTemplate(template, doc);
    } catch {
      return "";
    }
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const t of await contentTypes()) {
      const body = await get("delivery", entriesPath(t, [], 1, 0), () => out.slice());
      out.push({ name: t.id, count: totalOf(body) });
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
      const hashed = opts.fields?.[t.id] ?? settings?.fingerprint?.[t.id] ?? [];
      // The slug is read to make the entry's address; it is an address part, not content.
      const asked = t.fields.includes("slug") ? [...hashed, "slug"] : hashed;
      for await (const entry of entriesOf(
        t,
        asked,
        opts.limit === undefined,
        () => delivered,
        since,
      )) {
        if (since !== undefined && Date.parse(entry.updatedAt) < Date.parse(since)) continue;
        const s = entry.data.slug;
        // A slug that is not a plain address part is dropped: the entry has no address, and says why in the read.
        const slug = typeof s === "string" && ADDRESS_PART.test(s) ? s : undefined;
        const fieldHashes: Record<string, string> = {};
        for (const f of hashed) {
          const h = hashValue(valueAt(entry.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const url = resolveUrl({
          id: entry.id,
          type: t.id,
          ...(slug !== undefined ? { slug } : {}),
        });
        remaining--;
        delivered++;
        yield {
          id: entry.id,
          type: t.id,
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
   * Can the key reach unpublished work? The delivery API serves published entries and nothing else,
   * so with a delivery token alone the answer is no (after one read that proves the token works). When
   * CONTENTFUL_PREVIEW_TOKEN is set, the preview API's count is compared with the delivery count for
   * each content type: more entries there means drafts the preview token reaches.
   */
  const draftsReachable = async (): Promise<boolean> => {
    const all = await contentTypes();
    if ((env[CONTENTFUL_PREVIEW_TOKEN] ?? "").trim() === "") return false;
    for (const t of all) {
      const preview = totalOf(await get("preview", entriesPath(t, [], 1, 0), () => undefined));
      const live = totalOf(await get("delivery", entriesPath(t, [], 1, 0), () => undefined));
      if (preview > live) return true;
    }
    return false;
  };

  return {
    id: "contentful",
    describe: () => CONTENTFUL_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
  };
}
