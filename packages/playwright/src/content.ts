import { createFetcher, createSanityRead, isBlockedAddress, sanitise } from "@gaugeline/core";
import type { Fetcher, FetcherOptions } from "@gaugeline/core";
import { assertSampleSize, sampleSeeded } from "./shuffle.js";

/** One GROQ question in, the `result` of Sanity's answer out. The default asks Sanity with one GET. */
export type Reader = (groq: string) => Promise<unknown>;

/** A published document: the address a test should open, and every field the document has. */
export type PublishedDoc<F extends Record<string, unknown> = Record<string, string>> = F & {
  url: string;
  _id: string;
  _type: string;
};

/** A document that was left out of a loop because no address could be made from it. */
export interface SkippedDoc {
  id: string;
  type: string;
  reason: string;
}

export interface ContentOptions {
  /** Sanity project id. Default: SANITY_PROJECT_ID. */
  projectId?: string;
  /** Dataset name. Default: SANITY_DATASET, then "production". */
  dataset?: string;
  /** A read-only token (the Viewer role). Default: SANITY_TOKEN. Sent in a header, never printed. */
  token?: string;
  /** Seeds `sample`. Default: GAUGELINE_SEED, then today's date (UTC), so the sample rotates daily. */
  seed?: string | number;
  /** The field that holds a document's address. Default: "url". */
  urlField?: string;
  /** Where documents of a type live when they have no address: { product: "/shop/{slug}" }. */
  routes?: Record<string, string>;
  /**
   * The site the pages are on. Default: Playwright's own `baseURL`. A document's address must be a
   * path on this site, or an absolute address on this site's origin; anything else is skipped.
   */
  baseURL?: string;
  /**
   * Other origins a document may point at, e.g. ["https://shop.example"]. Default: none. Content is
   * data, so an address on any other origin is skipped with a reason: list an origin here only when
   * you want your tests to open it.
   */
  allowedOrigins?: string[];
  /** Allow an allowed origin that is loopback, private, link-local or a metadata name. Default: false. */
  allowPrivate?: boolean;
  /** Documents asked for per request, 1 to 1000. Default: 100. */
  pageSize?: number;
  /**
   * The most documents `published` reads (and the most a `sample` draws), 1 to 50,000. Default: 10,000.
   * A type with more fails with an error that says to use `sample`.
   */
  maxDocuments?: number;
  /** Replace the Sanity read, e.g. with recorded content. */
  read?: Reader;
}

export interface Content {
  /** Every published document of the type, a page at a time. Throws when there are none. */
  published<F extends Record<string, unknown> = Record<string, string>>(
    type: string,
  ): AsyncIterable<PublishedDoc<F>>;
  /** `n` published documents of the type, chosen by the seed. Throws when there are none. */
  sample<F extends Record<string, unknown> = Record<string, string>>(
    type: string,
    n: number,
  ): AsyncIterable<PublishedDoc<F>>;
  /** Documents left out because they have no usable address, so far in this test. */
  readonly skipped: readonly SkippedDoc[];
  /** The seed `sample` uses. */
  readonly seed: string;
}

export interface ContentContext {
  /** Add a line to the test report (a Playwright annotation). */
  annotate: (type: string, description: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  /** Playwright's `baseURL`, used when the options do not set one. */
  baseURL?: string;
}

/** What a document type is called: a letter, then letters, digits, underscores and hyphens. */
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
/** Requests one `published` or `sample` call may make, however the reader answers. */
export const MAX_REQUESTS = 300;
export const DEFAULT_MAX_DOCUMENTS = 10_000;
/** The most documents one call reads, and the most ids a sample holds in memory. */
export const HARD_MAX_DOCUMENTS = 50_000;
const COUNT_FORMAT = (n: number): string => n.toLocaleString("en-US");
/** Ids per request when fetching a sample: an address carries the query, and long ones are refused. */
const ID_CHUNK = 40;
/** Ids per page when listing a type to draw a sample from (an id is a few dozen bytes). */
const ID_PAGE = 1000;

/**
 * The fetcher the helper reads Sanity with. It is core's own, with its default of refusing
 * loopback, private, link-local and metadata addresses (ADR-0001). Nothing here sets allowPrivate.
 */
export function defaultFetcher(
  options: Pick<FetcherOptions, "resolver" | "transport"> = {},
): Fetcher {
  return createFetcher({ timeoutMs: 15_000, ...options });
}

/** A reader over Sanity's published documents: one GET per question, the token in a header. */
export function readerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fetcher: Fetcher = defaultFetcher(),
): Reader {
  const read = createSanityRead(env, fetcher, {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return (groq) => read.query(groq);
}

function slugOf(doc: Record<string, unknown>): string | undefined {
  const slug = doc.slug;
  const text =
    typeof slug === "string"
      ? slug
      : slug !== null && typeof slug === "object"
        ? (slug as { current?: unknown }).current
        : undefined;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : undefined;
}

/** Names that mean this machine or a private network (a cloud metadata name ends in .internal). */
const LOCAL_NAME = /(^|\.)(local[h]ost|local|internal|localdomain)$/i;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** An address nobody on the site made up: it is only ever a parsed, same-origin path. */
const NO_BASE = "http://gaugeline.invalid";

/** A control character (C0, DEL, C1) or a backslash: the URL parser strips or rewrites these, so a path with one is not what it looks like. */
export function hasHiddenCharacter(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || ch === "\\") return true;
  }
  return false;
}

/** An origin as the URL parser writes it, or undefined when it is not an http(s) site. */
function originOf(text: string): string | undefined {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The address a test should open for a document: its url field, or its route filled in with its
 * slug. A document's text is data from a CMS editor, so it can never send the browser anywhere
 * but the site under test: the result is a path on the site (the parser's own reading of it, with
 * no backslash, control character, dot segment or changed spelling), or, only for an origin in
 * `allowedOrigins`, an absolute address with no user name or password. An address on the site's
 * own origin is handed back as a path. The names a browser would resolve later are not looked up
 * here: only the fetcher resolves names, and it does not open the page.
 */
export function resolveUrl(
  doc: Record<string, unknown>,
  type: string,
  options: Pick<
    ContentOptions,
    "urlField" | "routes" | "allowPrivate" | "baseURL" | "allowedOrigins"
  >,
): { url: string } | { reason: string } {
  const field = doc[options.urlField ?? "url"];
  let raw: string | undefined = typeof field === "string" ? field : undefined;
  if (raw === undefined || raw.trim() === "") {
    const route = options.routes?.[type];
    const slug = slugOf(doc);
    if (route === undefined || slug === undefined)
      return {
        reason: `no url field and ${route === undefined ? `no route for "${type}"` : "no slug"}, so there is no address to open`,
      };
    raw = route.replace("{slug}", encodeURIComponent(slug));
  }
  if (hasHiddenCharacter(raw))
    return {
      reason:
        "its address holds a backslash or a control character, which a browser reads differently",
    };
  const text = raw.trim();
  const base = originOf(options.baseURL ?? NO_BASE);
  if (base === undefined) return { reason: "the site's baseURL is not an http(s) address" };

  if (text.startsWith("/") && !text.startsWith("//")) {
    let parsed: URL;
    try {
      parsed = new URL(text, base);
    } catch {
      return { reason: "its address is not a valid path" };
    }
    const written = text.split(/[?#]/, 1)[0];
    if (parsed.origin !== base || parsed.pathname !== written)
      return {
        reason:
          "its path changes when a browser reads it (dot segments, spaces or unescaped characters); percent-encode it",
      };
    return { url: parsed.pathname + parsed.search };
  }
  if (!SCHEME.test(text))
    return { reason: "its address is not a path starting with one / or an http(s) address" };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { reason: "its address is not a valid http(s) address" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { reason: `its address uses ${parsed.protocol}, not http or https` };
  if (parsed.username !== "" || parsed.password !== "")
    return { reason: "its address has a user name or password" };
  if (parsed.origin === base) return { url: parsed.pathname + parsed.search };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (options.allowPrivate !== true && (isBlockedAddress(host) || LOCAL_NAME.test(host)))
    return { reason: "its address is a private or local address (set allowPrivate to open it)" };
  const allowed = (options.allowedOrigins ?? []).map(originOf);
  if (!allowed.includes(parsed.origin))
    return {
      reason: `its address is on another site (${parsed.origin}); a document cannot send a test elsewhere. List the origin in allowedOrigins to open it`,
    };
  return { url: parsed.origin + parsed.pathname + parsed.search };
}

function emptyError(type: string): Error {
  return new Error(
    `No published "${type}" documents were found. A loop over nothing passes, so this fails instead. ` +
      `Check the type was not renamed, that documents of it are published (a draft is not read), ` +
      `and that the project, dataset and token are the ones that hold them.`,
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function defaultSeed(env: ContentContext["env"], now: () => Date): string {
  const fromEnv = (env.GAUGELINE_SEED ?? "").trim();
  return fromEnv !== "" ? fromEnv : now().toISOString().slice(0, 10);
}

/** A draft or a release version is not published content, whoever answered. */
const isPublishedId = (id: unknown): boolean =>
  typeof id !== "string" || !(id.startsWith("drafts.") || id.startsWith("versions."));

/** An id from content, cleaned for a report: no control characters, a short length. */
const shownId = (id: string): string => sanitise(id, 80).text;

function whole(
  name: string,
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(
      `${name} must be a whole number from ${COUNT_FORMAT(min)} to ${COUNT_FORMAT(max)}, not ${String(value)}.`,
    );
  return value;
}

/** The content fixture's engine: reads published documents of a type and turns them into pages to test. */
export function createContent(options: ContentOptions, context: ContentContext): Content {
  const seed = String(options.seed ?? defaultSeed(context.env, context.now ?? (() => new Date())));
  const pageSize = whole("pageSize", options.pageSize, 1, MAX_PAGE) ?? DEFAULT_PAGE;
  const maxDocuments =
    whole("maxDocuments", options.maxDocuments, 1, HARD_MAX_DOCUMENTS) ?? DEFAULT_MAX_DOCUMENTS;
  const siteOptions = {
    ...options,
    baseURL: options.baseURL ?? context.baseURL,
  };
  for (const origin of options.allowedOrigins ?? [])
    if (originOf(origin) === undefined)
      throw new TypeError(
        `allowedOrigins holds "${shownId(origin)}", which is not an http(s) address.`,
      );
  const skipped: SkippedDoc[] = [];
  let reader: Reader | undefined = options.read;
  const read: Reader = (groq) => {
    reader ??= readerFromEnv({
      SANITY_PROJECT_ID: options.projectId ?? context.env.SANITY_PROJECT_ID,
      SANITY_DATASET: options.dataset ?? context.env.SANITY_DATASET,
      SANITY_TOKEN: options.token ?? context.env.SANITY_TOKEN,
    });
    return reader(groq);
  };

  const typed = (type: string): string => {
    if (!TYPE_NAME.test(type))
      throw new Error(`"${type}" is not a document type name (letters, digits, _ and -).`);
    return JSON.stringify(type);
  };

  /** What one `published` or `sample` call has asked for so far: a reader cannot make it loop forever. */
  interface Budget {
    requests: number;
    /** The most requests this part of the call may make. */
    limit: number;
    /** What to say when the limit is hit: what the user can do about it. */
    hint: string;
  }
  const budgetFor = (hint: string, limit = MAX_REQUESTS): Budget => ({ requests: 0, limit, hint });

  const rows = async (groq: string, budget: Budget): Promise<Record<string, unknown>[]> => {
    if (++budget.requests > budget.limit)
      throw new Error(
        `Stopped after ${String(budget.limit)} requests: more than ${String(budget.limit)} requests were needed to read this type. ${budget.hint}`,
      );
    const result = await read(groq);
    if (!Array.isArray(result))
      throw new Error("Sanity answered with something that is not a list of documents.");
    return result.filter(isRecord);
  };

  /**
   * All the documents of a type, `size` at a time, walking forward by _id so a publish mid-run skips
   * nothing. It stops with an error when the cursor does not move forward (a reader that repeats a
   * page), when a page is longer than asked for, and at `limit` documents.
   */
  async function* walk(
    type: string,
    projection: string,
    size: number,
    limit: number,
    budget: Budget,
    overLimit: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const t = typed(type);
    let after = "";
    let count = 0;
    // Every cursor used so far: a page that ends where one already ended is a loop. (Not a < test:
    // Sanity decides how _id sorts, and a second opinion here could disagree with it.)
    const cursors = new Set<string>();
    for (;;) {
      const filter = after === "" ? "" : ` && _id > ${JSON.stringify(after)}`;
      const page = await rows(
        `*[_type == ${t}${filter}] | order(_id) [0...${size}]${projection}`,
        budget,
      );
      if (page.length > size)
        throw new Error(
          `The reader answered with ${String(page.length)} documents when ${String(size)} were asked for.`,
        );
      const last = page.at(-1)?._id;
      if (page.length > 0 && (typeof last !== "string" || last === after || cursors.has(last)))
        throw new Error(
          `The reader's pages did not move forward (the last _id was "${typeof last === "string" ? shownId(last) : "missing"}" after "${shownId(after)}"), so reading stopped instead of looping.`,
        );
      for (const doc of page) {
        if (!isPublishedId(doc._id)) continue;
        if (++count > limit) throw new Error(overLimit);
        yield doc;
      }
      if (page.length < size || typeof last !== "string") return;
      cursors.add(last);
      after = last;
    }
  }

  /** Documents become pages: an address or a skip, and an error if the loop would otherwise test nothing. */
  async function* pages<F extends Record<string, unknown>>(
    type: string,
    docs: AsyncIterable<Record<string, unknown>>,
  ): AsyncGenerator<PublishedDoc<F>> {
    let seen = 0;
    let yielded = 0;
    for await (const doc of docs) {
      seen++;
      const id = typeof doc._id === "string" ? shownId(doc._id) : "(no id)";
      const resolved = resolveUrl(doc, type, siteOptions);
      if ("reason" in resolved) {
        const skip = { id, type, reason: resolved.reason };
        skipped.push(skip);
        context.annotate("gaugeline-skipped", `${id}: ${skip.reason}`);
        continue;
      }
      yielded++;
      yield { ...doc, url: resolved.url } as PublishedDoc<F>;
    }
    if (seen === 0) throw emptyError(type);
    if (yielded === 0)
      throw new Error(
        `${seen} of ${seen} published "${type}" documents have no address, so nothing was tested. ` +
          `Give them a "${options.urlField ?? "url"}" field or set routes: { ${type}: "/path/{slug}" }.`,
      );
  }

  return {
    published: <F extends Record<string, unknown> = Record<string, string>>(type: string) =>
      pages<F>(
        type,
        walk(
          type,
          "{...}",
          pageSize,
          maxDocuments,
          budgetFor("Use content.sample(type, n) for a large type."),
          `There are more than ${COUNT_FORMAT(maxDocuments)} published "${type}" documents. Test a sample of them with content.sample("${type}", n), or raise maxDocuments (at most ${COUNT_FORMAT(HARD_MAX_DOCUMENTS)}).`,
        ),
      ),
    sample: <F extends Record<string, unknown> = Record<string, string>>(type: string, n: number) =>
      pages<F>(type, sampled(type, n)),
    skipped,
    seed,
  };

  async function* sampled(type: string, n: number): AsyncGenerator<Record<string, unknown>> {
    assertSampleSize(n);
    const t = typed(type);
    // Listing the ids and fetching the chosen documents are counted apart: the fetches are bounded by
    // how many were chosen (a reader cannot add to them), the listing by the cap.
    const listing = budgetFor(
      "The type is too large or the reader is not answering; narrow the type.",
    );
    const ids: string[] = [];
    for await (const row of walk(
      type,
      "{_id}",
      ID_PAGE,
      HARD_MAX_DOCUMENTS,
      listing,
      `There are more than ${COUNT_FORMAT(HARD_MAX_DOCUMENTS)} published "${type}" documents, more than a sample can be drawn from. Narrow the type, or test it with your own query.`,
    ))
      if (typeof row._id === "string") ids.push(row._id);
    if (ids.length === 0) return;
    context.annotate("gaugeline-seed", seed);
    const chosen = sampleSeeded(ids, Math.min(n, maxDocuments), seed);
    const byId = new Map<string, Record<string, unknown>>();
    const fetching = budgetFor(
      "The reader is not answering the way Sanity does.",
      Math.ceil(chosen.length / ID_CHUNK),
    );
    for (let at = 0; at < chosen.length; at += ID_CHUNK) {
      const chunk = chosen.slice(at, at + ID_CHUNK);
      const asked = new Set(chunk);
      const found = await rows(
        `*[_type == ${t} && _id in [${chunk.map((id) => JSON.stringify(id)).join(", ")}]]{...}`,
        fetching,
      );
      for (const doc of found)
        if (typeof doc._id === "string" && asked.has(doc._id) && isPublishedId(doc._id))
          byId.set(doc._id, doc);
    }
    // The draw's order, not Sanity's: the same seed visits the pages in the same order.
    for (const id of chosen) {
      const doc = byId.get(id);
      if (doc !== undefined) yield doc;
    }
  }
}
