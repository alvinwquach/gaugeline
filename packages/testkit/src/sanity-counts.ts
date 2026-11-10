import { Readable } from "node:stream";
import type { Transport, TransportRequest } from "@gaugeline/core";

/**
 * A stand-in for Sanity's query endpoint, for the tests of `gaugeline query`. It answers the count
 * queries the check sends (`{"total": count(...), "p0": count(*[... && defined(path)])}`) from a
 * small invented table of how many documents of each type exist and how many have each field, in
 * the shape of Sanity's query API (`{ ms, query, result }`). Nothing here was recorded from a
 * dataset, and no document exists: only the integers. Any other query is answered 400.
 */
export interface FakeSanityType {
  total: number;
  /** Documents that have a field, by the path the check counts. A path not listed is on every document. */
  defined?: Record<string, number>;
}

export interface FakeSanity {
  /** Types that exist. A type not listed has no documents (total 0). */
  types: Record<string, FakeSanityType>;
  /** A private dataset: 401 unless the request carries this token (or any token when true). */
  token?: string | true;
}

export interface SeenSanityRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The type the query counts, when it is a count query. */
  type: string | undefined;
}

const json = (status: number, body: unknown) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

/** `@["a-b"]["c"]` and `a.b` both come back as `a-b.c` and `a.b`: the path the check counted. */
function pathOf(expression: string): string {
  return expression
    .replace(/^@/, "")
    .replace(
      /\["((?:[^"\\]|\\.)*)"\]/g,
      (_m, name: string) => `.${JSON.parse(`"${name}"`) as string}`,
    )
    .replace(/^\./, "");
}

const COUNT =
  /"(total|p\d+)":count\(\*\[_type == ("(?:[^"\\]|\\.)*")(?: && defined\((.*?)\))?\]\)(?=,"p|\}$)/g;

export function sanityCountsTransport(spec: FakeSanity, seen: SeenSanityRequest[] = []): Transport {
  return (url: URL, req: TransportRequest) => {
    const query = url.searchParams.get("query") ?? "";
    const counts = [...query.matchAll(COUNT)];
    const first = counts[0]?.[2];
    seen.push({
      method: req.method,
      url: url.href,
      headers: req.headers,
      type: first === undefined ? undefined : (JSON.parse(first) as string),
    });
    if (spec.token !== undefined) {
      const sent = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (sent === undefined || (spec.token !== true && sent !== spec.token))
        return json(401, { error: { description: "Unauthorized", type: "corsOriginError" } });
    }
    if (counts.length === 0 || !query.startsWith("{") || !query.endsWith("}"))
      return json(400, { error: { description: "unsupported query", type: "queryParseError" } });
    const result: Record<string, number> = {};
    for (const m of counts) {
      const type = JSON.parse(m[2] ?? '""') as string;
      const t = spec.types[type] ?? { total: 0 };
      const key = m[1] ?? "";
      result[key] = key === "total" ? t.total : (t.defined?.[pathOf(m[3] ?? "")] ?? t.total);
    }
    return json(200, { ms: 3, query, result });
  };
}

/**
 * Copperhill Bakery's invented dataset, the one docs/query-check.md and the tests of
 * `gaugeline query` use with the repo-groq fixture: only integers.
 */
export const COPPERHILL_COUNTS: FakeSanity = {
  types: {
    order: { total: 31 },
    // The date field was renamed startsAt: no published popup has `date` any more.
    popup: { total: 9, defined: { date: 0 } },
    menuItem: { total: 40, defined: { allergens: 12 } },
    page: { total: 1 },
    // legacyPage was removed from the Studio: no documents.
    siteSettings: { total: 1 },
    post: { total: 14 },
    recipe: { total: 6, defined: { publishedAt: 4 } },
  },
};
