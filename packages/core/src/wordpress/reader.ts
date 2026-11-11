import { NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";

/**
 * What the two WordPress checks read beyond the page itself, once per address and shared: the current
 * releases from the public wordpress.org API, and whether the site's own REST API lists its users to a visitor.
 * Every request is a GET through the fetcher with no key and nothing sent. The wordpress.org API is asked
 * about a plugin or theme only by the slug the page's own file addresses show.
 */
export type Latest =
  | { ok: true; version: string }
  /** `unlisted`: wordpress.org answered and does not list it (a premium or custom plugin or theme). */
  | { ok: false; reason: string; unlisted?: true };

export type UsersRead =
  | {
      ok: true;
      exposed: boolean;
      /** How many users a visitor was shown. Their names, slugs and ids are not read. */
      listed: number;
      /** The route that was asked, as a path and query: what a finding names. */
      route: string;
    }
  | { ok: false; reason: string };

export interface WordPress {
  latest(kind: "core" | "plugin" | "theme", slug?: string): Promise<Latest>;
  /** `root` is the REST root, "https://client.example/wp-json/" (what the page's api.w.org link says). */
  users(root: string): Promise<UsersRead>;
  /**
   * True the first time a key is asked about in this run, false after: every page of a site carries the same
   * versions, and a finding or note about one is given once, on the first page.
   */
  claim(key: string): boolean;
  /**
   * True while fewer than WORDPRESS_LOOKUP_CAP plugins (or themes) have been looked up on wordpress.org in this run:
   * the allowance is the run's, shared by every page, so the requests are bounded however many pages are checked.
   */
  reserve(kind: "plugin" | "theme"): boolean;
}

/** The most plugins, and the most themes, one run asks wordpress.org about. */
export const WORDPRESS_LOOKUP_CAP = 15;

export const WORDPRESS_API = "https://api.wordpress.org";

/** The most body a wordpress.org answer may be: a plugin's record carries its readme, a few hundred KB at most. */
const MAX_BYTES = 2 * 1024 * 1024;

const slugOk = (slug: string): boolean => /^[a-z0-9][a-z0-9._-]{0,79}$/.test(slug);

const short = (err: unknown): string =>
  (err instanceof Error ? err.message : "the request failed").replace(/[.\s]+$/, "");

export function createWordPress(fetcher: Fetcher, api: string = WORDPRESS_API): WordPress {
  const latests = new Map<string, Promise<Latest>>();
  const users = new Map<string, Promise<UsersRead>>();
  const claimed = new Set<string>();
  const spent = { plugin: 0, theme: 0 };

  /** One GET, parsed as JSON: the status and the parsed body (undefined when it was not JSON). */
  async function getJson(
    url: string,
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> } | string> {
    try {
      const last = (await fetcher.get(url, { maxBytes: MAX_BYTES })).at(-1);
      if (!last) return "it gave no answer";
      if (last.error === "private-address-refused")
        return "it is a private address, which Gaugeline does not ask";
      if (last.truncated) return "its answer is larger than Gaugeline reads";
      let body: unknown;
      try {
        body = JSON.parse(last.body ?? "");
      } catch {
        body = undefined;
      }
      return { status: last.status, body, headers: last.headers };
    } catch (err) {
      if (err instanceof NetworkError) return `could not be read: ${short(err)}`;
      throw err;
    }
  }

  const record = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

  async function fetchLatest(kind: "core" | "plugin" | "theme", slug: string): Promise<Latest> {
    const subject = kind === "core" ? "the current WordPress release" : `the ${kind} ${slug}`;
    const url =
      kind === "core"
        ? `${api}/core/version-check/1.7/`
        : `${api}/${kind}s/info/1.2/?action=${kind}_information&request%5Bslug%5D=${encodeURIComponent(slug)}`;
    const got = await getJson(url);
    if (typeof got === "string")
      return { ok: false, reason: `${api} ${got}, so ${subject} is not known.` };
    if (got.status === 429)
      return {
        ok: false,
        reason: `${api} asked Gaugeline to slow down, so ${subject} is not known.`,
      };
    const body = record(got.body);
    // wordpress.org answers an unknown slug with an error object (HTTP 404 for a plugin, sometimes 200 for a theme).
    if (kind !== "core" && (got.status === 404 || typeof body.error === "string"))
      return {
        ok: false,
        unlisted: true,
        reason: `${subject} is not in the wordpress.org directory`,
      };
    if (got.status < 200 || got.status >= 300)
      return {
        ok: false,
        reason: `${api} answered HTTP ${got.status}, so ${subject} is not known.`,
      };
    let version: unknown;
    if (kind === "core") {
      const offers = Array.isArray(body.offers) ? body.offers : [];
      // The first offer is the current release (WordPress's own updater reads it the same way).
      version = record(offers[0]).current ?? record(offers[0]).version;
    } else version = body.version;
    if (
      typeof version !== "string" ||
      !/^\d{1,3}(?:\.\d{1,4}){1,3}(?:-[0-9A-Za-z.]{1,20})?$/.test(version)
    )
      return {
        ok: false,
        reason: `${api} did not give a version Gaugeline can read for ${subject}.`,
      };
    return { ok: true, version };
  }

  async function fetchUsers(root: string): Promise<UsersRead> {
    const base = root.replace(/\/+$/, "");
    // Only the count matters: asking for `id` alone means no name or slug is sent back to be read.
    const routes = [
      `${base}/wp/v2/users?per_page=100&_fields=id`,
      // A site with plain permalinks serves its REST API at /?rest_route=, and answers /wp-json/ with 404.
      `${base.replace(/\/wp-json$/, "")}/?rest_route=${encodeURIComponent("/wp/v2/users")}&per_page=100&_fields=id`,
    ];
    let last = "";
    for (const [i, url] of routes.entries()) {
      const got = await getJson(url);
      if (typeof got === "string") return { ok: false, reason: `The users route ${got}.` };
      const u = new URL(url);
      const route = `${u.pathname}${u.search}`;
      last = route;
      if (got.status === 404 && i === 0) continue;
      if (got.status === 401 || got.status === 403 || got.status === 404)
        return { ok: true, exposed: false, listed: 0, route };
      if (got.status === 429)
        return { ok: false, reason: "The users route asked Gaugeline to slow down." };
      if (got.status < 200 || got.status >= 300)
        return { ok: false, reason: `The users route answered HTTP ${got.status}.` };
      if (!Array.isArray(got.body))
        return {
          ok: false,
          reason: "The users route answered with something that is not a list of users.",
        };
      const total = Number(got.headers["x-wp-total"]);
      const listed =
        Number.isSafeInteger(total) && total >= got.body.length ? total : got.body.length;
      return { ok: true, exposed: listed > 0, listed, route };
    }
    return { ok: true, exposed: false, listed: 0, route: last };
  }

  const once = <T>(
    cache: Map<string, Promise<T>>,
    key: string,
    make: () => Promise<T>,
  ): Promise<T> => {
    let p = cache.get(key);
    if (!p) cache.set(key, (p = make()));
    return p;
  };

  return {
    latest(kind, slug = "") {
      if (kind !== "core" && !slugOk(slug))
        return Promise.resolve({
          ok: false,
          reason: `"${slug.slice(0, 40)}" is not a plugin or theme name.`,
        });
      return once(latests, `${kind}:${slug}`, () => fetchLatest(kind, slug));
    },
    users: (root) => once(users, root, () => fetchUsers(root)),
    reserve(kind) {
      if (spent[kind] >= WORDPRESS_LOOKUP_CAP) return false;
      spent[kind]++;
      return true;
    },
    claim(key) {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
}
