import * as z from "zod";
import { GqlSyntaxError, parseGraphql } from "../query/graphql-parse.js";

/**
 * The mapping the generic API adapter is driven by: the `api` object of a `generic-api` entry in
 * gaugeline.adapters.json. It is user config (a recipe is a copy of someone else's), so everything in it is
 * checked hard before a single request is built: addresses are https, paths are plain pointers with no
 * prototype keys, sizes have ceilings, a key can only be named by an environment variable that starts with
 * GAUGELINE_, and nothing in it can hold a key itself.
 */

/** The ceilings. A mapping cannot ask for more; the docs page lists them and a test keeps the two in step. */
export const GENERIC_API_LIMITS = {
  /** Items asked for in one request. */
  pageSize: 200,
  /** Pages read from one collection. A collection with more is could-not-check, never cut short silently. */
  maxPages: 200,
  /** The default for `maxPages`. */
  defaultMaxPages: 50,
  collections: 20,
  /** Characters in a pointer or a path. */
  pointer: 200,
  /** Segments in a pointer. */
  depth: 8,
  /** Characters in a GraphQL document. */
  graphql: 4000,
  queryParams: 20,
  bootstrap: 3,
  /** Items in one answer; a page with more is could-not-check. */
  itemsPerPage: 1000,
  /** Characters in an id, a slug or a type from an answer. */
  identifier: 128,
  /** Characters in a cursor from an answer. */
  cursor: 500,
  /** Characters in an address from an answer. */
  address: 512,
} as const;

/** What an id, a slug or a type from an answer may look like: URL-safe, no whitespace. */
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._~:@-]{0,127}$/;

/** Words that mean a write when they are a part of a path or a value. */
const WRITE_VERBS = new Set([
  "delete",
  "remove",
  "update",
  "create",
  "publish",
  "unpublish",
  "destroy",
  "purge",
  "archive",
  "restore",
  "import",
  "send",
  "submit",
]);

/** HTTP verbs that are not GET or HEAD. */
const HTTP_WRITES = new Set(["post", "put", "patch", "delete"]);

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const hasWriteVerb = (text: string): boolean => words(text).some((w) => WRITE_VERBS.has(w));

/** The marker a GraphQL document may hold once: the fields to fingerprint go there (and nothing is asked for with none). */
export const GRAPHQL_FIELDS_MARKER = "__FIELDS__";

/**
 * The only environment variables a mapping may name: GAUGELINE_API_<NAME>. Gaugeline's own variables (GAUGELINE_SLACK_WEBHOOK,
 * GAUGELINE_GITHUB_TOKEN, GAUGELINE_VERCEL_TOKEN, GAUGELINE_BASIC_AUTH, GAUGELINE_POSTGRES_URL...) never start with
 * GAUGELINE_API_, and a test reads every GAUGELINE_ name in the source to keep it so. A copied mapping therefore cannot send
 * one of them, or any other secret, to someone's server.
 */
export const GENERIC_ENV = /^GAUGELINE_API_[A-Z0-9][A-Z0-9_]{0,45}$/;

/** Names that cannot be pointer segments or field names: they would reach into an object's prototype. */
export const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,63}$/;

/** "/data/items/0/id" as its segments. Undefined when it is not a pointer this adapter reads. */
export function parsePointer(text: string): string[] | undefined {
  if (text === "") return [];
  if (text.length > GENERIC_API_LIMITS.pointer || !text.startsWith("/")) return undefined;
  const parts = text.slice(1).split("/");
  if (parts.length > GENERIC_API_LIMITS.depth) return undefined;
  for (const p of parts) if (!SEGMENT.test(p) || PROTOTYPE_KEYS.has(p)) return undefined;
  return parts;
}

const POINTER_MESSAGE =
  'a path like "/data/items" or "/attributes/changed": segments of letters, digits, "_", "-", ".", ":" or "@", at most 8, not __proto__, constructor or prototype';

const pointer = z
  .string()
  .max(GENERIC_API_LIMITS.pointer)
  .refine((v) => v !== "" && parsePointer(v) !== undefined, { message: POINTER_MESSAGE });

/** A pointer that may be empty: the root of the answer (a list that is the whole answer). */
const pointerOrRoot = z
  .string()
  .max(GENERIC_API_LIMITS.pointer)
  .refine((v) => parsePointer(v) !== undefined, { message: POINTER_MESSAGE });

/** One pointer, or up to three tried in order (Directus: `date_updated`, and `date_created` until the first edit). */
const pointers = z.union([pointer, z.array(pointer).min(1).max(3)]);

/** A path on the endpoint: "/api/posts" or "/items/articles". No "..", no "//", no query. */
const PATH = /^\/[A-Za-z0-9_.~:@,-]+(?:\/[A-Za-z0-9_.~:@,-]+){0,7}\/?$/;
const pathOnEndpoint = z
  .string()
  .max(200)
  .refine((v) => PATH.test(v) && !v.split("/").some((s) => s === ".." || s === "."), {
    message: 'a path on the endpoint such as "/api/posts" (no "..", no query string)',
  })
  .refine((v) => !hasWriteVerb(v), {
    message:
      "a path with no write verb in it (delete, update, create, publish, unpublish, send...): Gaugeline only reads, and will not ask for an address that sounds like a change",
  });

/** A query parameter name, brackets allowed (`page[limit]`). */
const PARAM = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,63}$/;

/** A parameter name that looks like it carries a key: keys go in `auth`, in a header, never in the address. */
const KEY_LIKE =
  /token|secret|passw|signature|jwt|bearer|private[_-]?key|api[_-]?key|access[_-]?key|(^|[^a-z])pat($|[^a-z])|^key$|^auth|^sig$/i;

/** A name that asks the server to treat the request as another method. */
const METHOD_LIKE = /method|override|verb/i;

/** Every name that goes into an address: a parameter, a pagination parameter, a select parameter. */
export const safeName = (v: string): boolean => !KEY_LIKE.test(v) && !METHOD_LIKE.test(v);

export const SAFE_NAME_MESSAGE =
  'a parameter name that is not a method override and not a key: a name that looks like a key goes in "auth" (a header), never in the address';

const param = z
  .string()
  .regex(PARAM, 'a parameter name such as "limit" or "page[limit]"')
  .refine(safeName, { message: SAFE_NAME_MESSAGE });

/** A GraphQL variable name. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const staticQuery = z
  .record(
    z.string().regex(PARAM, "a parameter name"),
    z
      .string()
      .max(200)
      .regex(/^[\x20-\x7E]*$/, "plain printable characters")
      .refine((v) => !HTTP_WRITES.has(v.toLowerCase()) && !WRITE_VERBS.has(v.toLowerCase()), {
        message:
          "a value that is not an HTTP verb or a write verb (a method override is never sent)",
      }),
  )
  .refine((q) => Object.keys(q).length <= GENERIC_API_LIMITS.queryParams, {
    message: `at most ${GENERIC_API_LIMITS.queryParams} parameters`,
  })
  .refine((q) => !Object.keys(q).some((name) => KEY_LIKE.test(name)), {
    message:
      'a parameter that looks like a key. Put the key in "auth" (an environment variable sent in a header); a key is never written into the mapping or the address',
  })
  .refine((q) => !Object.keys(q).some((name) => METHOD_LIKE.test(name)), {
    message:
      "a parameter that is not a method override (a name with method, override or verb in it)",
  });

const FORBIDDEN_HEADERS = new Set([
  "host",
  "cookie",
  "set-cookie",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "origin",
  "referer",
  "user-agent",
  "accept",
  "accept-encoding",
  "range",
  "proxy-authorization",
  "x-http-method-override",
  "x-method-override",
  "x-http-method",
]);

const auth = z.strictObject({
  /** The header the platform reads its key from: "Authorization", "X-API-Key", "X-Joomla-Token". */
  header: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]{0,39}$/, 'a header name such as "Authorization" or "X-API-Key"')
    .refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()) && !/^x-forwarded-/i.test(h), {
      message: "a header Gaugeline sets itself or that carries no key",
    }),
  /** The environment variable that holds the key. It must start with GAUGELINE_. */
  env: z
    .string()
    .regex(
      GENERIC_ENV,
      "an environment variable named GAUGELINE_API_<NAME> (such as GAUGELINE_API_DIRECTUS_TOKEN). Gaugeline's own variables (GAUGELINE_SLACK_WEBHOOK, GAUGELINE_GITHUB_TOKEN...) are never accepted, so a copied mapping cannot send your other secrets to someone's server",
    ),
  /** Text put before the key in the header's value: "Bearer ", "users API-Key ". */
  prefix: z
    .string()
    .max(32)
    .regex(/^[A-Za-z0-9 _.-]*$/, "letters, digits, spaces and . _ - only")
    .optional(),
});

const fieldPaths = z.strictObject({
  /** Where the item's id is. Required: an item with no id is could-not-check. */
  id: pointers,
  /** Where the item's content type is, when one endpoint holds several (Storyblok, Prismic, Kontent.ai). Otherwise the type is the collection's name. */
  type: pointers.optional(),
  slug: pointers.optional(),
  /** The item's address or path, when the platform gives it. A path without a leading "/" gets one. */
  url: pointers.optional(),
  /** When the item last changed. Without it, "changed since" cannot be answered. */
  updatedAt: pointers.optional(),
  publishedAt: pointers.optional(),
});

const offsetPagination = z.strictObject({
  style: z.literal("offset"),
  /** The parameter (or GraphQL variable) that says how many items: `limit`, `page[limit]`, `first`. */
  limit: param,
  /** The parameter that says how many items to skip: `offset`, `page[offset]`, `skip`. */
  offset: param,
  pageSize: z.number().int().min(1).max(GENERIC_API_LIMITS.pageSize),
  /** A yes or no in the answer, when there is one: more pages follow. */
  more: pointer.optional(),
});

const pagePagination = z.strictObject({
  style: z.literal("page"),
  page: param,
  size: param,
  pageSize: z.number().int().min(1).max(GENERIC_API_LIMITS.pageSize),
  /** The number of the first page: 1 for almost everything, 0 for a few. */
  firstPage: z.union([z.literal(0), z.literal(1)]).optional(),
  more: pointer.optional(),
  /** The number of pages in the answer, when there is one. */
  pages: pointer.optional(),
});

const cursorPagination = z.strictObject({
  style: z.literal("cursor"),
  /** The parameter (or GraphQL variable) that carries the cursor of the page to read. */
  cursor: param,
  size: param.optional(),
  pageSize: z.number().int().min(1).max(GENERIC_API_LIMITS.pageSize),
  /** Where the answer gives the cursor of the next page. Null, empty or absent is the end. */
  next: pointer,
  more: pointer.optional(),
});

const noPagination = z.strictObject({ style: z.literal("none") });

const pagination = z.discriminatedUnion("style", [
  offsetPagination,
  pagePagination,
  cursorPagination,
  noPagination,
]);

/** One thing to list: a REST path or a GraphQL document, where its items are in the answer and how it pages. */
const collection = z.strictObject({
  /** REST: the path on the endpoint. */
  path: pathOnEndpoint.optional(),
  /** GraphQL: a query document, sent as a GET. A mutation or subscription is refused. */
  graphql: z.string().min(1).max(GENERIC_API_LIMITS.graphql).optional(),
  /** Fixed parameters on every request (REST): `{ "depth": "0" }`. Never a key. */
  query: staticQuery.optional(),
  /** Where the list of items is in the answer. "" is an answer that is the list. */
  items: pointerOrRoot,
  /** Where the answer says how many items there are, when it does. A cheap count for `types()`. */
  total: pointer.optional(),
  pagination,
  fields: fieldPaths,
  /**
   * Asked back: an item counts as published only when the value at `path` is `equals` (compared as text). A platform
   * that shows drafts to a key that can see them does not make them published. With it, a count in the answer is not
   * trusted and every page is read.
   */
  published: z
    .strictObject({
      path: pointer,
      equals: z.union([z.string().max(100), z.number(), z.boolean()]),
    })
    .optional(),
  /** Where an item's own fields are, so a fingerprint field `title` is read at `<fieldRoot>/title`: "/attributes", "/content". */
  fieldRoot: pointerOrRoot.optional(),
  /** REST: ask the platform for only the fields that are needed (`fields=id,slug,title`) when it can. */
  select: z
    .strictObject({
      /** The parameter. `{type}` is replaced by the collection's name (Drupal: `fields[{type}]`). */
      param: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_.[\]{}-]{0,63}$/, "a parameter name")
        .refine(safeName, { message: SAFE_NAME_MESSAGE }),
      /** Fields always asked for, whatever the settings fingerprint: the ones the paths above read. */
      always: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/)).max(12),
      join: z.string().max(2).optional(),
    })
    .optional(),
});

const bootstrapStep = z.strictObject({
  /** The parameter to add to every request. */
  param,
  /** Where to ask for it, on the endpoint ("" is the endpoint itself). */
  path: z.union([z.literal(""), pathOnEndpoint]),
  /** Where the value is in that answer. */
  value: pointer,
  /** A check on the answer before the value is trusted: this path must hold this value. */
  expect: z
    .strictObject({
      path: pointer,
      equals: z.union([z.string().max(100), z.number(), z.boolean()]),
    })
    .optional(),
});

/** Why a recipe cannot run today. A blocked mapping asks for nothing and says this. */
export const BLOCKED_REASONS = {
  "key-in-address":
    "this platform reads its key from the address (a query-string token), and Gaugeline sends a key only in a header, never in an address. See open question 53 in PROGRESS.md.",
} as const;

export type Blocked = keyof typeof BLOCKED_REASONS;

/** The `api` object. */
export const genericApiSchema = z
  .strictObject({
    /** The platform's address: https, no key, no query. A path prefix is fine ("https://cms.example/api"). */
    endpoint: z.string().max(200),
    auth: auth.optional(),
    collections: z
      .record(
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "a content type name"),
        collection,
      )
      .refine(
        (c) =>
          Object.keys(c).length >= 1 && Object.keys(c).length <= GENERIC_API_LIMITS.collections,
        {
          message: `between 1 and ${GENERIC_API_LIMITS.collections} collections`,
        },
      ),
    /** Pages read from one collection before giving up. Default 50. */
    maxPages: z.number().int().min(1).max(GENERIC_API_LIMITS.maxPages).optional(),
    /** Values the platform hands out once and wants on every request (Prismic's `ref`). Not keys. */
    bootstrap: z.array(bootstrapStep).max(GENERIC_API_LIMITS.bootstrap).optional(),
    /** To answer "can the key reach drafts?": list this collection with these parameters and see whether anything comes back. */
    drafts: z.strictObject({ collection: z.string(), query: staticQuery }).optional(),
    blocked: z.literal("key-in-address").optional(),
  })
  .superRefine((api, ctx) => {
    const bad = (path: (string | number)[], message: string): void =>
      void ctx.addIssue({ code: "custom", path, message });

    let url: URL | undefined;
    try {
      url = new URL(api.endpoint);
    } catch {
      url = undefined;
    }
    if (url === undefined) bad(["endpoint"], "an address such as https://cms.example/api");
    else if (
      /%2e|%2f|%5c|\\/i.test(api.endpoint) ||
      new URL(api.endpoint).pathname.split("/").some((s) => s === "." || s === "..") ||
      api.endpoint
        .split("/")
        .slice(3)
        .some((s) => s === "." || s === "..")
    )
      bad(
        ["endpoint"],
        'an address with no dot segment ("..", or its encoded forms %2e) and no encoded slash or backslash in its path',
      );
    else {
      const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !loopback)
        bad(
          ["endpoint"],
          "an https address (http is accepted only for 127.0.0.1, for tests with --allow-private)",
        );
      else if (url.username !== "" || url.password !== "")
        bad(["endpoint"], "an address with no user name or password in it: keys go in `auth`");
      else if (url.search !== "" || url.hash !== "")
        bad(
          ["endpoint"],
          "an address with no query string or fragment: put parameters on the collection",
        );
      else if (url.protocol === "http:" && api.auth !== undefined)
        bad(
          ["auth"],
          "refused: the endpoint is plain http, and a request that carries a key is only sent over https",
        );
    }

    for (const [name, c] of Object.entries(api.collections)) {
      const at = (...rest: (string | number)[]): (string | number)[] => [
        "collections",
        name,
        ...rest,
      ];
      if ((c.path === undefined) === (c.graphql === undefined))
        bad(at(), 'a collection has "path" (REST) or "graphql" (a GraphQL query), and not both');
      if (c.graphql !== undefined) {
        if (c.query !== undefined) bad(at("query"), "a GraphQL collection has no fixed parameters");
        if (c.select !== undefined)
          bad(
            at("select"),
            `a GraphQL collection chooses its fields with ${GRAPHQL_FIELDS_MARKER} in the document`,
          );
        const p = c.pagination;
        const names =
          p.style === "offset"
            ? [p.limit, p.offset]
            : p.style === "page"
              ? [p.page, p.size]
              : p.style === "cursor"
                ? [p.cursor, ...(p.size !== undefined ? [p.size] : [])]
                : [];
        for (const v of names) {
          if (!VARIABLE.test(v)) bad(at("pagination"), `"${v}" is not a GraphQL variable name`);
          else if (!new RegExp(`\\$${v}\\b`).test(c.graphql))
            bad(at("pagination"), `the document does not use the variable $${v}`);
        }
        try {
          const defs = parseGraphql(c.graphql).filter((d) => d.kind !== "fragment");
          const ops = defs.filter((d) => d.kind === "operation");
          if (defs.length !== 1 || ops.length !== 1) bad(at("graphql"), "exactly one query");
          else if (ops[0]?.kind === "operation" && ops[0].operation !== "query")
            bad(at("graphql"), `a query: a ${ops[0].operation} is never sent`);
        } catch (err) {
          bad(
            at("graphql"),
            err instanceof GqlSyntaxError
              ? `GraphQL that parses (line ${err.line}: ${err.message})`
              : "GraphQL that parses",
          );
        }
        if (c.graphql.split(GRAPHQL_FIELDS_MARKER).length > 2)
          bad(at("graphql"), `${GRAPHQL_FIELDS_MARKER} at most once`);
      }
    }

    if (api.drafts !== undefined) {
      const target = api.collections[api.drafts.collection];
      if (target === undefined)
        bad(["drafts", "collection"], "a collection named in `collections`");
      else if (target.graphql !== undefined)
        bad(
          ["drafts", "collection"],
          "a REST collection: the drafts parameters are sent as an address query, which a GraphQL collection does not take",
        );
    }
    if (
      api.bootstrap !== undefined &&
      api.bootstrap.length > 0 &&
      Object.values(api.collections).some((c) => c.graphql !== undefined)
    )
      bad(
        ["bootstrap"],
        "left out when a collection is GraphQL: a bootstrap value is added to REST addresses only",
      );
    for (const [i, step] of (api.bootstrap ?? []).entries())
      if (step.path !== "" && hasWriteVerb(step.path))
        bad(["bootstrap", i, "path"], "a path with no write verb in it");
  });

export type GenericApiMapping = z.infer<typeof genericApiSchema>;
export type GenericApiCollection = z.infer<typeof collection>;
