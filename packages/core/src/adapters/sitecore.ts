import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  describeRetry,
  retryAfterSeconds,
} from "../connectors/http.js";
import { MAX_RETRY_SECONDS, isRecord } from "../connectors/get-json.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import { registerQueryAllow } from "../fetch/query-registry.js";
import { QueryRefusedError } from "../fetch/read-only-query.js";
import { FetchError, type Fetcher } from "../fetcher.js";
import { safePath } from "./craft.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

import {
  SITECORE_API_KEY,
  SITECORE_DESCRIPTION,
  SITECORE_ENV_VARS,
  SITECORE_LIMITS,
  SITECORE_PAGE_SIZE,
} from "./sitecore.entry.js";
export {
  SITECORE_API_KEY,
  SITECORE_DESCRIPTION,
  SITECORE_ENV_VARS,
  SITECORE_LIMITS,
  SITECORE_PAGE_SIZE,
};

/** Experience Edge's Delivery GraphQL endpoint: one host and one path, never read from a setting or an answer. */
export const SITECORE_EDGE_HOST = "edge.sitecorecloud.io";
const EDGE_PATH = "/api/graphql/v1";

/** The path the preview GraphQL endpoint has on an environment's own host (the Preview API's documented base path). */
export const SITECORE_PREVIEW_PATH = "/sitecore/api/graph/edge";

/**
 * The one POST this adapter may send (ADR-0006): the Delivery GraphQL API's endpoint, which answers a query with
 * a POST because a GraphQL query travels in the body. The entry is written once, here, registered and frozen; the
 * fetcher sends to it by id and refuses any other address, any document that is not exactly one `query`, and any
 * stored-query id. The body is `{ query, variables }` and nothing else. The vendor's documentation pages were not
 * reachable when this was built (the build session's network policy refused doc.sitecore.com), so the entry is
 * marked `checked: null`: the endpoint, the header and the query are from Sitecore's own JavaScript SDK
 * (@sitecore-jss 22.8) and excerpts of the documentation, and the entry is uncited until someone reads the page
 * and puts the date here.
 */
export const SITECORE_QUERY_ALLOW = registerQueryAllow({
  id: "sitecore-edge-query",
  host: SITECORE_EDGE_HOST,
  path: EDGE_PATH,
  body: { kind: "graphql-query" },
  docs: {
    url: "https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/experience-edge-apis.html",
    checked: null,
  },
});

/**
 * The published routes of one site in one language, a page at a time: the query Sitecore's own JavaScript SDK
 * sends to list a site's pages (`routes` under `siteInfo`, with `total`, `pageInfo { endCursor hasNext }` and the
 * route path). Every value is a variable; no value is ever written into the document. It selects the path and
 * nothing else, so no field of the client's content is asked for.
 */
export const SITECORE_ROUTES_QUERY =
  "query Routes($site: String!, $language: String!, $pageSize: Int, $after: String) { site { siteInfo(site: $site) { routes(language: $language, first: $pageSize, after: $after) { total pageInfo { endCursor hasNext } results { routePath } } } } }";

/** What the live-site read says about the Experience Edge read, in one place so the docs and the tests say the same thing. */
export interface SitecorePreview {
  state: "absent" | "protected" | "answers" | "unread";
  /** The HTTP status of the answer, for the words a finding uses. */
  status?: number;
  reason?: string;
}

export interface SitecoreAdapterOptions {
  /** SITECORE_API_KEY, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry: `siteName`, `languages`, `urls` (an address prefix per language) and `expectPrivate`. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces SITECORE_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
}

/** The Sitecore adapter, plus the reads the Sitecore checks need. */
export interface SitecoreAdapter extends ContentAdapter {
  /** The languages the settings name (default en), in order. The first is the site's own, whose routes need no prefix. */
  languages(): string[];
  /** Whether the settings say (`expectPrivate: true`) that the preview endpoint is not meant to answer on the public site. */
  privacyExpected(): boolean;
  /**
   * What the preview endpoint's path does on the PUBLIC site's host, asked with no key: one GET, no cookie. It asks a
   * path a visitor is not meant to be sent to, so a caller runs it only with the owner's consent (CLAUDE.md rule 14).
   */
  previewEndpoint(origin: string): Promise<SitecorePreview>;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/** A site name, a language, a cursor and a key: the only forms that are ever sent. Linear patterns, no nested quantifier. */
const SITE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const CURSOR = /^[A-Za-z0-9+/=_.-]{1,2048}$/;
const KEY_SHAPE = /^[\x21-\x7e]{8,4096}$/;
/** An address prefix for a language: a path (`/fr-ca`) or an https origin (`https://fr.studio.example`), with nothing after it. */
const PREFIX_PATH = /^\/[A-Za-z0-9._~-]{1,40}(?:\/[A-Za-z0-9._~-]{1,40}){0,3}$/;
const PREFIX_ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,253}$/;

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** One page of a route list, as the platform answered it. */
interface RoutePage {
  total: number;
  paths: string[];
  next: string | undefined;
  hasNext: boolean | undefined;
}

export function createSitecoreAdapter(options: SitecoreAdapterOptions): SitecoreAdapter {
  const { fetcher } = options;
  const settings = options.settings;
  const sleep = options.sleep ?? wait;
  const key = (options.env[SITECORE_API_KEY] ?? "").trim();
  const redact = createRedactor(options.env, [SITECORE_API_KEY]);
  const pageSize = Math.max(
    1,
    Math.min(options.pageSize ?? SITECORE_PAGE_SIZE, SITECORE_PAGE_SIZE),
  );
  const cap = options.maxItemsPerType ?? SITECORE_LIMITS.itemsPerType;
  const siteName = settings?.siteName;
  const named = [...new Set(settings?.languages ?? ["en"])];

  /** Before anything is asked of Experience Edge: the key, the site name and the languages are all usable. */
  const ready = (): string => {
    if (key === "")
      throw new AdapterCouldNotCheck(
        `${SITECORE_API_KEY} is not set. Experience Edge's content needs a Delivery API token (Sitecore Deploy, the environment's Details tab).`,
      );
    if (!KEY_SHAPE.test(key))
      throw new AdapterCouldNotCheck(
        `${SITECORE_API_KEY} holds characters an API token does not have: it must be one line of printable characters, with no spaces.`,
      );
    if (siteName === undefined || !SITE_NAME.test(siteName))
      throw new AdapterCouldNotCheck(
        'No Sitecore site name. Set "siteName" on the sitecore entry in gaugeline.adapters.json (the name of the site in Sitecore\'s site configuration, such as website).',
      );
    if (named.length > SITECORE_LIMITS.languages)
      throw new AdapterCouldNotCheck(
        `At most ${SITECORE_LIMITS.languages} languages are read in one run; ${named.length} were named.`,
      );
    for (const language of named)
      if (!LANGUAGE.test(language))
        throw new AdapterCouldNotCheck(
          `"${language.slice(0, 20)}" is not a language such as en or fr-CA.`,
        );
    for (const [language, prefix] of Object.entries(settings?.urls ?? {}))
      if (named.includes(language) && !prefixOk(prefix))
        throw new AdapterCouldNotCheck(
          `The urls entry for ${language} must be the start of the address that language's pages have: a path such as /fr-ca, or an https address such as https://fr.studio.example, with nothing after it.`,
        );
    if (fetcher.query === undefined)
      throw new AdapterCouldNotCheck("This fetcher cannot send a read-only query.");
    return key;
  };

  const prefixOk = (prefix: string): boolean =>
    prefix === "" || PREFIX_PATH.test(prefix) || PREFIX_ORIGIN.test(prefix);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check, in fixed words. */
  const translate = (err: unknown, language: string, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        `Experience Edge did not accept ${SITECORE_API_KEY} (HTTP ${err.status}). Check it is a current Delivery API token for this environment (Sitecore Deploy, the environment's Details tab).`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        `Experience Edge answered HTTP ${err.status} for the ${language} routes.`,
      );
    if (err instanceof QueryRefusedError)
      return new AdapterCouldNotCheck(
        "Gaugeline refused to send the Experience Edge query because it is not a read-only query.",
      );
    if (err instanceof FetchError)
      return new AdapterCouldNotCheck(`Experience Edge could not be reached (${err.reason}).`);
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /**
   * One query: a page of one language's published routes. The token goes in the sc_apikey header, never in the
   * address or the body; `fetcher.query` sends to the allowlisted address only and never follows a redirect, so
   * it goes nowhere else. A 429 with a wait of a minute or less is waited out and asked again once; a second one
   * is the rate limit.
   */
  async function queryPage(language: string, after: string, size: number): Promise<RoutePage> {
    const token = ready();
    for (let attempt = 0; ; attempt++) {
      const hop = await (fetcher.query as NonNullable<Fetcher["query"]>)(
        `https://${SITECORE_EDGE_HOST}${EDGE_PATH}`,
        {
          allow: SITECORE_QUERY_ALLOW.id,
          body: {
            query: SITECORE_ROUTES_QUERY,
            variables: { site: siteName, language, pageSize: size, after },
          },
          headers: { sc_apikey: token },
        },
      );
      if (hop.status === 429) {
        const seconds = retryAfterSeconds(hop.headers);
        if (attempt === 0 && seconds !== undefined && seconds <= MAX_RETRY_SECONDS) {
          await sleep(seconds * 1000);
          continue;
        }
        throw new ConnectorRateLimitedError(describeRetry(hop.headers), seconds);
      }
      if (hop.status === 401 || hop.status === 403) throw new ConnectorRefusedError(hop.status);
      if (hop.status < 200 || hop.status >= 300) throw new ConnectorStatusError(hop.status);
      if (hop.truncated === true)
        throw new TooLarge("Experience Edge's answer is larger than one page should be.");
      let json: unknown;
      try {
        json = JSON.parse(hop.body ?? "");
      } catch {
        throw new AdapterCouldNotCheck("Experience Edge answered with something that is not JSON.");
      }
      return pageOf(json, language, size);
    }
  }

  /** A GraphQL answer read into a page. Errors, a missing site and any shape that is not the documented one are could-not-check. */
  const pageOf = (json: unknown, language: string, size: number): RoutePage => {
    if (!isRecord(json))
      throw new AdapterCouldNotCheck(
        "Experience Edge answered with something that is not an object.",
      );
    // The messages of a GraphQL error may quote content: only how many there were is repeated.
    if (Array.isArray(json.errors) && json.errors.length > 0)
      throw new AdapterCouldNotCheck(
        `Experience Edge refused the query (${json.errors.length} GraphQL error${json.errors.length === 1 ? "" : "s"}). The usual cause is a token for another environment, or a query the endpoint's limits reject.`,
      );
    const data = isRecord(json.data) ? json.data : undefined;
    const site = data !== undefined && isRecord(data.site) ? data.site : undefined;
    if (site === undefined)
      throw new AdapterCouldNotCheck("Experience Edge answered with something that has no data.");
    const info = site.siteInfo;
    if (info === null || info === undefined)
      throw new AdapterCouldNotCheck(
        `Experience Edge has no site named "${siteName ?? ""}" for this token. Check "siteName" in gaugeline.adapters.json (the name in Sitecore's site configuration) and that the site was published to Edge.`,
      );
    const routes = isRecord(info) ? info.routes : undefined;
    if (!isRecord(routes) || !Array.isArray(routes.results))
      throw new AdapterCouldNotCheck(
        `Experience Edge answered with something that is not a list of ${language} routes.`,
      );
    const { total } = routes;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
      throw new AdapterCouldNotCheck(
        "Experience Edge answered with something that is not a count of routes.",
      );
    if (routes.results.length > size)
      throw new AdapterCouldNotCheck(
        `Experience Edge answered with more routes than the ${size} asked for, so its list cannot be trusted.`,
      );
    const paths: string[] = [];
    for (const r of routes.results) {
      const path =
        isRecord(r) && typeof r.routePath === "string" ? safePath(r.routePath) : undefined;
      if (path === undefined)
        throw new AdapterCouldNotCheck(
          "Experience Edge answered with routes that have no usable path.",
        );
      paths.push(path);
    }
    const info2 = isRecord(routes.pageInfo) ? routes.pageInfo : {};
    const next =
      typeof info2.endCursor === "string" && info2.endCursor !== "" ? info2.endCursor : undefined;
    return {
      total,
      paths,
      next,
      hasNext: typeof info2.hasNext === "boolean" ? info2.hasNext : undefined,
    };
  };

  /**
   * The published routes of one language, a page at a time, until the server says there are no more: the cursor
   * it returns is followed, and the read ends only when `hasNext` is false. A page that says there is more and
   * gives no cursor, a missing `hasNext`, a repeated cursor, an empty page that is not the end, a cursor that is
   * not a token, a repeated route, fewer routes than `total` at the end, more routes than `maxRead` whatever
   * total is claimed, and more requests than that many routes could need are each could-not-check, never the
   * end of the list. An answer over the size limit is asked again with half as many, down to ten.
   */
  async function* routesOf(
    language: string,
    maxRead: number,
    partial: () => unknown,
  ): AsyncGenerator<string> {
    const maxPages = Math.ceil(maxRead / MIN_PAGE_SIZE) + 12;
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let after = "";
    let size = pageSize;
    let asked = 0;
    for (;;) {
      if (++asked > maxPages)
        throw new AdapterCouldNotCheck(
          `Experience Edge needed more than ${maxPages} requests to list the ${language} routes, so they were not read to the end.`,
        );
      let page: RoutePage;
      try {
        page = await queryPage(language, after, size);
      } catch (err) {
        if (err instanceof TooLarge && size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw translate(err, language, partial());
      }
      if (page.total > maxRead)
        throw new AdapterCouldNotCheck(
          `The ${language} site has ${page.total} routes, more than ${maxRead}, which is as many as Gaugeline reads for one language.`,
        );
      for (const path of page.paths) {
        if (seen.has(path))
          throw new AdapterCouldNotCheck(
            `Experience Edge listed the same ${language} route twice, so its paging cannot be trusted and the routes were not read.`,
          );
        seen.add(path);
        if (seen.size > maxRead)
          throw new AdapterCouldNotCheck(
            `Experience Edge listed more than ${maxRead} ${language} routes, whatever total it reported.`,
          );
        yield path;
      }
      if (page.hasNext === undefined)
        throw new AdapterCouldNotCheck(
          `Experience Edge's ${language} list did not say whether there is more, so it was not read to the end.`,
        );
      if (!page.hasNext) {
        if (seen.size < page.total)
          throw new AdapterCouldNotCheck(
            `Experience Edge said the ${language} list has ${page.total} routes and gave ${seen.size}, so the rest was not read.`,
          );
        return;
      }
      if (
        page.next === undefined ||
        !CURSOR.test(page.next) ||
        cursors.has(page.next) ||
        page.paths.length === 0
      )
        throw new AdapterCouldNotCheck(
          `Experience Edge's ${language} list did not come to an end (no cursor, an unusable or repeated cursor, or an empty page), so it was not read to the end.`,
        );
      cursors.add(page.next);
      after = page.next;
    }
  }

  /** The address a route has on the live site: the language's prefix from the settings, else (for the first language) the path itself. */
  const urlFor = (language: string, path: string): string => {
    const prefix = settings?.urls?.[language];
    if (prefix !== undefined) return `${prefix}${path}`;
    return language === named[0] ? path : "";
  };

  const types = async (): Promise<TypeCount[]> => {
    ready();
    const out: TypeCount[] = [];
    for (const language of named) {
      let page: RoutePage;
      try {
        page = await queryPage(language, "", 1);
      } catch (err) {
        throw translate(err, language, out.slice());
      }
      if (page.total > cap)
        throw new AdapterCouldNotCheck(
          `The ${language} site has ${page.total} routes, more than ${cap}, which is as many as Gaugeline reads for one language.`,
        );
      out.push({ name: language, count: page.total });
    }
    return out;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    ready();
    if (opts.since !== undefined && Number.isNaN(Date.parse(opts.since)))
      throw new TypeError("since must be a date and time (ISO 8601).");
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const language of named.filter(
      (n) => opts.types === undefined || opts.types.includes(n),
    )) {
      if (remaining <= 0) return;
      for await (const path of routesOf(language, cap, () => delivered)) {
        const url = urlFor(language, path);
        remaining--;
        delivered++;
        // A route list has no dates and no fields: a doc carries its place and nothing more, and no time is made up.
        yield {
          id: `${language}:${path}`,
          type: language,
          ...(url !== "" ? { url } : {}),
          fieldHashes: {},
        };
        if (remaining <= 0) return;
      }
    }
  }

  const previewEndpoint = async (origin: string): Promise<SitecorePreview> => {
    let base: URL;
    try {
      base = new URL(origin);
    } catch {
      return { state: "unread", reason: "the site address is not an address" };
    }
    try {
      const hops = await fetcher.get(`${base.origin}${SITECORE_PREVIEW_PATH}`, {
        anonymous: true,
        maxRedirects: 0,
        maxBytes: 8192,
      });
      const hop = hops.at(-1);
      if (hop === undefined) return { state: "unread", reason: "no answer" };
      const status = hop.status;
      if (status === 404 || status === 410) return { state: "absent", status };
      if (status === 401 || status === 403) return { state: "protected", status };
      if (status === 200 || status === 400) {
        let json: unknown;
        try {
          json = JSON.parse(hop.body ?? "");
        } catch {
          json = undefined;
        }
        if (isRecord(json) && ("data" in json || "errors" in json))
          return { state: "answers", status };
        return {
          state: "unread",
          status,
          reason:
            "the path answered, but not like a GraphQL endpoint (it may be a page that answers every path)",
        };
      }
      return { state: "unread", status, reason: `the path answered HTTP ${status}` };
    } catch (err) {
      return {
        state: "unread",
        reason: redact(err instanceof Error ? err.message : String(err)),
      };
    }
  };

  return {
    id: "sitecore",
    describe: () => SITECORE_DESCRIPTION,
    types,
    fieldCounts: () =>
      Promise.reject(
        new AdapterCouldNotCheck(
          "Not applicable to what Gaugeline reads from Experience Edge: the route list (the pages published to Edge) has no fields. Gaugeline compares routes with the live site's pages, and reads no field value.",
        ),
      ),
    published,
    // The Delivery API answers only for content published to Edge, by design, so a Delivery token cannot reach drafts.
    // That is how the API is documented, not something Gaugeline measured: the preview endpoint is a separate check.
    draftsReachable: () => Promise.resolve("not-applicable"),
    languages: () => [...named],
    privacyExpected: () => settings?.expectPrivate === true,
    previewEndpoint,
  };
}
