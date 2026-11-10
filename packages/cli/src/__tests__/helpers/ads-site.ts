import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Transport } from "@gaugeline/core";

/**
 * Stand-ins for the invented tapas bar (tapas-bar.example) the ads fixtures link to, so a test of
 * `gaugeline ads` makes its requests without a network. Reserved names never reach DNS.
 */
const answer = (
  status: number,
  headers: Record<string, string> = {},
  body = "<!doctype html><title>Tapas Bar</title>",
) =>
  Promise.resolve({
    status,
    headers: { "content-type": "text/html", ...headers },
    body: Readable.from([Buffer.from(body)]),
  });

/** Every page answers 200 and keeps the query: nothing to report. */
export const okSite: Transport = () => answer(200);

/**
 * The gift cards page redirects to /shop/gift-cards and drops the query, as an old rule written by
 * hand often does; every other page answers 200. One finding, on one page.
 */
export const tapasSite: Transport = (url) =>
  url.pathname === "/gift-cards" ? answer(301, { location: "/shop/gift-cards" }) : answer(200);

/**
 * The same, and the old menu page has been taken down: it answers 404, as the page in the docs does
 * (docs/ad-landing-pages.md). Two findings, on two pages.
 */
export const autumnSite: Transport = (url) =>
  url.pathname === "/old-menu"
    ? answer(404, { "content-type": "text/plain" })
    : url.pathname === "/gift-cards"
      ? answer(301, { location: "/shop/gift-cards" })
      : answer(200);

const SITES = fileURLToPath(new URL("../../../../fixtures/sites/", import.meta.url));

interface Route {
  status?: number;
  location?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A fixture site (packages/fixtures/sites/<name>) answering like its server does, for the pages and
 * routes.json entries it holds, with no socket and whatever host name the export uses. Only what
 * the ads fixtures need: files (.html), routes with a status, a location, headers and a body.
 */
export function fixtureTransport(
  name: string,
  seen?: { method: string; url: string }[],
): Transport {
  const root = join(SITES, name);
  const routes: Record<string, Route> = existsSync(join(root, "routes.json"))
    ? (JSON.parse(readFileSync(join(root, "routes.json"), "utf8")) as Record<string, Route>)
    : {};
  const fileFor = (path: string): string | undefined => {
    const candidates = path.endsWith("/") ? [`${path}index.html`] : [path, `${path}.html`];
    return candidates.map((c) => join(root, c)).find((f) => existsSync(f) && statSync(f).isFile());
  };
  return (url, req) => {
    seen?.push({ method: req.method, url: url.href });
    const route = routes[url.pathname];
    const headers = {
      ...(route?.location ? { location: route.location } : {}),
      ...(route?.headers ?? {}),
    };
    if (route?.body !== undefined || (route?.status !== undefined && route.status >= 300))
      return answer(
        route.status ?? 200,
        { "content-type": "text/plain", ...headers },
        route.body ?? "",
      );
    const file = fileFor(url.pathname);
    if (!file)
      return answer(
        route?.status ?? 404,
        { "content-type": "text/plain", ...headers },
        "not found",
      );
    return answer(route?.status ?? 200, headers, readFileSync(file, "utf8"));
  };
}

/** Records every request it is asked for, then answers like okSite. */
export function recordingSite(): { transport: Transport; urls: string[]; methods: string[] } {
  const urls: string[] = [];
  const methods: string[] = [];
  return {
    urls,
    methods,
    transport: (url, req) => {
      urls.push(url.href);
      methods.push(req.method);
      return answer(200);
    },
  };
}
