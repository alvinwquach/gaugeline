import { ConnectorRateLimitedError } from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import {
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
  createSanityRead,
  typeCountsWith,
  type SanityRead,
} from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { readSanity } from "../handoff/sanity.js";
import { maskEmail } from "../handoff/people.js";
import { accessor, countPaths, countedPath, countedPaths } from "../query/counts.js";
import { fillUrlTemplate, hashValue } from "./fingerprint.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterMember,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

import { SANITY_DESCRIPTION } from "./meta.js";
export { SANITY_DESCRIPTION };

/** Items asked for in one request. A GET carries the query in its address, so the page stays small. */
export const SANITY_PAGE_SIZE = 100;

export interface SanityAdapterOptions {
  /** SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is read. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
}

const NO_ADDRESS = "(address not shown by Sanity)";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a value Sanity gave, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Sanity on ContentAdapter. Nothing here is new behaviour: the questions are the ones the query check
 * and the content model already ask (the type names and one count per type, `defined()` counts per
 * field), asked through the same reader (GET only, published perspective, the token in a header),
 * plus a page-by-page list of published documents as fingerprints and a count of drafts the key can
 * see. A field's value is requested only when the settings name it, and is hashed on arrival.
 */
export function createSanityAdapter(options: SanityAdapterOptions): ContentAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = options.pageSize ?? SANITY_PAGE_SIZE;
  const settings = options.settings;
  const redact = createRedactor(env, [SANITY_TOKEN]);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const reader = (perspective?: "raw"): SanityRead => {
    try {
      return createSanityRead(env, fetcher, { sleep, ...(perspective ? { perspective } : {}) });
    } catch (err) {
      throw translate(err, undefined);
    }
  };

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const types = async (): Promise<TypeCount[]> => {
    const read = reader();
    const into = new Map<string, number>();
    const list = (): TypeCount[] => [...into].map(([name, count]) => ({ name, count }));
    try {
      await typeCountsWith((groq) => read.query(groq), into);
    } catch (err) {
      throw translate(err, list());
    }
    return list();
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const read = reader();
    const counted = countedPaths(fields);
    let answer: Awaited<ReturnType<typeof countPaths>>;
    try {
      answer = await countPaths(type, counted, read);
    } catch (err) {
      throw translate(err, {});
    }
    const out: Record<string, number> = {};
    for (const f of fields) {
      const path = countedPath(f);
      // A system field (_id, _updatedAt) is on every document; a field no document has counts 0.
      out[f] = path === null ? answer.total : (answer.defined.get(path) ?? 0);
    }
    return out;
  };

  /** One page of one type, ordered by id so the next page can start after the last id. */
  const pageQuery = (
    type: string,
    fields: readonly string[],
    after: string | undefined,
    since: string | undefined,
    size: number,
  ): string => {
    const filter = [
      `_type == ${JSON.stringify(type)}`,
      ...(after !== undefined ? [`_id > ${JSON.stringify(after)}`] : []),
      ...(since !== undefined ? [`_updatedAt >= ${JSON.stringify(since)}`] : []),
    ].join(" && ");
    const hashed = fields.map((f, i) => `"h${i}":${accessor(f)}`);
    return `*[${filter}] | order(_id) [0...${size}]{_id,"slug":slug.current,"publishedAt":publishedAt,_updatedAt${hashed.map((h) => `,${h}`).join("")}}`;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = isoOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    let delivered = 0;
    const read = reader();
    const names = opts.types ?? (await types()).map((t) => t.name);
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const type of names) {
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      let after: string | undefined;
      while (remaining > 0) {
        const size = Math.min(pageSize, remaining);
        let rows: unknown;
        try {
          rows = await read.query(pageQuery(type, fields, after, since, size));
        } catch (err) {
          throw translate(err, delivered);
        }
        if (!Array.isArray(rows))
          throw new AdapterCouldNotCheck("Sanity answered with something that is not a list.");
        for (const row of rows) {
          const r = row !== null && typeof row === "object" ? (row as Record<string, unknown>) : {};
          const id = r._id;
          const updatedAt = isoOf(r._updatedAt);
          if (typeof id !== "string" || id === "" || updatedAt === undefined)
            throw new AdapterCouldNotCheck(
              "Sanity answered with documents that have no id or no update time.",
            );
          const fieldHashes: Record<string, string> = {};
          fields.forEach((f, i) => {
            const h = hashValue(r[`h${i}`]);
            if (h !== undefined) fieldHashes[f] = h;
          });
          const slug = typeof r.slug === "string" && r.slug !== "" ? r.slug : undefined;
          const publishedAt = isoOf(r.publishedAt);
          const url = resolveUrl({ id, type, ...(slug !== undefined ? { slug } : {}) });
          after = id;
          remaining--;
          delivered++;
          yield {
            id,
            type,
            ...(url !== "" ? { url } : {}),
            ...(slug !== undefined ? { slug } : {}),
            ...(publishedAt !== undefined ? { publishedAt } : {}),
            updatedAt,
            fieldHashes,
          };
          if (remaining <= 0) break;
        }
        if (rows.length < size) break;
      }
    }
  }

  const draftsReachable = async (): Promise<boolean> => {
    const read = reader("raw");
    let n: unknown;
    try {
      n = await read.query('count(*[_id in path("drafts.**")])');
    } catch (err) {
      throw translate(err, undefined);
    }
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
      throw new AdapterCouldNotCheck("Sanity answered with something that is not a count.");
    return n > 0;
  };

  const members = async (): Promise<AdapterMember[]> => {
    const projectId = (env[SANITY_PROJECT_ID] ?? "").trim();
    const got = await readSanity({
      env,
      fetcher,
      projectId: projectId === "" ? undefined : projectId,
    });
    if (!got.ok) throw new AdapterCouldNotCheck(redact(got.reason));
    // People only: an API token listed as a member is not someone with a mailbox.
    return got.members
      .filter((m) => m.token !== true)
      .map((m) => ({ emailMasked: m.email ? maskEmail(m.email) : NO_ADDRESS, role: m.role }));
  };

  return {
    id: "sanity",
    describe: () => SANITY_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    members,
    resolveUrl,
  };
}
