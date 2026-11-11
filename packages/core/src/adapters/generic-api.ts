import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
} from "../connectors/http.js";
import { getJson, isRecord, type JsonSource } from "../connectors/get-json.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { fillUrlTemplate, hashValue } from "./fingerprint.js";
import {
  BLOCKED_REASONS,
  GENERIC_API_LIMITS,
  GRAPHQL_FIELDS_MARKER,
  genericApiSchema,
  parsePointer,
  type GenericApiCollection,
  type GenericApiMapping,
} from "./generic-api-config.js";
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
 * The generic adapter reads whatever a headless CMS's read API says, from a mapping in the settings. Its key kind
 * is the narrowest the platform offers, which only the platform's recipe can say (a read-only role's static token,
 * a delivery token): `scoped` is what it claims, and each recipe names the actual key.
 */
export const GENERIC_API_DESCRIPTION: AdapterDescription = {
  name: "Any headless CMS with a read API",
  docsUrl: "https://gaugeline.dev/docs/integrations/generic-api",
  keyKind: "scoped",
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface GenericApiAdapterOptions {
  /** The environment variables the mapping names (GAUGELINE_..._TOKEN), already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry: `api` is required. `fingerprint` and `urls` work as for every adapter. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** A key's value goes in a header: printable ASCII, no line break, never empty. */
const HEADER_VALUE = /^[\x21-\x7E]+(?: [\x21-\x7E]+)*$/;

/** What a bootstrap value (Prismic's ref) may look like: it goes back into an address. */
const BOOTSTRAP_VALUE = /^[A-Za-z0-9_.~=-]{1,200}$/;

const ARRAY_INDEX = /^(?:0|[1-9]\d{0,5})$/;

/** The value at a pointer's segments: own properties and array positions only, never the prototype. */
function at(value: unknown, path: readonly string[]): unknown {
  let v = value;
  for (const s of path) {
    if (Array.isArray(v)) {
      if (!ARRAY_INDEX.test(s)) return undefined;
      v = v[Number(s)];
    } else if (isRecord(v) && Object.prototype.hasOwnProperty.call(v, s)) v = v[s];
    else return undefined;
  }
  return v;
}

/** No value: nothing, an empty string or an empty list. (A field the item does not have is left out, not hashed as empty.) */
function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
}

/** The first of one or more pointers that has a value. */
function firstAt(item: unknown, paths: string | readonly string[] | undefined): unknown {
  if (paths === undefined) return undefined;
  for (const p of typeof paths === "string" ? [paths] : paths) {
    const v = at(item, parsePointer(p) ?? []);
    if (present(v)) return v;
  }
  return undefined;
}

const textOf = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== ""
    ? v.trim()
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : undefined;

/**
 * An ISO 8601 UTC time from what a platform gave: ISO text, "2026-11-02 10:00:00" with no zone (read as UTC), or a
 * number of seconds or milliseconds since 1970. Undefined when it is none of these.
 */
function timeOf(value: unknown): string | undefined {
  let ms: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    ms = value >= 1e11 ? value : value * 1000;
  } else if (typeof value === "string" && value.trim() !== "") {
    const t = value.trim();
    const plain = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(t);
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t);
    ms = Date.parse(
      plain
        ? `${plain[1]}T${plain[2]}Z`
        : /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(t) && !zoned
          ? `${t}Z`
          : t,
    );
  } else return undefined;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A whole number from a number or numeric text, or undefined. */
function intOf(v: unknown): number | undefined {
  const n = typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

type Tree = Map<string, Tree>;

/** `title`, `seo.title` and `seo.image` as GraphQL: `title seo { title image }`. */
export function graphqlSelection(fields: readonly string[]): string {
  const root: Tree = new Map();
  for (const f of fields) {
    let node = root;
    for (const part of f.split(".")) {
      let next = node.get(part);
      if (!next) {
        next = new Map();
        node.set(part, next);
      }
      node = next;
    }
  }
  const render = (t: Tree): string =>
    [...t].map(([k, child]) => (child.size > 0 ? `${k} { ${render(child)} }` : k)).join(" ");
  return render(root);
}

interface Page {
  items: Record<string, unknown>[];
  /** The count the answer gave, when the mapping says where it is. */
  total: number | undefined;
}

interface Reading {
  /** Top-level field names to ask the platform for, when it can be asked. */
  select: readonly string[];
  /** The fields a GraphQL document should select (dotted names). */
  fields: readonly string[];
  /** Parameters that replace the collection's own (the drafts listing). */
  extra?: Readonly<Record<string, string>> | undefined;
  /** What a rate limit reports as read so far. */
  partial: () => unknown;
}

/**
 * The generic adapter: any REST or GraphQL read API, through a mapping. Every request is a GET (a GraphQL query is
 * a GET with the document in the address, as the Sanity reader does; a platform that answers only POST is
 * could-not-check, never sent a POST). The key is the value of one environment variable, sent in one header, to the
 * endpoint's origin only; it is blanked from every message. Items come back as ids, addresses, times and a hash of
 * each fingerprint field; a value is read only to be hashed or counted. Nothing is requested that the mapping did
 * not name: every address is built from the endpoint, and a link the platform returns is never followed.
 */
export function createGenericApiAdapter(options: GenericApiAdapterOptions): ContentAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const settings = options.settings;
  const parsed = genericApiSchema.safeParse(settings?.api);
  if (!parsed.success)
    throw new ConfigError(
      'gaugeline.adapters.json: the generic-api adapter needs a valid "api" mapping.',
      { hint: "See docs/integrations/generic-api and the recipes in docs/integrations/recipes." },
    );
  const mapping: GenericApiMapping = parsed.data;

  const endpoint = new URL(mapping.endpoint);
  const base = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}`;
  const host = endpoint.host;
  const names = Object.keys(mapping.collections).sort();
  const maxPages = mapping.maxPages ?? GENERIC_API_LIMITS.defaultMaxPages;
  const authEnv = mapping.auth?.env;
  const keyText = authEnv === undefined ? "" : (env[authEnv] ?? "").trim();
  const headerValue = mapping.auth === undefined ? "" : `${mapping.auth.prefix ?? ""}${keyText}`;
  const redact = createRedactor({ ...env, _header: headerValue }, [
    ...(authEnv === undefined ? [] : [authEnv]),
    "_header",
  ]);

  const collectionOf = (key: string): GenericApiCollection => {
    const c = mapping.collections[key];
    if (!c) throw new AdapterCouldNotCheck(`The mapping has no collection "${key}".`);
    return c;
  };

  /** A mapping that cannot run today asks for nothing and says why. */
  const runnable = (): void => {
    if (mapping.blocked !== undefined)
      throw new AdapterCouldNotCheck(`${host}: ${BLOCKED_REASONS[mapping.blocked]}`);
  };

  const source = (): JsonSource => {
    let request: JsonSource["request"] = { headers: { accept: "application/json" } };
    if (mapping.auth !== undefined) {
      if (keyText === "")
        throw new AdapterCouldNotCheck(
          `${mapping.auth.env} is not set: the mapping sends it as the key.`,
        );
      if (!HEADER_VALUE.test(headerValue))
        throw new AdapterCouldNotCheck(
          `${mapping.auth.env} holds something that cannot be sent as a header value (a line break or a character outside plain ASCII).`,
        );
      const name = mapping.auth.header.toLowerCase();
      request =
        name === "authorization"
          ? { ...request, authorization: headerValue }
          : { headers: { ...request.headers, [name]: headerValue } };
    }
    return { fetcher, request, sleep, system: host };
  };

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check with the key blanked. */
  const translate = (err: unknown, partial: unknown, graphql: boolean): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        mapping.auth !== undefined
          ? `${host} did not accept the key in ${mapping.auth.env}, or the key may not read this (HTTP ${err.status}). Check the variable and that the key's role or scope allows reading the collections in the mapping.`
          : `${host} refused an anonymous read (HTTP ${err.status}). It needs a key: add "auth" to the mapping.`,
      );
    if (err instanceof ConnectorStatusError && err.status === 405 && graphql)
      return new AdapterCouldNotCheck(
        `${host}: the platform only answers GraphQL queries over POST (HTTP 405 to a GET), and Gaugeline never sends a POST to a checked platform. See open question 53 in PROGRESS.md.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        `${host} answered HTTP ${err.status}${err.status === 404 ? ": check the endpoint and the collection's path in the mapping" : ""}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const read = async (url: string, partial: unknown, graphql: boolean): Promise<unknown> => {
    const src = source();
    try {
      return (await getJson(src, url)).body;
    } catch (err) {
      throw translate(err, partial, graphql);
    }
  };

  /** Values the platform hands out once (Prismic's ref), read on first use and added to every request. */
  let bootstrapped: Promise<[string, string][]> | undefined;
  const bootstrap = (partial: unknown): Promise<[string, string][]> => {
    if (mapping.bootstrap === undefined || mapping.bootstrap.length === 0)
      return Promise.resolve([]);
    bootstrapped ??= (async () => {
      const out: [string, string][] = [];
      for (const step of mapping.bootstrap ?? []) {
        const body = await read(`${base}${step.path}`, partial, false);
        if (step.expect !== undefined) {
          const got = at(body, parsePointer(step.expect.path) ?? []);
          if (got !== step.expect.equals)
            throw new AdapterCouldNotCheck(
              `${host}: the answer at ${step.path === "" ? "the endpoint" : step.path} does not have ${step.expect.equals} at ${step.expect.path}, so ${step.param} was not read from it.`,
            );
        }
        const value = textOf(at(body, parsePointer(step.value) ?? []));
        if (value === undefined || !BOOTSTRAP_VALUE.test(value))
          throw new AdapterCouldNotCheck(
            `${host}: no usable value for ${step.param} at ${step.value} in the answer from ${step.path === "" ? "the endpoint" : step.path}.`,
          );
        out.push([step.param, value]);
      }
      return out;
    })();
    bootstrapped.catch(() => {
      bootstrapped = undefined;
    });
    return bootstrapped;
  };

  const addressOf = (
    c: GenericApiCollection,
    pairs: [string, string][],
    vars: Record<string, unknown>,
    fields: readonly string[],
  ): string => {
    if (c.graphql !== undefined) {
      const text = c.graphql.replace(GRAPHQL_FIELDS_MARKER, graphqlSelection(fields));
      const q = new URLSearchParams({ query: text, variables: JSON.stringify(vars) });
      return `${base}?${q.toString()}`;
    }
    const q = new URLSearchParams();
    for (const [k, v] of pairs) q.set(k, v);
    const query = q.toString();
    return `${base}${c.path ?? ""}${query === "" ? "" : `?${query}`}`;
  };

  const truthy = (v: unknown, where: string): boolean => {
    if (v === true) return true;
    if (v === false) return false;
    throw new AdapterCouldNotCheck(
      `${host}: the answer has no yes or no at ${where}, so the mapping's paging cannot be followed.`,
    );
  };

  const topLevel = (fields: readonly string[]): string[] => [
    ...new Set(fields.map((f) => f.split(".")[0] ?? f)),
  ];

  /**
   * One page after another of a collection, until the platform says there are no more. A collection with more pages
   * than the mapping allows is could-not-check, not cut short; an answer that repeats items is too (the platform
   * ignored the paging parameters).
   */
  async function* pagesOf(
    key: string,
    c: GenericApiCollection,
    reading: Reading,
  ): AsyncGenerator<Page> {
    const p = c.pagination;
    const itemsAt = parsePointer(c.items) ?? [];
    const totalAt = c.total === undefined ? undefined : parsePointer(c.total);
    const idPaths = c.fields.id;
    const graphql = c.graphql !== undefined;
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let offset = 0;
    let page = p.style === "page" ? (p.firstPage ?? 1) : 0;
    let cursor: string | undefined;
    let got = 0;
    for (let n = 0; ; n++) {
      if (n >= maxPages)
        throw new AdapterCouldNotCheck(
          `${host}: "${key}" has more than ${maxPages} pages of ${p.style === "none" ? "" : p.pageSize} items, which is more than the mapping reads. Raise "maxPages" (up to ${GENERIC_API_LIMITS.maxPages}) if that is right.`,
        );
      const pairs: [string, string][] = [];
      const vars: Record<string, unknown> = {};
      const add = (name: string, value: number | string): void => {
        pairs.push([name, String(value)]);
        vars[name] = value;
      };
      if (c.query) for (const [k, v] of Object.entries(c.query)) pairs.push([k, v]);
      pairs.push(...(await bootstrap(reading.partial())));
      if (c.select && !graphql) {
        const wanted = [...new Set([...c.select.always, ...reading.select])];
        pairs.push([c.select.param.replace("{type}", key), wanted.join(c.select.join ?? ",")]);
      }
      if (p.style === "offset") {
        add(p.limit, p.pageSize);
        add(p.offset, offset);
      } else if (p.style === "page") {
        add(p.size, p.pageSize);
        add(p.page, page);
      } else if (p.style === "cursor") {
        if (p.size !== undefined) add(p.size, p.pageSize);
        if (cursor !== undefined) add(p.cursor, cursor);
      }
      if (reading.extra)
        for (const [k, v] of Object.entries(reading.extra)) {
          const at0 = pairs.findIndex(([name]) => name === k);
          if (at0 >= 0) pairs.splice(at0, 1, [k, v]);
          else pairs.push([k, v]);
        }
      const body = await read(
        addressOf(c, pairs, vars, reading.fields),
        reading.partial(),
        graphql,
      );
      if (graphql && isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0)
        throw new AdapterCouldNotCheck(
          `${host} answered the GraphQL query with errors. (The messages are not shown: they can carry content.) Check the document in the mapping against the platform's schema.`,
        );
      const raw = at(body, itemsAt);
      if (!Array.isArray(raw))
        throw new AdapterCouldNotCheck(
          `${host}: no list of items at ${c.items === "" ? "the top of the answer" : c.items} for "${key}". Check "items" in the mapping.`,
        );
      const items = raw.map((x) => {
        if (!isRecord(x))
          throw new AdapterCouldNotCheck(`${host}: an item in "${key}" is not an object.`);
        return x;
      });
      const total = totalAt === undefined ? undefined : intOf(at(body, totalAt));
      if (items.length > 0) {
        const ids = items.map((i) => textOf(firstAt(i, idPaths)));
        if (ids.every((id) => id !== undefined && seen.has(id)))
          throw new AdapterCouldNotCheck(
            `${host} gave the same items again for "${key}": it did not follow the paging parameters in the mapping.`,
          );
        for (const id of ids) if (id !== undefined) seen.add(id);
      }
      yield { items, total };
      got += items.length;

      let more: boolean;
      if (p.style === "none" || items.length === 0) more = false;
      else if (p.style === "offset") {
        more =
          p.more !== undefined
            ? truthy(at(body, parsePointer(p.more) ?? []), p.more)
            : total !== undefined
              ? got < total
              : items.length >= p.pageSize;
        offset += items.length;
      } else if (p.style === "page") {
        if (p.more !== undefined) more = truthy(at(body, parsePointer(p.more) ?? []), p.more);
        else if (p.pages !== undefined) {
          const pages = intOf(at(body, parsePointer(p.pages) ?? []));
          if (pages === undefined)
            throw new AdapterCouldNotCheck(
              `${host}: no page count at ${p.pages} in the answer for "${key}".`,
            );
          more = page - (p.firstPage ?? 1) + 1 < pages;
        } else if (total !== undefined) {
          more = got < total;
          if (more && items.length < p.pageSize)
            throw new AdapterCouldNotCheck(
              `${host} gave fewer items per page than the mapping asked for in "${key}", so the pages cannot be counted. Set "pageSize" to the platform's own maximum.`,
            );
        } else more = items.length >= p.pageSize;
        page++;
      } else {
        const next = textOf(at(body, parsePointer(p.next) ?? []));
        more =
          next !== undefined &&
          (p.more === undefined || truthy(at(body, parsePointer(p.more) ?? []), p.more));
        if (more && next !== undefined) {
          if (cursors.has(next))
            throw new AdapterCouldNotCheck(
              `${host} gave the same cursor twice for "${key}": the pages loop.`,
            );
          cursors.add(next);
          cursor = next;
        }
      }
      if (!more) return;
    }
  }

  /** An item the mapping's `published` guard lets through (every item when there is none). */
  const live = (c: GenericApiCollection, item: Record<string, unknown>): boolean =>
    c.published === undefined ||
    String(at(item, parsePointer(c.published.path) ?? [])) === String(c.published.equals);

  const typeOf = (key: string, c: GenericApiCollection, item: Record<string, unknown>): string => {
    if (c.fields.type === undefined) return key;
    const t = textOf(firstAt(item, c.fields.type));
    if (t === undefined)
      throw new AdapterCouldNotCheck(
        `${host}: an item in "${key}" has no content type at ${JSON.stringify(c.fields.type)}.`,
      );
    return t;
  };

  const fieldAt = (
    c: GenericApiCollection,
    item: Record<string, unknown>,
    field: string,
  ): unknown => {
    const v = at(item, [...(parsePointer(c.fieldRoot ?? "") ?? []), ...field.split(".")]);
    return present(v) ? v : undefined;
  };

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  /** A path from what the platform gave as an address: a path stays, an absolute address keeps its path and query. */
  const pathOf = (v: unknown): string | undefined => {
    const t = textOf(v);
    if (t === undefined || /\s/.test(t)) return undefined;
    if (/^https?:\/\//i.test(t)) {
      try {
        const u = new URL(t);
        return `${u.pathname}${u.search}`;
      } catch {
        return undefined;
      }
    }
    return t.startsWith("/") ? t : /^[A-Za-z0-9_~.%-]/.test(t) ? `/${t}` : undefined;
  };

  const types = async (): Promise<TypeCount[]> => {
    runnable();
    const counts = new Map<string, number>();
    const list = (): TypeCount[] => [...counts].map(([name, count]) => ({ name, count }));
    for (const key of names) {
      const c = collectionOf(key);
      const reading: Reading = { select: [], fields: [], partial: list };
      if (c.fields.type === undefined && c.published === undefined) {
        let n = 0;
        for await (const pg of pagesOf(key, c, reading)) {
          // A count in the answer is the whole collection: one request, not every page.
          if (pg.total !== undefined) {
            n = pg.total;
            break;
          }
          n += pg.items.length;
        }
        counts.set(key, n);
      } else {
        if (c.fields.type === undefined) counts.set(key, 0);
        for await (const pg of pagesOf(key, c, reading))
          for (const item of pg.items) {
            if (!live(c, item)) continue;
            const t = typeOf(key, c, item);
            counts.set(t, (counts.get(t) ?? 0) + 1);
          }
      }
    }
    return list().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    runnable();
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    if (fields.length === 0) return out;
    for (const key of names) {
      const c = collectionOf(key);
      if (c.fields.type === undefined && key !== type) continue;
      const reading: Reading = { select: topLevel(fields), fields, partial: () => out };
      for await (const pg of pagesOf(key, c, reading))
        for (const item of pg.items) {
          if (!live(c, item) || typeOf(key, c, item) !== type) continue;
          for (const f of fields) if (fieldAt(c, item, f) !== undefined) out[f] = (out[f] ?? 0) + 1;
        }
    }
    return out;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    runnable();
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = timeOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    const wanted = opts.types === undefined ? undefined : new Set(opts.types);
    const fieldsFor = (type: string): readonly string[] =>
      opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const key of names) {
      if (remaining <= 0) return;
      const c = collectionOf(key);
      const typed = c.fields.type !== undefined;
      if (!typed && wanted !== undefined && !wanted.has(key)) continue;
      if (since !== undefined && c.fields.updatedAt === undefined)
        throw new AdapterCouldNotCheck(
          `${host}: the mapping for "${key}" has no updatedAt path, so "changed since" cannot be answered.`,
        );
      // A collection that holds several types asks for the fields of all of them; each item keeps its own type's.
      const asked = typed
        ? [
            ...new Set(
              [...(wanted ?? Object.keys({ ...settings?.fingerprint, ...opts.fields }))].flatMap(
                (t) => [...fieldsFor(t)],
              ),
            ),
          ]
        : [...fieldsFor(key)];
      const reading: Reading = {
        select: topLevel(asked),
        fields: asked,
        partial: () => delivered,
      };
      for await (const pg of pagesOf(key, c, reading))
        for (const item of pg.items) {
          if (!live(c, item)) continue;
          const type = typeOf(key, c, item);
          if (wanted !== undefined && !wanted.has(type)) continue;
          const id = textOf(firstAt(item, c.fields.id));
          const updatedAt =
            c.fields.updatedAt === undefined
              ? undefined
              : timeOf(firstAt(item, c.fields.updatedAt));
          if (id === undefined || (c.fields.updatedAt !== undefined && updatedAt === undefined))
            throw new AdapterCouldNotCheck(
              `${host} answered with items in "${key}" that have no id or no update time at the paths in the mapping.`,
            );
          if (since !== undefined && updatedAt !== undefined && updatedAt < since) continue;
          const fieldHashes: Record<string, string> = {};
          for (const f of fieldsFor(type)) {
            const h = hashValue(fieldAt(c, item, f));
            if (h !== undefined) fieldHashes[f] = h;
          }
          const slug = textOf(firstAt(item, c.fields.slug));
          const publishedAt = timeOf(firstAt(item, c.fields.publishedAt));
          let url = resolveUrl({ id, type, ...(slug !== undefined ? { slug } : {}) });
          if (url === "" && templateFor(type) === undefined)
            url = pathOf(firstAt(item, c.fields.url)) ?? "";
          remaining--;
          delivered++;
          yield {
            id,
            type,
            ...(url !== "" ? { url } : {}),
            ...(slug !== undefined ? { slug } : {}),
            ...(publishedAt !== undefined ? { publishedAt } : {}),
            ...(updatedAt !== undefined ? { updatedAt } : {}),
            fieldHashes,
          };
          if (remaining <= 0) return;
        }
    }
  }

  const draftsReachable = async (): Promise<boolean | "not-applicable"> => {
    runnable();
    const drafts = mapping.drafts;
    if (drafts === undefined) return "not-applicable";
    const c = collectionOf(drafts.collection);
    const reading: Reading = {
      select: [],
      fields: [],
      extra: drafts.query,
      partial: () => undefined,
    };
    for await (const pg of pagesOf(drafts.collection, c, reading))
      return (pg.total ?? pg.items.length) > 0;
    return false;
  };

  return {
    id: "generic-api",
    describe: () => GENERIC_API_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
  };
}
