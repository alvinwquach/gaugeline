import { NetworkError } from "../errors.js";
import type { Fetcher, Hop } from "../fetcher.js";
import type { Budget } from "../limits.js";
import type { AccessSettings } from "./types.js";

/**
 * What one read returned:
 * - readable: rows came back (count > 0)
 * - empty: allowed, but 0 rows: an open, empty table looks exactly like one whose rules hide every row
 * - refused: 401 or 403 (permission denied)
 * - missing: 404, not exposed
 * - unknown: no answer, a server error, or no count to read
 */
export type ReadState = "readable" | "empty" | "refused" | "missing" | "unknown";

export interface ReadResult {
  state: ReadState;
  count?: number;
}

/** "0-41/42" or "*\/0" -> 42 or 0; undefined when the total is unknown ("*"). */
function total(contentRange: string | undefined): number | undefined {
  const m = /\/(\d+)\s*$/.exec(contentRange ?? "");
  return m ? Number(m[1]) : undefined;
}

/** One HEAD answer, classified. Only the status and the Content-Range total are read. */
export function classify(hop: Hop | undefined): ReadResult {
  if (!hop) return { state: "unknown" };
  if (hop.status === 401 || hop.status === 403) return { state: "refused" };
  if (hop.status === 404) return { state: "missing" };
  if (hop.status !== 200 && hop.status !== 206) return { state: "unknown" };
  const count = total(hop.headers["content-range"]);
  if (count === undefined) return { state: "unknown" };
  return count > 0 ? { state: "readable", count } : { state: "empty", count };
}

export interface ProbedTable {
  name: string;
  kind: "table" | "view";
  /** Column names from the project's API description. Never a row value. */
  columns: string[];
  anon: ReadResult;
}

export interface ScopedRead extends ReadResult {
  role: string;
  table: string;
  owner: string;
}

export interface AccessRead {
  url: string;
  tables: ProbedTable[];
  /** Rows a signed-in test user can read that belong to someone else, per table with an owner. */
  scoped: ScopedRead[];
  /** Tables the config marks as meant to be public. */
  publicTables: string[];
  /** The roles the tables were read as, in order. */
  roles: string[];
  /** Whether the project published its API description (the list of exposed tables). */
  schema: "read" | "refused" | "unknown";
}

interface OpenApi {
  definitions?: Record<string, { properties?: Record<string, unknown> }>;
  paths?: Record<string, Record<string, unknown>>;
}

const WRITE_VERBS = ["post", "patch", "put", "delete"];

/** GET or HEAD with headers, through the fetcher; [] when the project could not be reached. */
async function ask(
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string>,
  method: "GET" | "HEAD" = "GET",
): Promise<Hop[]> {
  try {
    return await fetcher.get(url, { headers, method });
  } catch (err) {
    if (err instanceof NetworkError) return [];
    throw err;
  }
}

function headersFor(apiKey: string, token: string): Record<string, string> {
  return { apikey: apiKey, authorization: `Bearer ${token}` };
}

/** The exposed tables and views, with their columns, from PostgREST's OpenAPI description. */
async function readSchema(
  fetcher: Fetcher,
  s: AccessSettings,
): Promise<{ state: AccessRead["schema"]; tables: Omit<ProbedTable, "anon">[] }> {
  const last = (
    await ask(fetcher, `${s.url}/rest/v1/`, {
      ...headersFor(s.anonKey, s.anonKey),
      accept: "application/openapi+json",
    })
  ).at(-1);
  if (!last) return { state: "unknown", tables: [] };
  if (last.status === 401 || last.status === 403) return { state: "refused", tables: [] };
  if (last.status < 200 || last.status >= 300) return { state: "unknown", tables: [] };
  let api: OpenApi;
  try {
    api = JSON.parse(last.body ?? "") as OpenApi;
  } catch {
    return { state: "unknown", tables: [] };
  }
  const tables = Object.entries(api.definitions ?? {}).map(([name, def]) => {
    const ops = Object.keys(api.paths?.[`/${name}`] ?? {});
    return {
      name,
      // A view with no write operations in the description; an updatable one reads as a table.
      kind:
        ops.length > 0 && !ops.some((o) => WRITE_VERBS.includes(o))
          ? ("view" as const)
          : ("table" as const),
      columns: Object.keys(def.properties ?? {}),
    };
  });
  return { state: "read", tables };
}

async function count(
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string>,
): Promise<ReadResult> {
  // HEAD with an exact count: the answer has a status and a total, and no rows at all.
  const hops = await ask(fetcher, url, { ...headers, prefer: "count=exact" }, "HEAD");
  return classify(hops.at(-1));
}

export interface AccessOptions {
  fetcher: Fetcher;
  budget: Budget;
  settings: AccessSettings;
}

/**
 * Ask the project, as an anonymous visitor and as each configured test user, how many rows of each
 * exposed table they can read. HEAD and one GET of the API description only: nothing is written,
 * and no row is ever downloaded. At most LIMITS.accessTables tables.
 */
export async function probeAccess({
  fetcher,
  budget,
  settings: s,
}: AccessOptions): Promise<AccessRead> {
  const schema = await readSchema(fetcher, s);
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  // Configured tables are probed even when the project hides its description.
  for (const t of s.tables)
    if (!byName.has(t.name)) byName.set(t.name, { name: t.name, kind: "table", columns: [] });
  const names = [...byName.keys()].sort();
  const taken = budget.take("accessTables", names);
  const rest = (name: string) => `${s.url}/rest/v1/${encodeURIComponent(name)}?select=*`;
  const anon = headersFor(s.anonKey, s.anonKey);
  const tables = await Promise.all(
    taken.map(async (name) => ({
      ...(byName.get(name) as Omit<ProbedTable, "anon">),
      anon: await count(fetcher, rest(name), anon),
    })),
  );
  const owned = s.tables.filter((t) => t.owner !== undefined && taken.includes(t.name));
  const scoped = await Promise.all(
    s.users.flatMap((u) =>
      owned.map(async (t) => ({
        role: u.role,
        table: t.name,
        owner: t.owner ?? "",
        ...(await count(
          fetcher,
          `${rest(t.name)}&${encodeURIComponent(t.owner ?? "")}=neq.${encodeURIComponent(u.userId)}`,
          headersFor(s.anonKey, u.token),
        )),
      })),
    ),
  );
  return {
    url: s.url,
    tables,
    scoped,
    publicTables: s.tables.filter((t) => t.public).map((t) => t.name),
    roles: ["anonymous", ...s.users.map((u) => u.role)],
    schema: schema.state,
  };
}

export function lazyAccess(opts: AccessOptions): () => Promise<AccessRead> {
  let pending: Promise<AccessRead> | undefined;
  return () => (pending ??= probeAccess(opts));
}
