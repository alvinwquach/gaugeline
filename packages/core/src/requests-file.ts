import * as z from "zod";
import { REQUEST_KINDS, type RequestRow } from "./request-log.js";
import { redact } from "./redact.js";
import type { PageData, StructuredBlock } from "./run-view.js";

/**
 * The file `--save-requests <file>` writes: every address a check requested and the data the page
 * declares, kept apart from the result. It has its own version, independent of the result's, and
 * its own published schema (schema/requests.v<N>.json). Bump REQUESTS_FILE_SCHEMA_VERSION only
 * together with a new schema file; never edit a published one.
 *
 * Everything in it goes through redact(), the function findings and reports use. It holds no
 * headers and no response bodies beyond the page's own title, canonical, first words and
 * structured data, and it is cut to the caps below, saying so in the file itself.
 */
export const REQUESTS_FILE_SCHEMA_VERSION = 1 as const;

/** Requests kept in the file. A run makes a few hundred at most; the rest are counted, not listed. */
export const MAX_SAVED_REQUESTS = 1000;
/** Text kept for the page (title, canonical, first words and structured data together), in UTF-8 bytes. */
export const MAX_SAVED_PAGE_BYTES = 256 * 1024;

/** Said in the file itself, so whoever opens it sees it before anything else. */
export const REQUESTS_FILE_NOTICE =
  "This file may contain page content and addresses from the site that was checked. Do not commit it or share it publicly.";

const CUT_ERROR = "This block was cut to fit the size limit.";

const okBlockSchema = z
  .object({
    ok: z.literal(true),
    /** The parsed JSON of one structured data script tag. */
    value: z.unknown(),
  })
  .strict();
const badBlockSchema = z
  .object({
    ok: z.literal(false),
    /** The block's text, redacted, and cut when it was too long. */
    raw: z.string(),
    error: z.string(),
    /** Present, and true, when `raw` was cut to fit the size limit. */
    truncated: z.literal(true).optional(),
  })
  .strict();

const requestSchema = z
  .object({
    url: z.string(),
    kind: z.enum(REQUEST_KINDS),
    method: z.enum(["GET", "HEAD"]),
    /** null when nothing answered. */
    status: z.number().int().nullable(),
    error: z.enum(["timeout", "private-address-refused", "no-answer"]).optional(),
    ms: z.number().nonnegative(),
    /** Where a 3xx pointed. */
    location: z.string().optional(),
  })
  .strict();

export const requestsFileSchema = z
  .object({
    schemaVersion: z.literal(REQUESTS_FILE_SCHEMA_VERSION),
    generatedBy: z.string(),
    notice: z.string(),
    url: z.string(),
    startedAt: z.iso.datetime({ offset: true }),
    /** What was cut to keep the file small. Everything is "not cut" in a normal run. */
    truncation: z
      .object({
        truncated: z.boolean(),
        maxRequests: z.number().int().nonnegative(),
        requestsTotal: z.number().int().nonnegative(),
        requestsSaved: z.number().int().nonnegative(),
        maxPageBytes: z.number().int().nonnegative(),
        notes: z.array(z.string()),
      })
      .strict(),
    /** By kind, then in the order they were requested. */
    requests: z.array(requestSchema),
    page: z
      .object({
        url: z.string(),
        title: z.string().optional(),
        canonical: z.string().optional(),
        words: z.number().int().nonnegative(),
        firstWords: z.string(),
        blocks: z.array(z.union([okBlockSchema, badBlockSchema])),
        /** Structured data blocks left out because the page's text limit was reached. */
        blocksOmitted: z.number().int().nonnegative(),
        /** Names of the fields above that were cut: "title", "canonical", "firstWords", "blocks". */
        truncated: z.array(z.enum(["title", "canonical", "firstWords", "blocks"])),
      })
      .strict(),
  })
  .strict();

export type RequestsFile = z.infer<typeof requestsFileSchema>;

export function parseRequestsFile(value: unknown): RequestsFile {
  return requestsFileSchema.parse(value);
}

export interface RequestsFileCaps {
  maxRequests?: number;
  maxPageBytes?: number;
}

/** redact() on every string in a JSON value, keys included, without ever re-parsing JSON text. */
function clean<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = clean(v);
    return out as T;
  }
  return value;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** The longest start of `text` that fits `max` UTF-8 bytes, never ending inside a character. */
function cutBytes(text: string, max: number): string {
  if (max <= 0) return "";
  if (bytes(text) <= max) return text;
  let out = Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
  while (out.endsWith("\uFFFD")) out = out.slice(0, -1);
  return out;
}

const num = (n: number): string => n.toLocaleString("en-US");

/**
 * Assemble the file. Redaction comes first and the cut second, so a cut can never leave the front
 * of a key that redact() would have recognised whole.
 */
export function buildRequestsFile(
  run: {
    url: string;
    startedAt: Date;
    /** The CLI's version, written as "Gaugeline <version>". */
    version: string;
    requests: readonly RequestRow[];
    page: PageData;
  },
  caps: RequestsFileCaps = {},
): RequestsFile {
  const maxRequests = caps.maxRequests ?? MAX_SAVED_REQUESTS;
  const maxPageBytes = caps.maxPageBytes ?? MAX_SAVED_PAGE_BYTES;
  const notes: string[] = [];

  // The keys in reading order: the address first.
  const requests = clean(
    run.requests.slice(0, maxRequests).map((r) => ({
      url: r.url,
      kind: r.kind,
      method: r.method,
      status: r.status,
      ...(r.error === undefined ? {} : { error: r.error }),
      ms: r.ms,
      ...(r.location === undefined ? {} : { location: r.location }),
    })),
  );
  if (run.requests.length > maxRequests)
    notes.push(
      `${num(run.requests.length)} requests were made; only the first ${num(maxRequests)} are saved.`,
    );

  const page = clean(run.page);
  const cut: RequestsFile["page"]["truncated"] = [];
  let left = maxPageBytes;
  const fit = (field: "title" | "canonical" | "firstWords", text: string): string => {
    const kept = cutBytes(text, left);
    if (kept !== text) {
      cut.push(field);
      notes.push(
        `page.${field} was cut to fit the ${num(maxPageBytes)}-byte limit for a page's text (it was ${num(bytes(text))} bytes).`,
      );
    }
    left -= bytes(kept);
    return kept;
  };
  const title = page.title === undefined ? undefined : fit("title", page.title);
  const canonical = page.canonical === undefined ? undefined : fit("canonical", page.canonical);
  const firstWords = fit("firstWords", page.firstWords);

  const blocks: RequestsFile["page"]["blocks"] = [];
  let omitted = 0;
  let blocksCut = 0;
  for (const block of page.blocks as StructuredBlock[]) {
    if (block.ok) {
      const text = JSON.stringify(block.value) ?? "null";
      if (bytes(text) <= left) {
        left -= bytes(text);
        blocks.push({ ok: true, value: block.value });
        continue;
      }
      const room = left - bytes(CUT_ERROR);
      if (room <= 0) {
        omitted += 1;
        continue;
      }
      blocks.push({ ok: false, raw: cutBytes(text, room), error: CUT_ERROR, truncated: true });
      left = 0;
      blocksCut += 1;
      continue;
    }
    const size = bytes(block.raw) + bytes(block.error);
    if (size <= left) {
      left -= size;
      blocks.push({ ok: false, raw: block.raw, error: block.error });
      continue;
    }
    const room = left - bytes(block.error);
    if (room <= 0) {
      omitted += 1;
      continue;
    }
    blocks.push({ ok: false, raw: cutBytes(block.raw, room), error: block.error, truncated: true });
    left = 0;
    blocksCut += 1;
  }
  if (omitted > 0 || blocksCut > 0) {
    cut.push("blocks");
    if (blocksCut > 0)
      notes.push(
        `${num(blocksCut)} structured data block${blocksCut === 1 ? " was" : "s were"} cut to fit the ${num(maxPageBytes)}-byte limit for a page's text.`,
      );
    if (omitted > 0)
      notes.push(
        `${num(omitted)} structured data block${omitted === 1 ? " was" : "s were"} left out: the ${num(maxPageBytes)}-byte limit for a page's text was reached.`,
      );
  }

  return {
    schemaVersion: REQUESTS_FILE_SCHEMA_VERSION,
    generatedBy: `Gaugeline ${run.version}`,
    notice: REQUESTS_FILE_NOTICE,
    url: redact(run.url),
    startedAt: run.startedAt.toISOString(),
    truncation: {
      truncated: notes.length > 0,
      maxRequests,
      requestsTotal: run.requests.length,
      requestsSaved: requests.length,
      maxPageBytes,
      notes,
    },
    requests,
    page: {
      url: page.url,
      ...(title === undefined ? {} : { title }),
      ...(canonical === undefined ? {} : { canonical }),
      words: page.words,
      firstWords,
      blocks,
      blocksOmitted: omitted,
      truncated: cut,
    },
  };
}
