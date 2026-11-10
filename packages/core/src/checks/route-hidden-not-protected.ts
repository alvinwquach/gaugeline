import { CheckRegistry, defineCheck, type Check, type Finding } from "../model.js";
import { LIMITS } from "../limits.js";
import type { RouteEntry } from "../routes/discover.js";
import type { RouteAnswer, SkippedRoute } from "../routes/probe.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/** What the check reads: the routes found in the repository and what the running site answered for each. */
export interface RoutesInput {
  routes: readonly RouteEntry[];
  /** What each probed route answered, by path. A route with no entry was not asked. */
  answers: ReadonlyMap<string, RouteAnswer>;
  /** The routes that expect a session and were not asked, with the reason. */
  skipped: readonly SkippedRoute[];
  /** The running site's address: findings name the address that was asked. */
  base: string;
  /** The folder as it was typed, put before each file so a line reads as a path from where the command ran. */
  prefix?: string;
  /** The owner agreed to probing checks (--owner-consent or gaugeline.consent.json). Without it nothing is asked. */
  ownerConsent: boolean;
}

/** Why a run without consent did not ask. Reads after "could not be checked:". */
export const NO_ROUTES_CONSENT_REASON =
  "this check asks signed-in routes for their page with no session, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const ROUTE_TITLE = "A page that should need a session is handed to anyone";

const count = (n: number): string => n.toLocaleString("en-US");

function sizeOf(a: RouteAnswer): string {
  const known = a.contentLength ?? a.bytes ?? 0;
  if (a.capped === true && a.contentLength === undefined)
    return `at least ${count(a.bytes ?? 0)} bytes`;
  return `${count(known)} byte${known === 1 ? "" : "s"}`;
}

const shown = (prefix: string | undefined, file: string): string =>
  escapeInvisible(prefix ? `${prefix}/${file}` : file, 160);

function addressOf(base: string, path: string): string {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${prefix}${path === "/" && prefix !== "" ? "" : path}`;
}

export const routeHiddenNotProtected = defineCheck<RoutesInput>({
  id: "route-hidden-not-protected",
  area: "Security & email",
  severity: "high",
  title: ROUTE_TITLE,
  what: "A route your code treats as signed-in only returns its page when asked with no session.",
  why: "A route that is missing from the navigation is not a protected route. If the page answers a stranger, anyone who guesses or finds the address (a search engine, a shared link, a guess at /account) can read what a signed-in customer would see: invoices, bookings, names.",
  fix: "Check the session inside the page or the route handler, before it renders or reads anything, and answer 401, 403 or a redirect to sign in when there is none. A middleware matcher that does not list the route does not protect it, so add the route to the matcher or check in the page itself.",
  tech: `probing check, off without --owner-consent: discoverRoutes reads the Next.js app directory (every page and route file is a path, route groups in parentheses are dropped, a bracketed segment is dynamic); a route expects a session when a middleware that looks like a gate has a matcher covering it, or its own file or a layout above it calls auth, getServerSession, cookies or currentUser (the root layout aside); only routes that expect a session and are not dynamic are asked, at most ${LIMITS.routeProbes}, in sorted order, at most ${LIMITS.concurrency} at once, each with one anonymous GET (no cookie, no Authorization, no Referer, no query string, redirects not followed); the body is read up to ${count(LIMITS.routeProbeBytes)} bytes to tell a sign-in form (a password field) from a page and is never kept; 401 and 403 are refused, 404 is not found, a redirect to another address is a redirect to sign in, 200 without a sign-in form is handed over (high, or low when the body is empty), anything else is could not check; the routes held in an array in path order and the answers in a Map from path to answer, since answers arrive out of order`,
  run(input, ctx) {
    if (input.ownerConsent !== true) {
      ctx.couldNotCheck?.(input.base, NO_ROUTES_CONSENT_REASON);
      return [];
    }
    for (const s of input.skipped)
      ctx.couldNotCheck?.(escapeInvisible(s.path, 120), `not probed: ${s.reason}`);
    const findings: Finding[] = [];
    for (const route of input.routes) {
      const answer = input.answers.get(route.path);
      if (!answer) continue;
      const path = escapeInvisible(route.path, 120);
      const file = shown(input.prefix, route.file);
      if (answer.result === "error") {
        ctx.couldNotCheck?.(path, answer.note ?? "the route did not answer");
        continue;
      }
      if (answer.result !== "handed-over") continue;
      const expects = escapeInvisible(route.reason ?? "its code expects a session", 200);
      const url = addressOf(input.base, route.path);
      if (answer.empty === true) {
        findings.push({
          checkId: "route-hidden-not-protected",
          severity: "low",
          title: `${path} responds with nothing`,
          evidence: `${path} answered ${answer.status ?? 200} with an empty body to a request with no session. Your code expects a session here (${expects}), so an empty answer may be a half-built route or a handler that returns before it checks. File: ${file}.`,
          url,
        });
        continue;
      }
      findings.push({
        checkId: "route-hidden-not-protected",
        severity: "high",
        title: `${path} is handed over with no session`,
        evidence: `${path} answered ${answer.status ?? 200} with ${sizeOf(answer)} to a request with no session, no cookie and no token. Your code expects a session here (${expects}). File: ${file}.`,
        url,
      });
    }
    return findings;
  },
});

/** The check `gaugeline check <folder> --routes --base <address>` runs. */
export const ROUTE_CHECKS: readonly Check<RoutesInput>[] = [routeHiddenNotProtected];

/** `--routes` is its own run: the one check above. */
export function createRoutesRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of ROUTE_CHECKS) registry.register(c);
  return registry;
}
