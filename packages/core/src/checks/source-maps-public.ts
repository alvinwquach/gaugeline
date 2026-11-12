import { load } from "cheerio/slim";
import { NetworkError } from "../errors.js";
import type { Fetcher, Hop } from "../fetcher.js";
import { LIMITS } from "../limits.js";
import { defineCheck, type CheckContext } from "../model.js";
import { isSameSite } from "../sample.js";
import {
  mapReference,
  readSourceMap,
  resolveMapAddress,
  type MapSummary,
} from "../sourcemaps/scan.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** A JavaScript or CSS file the page loads, as read. */
interface LoadedFile {
  url: string;
  text: string;
  truncated: boolean;
  /** The SourceMap response header, when there is one. */
  header?: string;
}

/** What one file's map turned out to be. */
type Named = { file: LoadedFile; map: MapSummary } | { file: LoadedFile; inline: number };

const SHOWN = 5;

/** The path of an address, with no query string, at most 120 characters. */
function pathOf(url: string): string {
  const p = new URL(url).pathname;
  return p.length > 120 ? `${p.slice(0, 117)}...` : p;
}

async function ask(fetcher: Fetcher, url: string): Promise<Hop | undefined> {
  try {
    // A redirect is not followed: only the address the file itself names is asked.
    return (await fetcher.get(url, { maxRedirects: 0 })).at(-1);
  } catch (err) {
    if (err instanceof NetworkError) return undefined;
    throw err;
  }
}

/** The page's same-site stylesheets, read once each (at most LIMITS.stylesheets). */
async function stylesheets(page: PageSnapshot, fetcher: Fetcher): Promise<LoadedFile[]> {
  const $ = load(page.hops.at(-1)?.body ?? "");
  const urls = new Set<string>();
  $("link[href]").each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) return;
    try {
      const u = new URL(($(el).attr("href") ?? "").trim(), page.finalUrl);
      u.hash = "";
      if (/^https?:$/.test(u.protocol) && isSameSite(u.href, page.finalUrl)) urls.add(u.href);
    } catch {
      // An address that does not parse is not a stylesheet to read.
    }
  });
  const read = await Promise.all(
    [...urls]
      .slice(0, LIMITS.stylesheets)
      .map(async (url) => ({ url, hop: await ask(fetcher, url) })),
  );
  return read.flatMap(({ url, hop }) =>
    hop && hop.status >= 200 && hop.status < 300
      ? [
          {
            url,
            text: hop.body ?? "",
            truncated: hop.truncated ?? false,
            ...(hop.headers.sourcemap ? { header: hop.headers.sourcemap.trim() } : {}),
          },
        ]
      : [],
  );
}

function describe(n: Named): string {
  const path = pathOf(n.file.url);
  if ("inline" in n)
    return `${path} (inline map, about ${Math.max(1, Math.round(n.inline / 1024))} KB)`;
  const files = `${n.map.sources} source file${n.map.sources === 1 ? "" : "s"}`;
  return n.map.withContent
    ? `${path} (${files}, original code included, ${n.map.sizeClass})`
    : `${path} (${files}, names only)`;
}

export const sourceMapsPublic = defineCheck<PageSnapshot>({
  id: "source-maps-public",
  size: "S",
  done: "The site's JavaScript and CSS name no source map a visitor can fetch, or the maps are kept on a private error-tracking service.",
  estimateChanges:
    "One build setting. If the site reports errors to a tracker that needs the maps, upload them there at build time and delete them from the deploy.",
  area: "Security & email",
  severity: "medium",
  title: "Your site publishes its source maps",
  what: "A script or stylesheet this page loads names a source map, and the map can be fetched by anyone. A source map is the original, readable code the minified file was made from.",
  why: "Anyone can read your site's original code, comments and file layout, which makes it easier to find a mistake, an internal address or a key left in the code.",
  fix: "Turn production source maps off, or upload them to your error tracker and keep them out of the deploy. Vite: build.sourcemap false (the default) or 'hidden'. webpack: devtool false, or hidden-source-map. Next.js: leave productionBrowserSourceMaps off. Nuxt: sourcemap: { client: false }.",
  tech: "GET of the map address a same-site file names, never a guessed one: the SourceMap (or X-SourceMap) response header or the last source map comment at the end of the file (a //# comment, /*# */ in CSS) of up to 15 script files and 5 stylesheets the page loads; at most 10 maps, same origin only, redirects not followed, a value that is not http(s) or not readable is not asked; a map counts only when its first 5 MB parse as a version 3 source map (so a page that answers 200 for every address does not); a map cut at the cap, a 401, 403, 429, 5xx and a network error are could not check; the evidence is file paths, counts of source files, whether the original code is included and a size class, never a name or a character from inside a map; an inline data: map is counted by size without decoding",
  async run(page, ctx) {
    if (!isHtmlPage(page) || !ctx.fetcher || !ctx.scripts) return [];
    const fetcher = ctx.fetcher;
    const files: LoadedFile[] = [];
    for (const s of await ctx.scripts()) {
      if (s.status === null)
        ctx.couldNotCheck?.(s.url, "the file could not be reached, so its map comment is unread");
      else if (s.status >= 200 && s.status < 300)
        files.push({
          url: s.url,
          text: s.text,
          truncated: s.truncated,
          ...(s.sourceMap ? { header: s.sourceMap } : {}),
        });
    }
    files.push(...(await stylesheets(page, fetcher)));
    const wanted = new Map<string, LoadedFile[]>();
    const inline: Named[] = [];
    for (const file of files) {
      const ref =
        file.header !== undefined
          ? ({ kind: "url", ref: file.header } as const)
          : mapReference(file.text);
      if (!ref) {
        if (file.truncated)
          ctx.couldNotCheck?.(
            file.url,
            `only the start was read (the file is over ${LIMITS.bodyBytes / 1048576} MB), and a map comment sits at the end of a file`,
          );
        continue;
      }
      if (ref.kind === "inline") {
        inline.push({ file, inline: ref.bytes });
        continue;
      }
      const at = resolveMapAddress(ref.ref, file.url);
      if ("skip" in at) {
        ctx.couldNotCheck?.(
          file.url,
          at.skip === "cross-origin"
            ? "its source map is on another origin, which is never asked"
            : "its source map value is not an address Gaugeline asks",
        );
        continue;
      }
      wanted.set(at.url, [...(wanted.get(at.url) ?? []), file]);
    }
    const urls = [...wanted.keys()];
    for (const url of urls.slice(LIMITS.sourceMaps))
      ctx.couldNotCheck?.(
        url,
        `not asked: more than ${LIMITS.sourceMaps} source maps are named, and the first ${LIMITS.sourceMaps} in page order are asked`,
      );
    const hops = await Promise.all(urls.slice(0, LIMITS.sourceMaps).map((u) => ask(fetcher, u)));
    const named: Named[] = [...inline];
    urls.slice(0, LIMITS.sourceMaps).forEach((url, i) => {
      const hop = hops[i];
      const refused =
        hop === undefined || [401, 403, 429].includes(hop.status) || hop.status >= 500;
      if (refused) return void reason(ctx, url, hop);
      if (hop.status < 200 || hop.status >= 300) return;
      if (hop.truncated)
        return void ctx.couldNotCheck?.(
          url,
          `the map is over ${LIMITS.bodyBytes / 1048576} MB, so it was not read`,
        );
      const map = readSourceMap(hop.body ?? "");
      if (map) for (const file of wanted.get(url) ?? []) named.push({ file, map });
    });
    if (named.length === 0) return [];
    const order = new Map(files.map((f, i) => [f.url, i]));
    named.sort((a, b) => (order.get(a.file.url) ?? 0) - (order.get(b.file.url) ?? 0));
    const shown = named.slice(0, SHOWN).map(describe).join("; ");
    const more = named.length > SHOWN ? ` and ${named.length - SHOWN} more` : "";
    const withCode = named.some((n) => "inline" in n || n.map.withContent);
    return [
      {
        checkId: "source-maps-public",
        severity: withCode ? ("medium" as const) : ("low" as const),
        title: this.title,
        evidence: `${named.length} file${named.length === 1 ? " names" : "s name"} a source map anyone can fetch: ${shown}${more}`,
        url: page.finalUrl,
      },
    ];
  },
});

function reason(ctx: CheckContext, url: string, hop: Hop | undefined): void {
  ctx.couldNotCheck?.(
    url,
    hop === undefined
      ? "the map address could not be reached"
      : `the map address answered ${hop.status}, so it was not read`,
  );
}
