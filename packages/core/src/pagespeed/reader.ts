import { isIP } from "node:net";
import { FetchError, type Fetcher } from "../fetcher.js";
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

const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"];

/**
 * The address that may leave: a public page's origin and path, with no query string, no fragment and no user
 * name (any of them can carry a token). Google reads only the public web, so a loopback or private address, an
 * address typed as numbers and a name with no dot are not sent: they would fail there and tell Google the name
 * of something internal.
 */
export function sendableAddress(
  input: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "The address could not be read, so it was not sent to Google." };
  }
  const host = u.hostname.toLowerCase();
  const refuse = {
    ok: false as const,
    reason:
      "PageSpeed Insights reads only public pages, and this address is not one, so it was not sent to Google.",
  };
  if (u.protocol !== "https:" && u.protocol !== "http:") return refuse;
  if (host.startsWith("[") || isIP(host) !== 0) return refuse;
  if (host === "localhost" || !host.includes(".")) return refuse;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return refuse;
  return { ok: true, url: `${u.origin}${u.pathname}` };
}

const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function createPageSpeed(fetcher: Fetcher): PageSpeed {
  const reads = new Map<string, Promise<PageSpeedReading>>();
  async function ask(page: string): Promise<PageSpeedReading> {
    const params = new URLSearchParams({ url: page, strategy: "MOBILE", category: "PERFORMANCE" });
    let last;
    try {
      last = (
        await fetcher.get(`${PAGESPEED_ORIGIN}/pagespeedonline/v5/runPagespeed?${params}`, {
          timeoutMs: WAIT_MS,
          maxRedirects: 0,
        })
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
  return {
    read(url) {
      const sendable = sendableAddress(url);
      if (!sendable.ok) return Promise.resolve({ ok: false, reason: sendable.reason });
      let pending = reads.get(sendable.url);
      if (!pending) {
        pending = ask(sendable.url);
        reads.set(sendable.url, pending);
      }
      return pending;
    },
  };
}
