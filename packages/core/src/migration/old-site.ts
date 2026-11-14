import { ConfigError } from "../errors.js";
import { FetchError, type Fetcher, type Hop } from "../fetcher.js";
import { parseSitemap } from "../site-context.js";
import { buildSnapshot } from "../snapshot.js";
import { ListBuilder, MIGRATION_ITEM_CAP, parseWordPress, type OldList } from "./list.js";

/**
 * Read the old site's content list from the old site itself. Three sources, in this order, and the
 * first that gives a list wins:
 *  1. The WordPress REST API: GET /wp-json/wp/v2/posts and /pages, published items only, no key. It is
 *     a documented public API, the same one the theme's own JavaScript reads, so it is not a probe.
 *  2. The sitemap: /sitemap.xml, /wp-sitemap.xml or /sitemap_index.xml, an index followed one level.
 *  3. The links on the old site's home page, one level, same site only.
 * Every request is a GET through the fetcher.
 */

const PER_PAGE = 100;
/** Sitemap files read, an index and its children together. */
const SITEMAP_FILES = 10;

async function tryGet(fetcher: Fetcher, url: string): Promise<Hop[] | undefined> {
  try {
    return await fetcher.get(url, { headers: { accept: "application/json, text/html, */*" } });
  } catch (err) {
    if (err instanceof FetchError) return err.hops.length > 0 ? err.hops : undefined;
    return undefined;
  }
}

const finalOk = (hops: Hop[] | undefined): Hop | undefined => {
  const last = hops?.at(-1);
  return last !== undefined && last.status >= 200 && last.status < 300 ? last : undefined;
};

/** Posts and pages from the WordPress REST API, or undefined when the site has none. */
async function readWordPress(fetcher: Fetcher, origin: URL): Promise<OldList | undefined> {
  const list = new ListBuilder();
  const notes: string[] = [];
  let found = 0;
  const counts: string[] = [];
  for (const kind of ["posts", "pages"] as const) {
    let page = 1;
    let pages = 1;
    let read = 0;
    while (page <= pages && read < MIGRATION_ITEM_CAP) {
      const url = `${origin.origin}/wp-json/wp/v2/${kind}?per_page=${PER_PAGE}&page=${page}&status=publish&_fields=link,title,type,status`;
      const hop = finalOk(await tryGet(fetcher, url));
      const rows = hop === undefined ? undefined : parseWordPress(hop.body ?? "");
      if (hop === undefined || rows === undefined) {
        if (page === 1) break;
        notes.push(
          `Page ${page} of the old site's ${kind} could not be read; the rest were listed.`,
        );
        break;
      }
      if (page === 1) found += 1;
      const total = Number(hop.headers["x-wp-totalpages"]);
      pages =
        Number.isInteger(total) && total > 0 ? total : rows.length >= PER_PAGE ? page + 1 : page;
      for (const r of rows) list.add(r.link, r.title, r.type ?? kind.slice(0, -1));
      read += rows.length;
      if (rows.length === 0) break;
      page += 1;
    }
    counts.push(`${read} ${kind}`);
  }
  if (found === 0) return undefined;
  return list.done("wordpress", [
    `Read ${counts.join(" and ")} from the old site's WordPress API.`,
    ...notes,
  ]);
}

/** Page addresses from the old site's sitemap files. */
async function readSitemap(fetcher: Fetcher, origin: URL): Promise<OldList | undefined> {
  const list = new ListBuilder();
  const seen = new Set<string>();
  let files = 0;
  let parsedAny = false;
  const read = async (url: string): Promise<ReturnType<typeof parseSitemap>> => {
    seen.add(url);
    files += 1;
    const hop = finalOk(await tryGet(fetcher, url));
    return hop === undefined ? { kind: "unknown", locs: [] } : parseSitemap(hop.body ?? "");
  };
  for (const start of ["/sitemap.xml", "/wp-sitemap.xml", "/sitemap_index.xml"]) {
    if (parsedAny || files >= SITEMAP_FILES) break;
    const top = await read(`${origin.origin}${start}`);
    if (top.kind === "unknown") continue;
    parsedAny = true;
    if (top.kind === "urlset") for (const loc of top.locs) list.add(loc);
    else
      for (const child of top.locs) {
        if (files >= SITEMAP_FILES || seen.has(child)) continue;
        const sub = await read(child);
        if (sub.kind === "urlset") for (const loc of sub.locs) list.add(loc);
      }
  }
  if (!parsedAny) return undefined;
  return list.done("sitemap", ["Read the old site's sitemap; it gives addresses, not titles."]);
}

const FILE = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|css|js|xml|json|mp4|mp3|woff2?)$/iu;

/** The same-site links on the old site's home page. */
async function readLinks(fetcher: Fetcher, origin: URL): Promise<OldList | undefined> {
  const hop = finalOk(await tryGet(fetcher, `${origin.origin}/`));
  if (hop === undefined) return undefined;
  const list = new ListBuilder();
  list.add("/");
  const snapshot = buildSnapshot([hop]);
  for (const link of snapshot.links) {
    if (!link.sameSite || link.href.startsWith("#") || FILE.test(link.href.split(/[?#]/u)[0] ?? ""))
      continue;
    list.add(link.href.split("#")[0] ?? link.href);
  }
  return list.done("links", [
    "The old site has no WordPress API or sitemap, so the links on its home page were followed one level.",
  ]);
}

/** The old site's content list, or a ConfigError saying how to give one by hand. */
export async function readOldSite(fetcher: Fetcher, address: string): Promise<OldList> {
  const origin = new URL(address);
  const got =
    (await readWordPress(fetcher, origin)) ??
    (await readSitemap(fetcher, origin)) ??
    (await readLinks(fetcher, origin));
  if (got === undefined || got.items.length === 0)
    throw new ConfigError(`Could not read a list of pages from ${origin.host}.`, {
      hint: "It has no WordPress API, no sitemap and no home page that answers. Give the list yourself with --old-file (a CSV or JSON export).",
    });
  return got;
}
