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
  PRISMIC_ACCESS_TOKEN,
  PRISMIC_DESCRIPTION,
  PRISMIC_ENV_VARS,
  PRISMIC_LIMITS,
  PRISMIC_PAGE_SIZE,
  PRISMIC_REPOSITORY,
} from "./prismic.entry.js";
export {
  PRISMIC_ACCESS_TOKEN,
  PRISMIC_DESCRIPTION,
  PRISMIC_ENV_VARS,
  PRISMIC_LIMITS,
  PRISMIC_PAGE_SIZE,
  PRISMIC_REPOSITORY,
};

/** The smallest page asked for when an answer is too big: the page size is divided down to this and no further. */
const MIN_PAGE_SIZE = 5;

/**
 * A repository name is what Prismic's own client accepts (letters, digits and hyphens, at least four characters,
 * not starting or ending with a hyphen), and no more than a DNS label. A name with a dot, a slash, a colon, an
 * at sign or a second hyphen in a row (an `xn--` look-alike) never becomes a host name.
 */
const REPOSITORY = /^[A-Za-z0-9](?!.*--)[-A-Za-z0-9]{2,59}[A-Za-z0-9]$/;

/** A document type's API id: letters, digits, underscores and hyphens. Anything else never goes into an address. */
const TYPE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A ref is an opaque word of letters, digits and a few signs; it is percent-encoded before it is used. */
const REF = /^[A-Za-z0-9._~%+=-]{1,200}$/;

/** A field name Gaugeline may put into the `fetch` parameter. */
const FIELD_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The master ref the public cache serves against the one the origin has, and what each shows as newest. */
export interface PrismicMasterReading {
  /**
   * - `same`: both hosts gave the same master ref.
   * - `stale`: the cache's master ref stayed behind the origin's across the re-reads, and the origin's ref shows a
   *   document published after the newest one the cache's ref shows.
   * - `undetermined`: the refs differ (or kept changing) and nothing shows the cache's ref is older. `reason` says why.
   */
  state: "same" | "stale" | "undetermined";
  reason?: string;
  /** Present when `stale`: the newest publication each ref shows, as ISO times, and the id of the document at the origin's. */
  cacheLatest?: string;
  originLatest?: string;
  originLatestId?: string;
}

/** What one release holds that is already live. Counts and ids only, never a document's content. */
export interface PrismicReleaseReading {
  /** The release's id (ref metadata, not content) and its label as the editors named it. */
  id: string;
  label: string;
  state: "read" | "unread";
  reason?: string;
  /** Documents the release read lists. */
  documents: number;
  /** Documents whose copy in the release was last published before the live copy was: publishing the release would put the older copy back. */
  behind: { id: string; type: string }[];
}

/** The Prismic adapter, plus the two reads its own checks need. */
export interface PrismicAdapter extends ContentAdapter {
  /** The repository the adapter reads. */
  repository(): string;
  /** The types the settings give an address pattern for (`urls`), in order. */
  patternTypes(): string[];
  /** True when the settings turn the release check on (`checkReleases`). */
  checkReleases(): boolean;
  /** The master ref the cache serves against the origin's, re-read to tell a stale ref from a publication in flight. */
  masterRefs(): Promise<PrismicMasterReading>;
  /**
   * What each release holds, read through the release's own ref with the token: documents the release lists whose
   * copy was published before the live copy. Reads unpublished content, so a caller runs it only with the owner's
   * consent (CLAUDE.md rule 14) and the settings entry.
   */
  releaseReadings(): Promise<PrismicReleaseReading[]>;
}

export interface PrismicAdapterOptions {
  /** PRISMIC_REPOSITORY and, optionally, PRISMIC_ACCESS_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`, `checkReleases`). With none, no field value is hashed. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces PRISMIC_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
  /** Replaces PRISMIC_LIMITS.releases. For tests. */
  maxReleases?: number | undefined;
}

/** An ISO 8601 UTC time from a value the platform gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field's value by name; a dotted name goes into objects. */
function valueAt(data: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(data, path)) return data[path];
  let at: unknown = data;
  for (const part of path.split(".")) {
    if (!isRecord(at) || !Object.hasOwn(at, part)) return undefined;
    at = at[part];
  }
  return at;
}

/** Keys of a Prismic value that say what kind it is, not what it holds: an empty link or block still has them. */
const KIND_KEYS = new Set([
  "type",
  "link_type",
  "spans",
  "direction",
  "kind",
  "dimensions",
  "edit",
]);

/**
 * A field counts as present when it holds something: a non-blank text, a number, a boolean, a list with a present
 * element, or an object with a present value besides the keys that only say what kind it is. An empty rich text
 * (one paragraph with no text), an empty link (just `link_type`) and an empty image (`{}`) are not present.
 */
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some(hasValue);
  if (isRecord(v)) return Object.entries(v).some(([k, x]) => !KIND_KEYS.has(k) && hasValue(x));
  return true;
}

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** A ref Prismic no longer knows (HTTP 404 or 410): the repository moved on while a list was being read. */
class RefGone extends AdapterCouldNotCheck {}

/** A ref as the root lists it. */
interface Ref {
  id: string;
  ref: string;
  label: string;
  isMaster: boolean;
  scheduledAt?: string;
}

/** What the repository's root answers: its refs, its document types and its main language. */
interface Root {
  master: Ref;
  releases: Ref[];
  types: string[];
  /** The language code of the repository's main language, or undefined when the root does not say. */
  masterLang: string | undefined;
}

/** A document as the adapter keeps it: its header, and the field data only until it is hashed or counted. */
interface RawDoc {
  id: string;
  type: string;
  uid: string | null;
  lang: string;
  firstPublishedAt: string;
  lastPublishedAt: string;
  data: Record<string, unknown>;
}

/** Which host a read goes to: the public cache (what the site reads) or the origin. */
type Host = "cache" | "origin";

/** Whether a read is for published content (no token unless it is refused) or needs the token (releases). */
type Auth = "published" | "token";

/** One page of a document list. */
interface Page {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  docs: RawDoc[];
}

/** The size to ask for when `size` was too big: its smallest prime factor divided out, so page numbers stay whole. */
function smaller(size: number): number | undefined {
  if (size <= MIN_PAGE_SIZE) return undefined;
  let p = 2;
  while (p * p <= size && size % p !== 0) p++;
  const factor = size % p === 0 ? p : size;
  const next = size / factor;
  return next >= MIN_PAGE_SIZE ? next : undefined;
}

export function createPrismicAdapter(options: PrismicAdapterOptions): PrismicAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? PRISMIC_PAGE_SIZE, PRISMIC_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? PRISMIC_LIMITS.itemsPerType;
  const releaseCap = options.maxReleases ?? PRISMIC_LIMITS.releases;
  const settings = options.settings;
  const token = (env[PRISMIC_ACCESS_TOKEN] ?? "").trim();
  const redact = createRedactor(env, [PRISMIC_ACCESS_TOKEN]);
  /** Once a published read was refused without the token and accepted with it, every read sends it. */
  let tokenNeeded = false;

  /** The repository's name, or a could-not-check that names the variable. */
  const repository = (): string => {
    const text = (env[PRISMIC_REPOSITORY] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${PRISMIC_REPOSITORY} is not set.`);
    if (!REPOSITORY.test(text) || text.length > 63)
      throw new AdapterCouldNotCheck(
        `${PRISMIC_REPOSITORY} is not a Prismic repository name (letters, digits and hyphens, such as larkspur-yoga: the name, not an address).`,
      );
    return text;
  };

  const originOf = (host: Host): string => {
    const name = repository();
    return host === "cache" ? `https://${name}.cdn.prismic.io` : `https://${name}.prismic.io`;
  };

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown, sentToken: boolean): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        sentToken
          ? `Prismic did not accept ${PRISMIC_ACCESS_TOKEN} in an Authorization header (HTTP ${err.status}). Check it is a current access token of this repository. Prismic's own client sends the token in the address for this API, which Gaugeline never does, so a repository that takes it only there cannot be read with a key.`
          : `Prismic does not show this repository to a visitor with no token (HTTP ${err.status}). It is private: set ${PRISMIC_ACCESS_TOKEN}.`,
      );
    if (err instanceof ConnectorStatusError) {
      if (err.status === 404 || err.status === 410)
        return new RefGone(
          err.status === 410
            ? "Prismic answered HTTP 410: the ref it was asked about has expired, so the repository changed while it was being read."
            : "Prismic answered HTTP 404: there is no such repository or ref. Check the repository name; a ref that was just replaced answers this too.",
        );
      return new AdapterCouldNotCheck(`Prismic answered HTTP ${err.status}.`);
    }
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /**
   * One GET of the Document API, parsed as a JSON object, to `https://<repository>.cdn.prismic.io` or
   * `https://<repository>.prismic.io` and no other host (the name is checked above). A published read goes with no
   * token first and is repeated with it only when refused; a `token` read always sends it. The token goes in an
   * Authorization header, never in the address, only over https, and a redirect to another origin drops it.
   */
  const get = async (
    host: Host,
    path: string,
    params: Record<string, string>,
    auth: Auth,
    partial: () => unknown,
    fresh = false,
  ): Promise<Record<string, unknown>> => {
    let sentToken = false;
    try {
      if (auth === "token" && token === "")
        throw new AdapterCouldNotCheck(
          `${PRISMIC_ACCESS_TOKEN} is not set. Releases need a read access token.`,
        );
      const query = new URLSearchParams(params).toString();
      const address = `${originOf(host)}/api/v2${path}${query === "" ? "" : `?${query}`}`;
      const ask = async (withToken: boolean): Promise<unknown> => {
        sentToken = withToken;
        const { body } = await getJson(
          {
            fetcher,
            request: {
              ...(withToken ? { authorization: `Token ${token}` } : { anonymous: true }),
              headers: { accept: "application/json" },
              // A second look at the same address (the fetcher remembers answers) is asked for again.
              ...(fresh ? { fresh: true } : {}),
            },
            sleep,
            system: "Prismic",
          },
          address,
        );
        return body;
      };
      let body: unknown;
      if (auth === "token" || tokenNeeded) body = await ask(true);
      else
        try {
          body = await ask(false);
        } catch (err) {
          if (!(err instanceof ConnectorRefusedError) || token === "") throw err;
          body = await ask(true);
          tokenNeeded = true;
        }
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Prismic answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial(), sentToken);
    }
  };

  const refOf = (raw: unknown): Ref => {
    const r = isRecord(raw) ? raw : {};
    if (
      typeof r.ref !== "string" ||
      !REF.test(r.ref) ||
      typeof r.id !== "string" ||
      r.id === "" ||
      typeof r.isMasterRef !== "boolean"
    )
      throw new AdapterCouldNotCheck("Prismic answered with a ref Gaugeline cannot read.");
    const scheduledAt = isoOf(r.scheduledAt);
    return {
      id: r.id,
      ref: r.ref,
      label: typeof r.label === "string" ? r.label : "",
      isMaster: r.isMasterRef,
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
    };
  };

  /** The repository's root: refs, document types and main language. Exactly one master ref, or it is could-not-check. */
  const root = async (
    host: Host,
    auth: Auth,
    partial: () => unknown,
    fresh = false,
  ): Promise<Root> => {
    const body = await get(host, "", {}, auth, partial, fresh);
    if (!Array.isArray(body.refs))
      throw new AdapterCouldNotCheck("Prismic's root answer has no list of refs.");
    const refs = body.refs.map(refOf);
    const masters = refs.filter((r) => r.isMaster);
    if (masters.length !== 1 || masters[0] === undefined)
      throw new AdapterCouldNotCheck(
        `Prismic's root answer lists ${masters.length} master refs, and there must be exactly one.`,
      );
    if (!isRecord(body.types))
      throw new AdapterCouldNotCheck("Prismic's root answer has no list of document types.");
    const types = Object.keys(body.types).sort();
    for (const t of types)
      if (!TYPE_NAME.test(t))
        throw new AdapterCouldNotCheck(
          `"${t}" is not a document type name Gaugeline can ask for (letters, digits, underscores and hyphens).`,
        );
    let masterLang: string | undefined;
    if (Array.isArray(body.languages)) {
      const main = body.languages.filter((l) => isRecord(l) && l.is_master === true);
      const first = main[0];
      if (main.length === 1 && isRecord(first) && typeof first.id === "string" && first.id !== "")
        masterLang = first.id;
    }
    return {
      master: masters[0],
      releases: refs
        .filter((r) => !r.isMaster)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      types,
      masterLang,
    };
  };

  /** A document, parsed strictly: a header value that is not the kind expected is unknown, never "none". */
  const parseDoc = (raw: unknown): RawDoc => {
    const r = isRecord(raw) ? raw : {};
    const first = isoOf(r.first_publication_date);
    const last = isoOf(r.last_publication_date);
    if (typeof r.id !== "string" || r.id === "")
      throw new AdapterCouldNotCheck("Prismic answered with a document that has no id.");
    if (typeof r.type !== "string" || !TYPE_NAME.test(r.type))
      throw new AdapterCouldNotCheck("Prismic answered with a document whose type is not a name.");
    if (typeof r.lang !== "string" || r.lang === "")
      throw new AdapterCouldNotCheck("Prismic answered with a document that has no language.");
    if (r.uid !== null && typeof r.uid !== "string")
      throw new AdapterCouldNotCheck(
        "Prismic answered with a document whose uid is neither text nor empty, so whether it has one is unknown.",
      );
    if (last === undefined || first === undefined)
      throw new AdapterCouldNotCheck(
        "Prismic answered with a document that has no usable publication time.",
      );
    return {
      id: r.id,
      type: r.type,
      uid: r.uid === "" ? null : r.uid,
      lang: r.lang,
      firstPublishedAt: first,
      lastPublishedAt: last,
      data: isRecord(r.data) ? r.data : {},
    };
  };

  const nonNegativeInt = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new AdapterCouldNotCheck(`Prismic's answer has no usable ${what}.`);
    return v;
  };

  interface ListSpec {
    ref: string;
    host: Host;
    auth: Auth;
    /** Only this document type; undefined: every type. */
    type?: string;
    /** Top-level field names to ask for (`fetch`); undefined: whole documents. */
    fetch?: readonly string[];
    /** The explicit order. Every list has one, so that pages do not overlap. */
    order: string;
  }

  const pageOf = async (
    spec: ListSpec,
    page: number,
    size: number,
    partial: () => unknown,
  ): Promise<Page> => {
    const fetchParam: Record<string, string> =
      spec.type !== undefined && spec.fetch !== undefined && spec.fetch.length > 0
        ? { fetch: spec.fetch.map((f) => `${spec.type}.${f}`).join(",") }
        : {};
    const body = await get(
      spec.host,
      "/documents/search",
      {
        ref: spec.ref,
        lang: "*",
        page: String(page),
        pageSize: String(size),
        orderings: `[${spec.order}]`,
        ...(spec.type !== undefined ? { q: `[[at(document.type, "${spec.type}")]]` } : {}),
        ...fetchParam,
      },
      spec.auth,
      partial,
    );
    if (!Array.isArray(body.results))
      throw new AdapterCouldNotCheck(
        "Prismic answered with something that is not a list of documents.",
      );
    return {
      page: nonNegativeInt(body.page, "page number"),
      perPage: nonNegativeInt(body.results_per_page, "page size"),
      total: nonNegativeInt(body.total_results_size, "total"),
      totalPages: nonNegativeInt(body.total_pages, "page count"),
      docs: body.results.map(parseDoc),
    };
  };

  /**
   * The documents of one list a page at a time, at one fixed ref (so the list is a snapshot), in an explicit
   * order, until every one is read. Cross-checks: each page says the page number asked for, the size asked for
   * and the same total and page count as the first; no document id appears twice; the list ends only when the
   * count read equals the total the first page reported. A shortfall or a surplus is could-not-check, never the end
   * of the list. An answer over the size limit is asked again with a smaller page (a divisor of the old one, so the
   * pages already read stay whole) before it becomes could-not-check; a list longer than `cap`, whatever total
   * the server claims, is could-not-check.
   */
  async function* listOf(
    spec: ListSpec,
    enforceCap: boolean,
    partial: () => unknown,
  ): AsyncGenerator<RawDoc> {
    const seen = new Set<string>();
    let size = pageSize;
    let read = 0;
    let total: number | undefined;
    let totalPages: number | undefined;
    const maxRequests = Math.ceil(cap / MIN_PAGE_SIZE) + 12;
    let asked = 0;
    for (;;) {
      if (++asked > maxRequests)
        throw new AdapterCouldNotCheck(
          `Prismic needed more than ${maxRequests} requests to list documents, so the list was not read to the end.`,
        );
      const next = read / size + 1;
      let page: Page;
      try {
        page = await pageOf(spec, next, size, partial);
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        const less = smaller(size);
        if (less !== undefined) {
          size = less;
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Prismic's answer for ${size} documents is larger than Gaugeline reads at once, even after asking for fewer at a time. The list was not read.`,
        );
      }
      if (page.page !== next)
        throw new AdapterCouldNotCheck(
          `Prismic answered page ${page.page} when page ${next} was asked for, so the list was not read.`,
        );
      if (page.perPage !== size)
        throw new AdapterCouldNotCheck(
          `Prismic answered with ${page.perPage} documents to a page when ${size} were asked for, so page numbers no longer line up and the list was not read.`,
        );
      if (total === undefined) {
        total = page.total;
        totalPages = page.totalPages;
        if (enforceCap && total > cap)
          throw new AdapterCouldNotCheck(
            `The list has ${total} documents, more than ${cap}, which is as many as Gaugeline reads from one list.`,
          );
        if (totalPages !== Math.ceil(total / size))
          throw new AdapterCouldNotCheck(
            `Prismic reported ${total} documents in ${totalPages} pages of ${size}, which does not add up, so the list was not read.`,
          );
      } else if (page.total !== total || page.totalPages !== totalPages)
        throw new AdapterCouldNotCheck(
          "The list changed while it was being read (the total moved between pages), so it was not read.",
        );
      // Every page but the last is full, and the last holds what is left: anything else is a list that moved or
      // a server that does not page the way it said, so it is could-not-check, never the end of the list.
      const expected = Math.min(size, total - read);
      if (page.docs.length !== expected)
        throw new AdapterCouldNotCheck(
          `Prismic gave ${page.docs.length} documents on page ${page.page} when ${expected} were expected (${read} of ${total} read), so the list was not read to the end.`,
        );
      if (read + page.docs.length > cap)
        throw new AdapterCouldNotCheck(
          `Prismic listed more documents than the ${cap} Gaugeline reads from one list, whatever total it reported.`,
        );
      for (const d of page.docs) {
        if (seen.has(d.id))
          throw new AdapterCouldNotCheck(
            "A document came back on two pages, so the list moved while it was read and was not counted.",
          );
        seen.add(d.id);
        yield d;
      }
      read += page.docs.length;
      if (read === total) return;
    }
  }

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const fieldsToFetch = (fields: readonly string[]): string[] | undefined => {
    const tops = fields.map((f) => f.split(".")[0] ?? f);
    return tops.length > 0 && tops.every((t) => FIELD_NAME.test(t))
      ? [...new Set(tops)]
      : undefined;
  };

  const PUBLISHED_ORDER = "document.first_publication_date";

  const cacheSpec = (r: Root, type?: string, fetch?: readonly string[]): ListSpec => ({
    ref: r.master.ref,
    host: "cache",
    auth: "published",
    ...(type !== undefined ? { type } : {}),
    ...(fetch !== undefined ? { fetch } : {}),
    order: PUBLISHED_ORDER,
  });

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    const r = await root("cache", "published", () => out.slice());
    for (const name of r.types) {
      const page = await pageOf(cacheSpec(r, name), 1, 1, () => out.slice());
      if (page.total > 0 && page.docs.length !== 1)
        throw new AdapterCouldNotCheck(
          `Prismic reported ${page.total} documents of ${name} and listed none on the first page.`,
        );
      out.push({ name, count: page.total });
    }
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    const r = await root("cache", "published", () => ({}));
    if (!r.types.includes(type)) return out;
    const fetch = fieldsToFetch(fields);
    for await (const d of listOf(cacheSpec(r, type, fetch), true, () => ({})))
      for (const f of fields) if (hasValue(valueAt(d.data, f))) out[f] = (out[f] ?? 0) + 1;
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
    const r = await root("cache", "published", () => delivered);
    for (const type of r.types.filter((n) => opts.types === undefined || opts.types.includes(n))) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      const read = listOf(
        cacheSpec(r, type, fieldsToFetch(fields)),
        opts.limit === undefined,
        () => delivered,
      );
      for await (const d of read) {
        if (since !== undefined && d.lastPublishedAt < since) continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          // An empty rich text, link or image is Prismic's way of "no value": left out, as a missing field is.
          const value = valueAt(d.data, f);
          const h = hasValue(value) ? hashValue(value) : undefined;
          if (h !== undefined) fieldHashes[f] = h;
        }
        // The page pattern is for the repository's main language. A document in another language lives at an
        // address Gaugeline does not guess (a locale prefix), so it is given none rather than a wrong one.
        const url =
          r.masterLang !== undefined && d.lang === r.masterLang
            ? resolveUrl({ id: d.id, type, ...(d.uid !== null ? { slug: d.uid } : {}) })
            : "";
        remaining--;
        delivered++;
        yield {
          id: d.id,
          type,
          ...(url !== "" ? { url } : {}),
          ...(d.uid !== null ? { slug: d.uid } : {}),
          publishedAt: d.firstPublishedAt,
          updatedAt: d.lastPublishedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  /**
   * Can the key reach unpublished work? With no token there is no key to ask about. With one, the root lists the
   * releases the token can see: a release is unpublished content the token can query. A root that lists none says
   * nothing (a repository may have none, or hide them), so it is could-not-check, never "no".
   */
  const draftsReachable = async (): Promise<boolean | "not-applicable"> => {
    if (token === "") return "not-applicable";
    // Listing the releases a token can see is a look at unpublished work: only when the settings say it may be.
    if (settings?.checkReleases !== true)
      throw new AdapterCouldNotCheck(
        "Not asked: the token could reach releases, which hold unpublished content, and gaugeline.adapters.json does not say checkReleases: true for prismic.",
      );
    const r = await root("cache", "token", () => undefined);
    if (r.releases.length > 0) return true;
    throw new AdapterCouldNotCheck(
      "The repository lists no release, so whether the token could read unpublished work is not known. A repository with no release has nothing to read, and one that hides its releases looks the same.",
    );
  };

  /** The newest publication a ref shows (one document, newest first), as ISO time and id. */
  const newestAt = async (ref: string): Promise<{ at: string; id: string } | undefined> => {
    const spec: ListSpec = {
      ref,
      host: "cache",
      auth: "published",
      order: "document.last_publication_date desc",
    };
    const page = await pageOf(spec, 1, 1, () => undefined);
    const d = page.docs[0];
    return d === undefined ? undefined : { at: d.lastPublishedAt, id: d.id };
  };

  const masterRefs = async (): Promise<PrismicMasterReading> => {
    const settleMs = PRISMIC_LIMITS.settleSeconds * 1000;
    let previous: { cache: string; origin: string } | undefined;
    for (let round = 0; round < 3; round++) {
      // A re-read is a new request: the fetcher would hand back what it was told the first time.
      const again = round > 0;
      const cache = (await root("cache", "published", () => undefined, again)).master.ref;
      const origin = (await root("origin", "published", () => undefined, again)).master.ref;
      if (cache === origin) return { state: "same" };
      // The two hosts disagree. A publication in flight makes them disagree for a moment, so the pair has to
      // survive a wait longer than the cache's own (5 seconds) before it counts.
      if (previous !== undefined && previous.cache === cache && previous.origin === origin) {
        const [seenByCache, seenByOrigin] = [await newestAt(cache), await newestAt(origin)];
        if (seenByCache === undefined || seenByOrigin === undefined)
          return {
            state: "undetermined",
            reason:
              "the two hosts give different master refs, and one of them shows no published document, so there is nothing to compare",
          };
        if (seenByOrigin.at > seenByCache.at)
          return {
            state: "stale",
            cacheLatest: seenByCache.at,
            originLatest: seenByOrigin.at,
            originLatestId: seenByOrigin.id,
          };
        return {
          state: "undetermined",
          reason:
            "the two hosts give different master refs for longer than the cache's own wait, but the origin's ref shows no document published after the newest the cache's ref shows (an unpublished or deleted document looks like this), so it cannot be said the cache is older",
        };
      }
      previous = { cache, origin };
      if (round < 2) await sleep(settleMs);
    }
    return {
      state: "undetermined",
      reason:
        "the master ref kept changing between reads, so the repository was being published to while it was read",
    };
  };

  const behindOf = async (
    release: Ref,
    masterDates: Map<string, string>,
  ): Promise<{ documents: number; behind: { id: string; type: string }[] }> => {
    const behind: { id: string; type: string }[] = [];
    let documents = 0;
    const spec: ListSpec = {
      ref: release.ref,
      host: "cache",
      auth: "token",
      order: PUBLISHED_ORDER,
    };
    for await (const d of listOf(spec, true, () => undefined)) {
      documents++;
      const live = masterDates.get(d.id);
      if (live !== undefined && d.lastPublishedAt < live) behind.push({ id: d.id, type: d.type });
    }
    return { documents, behind };
  };

  const releaseReadings = async (): Promise<PrismicReleaseReading[]> => {
    if (token === "")
      throw new AdapterCouldNotCheck(
        `${PRISMIC_ACCESS_TOKEN} is not set. Releases need a read access token.`,
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await root("cache", "token", () => undefined, attempt > 0);
      const masterDates = new Map<string, string>();
      for await (const d of listOf(
        { ref: before.master.ref, host: "cache", auth: "token", order: PUBLISHED_ORDER },
        true,
        () => undefined,
      ))
        masterDates.set(d.id, d.lastPublishedAt);
      const out: PrismicReleaseReading[] = [];
      const chosen = before.releases.slice(0, releaseCap);
      for (const rel of chosen) {
        try {
          const got = await behindOf(rel, masterDates);
          out.push({ id: rel.id, label: rel.label, state: "read", ...got });
        } catch (err) {
          if (err instanceof AdapterRateLimitedError) throw err;
          if (!(err instanceof AdapterCouldNotCheck)) throw err;
          out.push({
            id: rel.id,
            label: rel.label,
            state: "unread",
            reason: err.reason,
            documents: 0,
            behind: [],
          });
        }
      }
      for (const rel of before.releases.slice(releaseCap))
        out.push({
          id: rel.id,
          label: rel.label,
          state: "unread",
          reason: `more than ${releaseCap} releases exist, and a run reads at most ${releaseCap}`,
          documents: 0,
          behind: [],
        });
      // A publication, or a change to a release, between the reads makes a comparison of two moments: read the
      // refs again and, when any moved, start over once. A second move is could-not-check, never a finding.
      const after = await root("cache", "token", () => undefined, true);
      const same =
        after.master.ref === before.master.ref &&
        after.releases.length === before.releases.length &&
        after.releases.every(
          (r, i) => r.id === before.releases[i]?.id && r.ref === before.releases[i]?.ref,
        );
      if (same) return out;
      if (attempt === 1)
        return before.releases.map((rel) => ({
          id: rel.id,
          label: rel.label,
          state: "unread" as const,
          reason:
            "the repository was published to while the release was read, twice, so the two reads are not of the same moment",
          documents: 0,
          behind: [],
        }));
    }
    throw new AdapterCouldNotCheck("The releases were not read.");
  };

  return {
    id: "prismic",
    describe: () => PRISMIC_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    repository,
    patternTypes: () => Object.keys(settings?.urls ?? {}).sort(),
    checkReleases: () => settings?.checkReleases === true,
    masterRefs,
    releaseReadings,
  };
}
