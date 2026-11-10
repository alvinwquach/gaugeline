import { isSignedLink } from "../checks/paid-files.js";
import { linkCandidates } from "../links.js";
import type { PageSnapshot } from "../snapshot.js";

/**
 * Which download routes of a site to ask, found two ways and merged into one Set of same-site
 * addresses: the links on the page, and the route files of the site's repository (--routes). Pure:
 * no request, no file read. The repository side is file paths only; Gaugeline never opens a source file.
 */

/** A path that says it hands something over. */
const DOWNLOAD_WORDS = /download|file|deliver|export/i;

const ROUTE_FILE = /^route\.(?:[cm]?[jt]s|[jt]sx)$/;
const API_FILE = /^(?<name>.+)\.(?:[cm]?[jt]s|[jt]sx)$/;
const NOT_A_ROUTE = /\.(?:test|spec|stories)\.|\.d\.[cm]?ts$/;

/**
 * A route file of a Next.js project as the URL path it serves. The app router: a `route.ts` in a
 * folder (route groups like `(shop)` and slots like `@modal` are not part of the address). The pages
 * router: a file under `pages/api`. A dynamic segment stays as written: `[id]`, `[...path]`,
 * `[[...path]]`. A file that is not a route handler (a page, a layout, a test) is undefined.
 */
export function routeFileToPath(file: string): string | undefined {
  const parts = file
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  const name = parts.at(-1);
  if (name === undefined || NOT_A_ROUTE.test(name)) return undefined;
  const dirs = parts.slice(0, -1);
  const app = dirs.indexOf("app");
  if (app !== -1 && ROUTE_FILE.test(name)) {
    const segments = dirs.slice(app + 1);
    // A folder starting with an underscore is private to the project, not an address.
    if (segments.some((s) => s.startsWith("_"))) return undefined;
    const kept = segments.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    return `/${kept.join("/")}`;
  }
  const pages = dirs.findIndex((d, i) => d === "pages" && dirs[i + 1] === "api");
  if (pages !== -1) {
    const base = API_FILE.exec(name)?.groups?.name;
    if (base === undefined) return undefined;
    const segments = [...dirs.slice(pages + 1), ...(base === "index" ? [] : [base])];
    if (segments.some((s) => s.startsWith("_"))) return undefined;
    return `/${segments.join("/")}`;
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this path pattern have a dynamic segment? */
function isDynamic(path: string): boolean {
  return path.includes("[");
}

/**
 * A pattern for the concrete addresses a route serves: `[id]` is one segment, `[...path]` one or
 * more, `[[...path]]` none or more. Anything else must match exactly.
 */
export function routePattern(path: string): RegExp {
  const body = path
    .split("/")
    .filter((s) => s !== "")
    .map((segment) => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return "(?:/.+)?";
      if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return "/.+";
      if (/^\[[^\]]+\]$/.test(segment)) return "/[^/]+";
      return `/${escapeRegExp(segment)}`;
    })
    .join("");
  return new RegExp(`^${body === "" ? "/" : body}$`);
}

/** The address without its query string or fragment: what is printed. */
export function withoutQuery(address: string): string {
  try {
    const u = new URL(address);
    return `${u.origin}${u.pathname}`;
  } catch {
    return address.split(/[?#]/)[0] ?? address;
  }
}

/** The path of an address, without its query string: how a route is named in a finding. */
export function displayPath(address: string): string {
  try {
    return new URL(address).pathname;
  } catch {
    return address.split(/[?#]/)[0] ?? address;
  }
}

/** A last segment with a file extension: a static file, which is public by being served as a file. */
const STATIC_FILE = /\.[a-z0-9]{1,6}$/i;

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

export interface NotProbed {
  /** The path, as a route is named: dynamic segments in brackets. */
  path: string;
  /**
   * no-address: a dynamic route no link gives a concrete address for (ids are never guessed).
   * signed: a link that carries its own signature and expiry, which is a capability, not a gate.
   */
  reason: "no-address" | "signed";
}

export interface Discovery {
  /** Every address to ask, sorted, without repeats: a Set made into a list. */
  found: string[];
  /** Routes found and not asked, by path. */
  notProbed: NotProbed[];
}

/**
 * The routes to ask, from the links on the page and from route files. From links: same-site
 * addresses whose path contains download, file, deliver or export, or sits under /api/ (a link
 * straight to a file such as /files/menu.pdf is a static file, not a route). From route files: the
 * path each maps to, when it says download, file, deliver or export. A dynamic route is asked only
 * for the concrete addresses a link gave; with none it is listed as not probed. A Set removes the
 * repeats between the two sources, and the sort makes the routes the cap keeps the same every run.
 */
export function discoverRoutes(page: PageSnapshot, files: readonly string[]): Discovery {
  const links = linkCandidates(page).map((l) => {
    const u = new URL(l.url);
    u.hash = "";
    return u;
  });
  const found = new Set<string>();
  const notProbed = new Map<string, NotProbed>();
  for (const u of links) {
    const path = u.pathname;
    if (!DOWNLOAD_WORDS.test(path) && !isApiPath(path)) continue;
    if (STATIC_FILE.test(path) && !isApiPath(path)) continue;
    if (isSignedLink(u.href)) {
      notProbed.set(`signed ${path}`, { path, reason: "signed" });
      continue;
    }
    found.add(u.href);
  }
  const fromLinks = new Set([...found].map(displayPath));
  const origin = new URL(page.finalUrl).origin;
  for (const file of files) {
    const path = routeFileToPath(file);
    if (path === undefined || !DOWNLOAD_WORDS.test(path)) continue;
    if (!isDynamic(path)) {
      // A link to the same path (with its query) is this route's concrete address.
      if (!fromLinks.has(path)) found.add(new URL(path, origin).href);
      continue;
    }
    const pattern = routePattern(path);
    const seen = links.filter((u) => pattern.test(u.pathname) && !isSignedLink(u.href));
    for (const u of seen) found.add(u.href);
    if (seen.length === 0) notProbed.set(`no-address ${path}`, { path, reason: "no-address" });
  }
  return {
    found: [...found].sort(),
    notProbed: [...notProbed.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
}
