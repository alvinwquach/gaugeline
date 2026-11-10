import type { Fetcher } from "../fetcher.js";
import { LIMITS } from "../limits.js";
import { toMinor } from "../products/money.js";
import { SANITY_API_VERSION } from "../sanity.js";
import { isConfigured } from "./env.js";
import { ConnectorRateLimitedError, ConnectorRefusedError, connectorGet } from "./http.js";
import { createRedactor } from "./redact.js";
import type { Connector, Env } from "./types.js";

/** A product as the website's content system holds it. `price` is whole minor units, or null. */
export interface SanityProduct {
  _id: string;
  name: string;
  price: number | null;
  sku?: string;
  stripeId?: string;
  printfulId?: string;
}

export const SANITY_PROJECT_ID = "SANITY_PROJECT_ID";
export const SANITY_DATASET = "SANITY_DATASET";
export const SANITY_TOKEN = "SANITY_TOKEN";
export const PRODUCTS_QUERY = "GAUGELINE_PRODUCTS_QUERY";
export const PRICE_UNIT = "GAUGELINE_SANITY_PRICE_UNIT";

/** Every variable the Sanity connector may read: what the CLI hands to core for it. */
export const SANITY_ENV_VARS = [
  SANITY_PROJECT_ID,
  SANITY_DATASET,
  SANITY_TOKEN,
  PRODUCTS_QUERY,
  PRICE_UNIT,
] as const;

/** Proposed: the dataset a new Sanity project starts with, assumed when SANITY_DATASET is unset. */
export const DEFAULT_DATASET = "production";

/** Proposed: the type name the default query reads. */
export const DEFAULT_PRODUCTS_QUERY =
  '*[_type == "product"]{_id, name, price, sku, stripeId, printfulId}';

/** The fields every row must have. `price` may be absent (null); the last three may be left out. */
const REQUIRED_FIELDS = ["_id", "name"] as const;
const OPTIONAL_FIELDS = ["sku", "stripeId", "printfulId"] as const;

/** The version the roles of the token's user are asked at. Proposed; see the PR's Sources. */
const USERS_API_VERSION = "v2021-06-07";

/** A GET carries the query in its address; most servers refuse addresses much longer than this. */
const MAX_URL = 8000;
/** Type names counted in one request. */
const COUNT_CHUNK = 50;

const PROJECT_ID = /^[a-z0-9]{1,32}$/;
const DATASET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

interface Settings {
  projectId: string;
  dataset: string;
  datasetAssumed: boolean;
  token: string | undefined;
}

function settings(env: Env): Settings {
  const projectId = (env[SANITY_PROJECT_ID] ?? "").trim();
  if (projectId === "") throw new Error(`${SANITY_PROJECT_ID} is not set.`);
  if (!PROJECT_ID.test(projectId))
    throw new Error(
      `${SANITY_PROJECT_ID} is not a Sanity project id (lower-case letters and digits, as shown in sanity.io/manage).`,
    );
  const named = (env[SANITY_DATASET] ?? "").trim();
  if (named !== "" && !DATASET_NAME.test(named))
    throw new Error(`${SANITY_DATASET} is not a valid dataset name.`);
  const token = (env[SANITY_TOKEN] ?? "").trim();
  return {
    projectId,
    dataset: named === "" ? DEFAULT_DATASET : named,
    datasetAssumed: named === "",
    token: token === "" ? undefined : token,
  };
}

/** The project, dataset and token SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN name; throws when there is no valid project id. */
export const sanitySettings: (env: Env) => SanitySettings = settings;
export type SanitySettings = Settings;

/**
 * The query endpoint's address for a GROQ query, asking for what is published and nothing else, so
 * a draft nobody has published is never compared with checkout. The query travels in the address;
 * the token never does.
 */
export function productsUrl(projectId: string, dataset: string, query: string): string {
  return `https://${projectId}.api.sanity.io/${SANITY_API_VERSION}/data/query/${encodeURIComponent(dataset)}?query=${encodeURIComponent(query)}&perspective=published`;
}

const REFUSED_NO_TOKEN =
  "This dataset is private. A private dataset needs a read-only token with the Viewer role: create one under API in sanity.io/manage and set SANITY_TOKEN.";
const REFUSED_WITH_TOKEN =
  "Sanity did not accept SANITY_TOKEN. A private dataset needs a read-only token with the Viewer role; check it belongs to this project and has that role.";

/** What to tell a person whose query Sanity could not run or whose address was too long. */
interface AskHints {
  tooLong: string;
  badQuery: string;
  /** What to say when the answer is larger than one request can carry. Default: the products query's. */
  tooBig?: string;
}

const PRODUCTS_HINTS: AskHints = {
  tooLong:
    "The query is too long to send as a GET. Shorten GAUGELINE_PRODUCTS_QUERY (a projection of the six fields is enough).",
  badQuery:
    "Sanity could not run the query (HTTP 400). If you set GAUGELINE_PRODUCTS_QUERY, check it is valid GROQ.",
};

/** The address of a query is longer than a GET can carry. Thrown before anything is sent. */
export class QueryTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryTooLongError";
  }
}

/** One GROQ query, one GET. Returns the `result` of the answer. */
async function ask(
  env: Env,
  fetcher: Fetcher,
  query: string,
  hints: AskHints = PRODUCTS_HINTS,
): Promise<unknown> {
  const s = settings(env);
  const url = productsUrl(s.projectId, s.dataset, query);
  if (url.length > MAX_URL) throw new QueryTooLongError(hints.tooLong);
  let body: string;
  try {
    const hop = await connectorGet(fetcher, url, {
      ...(s.token ? { authorization: `Bearer ${s.token}` } : {}),
    });
    if (hop.truncated)
      throw new Error(
        hints.tooBig ??
          `The answer is larger than ${LIMITS.bodyBytes / (1024 * 1024)} MB. Narrow GAUGELINE_PRODUCTS_QUERY to the products and the six fields.`,
      );
    body = hop.body ?? "";
  } catch (err) {
    if (err instanceof ConnectorRefusedError)
      throw new ConnectorRefusedError(err.status, s.token ? REFUSED_WITH_TOKEN : REFUSED_NO_TOKEN);
    const status = /HTTP (\d{3})/.exec(err instanceof Error ? err.message : "")?.[1];
    if (status === "400") throw new Error(hints.badQuery);
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Sanity answered with something that is not a query result.");
  }
  if (parsed === null || typeof parsed !== "object" || !("result" in parsed))
    throw new Error("Sanity answered with something that is not a query result.");
  return (parsed as { result: unknown }).result;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A price as whole minor units, or null when there is none or it is not a plain amount. */
function priceOf(value: unknown, unit: "cents" | "major"): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  try {
    if (unit === "major") return toMinor(value);
    // Already minor units: only a whole, non-negative number of them is a price.
    const n = typeof value === "number" ? value : /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function optionalText(v: unknown): string | undefined {
  if (typeof v === "string") return v === "" ? undefined : v;
  return typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;
}

/**
 * The rows of a products query as products. `_id` and `name` must be present in every row (named
 * when not); `price` may be missing or null (no price, or one that is not a plain amount); `sku`,
 * `stripeId` and `printfulId` are optional.
 */
export function parseProducts(result: unknown, unit: "cents" | "major"): SanityProduct[] {
  if (!Array.isArray(result))
    throw new Error(
      'The query did not return a list. It should look like *[_type == "product"]{_id, name, price, sku, stripeId, printfulId}.',
    );
  for (const field of REQUIRED_FIELDS) {
    const missing = result.filter((r) => !isRecord(r) || !(field in r)).length;
    if (missing > 0)
      throw new Error(
        `The query must return "${field}" for every product, and ${missing} of ${result.length} rows do not have it. Add ${field} to the GROQ projection (GAUGELINE_PRODUCTS_QUERY).`,
      );
  }
  return result.map((row): SanityProduct => {
    const r = row as Record<string, unknown>;
    if (typeof r._id !== "string" || r._id === "")
      throw new Error('The query must return "_id" as text for every product.');
    const product: SanityProduct = {
      _id: r._id,
      name: typeof r.name === "string" ? r.name : "",
      price: priceOf(r.price, unit),
    };
    for (const field of OPTIONAL_FIELDS) {
      const v = optionalText(r[field]);
      if (v !== undefined) product[field] = v;
    }
    return product;
  });
}

function priceUnit(env: Env): "cents" | "major" {
  return (env[PRICE_UNIT] ?? "").trim().toLowerCase() === "cents" ? "cents" : "major";
}

/** Every message that leaves this file has the token blanked, whatever the fetcher put in it. */
function guarded<A extends unknown[], R>(
  fn: (env: Env, ...rest: A) => Promise<R>,
): (env: Env, ...rest: A) => Promise<R> {
  return async (env, ...rest) => {
    try {
      return await fn(env, ...rest);
    } catch (err) {
      if (
        err instanceof ConnectorRefusedError ||
        err instanceof ConnectorRateLimitedError ||
        err instanceof QueryTooLongError
      )
        throw err;
      const redact = createRedactor(env, [SANITY_TOKEN]);
      const text = err instanceof Error ? err.message : String(err);
      throw new Error(redact(text));
    }
  };
}

const readProducts = guarded(async (env: Env, fetcher: Fetcher): Promise<SanityProduct[]> => {
  const custom = (env[PRODUCTS_QUERY] ?? "").trim();
  const result = await ask(env, fetcher, custom === "" ? DEFAULT_PRODUCTS_QUERY : custom);
  return parseProducts(result, priceUnit(env));
});

/**
 * How many published documents there are of each `_type`: counts and type names, never a document.
 * Two small questions: the distinct type names, then one count per name (GROQ cannot group in a
 * single query without sending a row per document). Types come back in the order they were named,
 * which is alphabetical.
 */
export const typeCounts = guarded(
  async (env: Env, fetcher: Fetcher): Promise<Map<string, number>> => {
    const named = await ask(env, fetcher, "array::unique(*[]._type)");
    if (!Array.isArray(named))
      throw new Error("Sanity answered with something that is not a list of types.");
    const names = [...new Set(named.filter((n): n is string => typeof n === "string" && n !== ""))]
      .sort()
      .slice(0, 1000);
    const counts = new Map<string, number>();
    for (let at = 0; at < names.length; at += COUNT_CHUNK) {
      const chunk = names.slice(at, at + COUNT_CHUNK);
      const query = `{${chunk.map((n, i) => `"t${i}": count(*[_type == ${JSON.stringify(n)}])`).join(", ")}}`;
      const result = await ask(env, fetcher, query);
      chunk.forEach((n, i) => {
        const c = isRecord(result) ? result[`t${i}`] : undefined;
        if (typeof c !== "number" || !Number.isSafeInteger(c) || c < 0)
          throw new Error("Sanity answered with something that is not a count.");
        counts.set(n, c);
      });
    }
    return counts;
  },
);

/** What a document type is called: a letter, then letters, digits, underscores and hyphens. */
export const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const FIELD_HINTS: AskHints = {
  tooLong: "The query is too long to send as a GET. Use a shorter field path.",
  badQuery:
    "Sanity could not run the query (HTTP 400). Check the document type and field names in the source.",
};

/**
 * The GROQ query for one field of the published document of a type: `*[_type == "siteSettings"][0].features.preOrders`.
 * Names are checked against a plain-identifier pattern first, so a name from a config file can
 * never add anything to the query.
 */
export function fieldQuery(type: string, fields: readonly string[]): string {
  if (!TYPE_NAME.test(type)) throw new Error(`"${type}" is not a Sanity document type name.`);
  if (fields.length === 0 || !fields.every((f) => FIELD_NAME.test(f)))
    throw new Error("The field path must be plain field names joined by dots.");
  return `*[_type == ${JSON.stringify(type)}][0].${fields.join(".")}`;
}

/**
 * One field of the first published document of a type, as Sanity returns it: a value, a list, or
 * null when there is no such document or the field is not set. One GET; drafts are left out.
 */
export const readField = guarded(
  (env: Env, fetcher: Fetcher, type: string, fields: readonly string[]): Promise<unknown> =>
    ask(env, fetcher, fieldQuery(type, fields), FIELD_HINTS),
);

const COUNT_HINTS: AskHints = {
  tooLong: "The query is too long to send as a GET.",
  badQuery:
    "Sanity could not run the query (HTTP 400). Check the document type and field names in the source.",
  tooBig: `The answer is larger than ${LIMITS.bodyBytes / (1024 * 1024)} MB, more than one request can carry. A type with that many documents cannot be read in one GET.`,
};

/** What `gaugeline query` asks Sanity with: one GROQ query in, its `result` out, one GET. */
export interface SanityRead {
  query(groq: string): Promise<unknown>;
  /** The dataset the queries go to, and whether SANITY_DATASET was unset so "production" was assumed. */
  readonly dataset: string;
  readonly datasetAssumed: boolean;
}

/**
 * A reader for GROQ queries over the published documents of the configured dataset, for the query
 * check's counts. GET only, drafts left out, the token (optional for a public dataset) in an
 * Authorization header and never in the address. A query whose address is too long throws
 * QueryTooLongError before any request is made. Every message has the token blanked.
 */
export function createSanityRead(env: Env, fetcher: Fetcher): SanityRead {
  const s = settings(env);
  const run = guarded((e: Env, groq: string): Promise<unknown> =>
    ask(e, fetcher, groq, COUNT_HINTS),
  );
  return {
    query: (groq) => run(env, groq),
    dataset: s.dataset,
    datasetAssumed: s.datasetAssumed,
  };
}

/**
 * Anything worth changing about how Sanity is set up, in plain words: the dataset that was assumed,
 * and a token that can do more than read. The role of the token is read with one GET of the
 * token's own user (role names only; nothing else in the answer is kept). An answer Gaugeline
 * cannot read gives no advice, never a failure.
 */
async function advise(env: Env, fetcher: Fetcher): Promise<string[]> {
  let s: Settings;
  try {
    s = settings(env);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (s.datasetAssumed)
    out.push(
      `SANITY_DATASET is not set, so the dataset "${DEFAULT_DATASET}" was assumed. Set it if your products live in another dataset.`,
    );
  if (s.token) {
    try {
      const hop = await connectorGet(
        fetcher,
        `https://${s.projectId}.api.sanity.io/${USERS_API_VERSION}/users/me`,
        { authorization: `Bearer ${s.token}` },
      );
      const me: unknown = JSON.parse(hop.body ?? "");
      const roles = isRecord(me) && Array.isArray(me.roles) ? me.roles : undefined;
      const names = (roles ?? [])
        .map((r) => (isRecord(r) && typeof r.name === "string" ? r.name : ""))
        .filter((n) => /^[a-z0-9][a-z0-9 _-]{0,39}$/i.test(n));
      if (roles && roles.length > 0 && names.some((n) => n.toLowerCase() !== "viewer"))
        out.push(
          `SANITY_TOKEN has the role ${names.map((n) => `"${n}"`).join(", ")}, which can do more than read. It is used as it is, but Gaugeline only reads: use a token with the Viewer role.`,
        );
    } catch {
      // The role could not be read: no advice either way.
    }
  }
  return out;
}

export interface SanityConnector extends Connector<SanityProduct> {
  /** How many published documents each `_type` has. Counts and type names only. */
  typeCounts(env: Env, fetcher: Fetcher): Promise<Map<string, number>>;
}

/**
 * Sanity as a source of products. Configured by SANITY_PROJECT_ID alone: a public dataset needs no
 * token. Read only: GET of the query endpoint, the token in an Authorization header, drafts left out.
 */
export const sanityConnector: SanityConnector = {
  id: "sanity",
  envVars: [SANITY_PROJECT_ID],
  optionalEnvVars: [SANITY_DATASET, SANITY_TOKEN, PRODUCTS_QUERY, PRICE_UNIT],
  secretEnvVars: [SANITY_TOKEN],
  configured: (env) => isConfigured(env, [SANITY_PROJECT_ID]),
  read: readProducts,
  advise,
  typeCounts,
};
