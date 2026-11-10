import { Readable } from "node:stream";
import { evaluate, parse } from "groq-js";
import type { Transport, TransportRequest } from "@gaugeline/core";

/**
 * A stand-in for Sanity's query endpoint, for the tests of `gaugeline query`. It answers the count
 * queries the check sends (`{"total": count(...), "p0": count(*[... && defined(path)])}`) from a
 * small invented table of how many documents of each type exist and how many have each field, in
 * the shape of Sanity's query API (`{ ms, query, result }`). Nothing here was recorded from a
 * dataset, and no document exists: only the integers. It also answers the duplicates query of
 * `--dupes` (`*[_type == "T"]{_id,"slug":slug.current,title}`) from a list of invented documents,
 * the way Sanity does: published documents only (a `drafts.` id is left out when the request asks
 * for the published perspective), a missing slug or title as null. Any other query is answered 400.
 */
export interface FakeSanityType {
  total: number;
  /** Documents that have a field, by the path the check counts. A path not listed is on every document. */
  defined?: Record<string, number>;
}

/** An invented document, for the duplicates query: an id, and a slug and a title when it has them. */
export interface FakeDocument {
  _id: string;
  slug?: string | null;
  /** Usually text; anything else (a localised object) comes back as it is. */
  title?: unknown;
}

export interface FakeSanity {
  /** Types that exist. A type not listed has no documents (total 0). */
  types: Record<string, FakeSanityType>;
  /** The documents of each type, for the duplicates query. A type not listed has none. */
  documents?: Record<string, FakeDocument[]>;
  /**
   * Whole invented documents of each type. Any query that is not one of the fixed shapes below is
   * run over them with groq-js, the way Sanity would answer it (published documents only when the
   * request asks for that perspective), so a query the tests send is checked for being GROQ and for
   * what it counts. Nothing here was recorded from a dataset.
   */
  content?: Record<string, Record<string, unknown>[]>;
  /** A private dataset: 401 unless the request carries this token (or any token when true). */
  token?: string | true;
}

export interface SeenSanityRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The type the query counts or lists, when it is one of the two queries the fake knows. */
  type: string | undefined;
  /** The GROQ the request carried, as sent. */
  query: string;
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

const DUPES = /^\*\[_type == ("(?:[^"\\]|\\.)*")\]\{_id,"slug":slug\.current,title\}$/;

/** Answer a GROQ query over the invented documents, as Sanity's query API does: `{ ms, query, result }`. */
function evaluated(
  content: Record<string, Record<string, unknown>[]>,
  url: URL,
): ReturnType<typeof json> {
  const query = url.searchParams.get("query") ?? "";
  const published = url.searchParams.get("perspective") === "published";
  const dataset = Object.values(content)
    .flat()
    .filter((d) => !(published && String(d._id).startsWith("drafts.")));
  return Promise.resolve()
    .then(async () => (await evaluate(parse(query), { dataset })).get())
    .then(
      (result) => json(200, { ms: 3, query, result }),
      () => json(400, { error: { description: "unsupported query", type: "queryParseError" } }),
    );
}

export function sanityCountsTransport(spec: FakeSanity, seen: SeenSanityRequest[] = []): Transport {
  return (url: URL, req: TransportRequest) => {
    const query = url.searchParams.get("query") ?? "";
    const counts = [...query.matchAll(COUNT)];
    const listed = DUPES.exec(query)?.[1];
    const first = listed ?? counts[0]?.[2];
    seen.push({
      method: req.method,
      url: url.href,
      headers: req.headers,
      type: first === undefined ? undefined : (JSON.parse(first) as string),
      query,
    });
    if (spec.token !== undefined) {
      const sent = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (sent === undefined || (spec.token !== true && sent !== spec.token))
        return json(401, { error: { description: "Unauthorized", type: "corsOriginError" } });
    }
    if (listed !== undefined) {
      const published = url.searchParams.get("perspective") === "published";
      const docs = spec.documents?.[JSON.parse(listed) as string] ?? [];
      const rows = docs
        .filter((d) => !(published && d._id.startsWith("drafts.")))
        .map((d) => ({ _id: d._id, slug: d.slug ?? null, title: d.title ?? null }));
      return json(200, { ms: 3, query, result: rows });
    }
    if (counts.length === 0 && spec.content !== undefined) return evaluated(spec.content, url);
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
  documents: {
    menuItem: [
      { _id: "menu-sourdough", slug: "sourdough-loaf", title: "Sourdough loaf" },
      // Copied from the one above and given a new name, but not a new address.
      { _id: "menu-sourdough-old", slug: "sourdough-loaf", title: "Sourdough loaf (2024)" },
      { _id: "menu-rye", slug: "seeded-rye", title: "Seeded rye" },
      { _id: "menu-rye-copy", slug: "rye-seeded", title: " seeded Rye " },
      { _id: "menu-baguette", slug: "baguette", title: "Baguette" },
      // A draft of a published document is the same document, not a second one.
      { _id: "drafts.menu-baguette", slug: "baguette", title: "Baguette" },
      // No slug: left out of the slug groups.
      { _id: "menu-gift-box", title: "Gift box" },
    ],
    popup: [
      { _id: "popup-saturday", slug: "saturday-market", title: "Saturday market" },
      { _id: "popup-sunday", slug: "sunday-market", title: "Sunday market" },
    ],
    page: [{ _id: "page-home", slug: "home", title: "Home" }],
  },
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
