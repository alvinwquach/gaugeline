import { createFetcher, createSanityRead, isBlockedAddress } from "@gaugeline/core";
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
  /** Allow an absolute address that is loopback or private. Default: false. */
  allowPrivate?: boolean;
  /** Documents asked for per request. Default: 100. */
  pageSize?: number;
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
}

/** What a document type is called: a letter, then letters, digits, underscores and hyphens. */
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_PAGE = 100;
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

const LOCAL_NAME = /(^|\.)local[h]ost$/i;

/**
 * The address a test should open for a document: its url field, or its route filled in with its
 * slug. A path starts with one "/"; an absolute address is http(s) and, unless allowPrivate is
 * set, not an IP literal or name for the local machine or network. The names a browser would
 * resolve later are not looked up here: only the fetcher resolves names, and it does not open the page.
 */
export function resolveUrl(
  doc: Record<string, unknown>,
  type: string,
  options: Pick<ContentOptions, "urlField" | "routes" | "allowPrivate">,
): { url: string } | { reason: string } {
  const field = doc[options.urlField ?? "url"];
  let url: string | undefined = typeof field === "string" ? field.trim() : undefined;
  if (url === undefined || url === "") {
    const route = options.routes?.[type];
    const slug = slugOf(doc);
    if (route === undefined || slug === undefined)
      return {
        reason: `no url field and ${route === undefined ? `no route for "${type}"` : "no slug"}, so there is no address to open`,
      };
    url = route.replace("{slug}", encodeURIComponent(slug));
  }
  if (url.startsWith("/") && !url.startsWith("//")) return { url };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: "its address is not a path starting with / or an http(s) address" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { reason: `its address uses ${parsed.protocol}, not http or https` };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (options.allowPrivate !== true && (isBlockedAddress(host) || LOCAL_NAME.test(host)))
    return { reason: "its address is a private or local address (set allowPrivate to open it)" };
  return { url: parsed.href };
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

/** The content fixture's engine: reads published documents of a type and turns them into pages to test. */
export function createContent(options: ContentOptions, context: ContentContext): Content {
  const seed = String(options.seed ?? defaultSeed(context.env, context.now ?? (() => new Date())));
  const pageSize = options.pageSize ?? DEFAULT_PAGE;
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

  const rows = async (groq: string): Promise<Record<string, unknown>[]> => {
    const result = await read(groq);
    if (!Array.isArray(result))
      throw new Error("Sanity answered with something that is not a list of documents.");
    return result.filter(isRecord);
  };

  /** All the documents of a type, `pageSize` at a time, walking forward by _id so a publish mid-run skips nothing. */
  async function* walk(
    type: string,
    projection: string,
    size: number,
  ): AsyncGenerator<Record<string, unknown>> {
    const t = typed(type);
    let after = "";
    for (;;) {
      const filter = after === "" ? "" : ` && _id > ${JSON.stringify(after)}`;
      const page = await rows(`*[_type == ${t}${filter}] | order(_id) [0...${size}]${projection}`);
      for (const doc of page) yield doc;
      const last = page.at(-1)?._id;
      if (page.length < size || typeof last !== "string") return;
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
      const id = typeof doc._id === "string" ? doc._id : "(no id)";
      const resolved = resolveUrl(doc, type, options);
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
      pages<F>(type, walk(type, "{...}", pageSize)),
    sample: <F extends Record<string, unknown> = Record<string, string>>(type: string, n: number) =>
      pages<F>(type, sampled(type, n)),
    skipped,
    seed,
  };

  async function* sampled(type: string, n: number): AsyncGenerator<Record<string, unknown>> {
    assertSampleSize(n);
    const t = typed(type);
    const ids: string[] = [];
    for await (const row of walk(type, "{_id}", ID_PAGE))
      if (typeof row._id === "string") ids.push(row._id);
    if (ids.length === 0) return;
    context.annotate("gaugeline-seed", seed);
    const chosen = sampleSeeded(ids, n, seed);
    const byId = new Map<string, Record<string, unknown>>();
    for (let at = 0; at < chosen.length; at += ID_CHUNK) {
      const chunk = chosen.slice(at, at + ID_CHUNK);
      const found = await rows(
        `*[_type == ${t} && _id in [${chunk.map((id) => JSON.stringify(id)).join(", ")}]]{...}`,
      );
      for (const doc of found) if (typeof doc._id === "string") byId.set(doc._id, doc);
    }
    // The draw's order, not Sanity's: the same seed visits the pages in the same order.
    for (const id of chosen) {
      const doc = byId.get(id);
      if (doc !== undefined) yield doc;
    }
  }
}
