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

import { HUBSPOT_CMS_DESCRIPTION } from "./hubspot-cms.entry.js";
export { HUBSPOT_CMS_DESCRIPTION };

import { HUBSPOT_CMS_TOKEN } from "./hubspot-cms.entry.js";
export { HUBSPOT_CMS_TOKEN };

/**
 * HubSpot's API origin. Every address is built from it and no other, so the private app token is never
 * sent anywhere else (docs read 11 Nov 2026 was not reachable: the paths below are uncited, see the docs page).
 */
export const HUBSPOT_CMS_API = "https://api.hubapi.com";

/** Items asked for in one request. The API may answer with fewer: lists are stepped by the cursor it returns. */
export const HUBSPOT_CMS_PAGE_SIZE = 100;

/** Bounds a run keeps to, in the platform's terms. There are no flags to raise them. */
export const HUBSPOT_CMS_LIMITS = {
  /** Items read from one list. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
} as const;

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

const API_ORIGIN = new URL(HUBSPOT_CMS_API).origin;

/** The CMS lists that hold pages. The names are what gaugeline.adapters.json calls them. */
export const HUBSPOT_PAGE_KINDS = {
  "site-pages": "/cms/v3/pages/site-pages",
  "landing-pages": "/cms/v3/pages/landing-pages",
  "blog-posts": "/cms/v3/blogs/posts",
} as const;
export type HubspotPageKind = keyof typeof HUBSPOT_PAGE_KINDS;
const PAGE_KINDS = Object.keys(HUBSPOT_PAGE_KINDS) as HubspotPageKind[];

/** A HubDB table is the type `hubdb.<table name>`. */
export const HUBDB_PREFIX = "hubdb.";

/** The charset every id, name and slug segment from a response must have before it is used in an address. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CURSOR = /^[A-Za-z0-9_=-]{1,256}$/;
const FORM_ID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

export interface HubspotCmsAdapterOptions {
  /** HUBSPOT_CMS_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is hashed. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces HUBSPOT_CMS_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

/** A published page of the CMS, with where HubSpot says it lives. Ids, times and an address: never a field. */
export interface HubspotLivePage {
  id: string;
  kind: HubspotPageKind;
  slug?: string;
  /** The page's address on its live domain, when HubSpot gave a usable https one. */
  url?: string;
  /** The HubDB table this page is a dynamic page for (its id), when it is one. */
  hubdbTableId?: string;
}

export interface HubdbTable {
  id: string;
  name: string;
  published: boolean;
  /** Columns the table says hold a date or a date and time: their values are epoch milliseconds, not text. */
  dateColumns: string[];
}

/** A HubDB row as far as a comparison needs it: its id, its path, and the named columns as text, in memory only. */
export interface HubdbRow {
  id: string;
  path?: string;
  columns: Record<string, string | number | boolean>;
  /** Named columns that have a value here and are left out of `columns` because they cannot be compared with a page (dates). */
  notCompared: string[];
}

/** The adapter as the HubSpot reading uses it: the ContentAdapter plus the reads only HubSpot has. */
export interface HubspotCmsAdapter extends ContentAdapter {
  /** Published pages of one list (published only: a draft or an archived page is never yielded). */
  livePages(
    kind: HubspotPageKind,
    partial?: () => unknown,
    /** Called for each page whose state is not PUBLISHED, DRAFT or SCHEDULED (and not archived). */
    onUnrecognisedState?: () => void,
  ): AsyncGenerator<HubspotLivePage>;
  hubdbTables(): Promise<HubdbTable[]>;
  /** The published rows of one table, with only the named columns. */
  hubdbRows(
    table: string,
    columns: readonly string[],
    dateColumns?: readonly string[],
  ): Promise<HubdbRow[]>;
  /** The HubDB tables the settings name columns for: `{ table, columns }`. */
  hubdbNamed(): { table: string; columns: string[] }[];
  /** The portal (account) the token belongs to. */
  portalId(): Promise<string>;
  /** Whether a form is still in the portal. 404 and an archived form are "deleted". */
  formState(id: string): Promise<"exists" | "deleted">;
}

/** A part of the portal this key may not read (HTTP 403): the other parts are still read. */
export class PartRefused extends AdapterCouldNotCheck {}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value the platform gave (a string or milliseconds), or undefined. */
function isoOf(value: unknown): string | undefined {
  if ((typeof value !== "string" || value === "") && typeof value !== "number") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  const d = new Date(ms);
  return Number.isFinite(ms) && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
}

/** An id sent as a number or as text, if it has the safe charset. */
function safeId(v: unknown): string | undefined {
  const text = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  return typeof text === "string" && SAFE.test(text) ? text : undefined;
}

/** A page path ("about/team"): every segment has the safe charset. Anything else is no slug. */
function safeSlug(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "" || v.length > 256) return undefined;
  const parts = v.replace(/^\//, "").split("/");
  return parts.every((p) => SAFE.test(p)) ? parts.join("/") : undefined;
}

/** An https address with no credentials and a plain host, or undefined. Lone surrogates never throw. */
export function liveAddress(v: unknown): URL | undefined {
  if (typeof v !== "string" || v === "" || v.length > 2048) return undefined;
  try {
    const url = new URL(v);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    if (!/^[a-z0-9.-]+$/.test(url.hostname) || url.hostname.includes("..")) return undefined;
    return url;
  } catch {
    return undefined;
  }
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
  /** A state that is none of PUBLISHED, DRAFT, SCHEDULED (and the page is not archived): not counted as live, but counted. */
  unrecognisedState?: boolean;
  publishedAt?: string;
  updatedAt: string;
  url?: string;
  hubdbTableId?: string;
  data: Record<string, unknown>;
}

/** The page states Gaugeline knows are not live. Any other value but PUBLISHED is counted and reported (uncited). */
const KNOWN_NOT_LIVE = new Set(["DRAFT", "SCHEDULED"]);

const BAD_ITEMS = "HubSpot CMS answered with items that have no usable id or no update time.";

/** A page of the CMS (a site page, a landing page or a blog post). Archived pages are not published. */
function parsePage(raw: unknown): RawItem {
  const r = isRecord(raw) ? raw : {};
  const id = safeId(r.id);
  const publishedAt = isoOf(r.publishDate);
  const updatedAt = isoOf(r.updated) ?? publishedAt;
  if (id === undefined || updatedAt === undefined) throw new AdapterCouldNotCheck(BAD_ITEMS);
  const slug = safeSlug(r.slug);
  const url = liveAddress(r.url);
  const table = safeId(r.dynamicPageHubDbTableId);
  return {
    id,
    ...(slug !== undefined ? { slug } : {}),
    published: r.state === "PUBLISHED" && r.archived !== true,
    ...(r.archived !== true && r.state !== "PUBLISHED" && !KNOWN_NOT_LIVE.has(String(r.state))
      ? { unrecognisedState: true }
      : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    updatedAt,
    ...(url !== undefined ? { url: url.href } : {}),
    ...(table !== undefined ? { hubdbTableId: table } : {}),
    data: r,
  };
}

/** A row of a published HubDB table: the published list holds only published rows. */
function parseRow(raw: unknown): RawItem {
  const r = isRecord(raw) ? raw : {};
  const id = safeId(r.id);
  const publishedAt = isoOf(r.publishedAt);
  const updatedAt = isoOf(r.updatedAt) ?? publishedAt;
  if (id === undefined || updatedAt === undefined) throw new AdapterCouldNotCheck(BAD_ITEMS);
  const slug = safeSlug(r.path);
  return {
    id,
    ...(slug !== undefined ? { slug } : {}),
    published: true,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    updatedAt,
    data: isRecord(r.values) ? r.values : {},
  };
}

export function createHubspotCmsAdapter(options: HubspotCmsAdapterOptions): HubspotCmsAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? HUBSPOT_CMS_PAGE_SIZE, HUBSPOT_CMS_PAGE_SIZE),
  );
  const cap = options.maxItemsPerType ?? HUBSPOT_CMS_LIMITS.itemsPerType;
  const settings = options.settings;
  const redact = createRedactor(env, [HUBSPOT_CMS_TOKEN]);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return err.status === 401
        ? new AdapterCouldNotCheck(
            "HubSpot CMS did not accept HUBSPOT_CMS_TOKEN (HTTP 401). Check that it is a current private app token.",
          )
        : new PartRefused(
            "HubSpot did not let the token read this (HTTP 403). The private app needs the read scope for it (see docs/integrations/hubspot-cms).",
          );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? "HubSpot CMS answered HTTP 404: it has no such table, form or list."
          : `HubSpot CMS answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const keyOrThrow = (): string => {
    const key = (env[HUBSPOT_CMS_TOKEN] ?? "").trim();
    if (key === "")
      throw new AdapterCouldNotCheck(
        `${HUBSPOT_CMS_TOKEN} is not set. HubSpot's CMS API needs a private app token.`,
      );
    return key;
  };

  /**
   * One GET, parsed as a JSON object, to this API's origin and no other. The key goes in a header, never
   * in the address, and the fetcher drops it on a redirect to another origin.
   */
  const get = async (address: string, partial: () => unknown): Promise<Record<string, unknown>> => {
    if (new URL(address).origin !== API_ORIGIN)
      throw new AdapterCouldNotCheck("HubSpot CMS pointed at another address, which is not asked.");
    const key = keyOrThrow();
    try {
      const { body } = await getJson(
        {
          fetcher,
          request: { authorization: `Bearer ${key}`, headers: { accept: "application/json" } },
          sleep,
          system: "HubSpot CMS",
        },
        address,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck(
          "HubSpot CMS answered with something that is not an object.",
        );
      return body;
    } catch (err) {
      throw translate(err, partial());
    }
  };

  const address = (path: string, params: Record<string, string>): string => {
    const q = new URLSearchParams(params).toString();
    return `${HUBSPOT_CMS_API}${path}${q === "" ? "" : `?${q}`}`;
  };

  const totalOf = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

  /**
   * One list, a page at a time, to its real end. HubSpot pages by cursor (`paging.next.after`), and
   * a server may answer fewer items than asked, so the list ends where the cursor ends and nowhere
   * else. A cursor that is not plain, one seen before, an empty page that has a next, more items than
   * `maxRead` or fewer than the total says at the end are could-not-check, never a shorter list. An
   * answer over the size limit is asked again with half as many items, down to ten.
   */
  async function* listOf(
    path: string,
    extra: Record<string, string>,
    parse: (raw: unknown) => RawItem,
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawItem> {
    const maxPages = Math.ceil(cap / MIN_PAGE_SIZE) + 12;
    const seen = new Set<string>();
    let after: string | undefined;
    let size = pageSize;
    let read = 0;
    let asked = 0;
    for (;;) {
      if (++asked > maxPages)
        throw new AdapterCouldNotCheck(
          `HubSpot CMS needed more than ${maxPages} requests to list one type, so it was not read to the end.`,
        );
      let body: Record<string, unknown>;
      try {
        body = await get(
          address(path, {
            ...extra,
            limit: String(size),
            ...(after !== undefined ? { after } : {}),
          }),
          partial,
        );
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `HubSpot CMS's answer for ${size} items is larger than Gaugeline reads at once, even after asking for fewer items at a time (down to ${MIN_PAGE_SIZE}). The list was not read.`,
        );
      }
      const total = totalOf(body.total);
      if (enforceCap && total !== undefined && total > cap)
        throw new AdapterCouldNotCheck(
          `The list has ${total} items, more than ${cap}, which is as many as Gaugeline reads from one list.`,
        );
      if (!Array.isArray(body.results))
        throw new AdapterCouldNotCheck("HubSpot CMS answered with something that is not a list.");
      read += body.results.length;
      if (read > cap)
        throw new AdapterCouldNotCheck(
          `HubSpot CMS listed more than ${cap} items, which is as many as Gaugeline reads from one list, whatever total it reported.`,
        );
      for (const raw of body.results) yield parse(raw);
      const paging = isRecord(body.paging) ? body.paging : {};
      const next = isRecord(paging.next) ? paging.next : undefined;
      if (next === undefined) {
        if (total !== undefined && read < total)
          throw new AdapterCouldNotCheck(
            `HubSpot CMS's list stopped after ${read} of ${total} items, so the rest was not read.`,
          );
        return;
      }
      const cursor = typeof next.after === "string" ? next.after : "";
      if (!CURSOR.test(cursor) || seen.has(cursor) || cursor === after)
        throw new AdapterCouldNotCheck(
          "HubSpot CMS gave a cursor Gaugeline cannot follow (not plain, or one it had already been given), so the rest of the list was not read.",
        );
      if (body.results.length === 0)
        throw new AdapterCouldNotCheck(
          `HubSpot CMS's list stopped after ${read} items with more to come, so the rest was not read.`,
        );
      seen.add(cursor);
      after = cursor;
    }
  }

  const kindOf = (type: string): HubspotPageKind | undefined =>
    (PAGE_KINDS as string[]).includes(type) ? (type as HubspotPageKind) : undefined;
  const tableOf = (type: string): string | undefined => {
    if (!type.startsWith(HUBDB_PREFIX)) return undefined;
    const name = type.slice(HUBDB_PREFIX.length);
    return SAFE.test(name) ? name : undefined;
  };

  const itemsOf = (
    type: string,
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawItem> => {
    const kind = kindOf(type);
    if (kind !== undefined)
      return listOf(HUBSPOT_PAGE_KINDS[kind], {}, parsePage, enforceCap, partial);
    const table = tableOf(type);
    if (table !== undefined)
      return listOf(
        `/cms/v3/hubdb/tables/${encodeURIComponent(table)}/rows`,
        {},
        parseRow,
        enforceCap,
        partial,
      );
    throw new AdapterCouldNotCheck(
      `${type.slice(0, 80).replace(/[^\x20-\x7e]/g, "?")} is not a list this adapter reads: the names are site-pages, landing-pages, blog-posts and hubdb.<table>.`,
    );
  };

  const hubdbTables = async (partial: () => unknown = () => []): Promise<HubdbTable[]> => {
    const out: HubdbTable[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (let n = 0; n < 50; n++) {
      const body = await get(
        address("/cms/v3/hubdb/tables", {
          limit: String(pageSize),
          ...(after !== undefined ? { after } : {}),
        }),
        partial,
      );
      if (!Array.isArray(body.results))
        throw new AdapterCouldNotCheck("HubSpot CMS answered with something that is not a list.");
      for (const t of body.results) {
        const rec = isRecord(t) ? t : {};
        const id = safeId(rec.id);
        const name = typeof rec.name === "string" && SAFE.test(rec.name) ? rec.name : undefined;
        if (id === undefined || name === undefined)
          throw new AdapterCouldNotCheck(
            "HubSpot CMS answered with a table that has no usable id or name.",
          );
        const dateColumns = (Array.isArray(rec.columns) ? rec.columns : []).flatMap((c: unknown) =>
          isRecord(c) &&
          typeof c.name === "string" &&
          SAFE.test(c.name) &&
          /^DATE(TIME)?$/i.test(String(c.type))
            ? [c.name]
            : [],
        );
        out.push({ id, name, published: rec.published === true, dateColumns });
      }
      const paging = isRecord(body.paging) ? body.paging : {};
      const next = isRecord(paging.next) ? paging.next : undefined;
      if (next === undefined) {
        return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      }
      const cursor = typeof next.after === "string" ? next.after : "";
      if (!CURSOR.test(cursor) || seen.has(cursor) || body.results.length === 0)
        throw new AdapterCouldNotCheck(
          "HubSpot CMS gave a cursor Gaugeline cannot follow, so the list of tables was not read to the end.",
        );
      seen.add(cursor);
      after = cursor;
    }
    throw new AdapterCouldNotCheck("HubSpot CMS has more tables than Gaugeline reads.");
  };

  /** Every type this key can list: the three page lists and, when the token may read HubDB, its tables. */
  const typeNames = async (
    partial: () => unknown,
    skipped: { name: string; reason: string }[] = [],
  ): Promise<string[]> => {
    const names: string[] = [...PAGE_KINDS];
    try {
      for (const t of await hubdbTables(partial)) names.push(`${HUBDB_PREFIX}${t.name}`);
    } catch (err) {
      if (!(err instanceof PartRefused)) throw err;
      skipped.push({ name: "hubdb", reason: err.reason });
    }
    return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];
  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const name of await typeNames(() => out.slice(), skipped)) {
      try {
        let count = 0;
        for await (const item of itemsOf(name, true, () => out.slice()))
          if (item.published) count++;
        out.push({ name, count });
      } catch (err) {
        if (!(err instanceof PartRefused)) throw err;
        skipped.push({ name, reason: err.reason });
      }
    }
    // Every part refused is could-not-check, never an empty site; one part refused leaves the others read.
    const first = skipped[0];
    if (out.length === 0 && first !== undefined) throw new PartRefused(first.reason);
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    // A name HubSpot does not list is not "a type with no items": it is could-not-check.
    if (kindOf(type) === undefined && !(await typeNames(() => ({}))).includes(type))
      throw new AdapterCouldNotCheck(
        `HubSpot CMS has no list named ${type.slice(0, 80).replace(/[^\x20-\x7e]/g, "?")} (site-pages, landing-pages, blog-posts and hubdb.<table> are the names).`,
      );
    for await (const item of itemsOf(type, true, () => ({}))) {
      if (!item.published) continue;
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
    const all = opts.types === undefined || opts.types.some((t) => tableOf(t) !== undefined);
    const known = all ? await typeNames(() => delivered) : [...PAGE_KINDS];
    for (const type of opts.types ?? known) {
      if (remaining <= 0) return;
      if (!known.includes(type))
        throw new AdapterCouldNotCheck(
          `HubSpot CMS has no list named ${type.slice(0, 80).replace(/[^\x20-\x7e]/g, "?")}, so it was not read.`,
        );
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      for await (const item of itemsOf(type, opts.limit === undefined, () => delivered)) {
        if (!item.published) continue;
        if (since !== undefined && Date.parse(item.updatedAt) < Date.parse(since)) continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(item.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const templated = resolveUrl({
          id: item.id,
          type,
          ...(item.slug !== undefined ? { slug: item.slug } : {}),
        });
        const url = templated !== "" ? templated : item.url;
        remaining--;
        delivered++;
        yield {
          id: item.id,
          type,
          ...(url !== undefined && url !== "" ? { url } : {}),
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
   * True when the token can see a page that is not published (a draft, a scheduled page): the first one
   * found ends the read. A table that is not published counts too. A token that may not read a part
   * says nothing about it; one that may not read anything is could-not-check.
   */
  const draftsReachable = async (): Promise<boolean> => {
    let refused: string | undefined;
    let readAny = false;
    for (const kind of PAGE_KINDS) {
      try {
        for await (const item of itemsOf(kind, false, () => undefined)) {
          if (!item.published && item.data.archived !== true) return true;
        }
        readAny = true;
      } catch (err) {
        if (!(err instanceof PartRefused)) throw err;
        refused ??= err.reason;
      }
    }
    try {
      if ((await hubdbTables(() => undefined)).some((t) => !t.published)) return true;
      readAny = true;
    } catch (err) {
      if (!(err instanceof PartRefused)) throw err;
      refused ??= err.reason;
    }
    if (!readAny && refused !== undefined) throw new PartRefused(refused);
    return false;
  };

  async function* livePages(
    kind: HubspotPageKind,
    partial: () => unknown = () => undefined,
    onUnrecognisedState?: () => void,
  ): AsyncGenerator<HubspotLivePage> {
    for await (const item of itemsOf(kind, true, partial)) {
      if (item.unrecognisedState === true) onUnrecognisedState?.();
      if (!item.published) continue;
      yield {
        id: item.id,
        kind,
        ...(item.slug !== undefined ? { slug: item.slug } : {}),
        ...(item.url !== undefined ? { url: item.url } : {}),
        ...(item.hubdbTableId !== undefined ? { hubdbTableId: item.hubdbTableId } : {}),
      };
    }
  }

  const hubdbNamed = (): { table: string; columns: string[] }[] =>
    Object.entries(settings?.fingerprint ?? {})
      .filter(([type]) => tableOf(type) !== undefined)
      .map(([type, columns]) => ({ table: tableOf(type) ?? "", columns: [...columns] }))
      .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));

  /** HubDB date and datetime cells are epoch milliseconds: a whole number this large is a date, not a quantity. */
  const looksLikeEpoch = (v: unknown): boolean =>
    typeof v === "number" && Number.isInteger(v) && v >= 1e11 && v < 1e14;

  const hubdbRows = async (
    table: string,
    columns: readonly string[],
    dateColumns: readonly string[] = [],
  ): Promise<HubdbRow[]> => {
    if (!SAFE.test(table)) throw new AdapterCouldNotCheck("That is not a HubDB table name.");
    const rows: HubdbRow[] = [];
    for await (const item of listOf(
      `/cms/v3/hubdb/tables/${encodeURIComponent(table)}/rows`,
      {},
      parseRow,
      true,
      () => rows.slice(),
    )) {
      const cells: Record<string, string | number | boolean> = {};
      const notCompared: string[] = [];
      for (const c of columns) {
        const v = valueAt(item.data, c);
        if (
          (typeof v === "string" || typeof v === "number" || typeof v === "boolean") &&
          hasValue(v)
        ) {
          if (dateColumns.includes(c) || looksLikeEpoch(v)) notCompared.push(c);
          else cells[c] = v;
        }
      }
      rows.push({
        id: item.id,
        ...(item.slug !== undefined ? { path: item.slug } : {}),
        columns: cells,
        notCompared,
      });
    }
    return rows;
  };

  const portalId = async (): Promise<string> => {
    const body = await get(address("/account-info/v3/details", {}), () => undefined);
    const id = safeId(body.portalId);
    if (id === undefined)
      throw new AdapterCouldNotCheck("HubSpot did not say which portal the token belongs to.");
    return id;
  };

  const formState = async (id: string): Promise<"exists" | "deleted"> => {
    if (!FORM_ID.test(id)) throw new AdapterCouldNotCheck("That is not a HubSpot form id.");
    try {
      const body = await get(
        address(`/marketing/v3/forms/${encodeURIComponent(id)}`, {}),
        () => undefined,
      );
      return body.archived === true ? "deleted" : "exists";
    } catch (err) {
      if (err instanceof AdapterCouldNotCheck && /HTTP 404/.test(err.reason)) return "deleted";
      throw err;
    }
  };

  return {
    id: "hubspot-cms",
    describe: () => HUBSPOT_CMS_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    livePages,
    hubdbTables: () => hubdbTables(),
    hubdbRows,
    hubdbNamed,
    portalId,
    formState,
  };
}
