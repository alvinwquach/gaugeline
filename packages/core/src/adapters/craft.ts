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
  CRAFT_DESCRIPTION,
  CRAFT_ENV_VARS,
  CRAFT_LIMITS,
  CRAFT_PAGE_SIZE,
  CRAFT_TOKEN,
  CRAFT_URL,
} from "./craft.entry.js";
export { CRAFT_DESCRIPTION, CRAFT_ENV_VARS, CRAFT_LIMITS, CRAFT_PAGE_SIZE, CRAFT_TOKEN, CRAFT_URL };

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A section handle, a site handle, a GraphQL field or type name, an id: the only forms that ever go into a query or an id. */
const HANDLE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const GQL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The statuses Craft gives an element. `live` is published: enabled, enabled for the site, posted and not expired. */
const ALL_STATUSES = '["live", "pending", "expired", "disabled"]';

/** The most characters of a path or uri that is used. A longer one is not an address. */
const MAX_PATH = 512;

/** A page of one section's entries, as the platform answered it. */
export interface CraftNode {
  /** Craft's element id, shared by the entry on every site it exists in. */
  id: string;
  siteHandle: string;
  slug?: string;
  /** The entry's own address: an origin and a path, or only a path. Absent when the entry has no page. */
  address?: { origin?: string; path: string };
  published: boolean;
  publishedAt?: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

/** One live entry as the Craft check needs it: ids, site, slug and the address its page should have. No field. */
export interface CraftLiveEntry {
  /** `<element id>.<site handle>`: the same entry on two sites is two items. */
  id: string;
  section: string;
  siteHandle: string;
  slug?: string;
  /** Where its page is: an absolute address on the entry's own site, or a path (from the settings' pattern, or from a Craft site with no base address). */
  url?: string;
  /** True when `url` came from the settings' `urls` pattern for the section, which does not know which site an entry is on. */
  patterned: boolean;
}

/** The Craft adapter: ContentAdapter, plus the two reads the Craft check needs. */
export interface CraftAdapter extends ContentAdapter {
  /** The sections the settings name (under `urls` or `fingerprint`), in order. */
  sections(): string[];
  /**
   * Refuses (AdapterCouldNotCheck) a token whose schema allows mutations, and a missing or malformed CRAFT_URL.
   * Called once before the first read; a key that cannot be shown to be query-only because introspection is off passes.
   */
  checkKey(): Promise<void>;
  /** The live entries of the named sections, on every site or on the one site handle, with the address of each page. */
  liveEntries(options?: {
    types?: readonly string[];
    site?: string;
  }): AsyncGenerator<CraftLiveEntry>;
}

export interface CraftAdapterOptions {
  /** CRAFT_URL and, optionally, CRAFT_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry. Its `urls` and `fingerprint` keys name the sections to read. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces CRAFT_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value the platform gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field counts as present when it has a value: not missing, null, an empty string, an empty list or an empty object. */
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

/** Characters that never belong in a path taken from an answer: control characters, backslash, and a lone surrogate. */
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f\\]/;
const wellFormed = (s: string): boolean =>
  typeof s.isWellFormed === "function" ? s.isWellFormed() : !/[\ud800-\udfff]/.test(s);

/**
 * A path that is one site's own page: a single leading slash, no `//`, no `.` or `..` segment (written or
 * percent-encoded), no encoded slash or backslash, no control character. Anything else is not an address.
 */
export function safePath(path: string): string | undefined {
  if (path.length === 0 || path.length > MAX_PATH || path[0] !== "/" || path.startsWith("//"))
    return undefined;
  if (BAD_CHARS.test(path) || !wellFormed(path) || path.includes("//")) return undefined;
  if (/%(2e|2f|5c|00)/i.test(path)) return undefined;
  for (const seg of path.split("/").slice(1)) if (seg === "." || seg === "..") return undefined;
  return path;
}

/** The path Craft's `uri` stands for: `__home__` is the front page; a uri has no leading slash. */
function pathOfUri(uri: string): string | undefined {
  if (uri === "__home__") return "/";
  if (uri.length === 0 || uri.length > MAX_PATH) return undefined;
  if (/[?#%]/.test(uri) || BAD_CHARS.test(uri) || !wellFormed(uri)) return undefined;
  if (uri.startsWith("/")) return undefined;
  const segs = uri.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return safePath(`/${segs.map((s) => encodeURIComponent(s)).join("/")}`);
}

/** The address of an entry's page from the `url` and `uri` Craft gave. A `url` that is not a plain http(s) address on a host is none. */
function addressOfEntry(url: unknown, uri: unknown): CraftNode["address"] {
  if (typeof url === "string" && url !== "") {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if (
      (u.protocol !== "https:" && u.protocol !== "http:") ||
      u.username !== "" ||
      u.password !== ""
    )
      return undefined;
    const path = safePath(u.pathname);
    return path === undefined ? undefined : { origin: u.origin, path };
  }
  if (typeof uri === "string") {
    const path = pathOfUri(uri);
    return path === undefined ? undefined : { path };
  }
  return undefined;
}

/** A slug that is safe to show and to put in an address: no separator, no control character, not long. */
function slugOf(v: unknown): string | undefined {
  if (typeof v !== "string" || v === "" || v.length > 200) return undefined;
  if (/[/?#%]/.test(v) || BAD_CHARS.test(v) || !wellFormed(v)) return undefined;
  return v;
}

/** A field to read: a plain name (a field on every entry, like `title`), or `<entryTypeHandle>_Entry.<field>` for a custom field. */
interface FieldSpec {
  spec: string;
  alias: string;
  on?: string;
  name: string;
}

function parseFieldSpecs(fields: readonly string[]): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const spec of new Set(fields)) {
    const dot = spec.indexOf(".");
    const on = dot === -1 ? undefined : spec.slice(0, dot);
    const name = dot === -1 ? spec : spec.slice(dot + 1);
    if (!GQL_NAME.test(name) || (on !== undefined && !GQL_NAME.test(on)))
      throw new AdapterCouldNotCheck(
        `"${spec.length > 60 ? `${spec.slice(0, 60)}...` : spec}" is not a Craft field to read. Write a field handle such as title, or the entry type's GraphQL type and the handle, such as article_Entry.summary.`,
      );
    out.push({ spec, alias: `f${out.length}`, ...(on !== undefined ? { on } : {}), name });
  }
  return out;
}

/** The part of a query that asks for these fields: built-in ones on the entry, custom ones in an inline fragment for their type. */
function selectionOf(specs: readonly FieldSpec[]): string {
  const plain = specs.filter((s) => s.on === undefined).map((s) => `${s.alias}: ${s.name}`);
  const byType = new Map<string, string[]>();
  for (const s of specs)
    if (s.on !== undefined)
      byType.set(s.on, [...(byType.get(s.on) ?? []), `${s.alias}: ${s.name}`]);
  const fragments = [...byType].map(([on, list]) => `... on ${on} { ${list.join(" ")} }`);
  return [...plain, ...fragments].join(" ");
}

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

export function createCraftAdapter(options: CraftAdapterOptions): CraftAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? CRAFT_PAGE_SIZE, CRAFT_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? CRAFT_LIMITS.itemsPerType;
  const settings = options.settings;
  const token = (env[CRAFT_TOKEN] ?? "").trim();
  const redact = createRedactor(env, [CRAFT_TOKEN]);

  /** The sections the settings name, sorted: Craft lists its sections only to a schema that opted in (5.12 and later). */
  const named = [
    ...new Set([...Object.keys(settings?.urls ?? {}), ...Object.keys(settings?.fingerprint ?? {})]),
  ].sort();

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        token !== ""
          ? `Craft CMS did not accept ${CRAFT_TOKEN}, or its schema may not read this (HTTP ${err.status}). Check that it is a current schema token and that the schema allows queries on this section.`
          : `Craft CMS's public schema does not show this to a visitor (HTTP ${err.status}). Set ${CRAFT_TOKEN} to a schema token that can query the section.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 400
          ? `Craft CMS answered HTTP 400. Craft answers 400 to an invalid token and to a query it cannot run: check ${CRAFT_TOKEN} and that ${CRAFT_URL} is the site's GraphQL route.`
          : err.status === 404
            ? `Craft CMS answered HTTP 404: there is no GraphQL route at ${CRAFT_URL}.`
            : `Craft CMS answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The GraphQL route, or a could-not-check that names the variable. https only: the token never goes over plain http. */
  const endpoint = (): URL => {
    const text = (env[CRAFT_URL] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${CRAFT_URL} is not set.`);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new AdapterCouldNotCheck(
        `${CRAFT_URL} is not an address (expected https://cms.client.example/api).`,
      );
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "")
      throw new AdapterCouldNotCheck(
        `${CRAFT_URL} must be an https address with no user name, password or fragment in it.`,
      );
    return url;
  };

  /** A GraphQL document, refused unless it is a query: nothing else is ever built, and nothing else is ever sent. */
  const readOnly = (document: string): string => {
    if (/(^|[^A-Za-z0-9_])(mutation|subscription)\b/i.test(document))
      throw new Error("Only a GraphQL query is ever built.");
    return document;
  };

  /**
   * One GET with the document in the `query` parameter (Craft's documented GET form), parsed as a JSON
   * object. The token goes in a header, never in the address, only over https and only to the route's origin
   * (a redirect to another origin or to http is followed without it). With no token the request is a
   * visitor's: Craft answers from its public schema, if that is enabled.
   */
  const get = async (
    document: string,
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    try {
      const base = endpoint();
      const address = new URL(base.href);
      address.searchParams.set("query", readOnly(document));
      if (address.origin !== base.origin)
        throw new AdapterCouldNotCheck("Craft CMS pointed at another address, which is not asked.");
      const { body } = await getJson(
        {
          fetcher,
          request: {
            ...(token !== "" ? { authorization: `Bearer ${token}` } : { anonymous: true }),
            headers: { accept: "application/json" },
          },
          sleep,
          system: "Craft CMS",
        },
        address.href,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Craft CMS answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial());
    }
  };

  /** The `data` of a GraphQL answer. An answer with errors is could-not-check, and its messages (which may quote content) are not repeated. */
  const dataOf = (body: Record<string, unknown>): Record<string, unknown> => {
    if (Array.isArray(body.errors) && body.errors.length > 0)
      throw new AdapterCouldNotCheck(
        `Craft CMS refused the query (${body.errors.length} GraphQL error${body.errors.length === 1 ? "" : "s"}). The usual cause is a schema that does not include this section, or a field that is not on the entry type.`,
      );
    if (!isRecord(body.data))
      throw new AdapterCouldNotCheck("Craft CMS answered with something that has no data.");
    return body.data;
  };

  /** True once the token is known to be query-only (or cannot be shown not to be). A refusal is remembered; a rate limit is not. */
  let keyState: "unknown" | "ok" | { refused: AdapterCouldNotCheck } = "unknown";

  const checkKey = async (): Promise<void> => {
    if (keyState === "ok") return;
    if (keyState !== "unknown") throw keyState.refused;
    endpoint();
    if (token !== "") {
      let data: Record<string, unknown> | undefined;
      try {
        data = dataOf(await get("{ __schema { mutationType { name } } }", () => []));
      } catch (err) {
        // A rate limit goes on up; anything else (introspection off, a refused key) is for the read itself to say.
        if (err instanceof AdapterRateLimitedError) throw err;
      }
      const schema = data !== undefined && isRecord(data.__schema) ? data.__schema : {};
      if (isRecord(schema.mutationType)) {
        const refused = new AdapterCouldNotCheck(
          `The schema behind ${CRAFT_TOKEN} allows mutations, so the token can change content. Gaugeline will not use a key that can write: make a schema token whose schema allows queries only (Craft: GraphQL, Schemas), or run the live-site checks without Craft.`,
        );
        keyState = { refused };
        throw refused;
      }
    }
    keyState = "ok";
  };

  /** Section names the settings give, checked against the only form that is ever written into a query. */
  const section = (name: string): string => {
    if (!HANDLE.test(name))
      throw new AdapterCouldNotCheck(
        `"${name.length > 60 ? `${name.slice(0, 60)}...` : name}" is not a Craft section handle (letters, digits and underscores, starting with a letter).`,
      );
    return name;
  };

  const siteArg = (site: string | undefined): string => {
    if (site === undefined) return '"*"';
    if (!HANDLE.test(site)) throw new AdapterCouldNotCheck(`"${site}" is not a Craft site handle.`);
    return JSON.stringify(site);
  };

  const args = (name: string, status: "live" | "all", site: string | undefined): string =>
    `section: ${JSON.stringify(section(name))}, site: ${siteArg(site)}, status: ${status === "live" ? '["live"]' : ALL_STATUSES}`;

  const totalOf = (total: unknown): number => {
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new AdapterCouldNotCheck(
        "Craft CMS answered with something that is not a count of entries.",
      );
    return total;
  };

  /** One request for one section's entry total: nothing else. */
  const countOf = async (
    name: string,
    status: "live" | "all",
    partial: () => unknown,
  ): Promise<number> =>
    totalOf(
      dataOf(await get(`{ total: entryCount(${args(name, status, undefined)}) }`, partial)).total,
    );

  const parseNode = (raw: unknown, specs: readonly FieldSpec[]): CraftNode => {
    const r = isRecord(raw) ? raw : {};
    const idRaw = typeof r.id === "number" && Number.isSafeInteger(r.id) ? String(r.id) : r.id;
    const siteHandle = r.siteHandle;
    const updatedAt = isoOf(r.dateUpdated) ?? isoOf(r.postDate);
    if (
      typeof idRaw !== "string" ||
      !ID.test(idRaw) ||
      typeof siteHandle !== "string" ||
      !HANDLE.test(siteHandle) ||
      updatedAt === undefined
    )
      throw new AdapterCouldNotCheck(
        "Craft CMS answered with entries that have no usable id, site or update time.",
      );
    const slug = slugOf(r.slug);
    const address = addressOfEntry(r.url, r.uri);
    const publishedAt = isoOf(r.postDate);
    const data: Record<string, unknown> = {};
    for (const s of specs) if (s.alias in r) data[s.spec] = r[s.alias];
    return {
      id: idRaw,
      siteHandle,
      ...(slug !== undefined ? { slug } : {}),
      ...(address !== undefined ? { address } : {}),
      published: r.status === "live",
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      updatedAt,
      data,
    };
  };

  /**
   * The entries of one section, a page at a time, until every one is read. `limit` and `offset` are written into
   * the document (GET carries no variables). Pages are stepped by what each answer returned, and the total is
   * read again on every page. A page longer than asked for, a repeated entry, a list longer than `cap` whatever
   * total the server claims, and more requests than the cap needs are could-not-check; so is a page that comes
   * back empty before the total. An answer over the size limit is asked again with half as many, down to ten.
   */
  async function* nodesOf(
    name: string,
    status: "live" | "all",
    site: string | undefined,
    specs: readonly FieldSpec[],
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<CraftNode> {
    const maxPages = Math.ceil(cap / MIN_PAGE_SIZE) + 12;
    const select = selectionOf(specs);
    const seen = new Set<string>();
    let offset = 0;
    let size = pageSize;
    let asked = 0;
    for (;;) {
      if (++asked > maxPages)
        throw new AdapterCouldNotCheck(
          `Craft CMS needed more than ${maxPages} requests to list one section, so it was not read to the end.`,
        );
      const a = args(name, status, site);
      const document = `{ total: entryCount(${a}) nodes: entries(${a}, orderBy: "id asc", limit: ${size}, offset: ${offset}) { id slug uri url siteHandle status dateUpdated postDate ${select} } }`;
      let data: Record<string, unknown>;
      try {
        data = dataOf(await get(document, partial));
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Craft CMS's answer for ${size} entries is larger than Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The section was not read.`,
        );
      }
      const total = totalOf(data.total);
      if (enforceCap && total > cap)
        throw new AdapterCouldNotCheck(
          `The section has ${total} entries, more than ${cap}, which is as many as Gaugeline reads from one section.`,
        );
      if (!Array.isArray(data.nodes))
        throw new AdapterCouldNotCheck("Craft CMS answered with something that is not a list.");
      const nodes: unknown[] = data.nodes;
      if (nodes.length > size)
        throw new AdapterCouldNotCheck(
          `Craft CMS answered with more entries than the ${size} asked for, so its list cannot be trusted.`,
        );
      if (offset + nodes.length > cap)
        throw new AdapterCouldNotCheck(
          `Craft CMS listed more entries than the ${cap} Gaugeline reads from one section, whatever total it reported.`,
        );
      for (const raw of nodes) {
        const node = parseNode(raw, specs);
        const key = `${node.id}.${node.siteHandle}`;
        if (seen.has(key))
          throw new AdapterCouldNotCheck(
            "Craft CMS listed the same entry twice, so its paging cannot be trusted and the section was not read.",
          );
        seen.add(key);
        yield node;
      }
      offset += nodes.length;
      if (offset >= total) return;
      if (nodes.length === 0)
        throw new AdapterCouldNotCheck(
          `Craft CMS's list stopped after ${offset} of ${total} entries, so the rest was not read.`,
        );
    }
  }

  const patternFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = patternFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const chosen = (names: readonly string[] | undefined): string[] =>
    named.filter((n) => names === undefined || names.includes(n));

  const idOf = (n: CraftNode): string => `${n.id}.${n.siteHandle}`;

  /** An entry's address: the settings' pattern for its section when there is one, else the one Craft gave. */
  const urlOf = (type: string, n: CraftNode): { url?: string; patterned: boolean } => {
    const pattern = patternFor(type);
    if (pattern !== undefined) {
      const raw = fillUrlTemplate(pattern, {
        id: n.id,
        type,
        ...(n.slug !== undefined ? { slug: n.slug } : {}),
      });
      return { ...(raw !== "" ? { url: raw } : {}), patterned: true };
    }
    if (n.address === undefined) return { patterned: false };
    return {
      url: n.address.origin !== undefined ? `${n.address.origin}${n.address.path}` : n.address.path,
      patterned: false,
    };
  };

  const types = async (): Promise<TypeCount[]> => {
    await checkKey();
    const out: TypeCount[] = [];
    for (const name of named)
      out.push({ name, count: await countOf(name, "live", () => out.slice()) });
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    await checkKey();
    const specs = parseFieldSpecs(fields);
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for (const name of chosen([type]))
      for await (const n of nodesOf(name, "live", undefined, specs, true, () => ({})))
        if (n.published)
          for (const s of specs) if (hasValue(n.data[s.spec])) out[s.spec] = (out[s.spec] ?? 0) + 1;
    return out;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = isoOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    await checkKey();
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const type of chosen(opts.types)) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      const specs = parseFieldSpecs(fields);
      for await (const n of nodesOf(
        type,
        "live",
        undefined,
        specs,
        opts.limit === undefined,
        () => delivered,
      )) {
        if (!n.published) continue;
        if (since !== undefined && Date.parse(n.updatedAt) < Date.parse(since)) continue;
        const fieldHashes: Record<string, string> = {};
        for (const s of specs) {
          const h = hashValue(n.data[s.spec]);
          if (h !== undefined) fieldHashes[s.spec] = h;
        }
        const { url } = urlOf(type, n);
        remaining--;
        delivered++;
        yield {
          id: idOf(n),
          type,
          ...(url !== undefined ? { url } : {}),
          ...(n.slug !== undefined ? { slug: n.slug } : {}),
          ...(n.publishedAt !== undefined ? { publishedAt: n.publishedAt } : {}),
          updatedAt: n.updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  async function* liveEntries(
    opts: { types?: readonly string[]; site?: string } = {},
  ): AsyncGenerator<CraftLiveEntry> {
    await checkKey();
    for (const type of chosen(opts.types))
      for await (const n of nodesOf(type, "live", opts.site, [], true, () => undefined)) {
        if (!n.published) continue;
        const { url, patterned } = urlOf(type, n);
        yield {
          id: idOf(n),
          section: type,
          siteHandle: n.siteHandle,
          ...(n.slug !== undefined ? { slug: n.slug } : {}),
          ...(url !== undefined ? { url } : {}),
          patterned,
        };
      }
  }

  /**
   * True when the count of every status holds more entries than the live count: a disabled entry, one not yet
   * posted or one expired. Two counts per section and no entry is asked for. A Craft that ignores the status
   * argument looks the same as one with nothing unpublished, so false is "no sign of unpublished work".
   */
  const draftsReachable = async (): Promise<boolean> => {
    await checkKey();
    for (const name of named) {
      const every = await countOf(name, "all", () => undefined);
      const live = await countOf(name, "live", () => undefined);
      if (every > live) return true;
    }
    return false;
  };

  return {
    id: "craft",
    describe: () => CRAFT_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    sections: () => [...named],
    checkKey,
    liveEntries,
  };
}
