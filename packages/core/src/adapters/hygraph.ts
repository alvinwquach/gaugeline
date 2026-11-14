import {
  MAX_RETRY_SECONDS,
  ResponseTooLargeError,
  idText,
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
import { registerQueryAllow } from "../fetch/query-registry.js";
import { fillUrlTemplate, hasValue, hashValue, valueAt } from "./fingerprint.js";
import {
  HYGRAPH_DESCRIPTION,
  HYGRAPH_ENDPOINT,
  HYGRAPH_ENV_VARS,
  HYGRAPH_LIMITS,
  HYGRAPH_PAGE_SIZE,
  HYGRAPH_TOKEN,
} from "./hygraph.entry.js";
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
  HYGRAPH_DESCRIPTION,
  HYGRAPH_ENDPOINT,
  HYGRAPH_ENV_VARS,
  HYGRAPH_LIMITS,
  HYGRAPH_PAGE_SIZE,
  HYGRAPH_TOKEN,
};

/**
 * The Content API is GraphQL, and a project's endpoint is one address that answers a query sent as a POST. It is
 * the project's own address, so the host is not fixed: it is the one the person set in HYGRAPH_ENDPOINT, checked
 * against `HYGRAPH_HOST` below before anything is sent, and the entry lets the fetcher send only a document that
 * parses as one `query` (ADR-0006). Two entries, one for each of the two paths the endpoints have: the standard
 * one (`/v2/<project>/<environment>`) and the high performance one (`/content/<project>/<environment>`).
 * Source: the endpoints in Hygraph's own example repositories (hygraph/hygraph-examples, hygraph-astro-loader and
 * gatsby-source-graphcms, read 11 Nov 2026) are of these two shapes and are called with `Authorization: Bearer
 * <token>` and a GraphQL body. hygraph.com could not be reached when this was written, so the entries are marked
 * not verified (`checked: null`) and a reviewer sees it.
 */
export const HYGRAPH_API_QUERY = registerQueryAllow({
  id: "hygraph-content-api",
  host: { configured: HYGRAPH_ENDPOINT },
  path: "/v2/*/*",
  body: { kind: "graphql-query" },
  docs: { url: "https://hygraph.com/docs/api-reference/basics/authorization", checked: null },
});

export const HYGRAPH_CDN_QUERY = registerQueryAllow({
  id: "hygraph-content-cdn",
  host: { configured: HYGRAPH_ENDPOINT },
  path: "/content/*/*",
  body: { kind: "graphql-query" },
  docs: { url: "https://hygraph.com/docs/api-reference/basics/authorization", checked: null },
});

/**
 * Where a Hygraph Content API endpoint may be: `api-<region>.hygraph.com` or `<region>.cdn.hygraph.com`. Each
 * part is hyphen-separated words, so the pattern has one way to match and no nested repeat to run away on.
 */
const HYGRAPH_HOST =
  /^(?:api-[a-z0-9]+(?:-[a-z0-9]+){1,8}|[a-z0-9]+(?:-[a-z0-9]+){1,10}\.cdn)\.hygraph\.com$/;
/** `/v2/<project id>/<environment>` or `/content/<project id>/<environment>`. */
const HYGRAPH_PATH = /^\/(v2|content)\/([a-z0-9]{20,32})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

export interface HygraphEndpoint {
  host: string;
  path: string;
  /** The id of the allowlist entry for this path. */
  allow: string;
}

/**
 * The endpoint HYGRAPH_ENDPOINT names, or why it is not one. The value is never repeated in the reason. Over
 * https only, no credentials, port, query string or fragment, a hygraph.com host of the two known shapes and a path
 * of the two known shapes: anything else is refused before the token goes anywhere.
 */
export function parseHygraphEndpoint(value: string): HygraphEndpoint | string {
  const text = value.trim();
  if (text === "" || text.length > 300)
    return `${HYGRAPH_ENDPOINT} is not set, or is too long to be an address.`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `${HYGRAPH_ENDPOINT} is not a web address.`;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return `${HYGRAPH_ENDPOINT} must be an https address with no credentials, port, query string or fragment.`;
  if (!HYGRAPH_HOST.test(url.hostname) || url.hostname.length > 120)
    return `${HYGRAPH_ENDPOINT} is not a Hygraph Content API host (api-<region>.hygraph.com or <region>.cdn.hygraph.com), so the token was not sent.`;
  const m = HYGRAPH_PATH.exec(url.pathname);
  if (m === null)
    return `${HYGRAPH_ENDPOINT} does not have the Content API's path (/v2/<project>/<environment> or /content/<project>/<environment>), so the token was not sent.`;
  // The two shapes go together in every endpoint Hygraph's own repositories show: the registry cannot tie a host
  // to a path, so the pairing is checked here, and a mismatch is refused. (Observed, not documented: uncited.)
  const cdn = url.hostname.endsWith(".cdn.hygraph.com");
  if ((m[1] === "content") !== cdn)
    return `${HYGRAPH_ENDPOINT} pairs a ${cdn ? "cdn" : "api"} host with the wrong path (api-REGION.hygraph.com uses /v2/..., REGION.cdn.hygraph.com uses /content/...), so the token was not sent.`;
  return {
    host: url.host,
    path: url.pathname,
    allow: m[1] === "v2" ? HYGRAPH_API_QUERY.id : HYGRAPH_CDN_QUERY.id,
  };
}

/** The most entries a page may ask for: Hygraph's `first` (its own limit is higher, uncited). */
const MAX_PAGE_SIZE = 1000;
/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A GraphQL name. Names from the settings go into a query document, so nothing else is ever put there. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOKEN_TEXT = /^[\x21-\x7e]{1,4096}$/;
const ID_TEXT = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_TEXT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;

/** The two stages a document may name. A closed set: no other text is ever put into the `stage` argument. */
type Stage = "PUBLISHED" | "DRAFT";

/** An unpublished entry: the ids and the slug, never a field. */
export interface UnpublishedEntry {
  id: string;
  slug?: string;
}

/** What a read of the DRAFT stage found for one model. Ids, slugs and counts only; never a field. */
export interface UnpublishedRead {
  type: string;
  /**
   * read: both stages were read in full.
   * refused: the PUBLISHED stage was read, and Hygraph would not give the DRAFT stage to this token (HTTP 401 or 403, or a GraphQL error on its first page: refused or errored): nothing is known about unpublished entries.
   * unread: the model could not be read; `reason` says why.
   */
  state: "read" | "refused" | "unread";
  /** Entries in the PUBLISHED stage. */
  published: number;
  /** Entries in the DRAFT stage that are not in the PUBLISHED stage. */
  unpublished: number;
  /** The first of them by id (at most HYGRAPH_LIMITS.pages). */
  entries: UnpublishedEntry[];
  /** Slugs the PUBLISHED stage also has: an unpublished entry with one of these shares an address with a published one. */
  sharedSlugs: string[];
  reason?: string;
}

export interface HygraphAdapter extends ContentAdapter {
  /** The content types the settings name. Hygraph is not asked to list its models. */
  collections(): string[];
  /** The settings let the draft-stage check read the DRAFT stage (`readDraftStage`). */
  draftStageAllowed(): boolean;
  /**
   * For each model: the entries in the DRAFT stage that are not in the PUBLISHED stage, as ids and slugs. Only
   * when the settings say `readDraftStage: true`; it is a probing read and the caller must also have the owner's
   * consent.
   */
  unpublishedReading(): Promise<UnpublishedRead[]>;
}

export interface HygraphAdapterOptions {
  /** HYGRAPH_ENDPOINT and HYGRAPH_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`collections`, `fingerprint`, `urls`, `readDraftStage`). */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces HYGRAPH_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value the platform gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** Hygraph refused a request (HTTP 401 or 403), or answered with GraphQL errors: kept apart so a refused DRAFT read is not mistaken for a bad token. */
class Refused extends AdapterCouldNotCheck {
  readonly status: number | "errors";
  constructor(status: number | "errors", reason: string) {
    super(reason);
    this.status = status;
  }
}

/** The selection of a set of field names: a dotted name nests (`seo.title` is `seo { title }`). A name that is also a parent keeps its children. */
function selectionOf(paths: readonly string[]): string {
  interface Node {
    children: Map<string, Node>;
  }
  const root: Node = { children: new Map() };
  for (const path of paths) {
    let at = root;
    for (const part of path.split(".")) {
      let next = at.children.get(part);
      if (next === undefined) {
        next = { children: new Map() };
        at.children.set(part, next);
      }
      at = next;
    }
  }
  const print = (n: Node): string =>
    [...n.children]
      .map(([name, child]) => (child.children.size === 0 ? name : `${name} { ${print(child)} }`))
      .join(" ");
  return print(root);
}

/** An entry as the adapter keeps it: ids, times and the field data only until it is hashed or counted. */
interface RawItem {
  id: string;
  slug?: string;
  publishedAt?: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

function parseItem(raw: unknown, slugField: string | undefined): RawItem {
  const r = isRecord(raw) ? raw : {};
  const publishedAt = isoOf(r.publishedAt);
  const updatedAt = isoOf(r.updatedAt) ?? publishedAt;
  const id = idText(r.id);
  if (id === null || id === "" || updatedAt === undefined)
    throw new AdapterCouldNotCheck(
      "Hygraph answered with entries that have no id or no update time.",
    );
  const slug = slugField === undefined ? undefined : r[slugField];
  return {
    id,
    ...(typeof slug === "string" && slug !== "" ? { slug } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    updatedAt,
    data: r,
  };
}

export function createHygraphAdapter(options: HygraphAdapterOptions): HygraphAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? HYGRAPH_PAGE_SIZE, MAX_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? HYGRAPH_LIMITS.itemsPerType;
  const settings = options.settings;
  const redact = createRedactor(env, [HYGRAPH_TOKEN]);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new Refused(
        err.status,
        err.status === 401
          ? `Hygraph did not accept ${HYGRAPH_TOKEN} (HTTP 401). Check that it is a current permanent auth token for this project.`
          : `Hygraph did not let the token read this (HTTP ${err.status}). The token needs read permission on the model, for the stage that was asked.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(`Hygraph answered HTTP ${err.status}.`);
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const tokenOrThrow = (): string => {
    const key = (env[HYGRAPH_TOKEN] ?? "").trim();
    if (key === "")
      throw new AdapterCouldNotCheck(
        `${HYGRAPH_TOKEN} is not set. Hygraph's content needs a permanent auth token with read permission.`,
      );
    if (!TOKEN_TEXT.test(key))
      throw new AdapterCouldNotCheck(
        `${HYGRAPH_TOKEN} is not a plain token, so nothing was asked.`,
      );
    return key;
  };

  /** The validated endpoint, before the token is read or sent anywhere. */
  const endpointOrThrow = (): HygraphEndpoint => {
    const parsed = parseHygraphEndpoint(env[HYGRAPH_ENDPOINT] ?? "");
    if (typeof parsed === "string") throw new AdapterCouldNotCheck(parsed);
    return parsed;
  };

  /** The `data` of a GraphQL answer. An answer with errors is never an empty list, and its messages (which may quote content) are not repeated. */
  const dataOf = (body: Record<string, unknown>): Record<string, unknown> => {
    if (Array.isArray(body.errors) && body.errors.length > 0)
      throw new Refused(
        "errors",
        `Hygraph answered with ${body.errors.length} error${body.errors.length === 1 ? "" : "s"}. A model or field name in gaugeline.adapters.json may not exist in this project, or the token may have no read permission on it.`,
      );
    if (!isRecord(body.data))
      throw new AdapterCouldNotCheck("Hygraph answered with something that has no data.");
    return body.data;
  };

  /** One query through the allowlist, parsed. A short Retry-After is waited out once. */
  const ask = async (
    document: string,
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    if (fetcher.query === undefined)
      throw new AdapterCouldNotCheck(
        "This fetcher cannot send a read-only query, which Hygraph's Content API needs.",
      );
    const endpoint = endpointOrThrow();
    const headers: Record<string, string> = { authorization: `Bearer ${tokenOrThrow()}` };
    for (let attempt = 0; ; attempt++) {
      try {
        const hop = await fetcher.query(`https://${endpoint.host}${endpoint.path}`, {
          allow: endpoint.allow,
          host: endpoint.host,
          body: { query: document },
          headers,
        });
        if (hop.status === 401 || hop.status === 403) throw new ConnectorRefusedError(hop.status);
        if (hop.status === 429)
          throw new ConnectorRateLimitedError(
            describeRetry(hop.headers),
            retryAfterSeconds(hop.headers),
          );
        if (hop.status < 200 || hop.status >= 300) throw new ConnectorStatusError(hop.status);
        if (hop.truncated) throw new ResponseTooLargeError("Hygraph");
        let body: unknown;
        try {
          body = JSON.parse(hop.body ?? "");
        } catch {
          throw new AdapterCouldNotCheck("Hygraph answered with something that is not JSON.");
        }
        if (!isRecord(body))
          throw new AdapterCouldNotCheck("Hygraph answered with something that is not an object.");
        return dataOf(body);
      } catch (err) {
        if (
          attempt === 0 &&
          err instanceof ConnectorRateLimitedError &&
          err.retrySeconds !== undefined &&
          err.retrySeconds <= MAX_RETRY_SECONDS
        ) {
          await sleep(err.retrySeconds * 1000);
          continue;
        }
        throw translate(err, partial());
      }
    }
  };

  /** The collection and slug field the settings name for a type, checked to be plain GraphQL names. */
  const target = (type: string): { collection: string; slug: string | undefined } => {
    const named = settings?.collections;
    if (named === undefined || Object.keys(named).length === 0)
      throw new AdapterCouldNotCheck(
        'No model is named in gaugeline.adapters.json (under "collections"), and Gaugeline does not ask Hygraph to list its models, so nothing was read.',
      );
    const one = named[type];
    if (one === undefined)
      throw new AdapterCouldNotCheck(
        `The type "${type.slice(0, 40)}" is not named under "collections" in gaugeline.adapters.json, so it was not read.`,
      );
    if (!NAME.test(one.collection) || (one.slug !== undefined && !NAME.test(one.slug)))
      throw new AdapterCouldNotCheck(
        `The collection or slug named for "${type.slice(0, 40)}" is not a plain GraphQL name, so nothing was asked.`,
      );
    return { collection: one.collection, slug: one.slug };
  };

  const typeNames = (): string[] => {
    const named = settings?.collections;
    if (named === undefined || Object.keys(named).length === 0) target("");
    return Object.keys(named ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };

  /**
   * One page of one stage. The order is explicit (`orderBy: id_ASC`), so `skip` walks one stable list. The first
   * page also asks the model's count (`<collection>Connection { aggregate { count } }`), which the whole read is
   * checked against. The stage is one of two words and is always written: a document never relies on the default.
   * The spelling of `first`, `skip`, `stage`, `orderBy: id_ASC` and `aggregate { count }` follows the schema in
   * Hygraph's example repository; a wrong one is a GraphQL error and could-not-check, never a pass.
   */
  const document = (
    collection: string,
    first: number,
    skip: number,
    stage: Stage,
    selection: string,
  ): string =>
    `query Page { ${skip === 0 ? `${collection}Connection(stage: ${stage}) { aggregate { count } } ` : ""}${collection}(first: ${first}, skip: ${skip}, stage: ${stage}, orderBy: id_ASC) { ${selection} } }`;

  /**
   * The entries of one model and one stage, a page at a time, until the first page that comes back short (the API's
   * own `first` and `skip`). An answer over the size limit is asked again with half as many entries, down to ten. An
   * entry seen twice means the list moved while it was read: could-not-check, never a count of a shifting list.
   * Entries scanned count against the bound whatever the caller does with them; `countCap` also refuses, on the
   * first page, a model whose count is over the bound. A list that ends with a different number of entries than its
   * count said is could-not-check. The DRAFT stage is read only through unpublishedReading, which the settings gate.
   */
  async function* pagesOf(
    type: string,
    selection: string,
    stage: Stage,
    countCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<unknown[]> {
    const { collection } = target(type);
    const seen = new Set<string>();
    let counted: number | undefined;
    let skip = 0;
    let size = pageSize;
    for (;;) {
      let rows: unknown[];
      try {
        const data = await ask(document(collection, size, skip, stage, selection), partial);
        const got = data[collection];
        if (!Array.isArray(got))
          throw new AdapterCouldNotCheck(
            "Hygraph answered with something that is not a list of entries.",
          );
        rows = got;
        if (skip === 0) {
          const connection = data[`${collection}Connection`];
          const aggregate = isRecord(connection) ? connection.aggregate : undefined;
          const count = isRecord(aggregate) ? aggregate.count : undefined;
          if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
            throw new AdapterCouldNotCheck(
              "Hygraph answered with something that is not a count of entries.",
            );
          counted = count;
          if (countCap && count > cap)
            throw new AdapterCouldNotCheck(
              `The type has more than ${cap} ${cap === 1 ? "entry" : "entries"}, which is as many as Gaugeline reads from one type.`,
            );
        }
      } catch (err) {
        // A refusal means "this token cannot read this stage" only on the first page. After a page was answered it
        // says nothing about the token, and what came before must not be thrown away as a pass.
        if (err instanceof Refused && stage === "DRAFT" && skip > 0)
          throw new AdapterCouldNotCheck(
            "Hygraph refused the DRAFT stage after answering its first page, so the DRAFT list was not read in full and nothing is concluded from it.",
          );
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Hygraph's answer for ${size} entries is larger than Gaugeline reads at once, even after asking for fewer entries at a time (down to ${MIN_PAGE_SIZE}). The type was not read.`,
        );
      }
      for (const row of rows) {
        const id = isRecord(row) ? idText(row.id) : null;
        if (id === null || id === "")
          throw new AdapterCouldNotCheck(
            "Hygraph answered with entries that have no id or no update time.",
          );
        if (seen.has(id))
          throw new AdapterCouldNotCheck(
            "Hygraph gave an entry more than once while the list was read, so the list changed under the read and was not counted.",
          );
        seen.add(id);
      }
      if (seen.size > cap)
        throw new AdapterCouldNotCheck(
          `The type has more than ${cap} ${cap === 1 ? "entry" : "entries"}, which is as many as Gaugeline reads from one type.`,
        );
      yield rows;
      skip += rows.length;
      // A page shorter than the page asked for is the end of the list; a full one is asked past.
      if (rows.length < size) {
        if (counted !== undefined && counted !== seen.size)
          throw new AdapterCouldNotCheck(
            `Hygraph said the model has ${counted} ${counted === 1 ? "entry" : "entries"} and ${seen.size} ${seen.size === 1 ? "was" : "were"} read, so the list was not read as it stood.`,
          );
        return;
      }
    }
  }

  /** The ids of a model's PUBLISHED stage, in a Set: the order and any repeat do not matter. */
  const publishedIds = async (type: string, partial: () => unknown): Promise<Set<string>> => {
    const ids = new Set<string>();
    for await (const rows of pagesOf(type, "id", "PUBLISHED", true, partial))
      for (const row of rows) ids.add(idText((row as Record<string, unknown>).id) ?? "");
    return ids;
  };

  const plainFields = (fields: readonly string[]): string[] => {
    const parts = fields.flatMap((f) => f.split("."));
    if (parts.some((p) => !NAME.test(p)))
      throw new AdapterCouldNotCheck(
        "A field name is not a plain GraphQL name, so nothing was asked.",
      );
    return [...fields];
  };

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = settings?.urls?.[doc.type];
    const url = template === undefined ? "" : fillUrlTemplate(template, doc);
    // One leading slash, or an https address: "//other.example/x" would name another site.
    return /^\/(?![/\\])/.test(url) || url.startsWith("https://") ? url : "";
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of typeNames())
      out.push({ name, count: (await publishedIds(name, () => out.slice())).size });
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    const names = plainFields(fields);
    const selection = selectionOf(["id", ...names]);
    for await (const rows of pagesOf(type, selection, "PUBLISHED", true, () => ({ ...out })))
      for (const row of rows) {
        const data = isRecord(row) ? row : {};
        for (const f of fields) if (hasValue(valueAt(data, f))) out[f] = (out[f] ?? 0) + 1;
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
    const wanted = typeNames().filter((n) => opts.types === undefined || opts.types.includes(n));
    for (const type of wanted) {
      if (remaining <= 0) return;
      const { slug: slugField } = target(type);
      const fields = plainFields(opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? []);
      const selection = selectionOf([
        "id",
        "updatedAt",
        "publishedAt",
        ...(slugField === undefined ? [] : [slugField]),
        ...fields,
      ]);
      for await (const rows of pagesOf(
        type,
        selection,
        "PUBLISHED",
        opts.limit === undefined,
        () => delivered,
      ))
        for (const raw of rows) {
          const item = parseItem(raw, slugField);
          if (since !== undefined && Date.parse(item.updatedAt) < Date.parse(since)) continue;
          const fieldHashes: Record<string, string> = {};
          for (const f of fields) {
            const h = hashValue(valueAt(item.data, f));
            if (h !== undefined) fieldHashes[f] = h;
          }
          const url = resolveUrl({
            id: item.id,
            type,
            ...(item.slug !== undefined ? { slug: item.slug } : {}),
          });
          remaining--;
          delivered++;
          yield {
            id: item.id,
            type,
            ...(url !== "" ? { url } : {}),
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
   * For each model: the ids and slugs the DRAFT stage has that the PUBLISHED stage does not. The PUBLISHED list is
   * read first (ids only, then again if something is found), then the DRAFT list asks for ids and the slug field
   * and nothing else: no field of a draft is ever requested. A model Hygraph will not read is recorded with its
   * reason and the others are still read; a rate limit that stays is thrown with what was read.
   */
  const unpublishedReading = async (): Promise<UnpublishedRead[]> => {
    if (settings?.readDraftStage !== true)
      throw new AdapterCouldNotCheck(
        'The DRAFT stage is read only when gaugeline.adapters.json says "readDraftStage": true for hygraph (and the run has --owner-consent), so nothing was asked.',
      );
    const out: UnpublishedRead[] = [];
    for (const type of typeNames()) {
      try {
        const { slug: slugField } = target(type);
        const live = await publishedIds(type, () => out.slice());
        const rows: { id: string; slug?: string }[] = [];
        try {
          for await (const page of pagesOf(
            type,
            selectionOf(["id", ...(slugField === undefined ? [] : [slugField])]),
            "DRAFT",
            true,
            () => out.slice(),
          ))
            for (const raw of page) {
              const r = raw as Record<string, unknown>;
              const slug = slugField === undefined ? undefined : r[slugField];
              rows.push({
                id: idText(r.id) ?? "",
                ...(typeof slug === "string" && SLUG_TEXT.test(slug) ? { slug } : {}),
              });
            }
        } catch (err) {
          if (err instanceof Refused) {
            out.push({
              type,
              state: "refused",
              published: live.size,
              unpublished: 0,
              entries: [],
              sharedSlugs: [],
              reason: err.reason,
            });
            continue;
          }
          throw err;
        }
        // The DRAFT stage holds every published entry. A DRAFT list that lacks one is not the DRAFT stage (a token
        // limited to PUBLISHED may be given an empty list instead of an error), and "nothing is unpublished" from it
        // would be a pass built on nothing.
        const inDraft = new Set(rows.map((r) => r.id));
        if ([...live].some((id) => !inDraft.has(id)))
          throw new AdapterCouldNotCheck(
            "The DRAFT list did not contain published entries, so it is not the DRAFT stage and nothing is concluded from it.",
          );
        const extra = rows.filter((r) => !live.has(r.id));
        // Unpublished entries found: read the PUBLISHED list once more. An entry published (or unpublished) while the
        // lists were read would look unpublished or hide one, so a list that moved is could-not-check.
        if (extra.length > 0) {
          const again = await publishedIds(type, () => out.slice());
          if (again.size !== live.size || [...again].some((id) => !live.has(id)))
            throw new AdapterCouldNotCheck(
              "The published list changed during the read, so which entries are unpublished cannot be told from this read. Run it again.",
            );
        }
        const entries = extra
          .filter((r) => ID_TEXT.test(r.id))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, HYGRAPH_LIMITS.pages);
        // The slugs of the published list, to tell an unpublished entry that shares an address with a published one.
        const publishedSlugs = new Set<string>();
        if (slugField !== undefined && extra.length > 0)
          for await (const page of pagesOf(
            type,
            selectionOf(["id", slugField]),
            "PUBLISHED",
            true,
            () => out.slice(),
          ))
            for (const raw of page) {
              const s = (raw as Record<string, unknown>)[slugField];
              if (typeof s === "string") publishedSlugs.add(s);
            }
        out.push({
          type,
          state: "read",
          published: live.size,
          unpublished: extra.length,
          entries,
          sharedSlugs: entries
            .map((e) => e.slug)
            .filter((s): s is string => s !== undefined && publishedSlugs.has(s)),
        });
      } catch (err) {
        if (err instanceof AdapterRateLimitedError) throw err;
        if (err instanceof AdapterCouldNotCheck)
          out.push({
            type,
            state: "unread",
            published: 0,
            unpublished: 0,
            entries: [],
            sharedSlugs: [],
            reason: err.reason,
          });
        else throw err;
      }
    }
    return out;
  };

  return {
    id: "hygraph",
    describe: () => HYGRAPH_DESCRIPTION,
    types,
    fieldCounts,
    published,
    // Only the PUBLISHED stage is asked for here, so there is no draft read to report.
    draftsReachable: () => Promise.resolve("not-applicable"),
    collections: () => Object.keys(settings?.collections ?? {}).sort(),
    draftStageAllowed: () => settings?.readDraftStage === true,
    unpublishedReading,
    resolveUrl,
  };
}
