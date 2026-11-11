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
import { fillUrlTemplate, hashValue } from "./fingerprint.js";
import { DATOCMS_DESCRIPTION, DATOCMS_ENVIRONMENT, DATOCMS_TOKEN } from "./datocms.entry.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

export { DATOCMS_DESCRIPTION, DATOCMS_ENVIRONMENT, DATOCMS_TOKEN };

/**
 * The Content Delivery API is one GraphQL endpoint that answers a query sent as a POST. It is a read API with no
 * write endpoint, and this entry lets Gaugeline send only a document that parses as one `query` (ADR-0006).
 * Source: the package @datocms/cda-client (version 0.3.2, read 11 Nov 2026) sends every request as a POST of
 * `{ query, variables }` to https://graphql.datocms.com/ with `Authorization: Bearer <token>`, and its README
 * links the Content Delivery API pages. The vendor's own pages (www.datocms.com/docs) could not be reached when
 * this was written, so the entry is marked not verified (`checked: null`) and a reviewer sees it.
 */
export const DATOCMS_CDA_QUERY = registerQueryAllow({
  id: "datocms-cda-query",
  host: "graphql.datocms.com",
  path: "/",
  body: { kind: "graphql-query" },
  docs: { url: "https://www.datocms.com/docs/content-delivery-api", checked: null },
});

/** Every request is made to this address and no other: the token is never sent anywhere else. */
export const DATOCMS_ENDPOINT = "https://graphql.datocms.com/";

/**
 * Records asked for in one page. The Content Delivery API returns at most 500 records a collection at a time
 * (the @datocms/cda-client README says so), so 100 keeps an answer small.
 */
export const DATOCMS_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/** Bounds a run keeps to, in the platform's terms. There are no flags to raise them. */
export const DATOCMS_LIMITS = {
  /** Records read from one collection. A bigger one is could-not-check, never a count of part of it. */
  itemsPerType: 10_000,
  /** Ids named in a finding or a reading. The count is always whole; the list is cut. */
  idsShown: 5,
} as const;

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A GraphQL name. Names from the settings go into a query document, so nothing else is ever put there. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TOKEN_TEXT = /^[\x21-\x7e]{1,256}$/;
const ID_TEXT = /^[A-Za-z0-9_-]{1,64}$/;

/** What a read of drafts found for one collection. Ids and counts only; never a field. */
export interface DraftRead {
  type: string;
  /**
   * reachable: a request that asks for drafts got records the published list does not have.
   * accepted-no-drafts: it was accepted and nothing extra came back (no unpublished record exists, or the header had no effect): not proof of anything.
   * refused: DatoCMS refused the request that asks for drafts (HTTP 401 or 403) after answering the published one.
   * unread: the collection could not be read; `reason` says why.
   */
  state: "reachable" | "accepted-no-drafts" | "refused" | "unread";
  /** Records in the published list. */
  published: number;
  /** Records the draft list had and the published list did not. */
  extra: number;
  /** The first of their ids (at most DATOCMS_LIMITS.idsShown, plain ids only). */
  extraIds: string[];
  reason?: string;
}

export interface DatocmsAdapter extends ContentAdapter {
  /** The content types the settings name. DatoCMS has no list of types to ask. */
  collections(): string[];
  /** The settings say the token is meant for published content only (`expectPublishedOnly`). */
  publishedOnlyExpected(): boolean;
  /** For each collection: can a request that asks for drafts see a record the published list does not have. Ids and counts only. */
  draftReading(): Promise<DraftRead[]>;
}

export interface DatocmsAdapterOptions {
  /** DATOCMS_TOKEN and DATOCMS_ENVIRONMENT, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`collections`, `fingerprint`, `urls`, `expectPublishedOnly`). */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces DATOCMS_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value the platform gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A field's value by name; a dotted name goes into objects. */
function valueAt(data: Record<string, unknown>, path: string): unknown {
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

/** DatoCMS refused a request (HTTP 401 or 403), kept apart so a refused draft read is not mistaken for a bad token. */
class Refused extends AdapterCouldNotCheck {
  readonly status: number;
  constructor(status: number, reason: string) {
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

/** An item as the adapter keeps it: ids, times and the field data only until it is hashed or counted. */
interface RawItem {
  id: string;
  slug?: string;
  publishedAt?: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

function parseItem(raw: unknown, slugField: string | undefined): RawItem {
  const r = isRecord(raw) ? raw : {};
  const publishedAt = isoOf(r._publishedAt);
  const updatedAt = isoOf(r._updatedAt) ?? publishedAt;
  const id = idText(r.id);
  if (id === null || id === "" || updatedAt === undefined)
    throw new AdapterCouldNotCheck(
      "DatoCMS answered with records that have no id or no update time.",
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

export function createDatocmsAdapter(options: DatocmsAdapterOptions): DatocmsAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DATOCMS_PAGE_SIZE, MAX_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? DATOCMS_LIMITS.itemsPerType;
  const settings = options.settings;
  const redact = createRedactor(env, [DATOCMS_TOKEN]);

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
          ? "DatoCMS did not accept DATOCMS_TOKEN (HTTP 401). Check that it is a current API token."
          : `DatoCMS did not let the token read this (HTTP ${err.status}). The token needs the Content Delivery API turned on.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(`DatoCMS answered HTTP ${err.status}.`);
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const keyOrThrow = (): string => {
    const key = (env[DATOCMS_TOKEN] ?? "").trim();
    if (key === "")
      throw new AdapterCouldNotCheck(
        `${DATOCMS_TOKEN} is not set. DatoCMS's content needs an API token.`,
      );
    if (!TOKEN_TEXT.test(key))
      throw new AdapterCouldNotCheck(
        `${DATOCMS_TOKEN} is not a plain token, so nothing was asked.`,
      );
    return key;
  };

  const environmentHeader = (): Record<string, string> => {
    const name = (env[DATOCMS_ENVIRONMENT] ?? "").trim();
    if (name === "") return {};
    if (!ENVIRONMENT.test(name))
      throw new AdapterCouldNotCheck(
        `${DATOCMS_ENVIRONMENT} is not a plain environment name (letters, digits, dots, hyphens and underscores), so nothing was asked and the token was not sent.`,
      );
    return { "x-environment": name };
  };

  /** The `data` of a GraphQL answer. An answer with errors is never an empty list, and its messages (which may quote content) are not repeated. */
  const dataOf = (body: Record<string, unknown>): Record<string, unknown> => {
    if (Array.isArray(body.errors) && body.errors.length > 0)
      throw new AdapterCouldNotCheck(
        `DatoCMS answered with ${body.errors.length} error${body.errors.length === 1 ? "" : "s"}. A collection or field name in gaugeline.adapters.json may not exist in this project.`,
      );
    if (!isRecord(body.data))
      throw new AdapterCouldNotCheck("DatoCMS answered with something that has no data.");
    return body.data;
  };

  /**
   * One query through the allowlist, parsed. `drafts` adds X-Include-Drafts, which DatoCMS answers only for a token
   * that may preview. A short Retry-After is waited out once.
   */
  const ask = async (
    document: string,
    drafts: boolean,
    partial: () => unknown,
  ): Promise<Record<string, unknown>> => {
    if (fetcher.query === undefined)
      throw new AdapterCouldNotCheck(
        "This fetcher cannot send a read-only query, which DatoCMS's Content Delivery API needs.",
      );
    const headers: Record<string, string> = {
      authorization: `Bearer ${keyOrThrow()}`,
      ...environmentHeader(),
      ...(drafts ? { "x-include-drafts": "true" } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const hop = await fetcher.query(DATOCMS_ENDPOINT, {
          allow: DATOCMS_CDA_QUERY.id,
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
        if (hop.truncated) throw new ResponseTooLargeError("DatoCMS");
        let body: unknown;
        try {
          body = JSON.parse(hop.body ?? "");
        } catch {
          throw new AdapterCouldNotCheck("DatoCMS answered with something that is not JSON.");
        }
        if (!isRecord(body))
          throw new AdapterCouldNotCheck("DatoCMS answered with something that is not an object.");
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
        'No collection is named in gaugeline.adapters.json (under "collections"), and the DatoCMS Content Delivery API has no list of its content types to ask, so nothing was read.',
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
   * One page. The order is explicit (`orderBy: [id_ASC]`), so `skip` walks one stable list. The first page also
   * asks the collection's count (`_allXMeta { count }`), which the whole read is checked against. The spelling of
   * `orderBy`, `id_ASC` and `count` is uncited (the @datocms/cda-client source only shows that `_allXXXMeta` fields
   * exist); a wrong one is a GraphQL error and could-not-check, never a pass.
   */
  const document = (collection: string, first: number, skip: number, selection: string): string =>
    `query Page { ${skip === 0 ? `_${collection}Meta { count } ` : ""}${collection}(first: ${first}, skip: ${skip}, orderBy: [id_ASC]) { ${selection} } }`;

  /**
   * The records of one collection, a page at a time, until the first page that comes back short (the API's own
   * `first` and `skip`). An answer over the size limit is asked again with half as many records, down to ten. A
   * record seen twice means the list moved while it was read: could-not-check, never a count of a shifting list.
   * `drafts` asks as a token that may preview. Records scanned count against the bound whatever the caller does
   * with them; `countCap` also refuses, on the first page, a collection whose count is over the bound. A list that
   * ends with a different number of records than its count said is could-not-check.
   */
  async function* pagesOf(
    type: string,
    selection: string,
    drafts: boolean,
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
        const data = await ask(document(collection, size, skip, selection), drafts, partial);
        const got = data[collection];
        if (!Array.isArray(got))
          throw new AdapterCouldNotCheck(
            "DatoCMS answered with something that is not a list of records.",
          );
        rows = got;
        if (skip === 0) {
          const meta = data[`_${collection}Meta`];
          const count = isRecord(meta) ? meta.count : undefined;
          if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
            throw new AdapterCouldNotCheck(
              "DatoCMS answered with something that is not a count of records.",
            );
          counted = count;
          if (countCap && count > cap)
            throw new AdapterCouldNotCheck(
              `The type has more than ${cap} record${cap === 1 ? "" : "s"}, which is as many as Gaugeline reads from one type.`,
            );
        }
      } catch (err) {
        // A refusal means "this token cannot read drafts" only on the first page. After a page was answered it
        // says nothing about the token, and what came before must not be thrown away as a pass.
        if (err instanceof Refused && drafts && skip > 0)
          throw new AdapterCouldNotCheck(
            "DatoCMS refused the draft read after answering its first page, so the draft list was not read in full and nothing is concluded from it.",
          );
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `DatoCMS's answer for ${size} records is larger than Gaugeline reads at once, even after asking for fewer records at a time (down to ${MIN_PAGE_SIZE}). The type was not read.`,
        );
      }
      for (const row of rows) {
        const id = isRecord(row) ? idText(row.id) : null;
        if (id === null || id === "")
          throw new AdapterCouldNotCheck(
            "DatoCMS answered with records that have no id or no update time.",
          );
        if (seen.has(id))
          throw new AdapterCouldNotCheck(
            "DatoCMS gave a record more than once while the list was read, so the list changed under the read and was not counted.",
          );
        seen.add(id);
      }
      if (seen.size > cap)
        throw new AdapterCouldNotCheck(
          `The type has more than ${cap} record${cap === 1 ? "" : "s"}, which is as many as Gaugeline reads from one type.`,
        );
      yield rows;
      skip += rows.length;
      // A page shorter than the page asked for is the end of the list; a full one is asked past.
      if (rows.length < size) {
        if (counted !== undefined && counted !== seen.size)
          throw new AdapterCouldNotCheck(
            `DatoCMS said the collection has ${counted} record${counted === 1 ? "" : "s"} and ${seen.size} ${seen.size === 1 ? "was" : "were"} read, so the list was not read as it stood.`,
          );
        return;
      }
    }
  }

  /** The ids of a collection (the published list, or with drafts), in a Set: the order and any repeat do not matter. */
  const idsOf = async (
    type: string,
    drafts: boolean,
    partial: () => unknown,
  ): Promise<Set<string>> => {
    const ids = new Set<string>();
    for await (const rows of pagesOf(type, "id", drafts, true, partial))
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
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of typeNames())
      out.push({ name, count: (await idsOf(name, false, () => out.slice())).size });
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    const names = plainFields(fields);
    const selection = selectionOf(["id", ...names]);
    for await (const rows of pagesOf(type, selection, false, true, () => ({ ...out })))
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
        "_updatedAt",
        "_publishedAt",
        ...(slugField === undefined ? [] : [slugField]),
        ...fields,
      ]);
      for await (const rows of pagesOf(
        type,
        selection,
        false,
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
   * For each collection: the ids the published list has, then the ids a request that asks for drafts has, and the
   * ids only the second one has. Ids only: no field of a draft is ever requested. A collection DatoCMS will not read
   * is recorded with its reason and the others are still read; a rate limit that stays is thrown with what was read.
   */
  const draftReading = async (): Promise<DraftRead[]> => {
    const out: DraftRead[] = [];
    for (const type of typeNames()) {
      try {
        const live = await idsOf(type, false, () => out.slice());
        let every: Set<string>;
        try {
          every = await idsOf(type, true, () => out.slice());
        } catch (err) {
          if (err instanceof Refused) {
            out.push({ type, state: "refused", published: live.size, extra: 0, extraIds: [] });
            continue;
          }
          throw err;
        }
        const extra = [...every].filter((id) => !live.has(id));
        // Drafts found: read the published list once more. A record published (or unpublished) while the lists were
        // read would look like a draft or hide one, so a list that moved is could-not-check.
        if (extra.length > 0) {
          const again = await idsOf(type, false, () => out.slice());
          if (again.size !== live.size || [...again].some((id) => !live.has(id)))
            throw new AdapterCouldNotCheck(
              "The published list changed during the read, so which records are drafts cannot be told from this read. Run it again.",
            );
        }
        out.push({
          type,
          state: extra.length > 0 ? "reachable" : "accepted-no-drafts",
          published: live.size,
          extra: extra.length,
          // Ids are named only when the settings ask for them (showDraftIds); a count is the default.
          extraIds:
            settings?.showDraftIds === true
              ? extra.filter((id) => ID_TEXT.test(id)).slice(0, DATOCMS_LIMITS.idsShown)
              : [],
        });
      } catch (err) {
        if (err instanceof AdapterCouldNotCheck)
          out.push({
            type,
            state: "unread",
            published: 0,
            extra: 0,
            extraIds: [],
            reason: err.reason,
          });
        else throw err;
      }
    }
    return out;
  };

  /**
   * True when a request that asks for drafts is given a record the published list does not have. False only when
   * DatoCMS refuses that request for every collection. A request that is accepted and shows no extra record proves
   * nothing (none may exist), so it is could-not-check, never a pass.
   */
  const draftsReachable = async (): Promise<boolean> => {
    const reads = await draftReading();
    if (reads.some((r) => r.state === "reachable")) return true;
    const unread = reads.find((r) => r.state === "unread");
    if (unread !== undefined)
      throw new AdapterCouldNotCheck(`${unread.type}: ${unread.reason ?? "it could not be read"}`);
    if (reads.length > 0 && reads.every((r) => r.state === "refused")) return false;
    throw new AdapterCouldNotCheck(
      "The token was accepted with a request that asks for drafts, and there is no record that is not published, so whether drafts can be read cannot be told from here.",
    );
  };

  return {
    id: "datocms",
    describe: () => DATOCMS_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    draftReading,
    collections: () => Object.keys(settings?.collections ?? {}).sort(),
    publishedOnlyExpected: () => settings?.expectPublishedOnly === true,
    resolveUrl,
  };
}
