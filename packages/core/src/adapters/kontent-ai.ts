import { ResponseTooLargeError, getJson, isRecord } from "../connectors/get-json.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { fillUrlTemplate, hasValue, hashValue, valueAt } from "./fingerprint.js";
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
  KONTENT_DEFAULT_SLUG_ELEMENT,
  KONTENT_DELIVERY_HOST,
  KONTENT_DESCRIPTION,
  KONTENT_ENVIRONMENT_ID,
  KONTENT_ENV_VARS,
  KONTENT_LIMITS,
  KONTENT_PAGE_SIZE,
  KONTENT_PREVIEW_API_KEY,
  KONTENT_PREVIEW_HOST,
  KONTENT_SECURE_ACCESS_KEY,
} from "./kontent-ai.entry.js";
export {
  KONTENT_DEFAULT_SLUG_ELEMENT,
  KONTENT_DELIVERY_HOST,
  KONTENT_DESCRIPTION,
  KONTENT_ENVIRONMENT_ID,
  KONTENT_ENV_VARS,
  KONTENT_LIMITS,
  KONTENT_PAGE_SIZE,
  KONTENT_PREVIEW_API_KEY,
  KONTENT_PREVIEW_HOST,
  KONTENT_SECURE_ACCESS_KEY,
};

/** The page size is never asked smaller than this: a page is made smaller only while the answer is too big, down to this and no further. */
const MIN_PAGE_SIZE = 5;

/** An environment id is a UUID. It goes into the address path, so nothing else is accepted. */
const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An element codename: lower-case letters, digits and underscores. It goes into an address (the `elements` projection), so nothing else is accepted. */
const ELEMENT = /^[a-z0-9_]{1,50}$/;

/** What a key looks like: printable ASCII with no space. Anything else is a paste mistake, and is never sent. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

/** An id Gaugeline will print in a finding and put in a report: letters, digits, hyphens and underscores. */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The workflow step Kontent.ai gives an item that has a published version and no newer one. */
const PUBLISHED_STEP = "published";

type Host = "delivery" | "preview";

/** An unpublished item as the check needs it: where it is, what step it is in, and its slug. Never a name or an element. */
export interface UnpublishedEntry {
  id: string;
  type: string;
  slug?: string;
  /** The workflow step's codename, as the Preview API gives it ("draft", "scheduled", "archived", or a step of your own). */
  step: string;
}

/**
 * What the Preview API shows that the Delivery API does not.
 * - read: both lists were read in full and agree (every published item is in the Preview list).
 * - refused: the Preview API would not give the list to this key (HTTP 401 or 403): nothing is known about unpublished items.
 * - unread: the lists could not be read or do not agree; `reason` says why.
 */
export interface KontentUnpublishedRead {
  state: "read" | "refused" | "unread";
  /** Items in the Delivery list. */
  published: number;
  /** Unpublished items of a type with an address pattern, by codename, at most KONTENT_LIMITS.pages. */
  entries: UnpublishedEntry[];
  /** Unpublished items of a type with an address pattern that are not in `entries` (more than the page budget). */
  unlisted: number;
  /** Unpublished items by type that have no address pattern in the settings: their pages were not asked. */
  withoutPattern: { type: string; count: number }[];
  /** Items in the Preview list and not in the Delivery list whose step says "published" or says nothing readable: most likely published a moment ago, so never reported as unpublished. */
  unclear: number;
  /** Slugs a published item of the same type also has: an unpublished item with one of these shares an address with a published one. */
  sharedSlugs: { type: string; slug: string }[];
  reason?: string;
}

/** The Kontent.ai adapter, plus the one probing read the preview check needs. */
export interface KontentAdapter extends ContentAdapter {
  /** The settings let the preview check read the Preview API (`readPreview`). */
  readPreviewAllowed(): boolean;
  /** The types that have an address pattern in the settings, sorted. */
  patternTypes(): string[];
  /**
   * The items the Preview API lists that the Delivery API does not, as ids, types, slugs and workflow steps. Only when
   * the settings say `readPreview: true`; it reads unpublished content with the Preview API key, so a caller runs it
   * only with the owner's consent (CLAUDE.md rule 14).
   */
  unpublishedReading(): Promise<KontentUnpublishedRead>;
}

export interface KontentAdapterOptions {
  /** KONTENT_ENVIRONMENT_ID and, optionally, the two keys, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry: `fingerprint`, `urls`, `slugElement`, `readPreview`. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces KONTENT_LIMITS.items. For tests. */
  maxItems?: number | undefined;
  /** Replaces KONTENT_LIMITS.pages. For tests. */
  maxPages?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The Preview API refused the key: nothing is known about unpublished items. */
class PreviewRefused extends AdapterCouldNotCheck {}

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** The next smaller page size: half of it, down to MIN_PAGE_SIZE. `skip` counts items, so any size reads on exactly. */
function smaller(size: number): number | undefined {
  return size <= MIN_PAGE_SIZE ? undefined : Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
}

/** An item as the adapter keeps it. */
interface Row {
  id: string;
  type: string;
  modified: string | undefined;
  /** The workflow step. null: present and not text. undefined: the answer has none. */
  step: string | null | undefined;
  elements: Record<string, unknown>;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= 200 ? value : undefined;
}

function parseRow(raw: unknown): Row {
  const system = isRecord(raw) && isRecord(raw.system) ? raw.system : undefined;
  const id = textOf(system?.id);
  const type = textOf(system?.type);
  if (system === undefined || id === undefined || type === undefined)
    throw new AdapterCouldNotCheck(
      "Kontent.ai answered with items that have no id or no type, or whose id or type is not text.",
    );
  const raws = (raw as Record<string, unknown>).elements;
  return {
    id,
    type,
    modified: isoOf(system.last_modified),
    step: !Object.hasOwn(system, "workflow_step")
      ? undefined
      : typeof system.workflow_step === "string"
        ? system.workflow_step
        : null,
    elements: isRecord(raws) ? raws : {},
  };
}

/** The elements of a row as `{ codename: value }`, for the codenames asked for only. */
function dataOf(row: Row, codenames: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of codenames) {
    const el = row.elements[c];
    if (isRecord(el) && Object.hasOwn(el, "value")) out[c] = el.value;
  }
  return out;
}

export function createKontentAdapter(options: KontentAdapterOptions): KontentAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? KONTENT_PAGE_SIZE, KONTENT_PAGE_SIZE));
  const cap = options.maxItems ?? KONTENT_LIMITS.items;
  const pageBudget = options.maxPages ?? KONTENT_LIMITS.pages;
  const settings = options.settings;
  const secureKey = (env[KONTENT_SECURE_ACCESS_KEY] ?? "").trim();
  const previewKey = (env[KONTENT_PREVIEW_API_KEY] ?? "").trim();
  const slugElement = settings?.slugElement ?? KONTENT_DEFAULT_SLUG_ELEMENT;
  const redact = createRedactor(env, [KONTENT_SECURE_ACCESS_KEY, KONTENT_PREVIEW_API_KEY]);
  const patterns = Object.keys(settings?.urls ?? {}).sort();

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown, host: Host): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new TooLarge(err.message);
    if (err instanceof ConnectorRefusedError && host === "preview")
      return new PreviewRefused(
        `Kontent.ai would not let ${KONTENT_PREVIEW_API_KEY} read the Preview API (HTTP ${err.status}). Check that it is a Preview API key of this environment, and that it has not been regenerated.`,
      );
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        secureKey !== ""
          ? `Kontent.ai would not let ${KONTENT_SECURE_ACCESS_KEY} read the Delivery API (HTTP ${err.status}). Check that it is a Delivery API secure access key of this environment and that secure access is on for it.`
          : `Kontent.ai would not show this environment to a visitor with no key (HTTP ${err.status}). If secure access is on for the environment, set ${KONTENT_SECURE_ACCESS_KEY} to a Delivery API secure access key.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status >= 300 && err.status < 400
          ? `Kontent.ai answered HTTP ${err.status}, a redirect, which is not followed (a key is never sent on to another address). Check ${KONTENT_ENVIRONMENT_ID}.`
          : err.status === 404
            ? `Kontent.ai answered HTTP 404: there is no environment with the id in ${KONTENT_ENVIRONMENT_ID}. Copy it again from Environment settings, API keys.`
            : `Kontent.ai answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The environment's id, or a could-not-check that names the variable. */
  const environmentId = (): string => {
    const text = (env[KONTENT_ENVIRONMENT_ID] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${KONTENT_ENVIRONMENT_ID} is not set.`);
    if (!ENVIRONMENT_ID.test(text))
      throw new AdapterCouldNotCheck(
        `${KONTENT_ENVIRONMENT_ID} is not an environment id (expected a UUID such as 5f1d2c7e-3b8a-4c1e-9d46-7a2b8e0f1c35).`,
      );
    return text.toLowerCase();
  };

  /** The codenames of the elements to ask for, validated: nothing else is put into an address. */
  const codenamesOf = (fields: readonly string[]): string[] => {
    const out = new Set<string>();
    for (const f of fields) {
      const c = f.split(".")[0] ?? f;
      if (!ELEMENT.test(c))
        throw new AdapterCouldNotCheck(
          `"${f}" is not an element codename (lower-case letters, digits and underscores).`,
        );
      out.add(c);
    }
    return [...out];
  };

  const keyOk = (key: string, name: string): void => {
    if (!KEY_SHAPE.test(key))
      throw new AdapterCouldNotCheck(
        `${name} has a space, a line break or a character that is not plain ASCII in it, so it is not a key. Copy it again without anything around it.`,
      );
  };

  /**
   * One GET of the item list, parsed as JSON. The key goes in a header, never in the address: the Delivery host gets
   * the secure access key (when there is one) and the Preview host gets the Preview key, and neither is ever sent to
   * the other. A redirect is not followed, so a key goes to the address that was asked and nowhere else.
   */
  const get = async (
    host: Host,
    params: Record<string, string>,
    partial: () => unknown,
    fresh = false,
  ): Promise<Record<string, unknown>> => {
    try {
      const id = environmentId();
      const key = host === "preview" ? previewKey : secureKey;
      if (host === "preview" && key === "")
        throw new AdapterCouldNotCheck(
          `${KONTENT_PREVIEW_API_KEY} is not set. Unpublished items need a Preview API key.`,
        );
      if (key !== "")
        keyOk(key, host === "preview" ? KONTENT_PREVIEW_API_KEY : KONTENT_SECURE_ACCESS_KEY);
      const address = `https://${host === "preview" ? KONTENT_PREVIEW_HOST : KONTENT_DELIVERY_HOST}/${id}/items?${new URLSearchParams(params).toString()}`;
      const { body } = await getJson(
        {
          fetcher,
          request: {
            // A read with no key is a visitor's: nothing the fetcher adds per address goes with it.
            ...(key !== "" ? { authorization: `Bearer ${key}` } : { anonymous: true }),
            headers: { accept: "application/json" },
            maxRedirects: 0,
            // The fetcher remembers answers: a second read to check the first must not be handed the first.
            ...(fresh ? { fresh: true } : {}),
          },
          sleep,
          system: "Kontent.ai",
        },
        address,
      );
      if (!isRecord(body))
        throw new AdapterCouldNotCheck("Kontent.ai answered with something that is not an object.");
      return body;
    } catch (err) {
      throw translate(err, partial(), host);
    }
  };

  /**
   * The items of the environment's list a page at a time, until every one is read. The order is fixed (`order` by
   * codename, which is unique), `skip` is the number of items already read, and the end is the reported total
   * (`includeTotalCount`): the list is read to exactly that many, every id is seen once, and the page echoes the `skip`
   * that was asked. A total that moves, a repeated id, a page whose count is not the number of items in it, a list
   * that stops early, a `next_page` after the last item, or a list longer than the cap is could-not-check, never the
   * end of the list. An answer over the size limit is asked again with a smaller page, down to five.
   */
  async function* rowsIn(
    host: Host,
    enforceCap: boolean,
    partial: () => unknown,
    codenames: readonly string[] = [],
    fresh = false,
  ): AsyncGenerator<Row> {
    const maxPages = Math.ceil(cap / MIN_PAGE_SIZE) + 12;
    let size = pageSize;
    let read = 0;
    let asked = 0;
    const seen = new Set<string>();
    let firstTotal: number | undefined;
    for (;;) {
      if (++asked > maxPages)
        throw new AdapterCouldNotCheck(
          `Kontent.ai needed more than ${maxPages} requests to list the items, so they were not read to the end.`,
        );
      let body: Record<string, unknown>;
      try {
        body = await get(
          host,
          {
            limit: String(size),
            skip: String(read),
            order: "system.codename[asc]",
            includeTotalCount: "true",
            ...(codenames.length > 0 ? { elements: codenames.join(",") } : {}),
          },
          partial,
          fresh,
        );
      } catch (err) {
        if (!(err instanceof TooLarge)) throw err;
        const next = smaller(size);
        if (next !== undefined) {
          size = next;
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Kontent.ai's answer for ${size} items is larger than the 5 MB Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The items were not read.`,
        );
      }
      const pagination = body.pagination;
      if (!isRecord(pagination))
        throw new AdapterCouldNotCheck(
          "Kontent.ai's answer has no pagination, so the list cannot be checked against its total.",
        );
      const total = pagination.total_count;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
        throw new AdapterCouldNotCheck(
          "Kontent.ai's answer has no total_count, so the list cannot be checked against it.",
        );
      firstTotal ??= total;
      if (total !== firstTotal)
        throw new AdapterCouldNotCheck(
          `The list changed while it was read: Kontent.ai reported ${firstTotal} items and then ${total}.`,
        );
      if (enforceCap && total > cap)
        throw new AdapterCouldNotCheck(
          `The environment has ${total} items, more than ${cap}, which is as many as Gaugeline reads.`,
        );
      if (pagination.skip !== read)
        throw new AdapterCouldNotCheck(
          `Kontent.ai answered from item ${String(pagination.skip)} when ${read} was asked for, so the list is not reliable.`,
        );
      const rows = body.items;
      if (!Array.isArray(rows))
        throw new AdapterCouldNotCheck(
          "Kontent.ai answered with something that is not a list of items.",
        );
      if (pagination.count !== rows.length)
        throw new AdapterCouldNotCheck(
          `Kontent.ai counted ${String(pagination.count)} items in a page that holds ${rows.length}, so the list is not reliable.`,
        );
      if (rows.length > size)
        throw new AdapterCouldNotCheck(
          `Kontent.ai listed ${rows.length} items when ${size} were asked for, so the list is not reliable.`,
        );
      if (read + rows.length > cap)
        throw new AdapterCouldNotCheck(
          `Kontent.ai listed more items than the ${cap} Gaugeline reads, whatever total it reported.`,
        );
      for (const raw of rows) {
        const row = parseRow(raw);
        if (seen.has(row.id))
          throw new AdapterCouldNotCheck(
            `Kontent.ai listed the same item twice (id ${PLAIN_ID.test(row.id) ? row.id : "with an odd id"}) while the list was read, so it is not reliable: the server may ignore skip, or items were added or removed during the read.`,
          );
        seen.add(row.id);
        yield row;
      }
      read += rows.length;
      const next = pagination.next_page;
      if (read > total)
        throw new AdapterCouldNotCheck(
          `The list changed while it was read: Kontent.ai reported ${total} items and ${read} came back.`,
        );
      if (read === total) {
        if (typeof next === "string" && next !== "")
          throw new AdapterCouldNotCheck(
            `Kontent.ai says there is another page after all ${total} items were read, so the list is not reliable.`,
          );
        return;
      }
      if (rows.length === 0 || next === "")
        throw new AdapterCouldNotCheck(
          `Kontent.ai's list stopped after ${read} of ${total} items, so the rest was not read.`,
        );
    }
  }

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  /** The slug element's text, or undefined. */
  const slugOf = (row: Row): string | undefined => {
    const el = row.elements[slugElement];
    return isRecord(el) ? textOf(el.value) : undefined;
  };

  const types = async (): Promise<TypeCount[]> => {
    const counts = new Map<string, number>();
    for await (const row of rowsIn("delivery", true, () => [], [slugElement]))
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
    return [...counts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, count]) => ({ name, count }));
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const codenames = codenamesOf(fields);
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    for await (const row of rowsIn("delivery", true, () => [], codenames)) {
      if (row.type !== type) continue;
      const data = dataOf(row, codenames);
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
    const fieldsOf = (type: string): readonly string[] =>
      opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
    // Which elements to ask for: the fields of the types asked about, and the slug element (a slug is not content).
    const wanted = (
      opts.types ?? [
        ...new Set([
          ...Object.keys(settings?.fingerprint ?? {}),
          ...Object.keys(opts.fields ?? {}),
        ]),
      ]
    ).flatMap((t) => [...fieldsOf(t)]);
    const codenames = codenamesOf([...wanted, slugElement]);
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    if (remaining <= 0) return;
    for await (const row of rowsIn(
      "delivery",
      opts.limit === undefined,
      () => delivered,
      codenames,
    )) {
      if (opts.types !== undefined && !opts.types.includes(row.type)) continue;
      if (row.modified === undefined)
        throw new AdapterCouldNotCheck(
          "Kontent.ai answered with items that have no readable last_modified, so their update time is unknown.",
        );
      if (since !== undefined && row.modified < since) continue;
      const data = dataOf(row, codenames);
      const slug = slugOf(row);
      const fieldHashes: Record<string, string> = {};
      for (const f of fieldsOf(row.type)) {
        // Kontent.ai sends an element that is empty as an element with an empty value: it is a field the item does not have.
        const v = valueAt(data, f);
        const h = hasValue(v) ? hashValue(v) : undefined;
        if (h !== undefined) fieldHashes[f] = h;
      }
      const url = resolveUrl({
        id: row.id,
        type: row.type,
        ...(slug !== undefined ? { slug } : {}),
      });
      remaining--;
      delivered++;
      yield {
        id: row.id,
        type: row.type,
        ...(url !== "" ? { url } : {}),
        ...(slug !== undefined ? { slug } : {}),
        updatedAt: row.modified,
        fieldHashes,
      };
      if (remaining <= 0) return;
    }
  }

  /** The Delivery list as ids and slugs only, in one pass. */
  const deliveryIds = async (
    fresh = false,
  ): Promise<Map<string, { type: string; slug?: string }>> => {
    const out = new Map<string, { type: string; slug?: string }>();
    for await (const row of rowsIn("delivery", true, () => [], [slugElement], fresh)) {
      const slug = slugOf(row);
      out.set(row.id, { type: row.type, ...(slug !== undefined ? { slug } : {}) });
    }
    return out;
  };

  const unpublishedReading = async (): Promise<KontentUnpublishedRead> => {
    if (settings?.readPreview !== true)
      throw new AdapterCouldNotCheck(
        'The Preview API is read only when gaugeline.adapters.json says "readPreview": true for kontent-ai (and the run has --owner-consent), so nothing was asked.',
      );
    const empty = (
      state: "refused" | "unread",
      reason: string,
      published = 0,
    ): KontentUnpublishedRead => ({
      state,
      published,
      entries: [],
      unlisted: 0,
      withoutPattern: [],
      unclear: 0,
      sharedSlugs: [],
      reason,
    });
    let first: Map<string, { type: string; slug?: string }>;
    try {
      first = await deliveryIds();
    } catch (err) {
      if (err instanceof AdapterRateLimitedError) throw err;
      if (err instanceof AdapterCouldNotCheck) return empty("unread", err.reason);
      throw err;
    }
    const preview: { row: Row; slug: string | undefined }[] = [];
    try {
      for await (const row of rowsIn("preview", true, () => [], [slugElement]))
        preview.push({ row, slug: slugOf(row) });
    } catch (err) {
      if (err instanceof AdapterRateLimitedError) throw err;
      if (err instanceof AdapterCouldNotCheck) {
        // A refusal is the Preview key being refused: nothing is known about unpublished items, and it says so.
        return empty(err instanceof PreviewRefused ? "refused" : "unread", err.reason, first.size);
      }
      throw err;
    }
    // The Preview list holds every published item. One that is missing means this is not the Preview list (or the list moved).
    const inPreview = new Set(preview.map((p) => p.row.id));
    for (const id of first.keys())
      if (!inPreview.has(id))
        return empty(
          "unread",
          "an item the Delivery API lists is missing from the Preview API's list, so it is not the whole Preview list, or an item was unpublished while the lists were read",
          first.size,
        );
    const candidates: UnpublishedEntry[] = [];
    let unclear = 0;
    for (const { row, slug } of preview) {
      if (first.has(row.id)) continue;
      // A step that says "published", or says nothing readable (absent, not text, or not a codename), is an item
      // published a moment ago or one Gaugeline cannot classify: never a finding.
      if (
        row.step === undefined ||
        row.step === null ||
        row.step === PUBLISHED_STEP ||
        !ELEMENT.test(row.step)
      ) {
        unclear++;
        continue;
      }
      candidates.push({
        id: row.id,
        type: row.type,
        ...(slug !== undefined ? { slug } : {}),
        step: row.step,
      });
    }
    if (candidates.length > 0) {
      // Read the Delivery list again: an item published while the lists were read, or any other change, is not a finding.
      let again: Map<string, { type: string; slug?: string }>;
      try {
        again = await deliveryIds(true);
      } catch (err) {
        if (err instanceof AdapterRateLimitedError) throw err;
        if (err instanceof AdapterCouldNotCheck) return empty("unread", err.reason, first.size);
        throw err;
      }
      const same = again.size === first.size && [...first.keys()].every((id) => again.has(id));
      if (!same)
        return empty(
          "unread",
          "the Delivery list changed while the Preview list was read, so which items are unpublished cannot be told from these reads",
          first.size,
        );
    }
    const withPattern = new Set(patterns);
    const entries: UnpublishedEntry[] = [];
    const counts = new Map<string, number>();
    let unlisted = 0;
    for (const c of candidates) {
      if (!withPattern.has(c.type)) {
        counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
      } else if (entries.length < pageBudget && PLAIN_ID.test(c.id)) entries.push(c);
      else unlisted++;
    }
    const shared: { type: string; slug: string }[] = [];
    for (const v of first.values())
      if (v.slug !== undefined && entries.some((e) => e.type === v.type && e.slug === v.slug))
        shared.push({ type: v.type, slug: v.slug });
    return {
      state: "read",
      published: first.size,
      entries,
      unlisted,
      withoutPattern: [...counts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([type, count]) => ({ type, count })),
      unclear,
      sharedSlugs: shared,
    };
  };

  return {
    id: "kontent-ai",
    describe: () => KONTENT_DESCRIPTION,
    types,
    fieldCounts,
    published,
    // Only published items are asked for here, so there is no draft read to report.
    draftsReachable: () => Promise.resolve("not-applicable"),
    resolveUrl,
    readPreviewAllowed: () => settings?.readPreview === true,
    patternTypes: () => [...patterns],
    unpublishedReading,
  };
}
