import { isIP } from "node:net";
import { FetchError, type Fetcher } from "../fetcher.js";
import { classifyAddress } from "../net/address-policy.js";
import { Semaphore } from "../semaphore.js";
import { systemResolver, type Resolver } from "../transport.js";
import { parsePageSpeed, PageSpeedError, type PageSpeedAnswer } from "./vitals.js";

/**
 * Google's PageSpeed Insights, for the pages a run covers (PERF-01, `--pagespeed`). One GET per page to the one
 * host below, through the fetcher, and nothing else is ever asked of Google: no POST, no other host.
 *
 *   GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed?url=<page>&strategy=MOBILE&category=PERFORMANCE
 *
 * The answer holds a Lighthouse run on Google's servers (lab data) and, when the page has enough visitors, the
 * Chrome UX Report's real-user data for the address and its site (field data). That is why no request goes to the
 * Chrome UX Report API itself: its only method, `records:queryRecord`, is a POST that wants a key, and the key's
 * documented place is the address (decision 53 allows no key there). See docs/adr/0015-pagespeed-and-crux.md.
 *
 * Keyless. The key is never read, so it cannot reach an address, a log, a finding or a report. Without one the
 * quota is shared with every other keyless caller, and Google answers 429 when it is used up: that is
 * could-not-check, with the reason, never a pass.
 */
export const PAGESPEED_ORIGIN = "https://pagespeedonline.googleapis.com";

/** The registered list of hosts this feature may contact (ADR-0015). A test asserts nothing else is asked. */
export const PAGESPEED_HOSTS: readonly string[] = Object.freeze(["pagespeedonline.googleapis.com"]);

/** The pages one run sends to Google: the checked page and the first same-site pages of the run's sample. */
export const PAGESPEED_PAGE_CAP = 5;

/** A run takes Google a whole page load; the fetcher's 10 seconds is not enough. */
const WAIT_MS = 90_000;

export type PageSpeedReading =
  { ok: true; answer: PageSpeedAnswer } | { ok: false; reason: string };

export interface PageSpeed {
  /** One GET per address, shared by every check that asks. Never throws. */
  read(url: string): Promise<PageSpeedReading>;
}

/** Last labels that never name a public site: reserved (RFC 2606, 6761, 8375), local-use and internal ones. */
const RESERVED_LAST_LABELS = new Set([
  "test",
  "example",
  "invalid",
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "private",
  "lan",
  "home",
  "corp",
  "onion",
  "arpa",
  // Not in the public root: names a company or a router makes up for itself.
  "staging",
  "stage",
  "box",
  "router",
  "domain",
  "workgroup",
  "svc",
  "cluster",
]);

/** The reserved example domains (RFC 2606): `example.com` and its subdomains are never a real site. */
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

/** Services that answer any name with the address written inside it, so a name can point at a private one. */
const WILDCARD_DNS = [
  "nip.io",
  "sslip.io",
  "xip.io",
  "traefik.me",
  "localtest.me",
  "lvh.me",
  "localhost.run",
];

const underDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/** A path segment that looks like it carries a secret: a long token, or a word that says so. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,}$/;
const SECRET_WORDS = /token|key|secret|reset|invite|session|password|passwd|auth/i;

/** Why a name is not a public site's, or undefined when its spelling is fine (what it resolves to is checked later). */
function nameProblem(host: string): string | undefined {
  if (host === "" || host.startsWith("[") || isIP(host) !== 0)
    return "an address written as numbers is not a public site's name";
  const labels = host.split(".");
  if (labels.length < 2) return "a name with no dot is not a public site's";
  if (RESERVED_LAST_LABELS.has(labels.at(-1) ?? ""))
    return "its last part is reserved or for private use";
  if (RESERVED_DOMAINS.some((d) => underDomain(host, d))) return "it is a reserved example domain";
  if (WILDCARD_DNS.some((d) => underDomain(host, d)))
    return "it is a wildcard name service, which can point anywhere";
  return undefined;
}

/** Why a path may not be sent, or undefined. Only a path that is clearly not a secret goes out. */
function pathProblem(pathname: string): string | undefined {
  if (/%(?:3f|23|3d|3b)/i.test(pathname))
    return "its path holds an encoded query or parameter mark";
  for (const raw of pathname.split("/")) {
    const segment = raw.split(";")[0] ?? "";
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return "its path is not readable";
    }
    if (TOKEN_SHAPE.test(decoded) || SECRET_WORDS.test(decoded) || decoded.includes("="))
      return "a part of its path looks like it carries a secret";
  }
  return undefined;
}

/**
 * The address that may leave: a public page's origin and path, with no query string, fragment, user name or
 * path parameter (`;jsessionid=...`). Google reads only the public web, so a loopback or private address, an
 * address typed as numbers, a name with no dot or a reserved or private-use name (a trailing dot is dropped
 * first) is never sent: it would fail there and tell Google the name of something internal. A path with a part
 * that looks like a token, a reset or invite link or a session is not sent either. What a name resolves to is
 * checked by the reader before the address is sent.
 */
export function sendableAddress(
  input: string,
  opts: { reservedNamesAllowed?: boolean } = {},
): { ok: true; url: string } | { ok: false; reason: string } {
  const refuse = (why: string) => ({
    ok: false as const,
    reason: `PageSpeed Insights reads only public pages, and this address was not sent to Google: ${why}.`,
  });
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return refuse("it could not be read");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return refuse("it is not a web address");
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  const name = nameProblem(host);
  // The reserved names are allowed only where the sites in the tests are invented with them.
  if (name !== undefined && !(opts.reservedNamesAllowed && isInventedName(host)))
    return refuse(name);
  const path = pathProblem(u.pathname);
  if (path !== undefined) return refuse(path);
  const clean = u.pathname
    .split("/")
    .map((segment) => segment.split(";")[0] ?? "")
    .join("/");
  return { ok: true, url: `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}${clean}` };
}

/** Test sites are invented under `.example`, `.test` and `.invalid`, which a real run never sends. */
const isInventedName = (host: string): boolean =>
  ["example", "test"].includes(host.split(".").at(-1) ?? "") && !isIP(host);

const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export interface PageSpeedOptions {
  /** Turns a name into addresses; every answer must be public. Default: the system's. Tests inject one. */
  resolver?: Resolver;
  /** The run allows private addresses (--allow-private): nothing is sent to Google at all. */
  allowPrivate?: boolean;
  /** Tests only: let an invented `.example` or `.test` name through the spelling rules (the sites are invented). */
  reservedNamesAllowed?: boolean;
}

/** Calls to Google go one at a time, so slow answers hold one of the fetcher's slots and never all of them. */
const CALLS_AT_ONCE = 1;

export function createPageSpeed(fetcher: Fetcher, options: PageSpeedOptions = {}): PageSpeed {
  const reads = new Map<string, Promise<PageSpeedReading>>();
  const resolve = options.resolver ?? systemResolver;
  const line = new Semaphore(CALLS_AT_ONCE);
  const notSent = (why: string): PageSpeedReading => ({
    ok: false,
    reason: `PageSpeed Insights reads only public pages, and this address was not sent to Google: ${why}.`,
  });
  /** Every address the name resolves to must be public; no answer, or an error, is a refusal. */
  async function resolvesPublic(host: string): Promise<boolean> {
    try {
      const found = await resolve(host);
      return found.length > 0 && found.every((a) => classifyAddress(a.address) === "public");
    } catch {
      return false;
    }
  }
  async function ask(page: string): Promise<PageSpeedReading> {
    const params = new URLSearchParams({ url: page, strategy: "MOBILE", category: "PERFORMANCE" });
    let last;
    try {
      last = (
        await line.run(() =>
          fetcher.get(`${PAGESPEED_ORIGIN}/pagespeedonline/v5/runPagespeed?${params}`, {
            timeoutMs: WAIT_MS,
            maxRedirects: 0,
          }),
        )
      ).at(-1);
    } catch (err) {
      if (err instanceof FetchError && err.reason === "timeout")
        return {
          ok: false,
          reason: "PageSpeed Insights did not answer in time, so the page was not judged.",
        };
      return { ok: false, reason: "PageSpeed Insights could not be reached." };
    }
    if (!last) return { ok: false, reason: "PageSpeed Insights gave no answer." };
    if (last.status === 429)
      return {
        ok: false,
        reason:
          "PageSpeed Insights answered that its quota is used up (HTTP 429). Gaugeline sends no key, so the quota is shared with every other keyless caller; try again later.",
      };
    if (last.status === 400)
      return {
        ok: false,
        reason:
          "PageSpeed Insights could not load this page (HTTP 400): it may be unreachable from Google's servers, or not a page.",
      };
    if (last.status < 200 || last.status >= 300)
      return { ok: false, reason: `PageSpeed Insights answered HTTP ${last.status}.` };
    if (last.truncated)
      return { ok: false, reason: "PageSpeed Insights' answer was larger than Gaugeline reads." };
    const json = parseBody(last.body ?? "");
    try {
      return { ok: true, answer: parsePageSpeed(json) };
    } catch (err) {
      if (err instanceof PageSpeedError)
        return { ok: false, reason: "PageSpeed Insights' answer was not a result." };
      throw err;
    }
  }
  async function check(sendable: string): Promise<PageSpeedReading> {
    if (!(await resolvesPublic(new URL(sendable).hostname)))
      return notSent("its name does not resolve to a public address");
    return ask(sendable);
  }
  return {
    read(url) {
      if (options.allowPrivate)
        return Promise.resolve(
          notSent(
            "this run allows private addresses (--allow-private), so nothing is sent to Google",
          ),
        );
      const sendable = sendableAddress(url, {
        ...(options.reservedNamesAllowed ? { reservedNamesAllowed: true } : {}),
      });
      if (!sendable.ok) return Promise.resolve({ ok: false, reason: sendable.reason });
      let pending = reads.get(sendable.url);
      if (!pending) {
        pending = check(sendable.url);
        reads.set(sendable.url, pending);
      }
      return pending;
    },
  };
}
