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
  JOOMLA_DESCRIPTION,
  JOOMLA_ENV_VARS,
  JOOMLA_LIMITS,
  JOOMLA_PAGE_SIZE,
  JOOMLA_TOKEN,
  JOOMLA_URL,
} from "./joomla.entry.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";
export {
  JOOMLA_DESCRIPTION,
  JOOMLA_ENV_VARS,
  JOOMLA_LIMITS,
  JOOMLA_PAGE_SIZE,
  JOOMLA_TOKEN,
  JOOMLA_URL,
};

/** The one content type the adapter reads: Joomla's articles (`GET /api/index.php/v1/content/articles`). [docs] */
export const JOOMLA_TYPE = "articles";

/** Where the Web Services API lives under the site's address (the `index.php` form works with or without URL rewriting). [docs] */
export const JOOMLA_API_PATH = "/api/index.php/v1";

/** The article list route, under the API path. [docs] */
export const JOOMLA_ARTICLES_PATH = `${JOOMLA_API_PATH}/content/articles`;

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** The view level id of "Public" in a Joomla install. An article at another level is not for every visitor. [uncited] */
const PUBLIC_ACCESS = 1;

/** An article id: a positive integer, sent as text. */
const ITEM_ID = /^[1-9][0-9]{0,9}$/;
/** An article alias that can stand in a path. A Unicode alias is not used (it is left out of the slug). */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
/** A custom or core field's name: the key it has in an article's attributes. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A site folder: path characters only, no dot segments (checked apart). */
const FOLDER = /^(?:\/[A-Za-z0-9._~-]{1,64}){0,8}$/;
/** What an API token is made of (base64 of "algorithm:user id:hash"), and no whitespace that could end a header. */
const TOKEN = /^[A-Za-z0-9+/=_-]{16,512}$/;

/**
 * The site's own address from JOOMLA_URL, without a trailing slash, or undefined: https only, a host, no sign-in
 * details, no query and no fragment, and at most a folder as a path (Joomla may live in /cms). Anything else is
 * not the Joomla site, and a token is never sent to it.
 */
export function joomlaBase(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname === "") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  // The URL parser resolves dot segments, so they are looked for in the text as it was written.
  if (/(^|\/)(\.|%2e){1,2}(\/|$|\?|#)/i.test(raw.trim().replace(/^https:\/\/[^/]*/i, "")))
    return undefined;
  const folder = url.pathname.replace(/\/+$/, "");
  if (!FOLDER.test(folder) || folder.split("/").some((s) => s === "." || s === ".."))
    return undefined;
  return `${url.origin}${folder}`;
}

/**
 * What an anonymous visitor (no token) is told by the article list route:
 * - `public`: it answered with a JSON:API list. `total` is how many articles it says a visitor can list.
 * - `protected`: it answered 401 or 403, which is what Joomla does for a route that is not public.
 * - `closed`: it answered 404: the Web Services API is off, or this is not where it is.
 * - `unread`: the answer could not be read; `reason` says why.
 */
export type JoomlaPublicState = "public" | "protected" | "closed" | "unread";

export interface JoomlaPublicApi {
  state: JoomlaPublicState;
  /** The article count the route reported to a visitor with no token. Only when `public`. */
  total?: number;
  reason?: string;
}

/** Articles the adapter did not give to published(), and why: counted, never silent. */
export interface JoomlaSkipped {
  /** Published, but for a view level other than Public (a visitor is sent to sign in, so no page is expected). */
  notPublic: number;
  /** Published, but its start time has not come. */
  scheduled: number;
  /** Published, but its finish time has passed. */
  expired: number;
  /** Published in one language (not "All"): its address carries a language prefix this adapter cannot know. */
  otherLanguage: number;
}

/** The Joomla adapter: ContentAdapter, plus the reads the two Joomla checks need. */
export interface JoomlaAdapter extends ContentAdapter {
  /** Always the one type: articles. */
  collections(): string[];
  /** Names in the settings (under `urls` or `fingerprint`) that are not a type this adapter reads. */
  unknownTypes(): string[];
  /** Articles published() left out so far, and why. Counts for the reads made through this adapter. */
  skipped(): JoomlaSkipped;
  /** Whether the settings say (`expectPrivate: true`) that the Web Services API is meant to be private. A token being set says nothing of it. */
  privacyExpected(): boolean;
  /**
   * What a visitor with NO token is told by the article list route: one GET, sent with no token, no cookie and
   * nothing the fetcher adds per address. It asks a route a visitor is not meant to be sent to when the API is
   * private, so a caller runs it only with the owner's consent (CLAUDE.md rule 14).
   */
  publicApi(): Promise<JoomlaPublicApi>;
}

export interface JoomlaAdapterOptions {
  /** JOOMLA_URL and JOOMLA_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry. Its `urls` and `fingerprint` keys may name `articles`. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** The time "now" is judged by (scheduled and expired articles). Default: the clock. For tests. */
  now?: (() => number) | undefined;
  pageSize?: number | undefined;
  /** Replaces JOOMLA_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
  /** Replaces JOOMLA_LIMITS.requestsPerList. For tests. */
  maxRequestsPerList?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * An ISO 8601 UTC time from a value Joomla gave, or undefined when it is not a time. Joomla's database format
 * ("2026-10-01 09:00:00", always UTC) and ISO 8601 are both read; the zero date is no time. [docs]
 */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value.startsWith("0000-00-00")) return undefined;
  const text = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field's value by name. */
function valueAt(data: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(data, name) ? data[name] : undefined;
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

/** An article as the adapter keeps it: id, state, times and alias, and the named fields only until they are hashed or counted. */
interface RawItem {
  id: string;
  slug?: string;
  state: number;
  access: number;
  language: string;
  publishUp?: string;
  publishDown?: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

/** An integer sent as a number or as digits, or undefined. */
function intOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^-?\d{1,10}$/.test(v)) return Number(v);
  return undefined;
}

/**
 * One article of a list: a JSON:API resource with `id` and `attributes`. Only the id, the state, the access level,
 * the language, the alias, the three times and the requested fields are kept: the title, the text and every other
 * attribute are dropped here. [docs]
 */
function parseItem(raw: unknown, fields: readonly string[]): RawItem {
  const r = isRecord(raw) ? raw : {};
  const a = isRecord(r.attributes) ? r.attributes : {};
  const id = typeof r.id === "string" ? r.id : typeof r.id === "number" ? String(r.id) : "";
  const publishUp = isoOf(a.publish_up);
  const updatedAt = isoOf(a.modified) ?? publishUp ?? isoOf(a.created);
  const state = intOf(a.state);
  const access = intOf(a.access);
  if (!ITEM_ID.test(id) || updatedAt === undefined || state === undefined)
    throw new AdapterCouldNotCheck(
      "Joomla answered with articles that have no usable id, state or update time.",
    );
  if (access === undefined)
    throw new AdapterCouldNotCheck(
      "Joomla answered with an article that has no view level (access), so whether visitors can see it is not known.",
    );
  const data: Record<string, unknown> = {};
  for (const f of fields) if (Object.hasOwn(a, f)) data[f] = a[f];
  const alias = a.alias;
  const publishDown = isoOf(a.publish_down);
  return {
    id,
    ...(typeof alias === "string" && SLUG.test(alias) ? { slug: alias } : {}),
    state,
    access,
    language: typeof a.language === "string" ? a.language : "*",
    ...(publishUp !== undefined ? { publishUp } : {}),
    ...(publishDown !== undefined ? { publishDown } : {}),
    updatedAt,
    data,
  };
}

export function createJoomlaAdapter(options: JoomlaAdapterOptions): JoomlaAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? JOOMLA_PAGE_SIZE, JOOMLA_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? JOOMLA_LIMITS.itemsPerType;
  const requestBudget = options.maxRequestsPerList ?? JOOMLA_LIMITS.requestsPerList;
  const settings = options.settings;
  const redact = createRedactor(env, [JOOMLA_TOKEN]);
  const skipped: JoomlaSkipped = { notPublic: 0, scheduled: 0, expired: 0, otherLanguage: 0 };

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        err.status === 401
          ? `Joomla did not accept ${JOOMLA_TOKEN} (HTTP 401). Check that it is the user's current API token, that the token is enabled, and that the user's group may sign in to the API.`
          : "Joomla did not let the token read articles (HTTP 403). The user's group needs the Access API permission.",
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `Joomla answered HTTP 404: the Web Services API is not at this address. It may be switched off (the Web Services plugins), or ${JOOMLA_URL} is not the Joomla site.`
          : `Joomla answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The site's address, or could-not-check naming the variable (never its value). */
  const baseOrThrow = (): string => {
    const raw = (env[JOOMLA_URL] ?? "").trim();
    if (raw === "")
      throw new AdapterCouldNotCheck(
        `${JOOMLA_URL} is not set. Set it to the Joomla site's address, such as https://example.com.`,
      );
    const base = joomlaBase(raw);
    if (base === undefined)
      throw new AdapterCouldNotCheck(
        `${JOOMLA_URL} must be the site's address with https and no query, such as https://example.com or https://example.com/cms.`,
      );
    return base;
  };

  const tokenOrThrow = (): string => {
    const token = (env[JOOMLA_TOKEN] ?? "").trim();
    if (token === "")
      throw new AdapterCouldNotCheck(
        `${JOOMLA_TOKEN} is not set. Joomla's article list needs an API token.`,
      );
    if (!TOKEN.test(token))
      throw new AdapterCouldNotCheck(
        `${JOOMLA_TOKEN} does not look like a Joomla API token (it is base64 text with no spaces). Copy it again from the user's Joomla API Token tab.`,
      );
    return token;
  };

  /**
   * One GET of the article list route, parsed as a JSON object, to the site's origin and no other. The token goes
   * in the X-Joomla-Token header, never in the address. `visitor` sends no token (and nothing the fetcher adds
   * per address). JSON:API content negotiation needs the vnd.api+json type: Joomla answers 406 to any other.
   */
  const rawGet = async (query: string, visitor: boolean): Promise<unknown> => {
    const base = baseOrThrow();
    const token = visitor ? undefined : tokenOrThrow();
    const { body } = await getJson(
      {
        fetcher,
        request: {
          headers: {
            accept: "application/vnd.api+json",
            ...(token !== undefined ? { "x-joomla-token": token } : {}),
          },
          ...(visitor ? { anonymous: true } : {}),
        },
        sleep,
        system: "Joomla",
      },
      `${base}${JOOMLA_ARTICLES_PATH}?${query}`,
    );
    return body;
  };

  const get = async (query: string, partial: () => unknown): Promise<Record<string, unknown>> => {
    try {
      const body = await rawGet(query, false);
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Joomla answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial());
    }
  };

  /**
   * The query for one page: the state filter (`filter[state]=1` is Published; with none Joomla lists published and
   * unpublished articles), a stable order, and the window. Brackets are escaped. [docs]
   */
  const listQuery = (published: boolean, offset: number, limit: number): string =>
    `${published ? "filter%5Bstate%5D=1&" : ""}list%5Bordering%5D=a.id&list%5Bdirection%5D=ASC` +
    `&page%5Blimit%5D=${limit}&page%5Boffset%5D=${offset}`;

  const typeOrThrow = (type: string): void => {
    if (type !== JOOMLA_TYPE)
      throw new AdapterCouldNotCheck(
        `The Joomla adapter reads articles only; "${type.slice(0, 40)}" is not read.`,
      );
  };

  const unknownTypes = (): string[] =>
    [
      ...new Set([
        ...Object.keys(settings?.urls ?? {}),
        ...Object.keys(settings?.fingerprint ?? {}),
      ]),
    ]
      .filter((n) => n !== JOOMLA_TYPE)
      .sort();

  const pagesOf = (meta: unknown): number => {
    const pages = isRecord(meta) ? meta["total-pages"] : undefined;
    if (typeof pages !== "number" || !Number.isSafeInteger(pages) || pages < 0)
      throw new AdapterCouldNotCheck(
        "Joomla answered with something that is not a count of pages (meta total-pages).",
      );
    return pages;
  };

  /**
   * How many articles a list has. The API reports pages ("total-pages"), not a total, so a window of one article is
   * the exact count. It is checked with a window of two: the pages there must be half the count, rounded up. A
   * server that clamps the window (an extension, a proxy) breaks that, and is could-not-check, never a wrong count.
   * [docs]
   */
  const countOf = async (published: boolean, partial: () => unknown): Promise<number> => {
    const pagesFor = async (limit: number): Promise<number> => {
      const body = await get(listQuery(published, 0, limit), partial);
      if (!Array.isArray(body.data))
        throw new AdapterCouldNotCheck(
          "Joomla answered with something that is not a list of articles.",
        );
      const pages = pagesOf(body.meta);
      // The window and the page count must tell the same story: a server or a cache that ignores page[limit]
      // gives more articles than were asked for, and one page, which would be read as a count of 1.
      if (body.data.length > limit)
        throw new AdapterCouldNotCheck(
          `Joomla answered with more articles than the window of ${limit} that was asked for, so the number of articles is not known (something between Gaugeline and Joomla ignores the page size).`,
        );
      if (pages > 0 && body.data.length === 0)
        throw new AdapterCouldNotCheck(
          "Joomla reported pages of articles but gave no article in the window, so the number of articles is not known.",
        );
      if (pages === 0 && body.data.length > 0)
        throw new AdapterCouldNotCheck(
          "Joomla gave articles but a count of 0 pages, so the number of articles is not known.",
        );
      return pages;
    };
    const count = await pagesFor(1);
    if ((await pagesFor(2)) !== Math.ceil(count / 2))
      throw new AdapterCouldNotCheck(
        "Joomla's page counts for one article and for two articles a page do not agree, so the number of articles is not known (something between Gaugeline and Joomla changes the page size).",
      );
    return count;
  };

  /**
   * The Published articles, a window at a time, until every one is read. The window moves by the number of
   * articles that came back, never by the number asked for. A list is complete only when the position reaches the
   * count taken first: an empty window, a window with nothing new in it, a list that needs more requests than the
   * budget, or one that changed while it was read is could-not-check, never a short list taken for the whole.
   */
  async function* articles(o: {
    fields: readonly string[];
    enforceCap: boolean;
    partial: () => unknown;
  }): AsyncGenerator<RawItem> {
    const total = await countOf(true, o.partial);
    if (o.enforceCap && total > cap)
      throw new AdapterCouldNotCheck(
        `The site has ${total} published articles, more than ${cap} article${cap === 1 ? "" : "s"}, which is as many as Gaugeline reads in one list.`,
      );
    let offset = 0;
    let size = pageSize;
    let requests = 0;
    const seen = new Set<string>();
    while (offset < total) {
      if (++requests > requestBudget)
        throw new AdapterCouldNotCheck(
          `Joomla's article list needed more than ${requestBudget} requests, so the rest was not read.`,
        );
      let body: Record<string, unknown>;
      try {
        body = await get(listQuery(true, offset, size), o.partial);
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Joomla's answer for ${size} articles is larger than Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The articles were not read.`,
        );
      }
      if (!Array.isArray(body.data))
        throw new AdapterCouldNotCheck(
          "Joomla answered with something that is not a list of articles.",
        );
      let fresh = 0;
      for (const raw of body.data) {
        const item = parseItem(raw, o.fields);
        if (item.state !== 1)
          throw new AdapterCouldNotCheck(
            "Joomla answered with an article that is not published to a request for published articles.",
          );
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        fresh++;
        yield item;
      }
      offset += body.data.length;
      if (body.data.length === 0)
        throw new AdapterCouldNotCheck(
          `Joomla's list stopped after ${offset} of ${total} articles, so the rest was not read.`,
        );
      if (fresh === 0)
        throw new AdapterCouldNotCheck(
          "Joomla's list gave the same articles again instead of the next ones, so the rest was not read.",
        );
    }
    if (seen.size < total)
      throw new AdapterCouldNotCheck(
        "Joomla's list changed while it was read (articles were unpublished or deleted), so it may be missing some. Run again.",
      );
  }

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const types = async (): Promise<TypeCount[]> => [
    { name: JOOMLA_TYPE, count: await countOf(true, () => []) },
  ];

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    typeOrThrow(type);
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    const names = fields.filter((f) => FIELD_NAME.test(f));
    for await (const item of articles({ fields: names, enforceCap: true, partial: () => out }))
      for (const f of names) if (hasValue(valueAt(item.data, f))) out[f] = (out[f] ?? 0) + 1;
    return out;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = isoOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    if (opts.types !== undefined && !opts.types.includes(JOOMLA_TYPE)) return;
    // The left-out counts are for this read only: a second call starts again from zero.
    skipped.notPublic = skipped.scheduled = skipped.expired = skipped.otherLanguage = 0;
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    if (remaining <= 0) return;
    const fields = (
      opts.fields?.[JOOMLA_TYPE] ??
      settings?.fingerprint?.[JOOMLA_TYPE] ??
      []
    ).filter((f) => FIELD_NAME.test(f));
    const at = now();
    for await (const item of articles({
      fields,
      enforceCap: opts.limit === undefined,
      partial: () => delivered,
    })) {
      // Left out, and counted: a visitor is not expected to find a page for these.
      if (item.access !== PUBLIC_ACCESS) {
        skipped.notPublic++;
        continue;
      }
      if (item.publishUp !== undefined && Date.parse(item.publishUp) > at) {
        skipped.scheduled++;
        continue;
      }
      if (item.publishDown !== undefined && Date.parse(item.publishDown) <= at) {
        skipped.expired++;
        continue;
      }
      if (item.language !== "*") {
        skipped.otherLanguage++;
        continue;
      }
      if (since !== undefined && Date.parse(item.updatedAt) < Date.parse(since)) continue;
      const fieldHashes: Record<string, string> = {};
      for (const f of fields) {
        // Joomla sends an empty field as "": an empty field is left out, as a missing one is.
        const value = valueAt(item.data, f);
        const h = hasValue(value) ? hashValue(value) : undefined;
        if (h !== undefined) fieldHashes[f] = h;
      }
      const url = resolveUrl({
        id: item.id,
        type: JOOMLA_TYPE,
        ...(item.slug !== undefined ? { slug: item.slug } : {}),
      });
      remaining--;
      delivered++;
      yield {
        id: item.id,
        type: JOOMLA_TYPE,
        ...(url !== "" ? { url } : {}),
        ...(item.slug !== undefined ? { slug: item.slug } : {}),
        ...(item.publishUp !== undefined ? { publishedAt: item.publishUp } : {}),
        updatedAt: item.updatedAt,
        fieldHashes,
      };
      if (remaining <= 0) return;
    }
  }

  /**
   * True when the default list (published and unpublished articles) holds more than the Published filter does:
   * an unpublished article the token can list. Four small requests and no article is read beyond the first two.
   */
  const draftsReachable = async (): Promise<boolean> => {
    const live = await countOf(true, () => undefined);
    const every = await countOf(false, () => undefined);
    if (every > live) return true;
    // No more articles unfiltered than filtered does not show that nothing is unpublished: a draft may sit at a
    // view level the user cannot see, and a site with no drafts looks the same. Not false.
    throw new AdapterCouldNotCheck(
      "Joomla listed no unpublished article to this token, which does not show whether unpublished work is reachable (there may be none, or they may be at a view level the user cannot see).",
    );
  };

  const publicApi = async (): Promise<JoomlaPublicApi> => {
    try {
      const body = await rawGet("page%5Blimit%5D=1", true);
      if (!isRecord(body) || !Array.isArray(body.data) || !isRecord(body.meta))
        return {
          state: "unread",
          reason: "the route answered, but not with Joomla's JSON:API list of articles",
        };
      const pages = body.meta["total-pages"];
      return typeof pages === "number" && Number.isSafeInteger(pages) && pages >= 0
        ? { state: "public", total: pages }
        : { state: "unread", reason: "the route answered with a count that is not a number" };
    } catch (err) {
      if (err instanceof AdapterCouldNotCheck) throw err;
      if (err instanceof ConnectorRefusedError) return { state: "protected" };
      if (err instanceof ConnectorRateLimitedError)
        throw new AdapterRateLimitedError([], err.retry);
      if (err instanceof ConnectorStatusError)
        return err.status === 404
          ? { state: "closed" }
          : { state: "unread", reason: `the route answered HTTP ${err.status}` };
      if (err instanceof ResponseTooLargeError)
        return { state: "unread", reason: "the answer was larger than a response may be" };
      return { state: "unread", reason: redact(err instanceof Error ? err.message : String(err)) };
    }
  };

  return {
    id: "joomla",
    describe: () => JOOMLA_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    collections: () => [JOOMLA_TYPE],
    unknownTypes,
    skipped: () => ({ ...skipped }),
    privacyExpected: () => settings?.expectPrivate === true,
    publicApi,
  };
}
