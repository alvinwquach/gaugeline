import { NetworkError } from "../errors.js";
import { FetchError, type Fetcher, type Hop } from "../fetcher.js";
import type { CheckContext } from "../model.js";

/** What one GET answered: every hop, or the reason there was no answer. */
export type Asked = { hops: Hop[] } | { none: string };

/**
 * One GET through the run's fetcher (never a POST). A refusal, an error status or a network
 * failure is not a finding: the caller gets the hops that came back, or the reason there were none.
 */
const memo = new WeakMap<Fetcher, Map<string, Promise<Asked>>>();

/** `ask`, once per run and address: every page of a run shares one request for a back-end address. */
export function askOnce(
  ctx: CheckContext,
  url: string,
  headers?: Record<string, string>,
): Promise<Asked> {
  if (!ctx.fetcher) return ask(ctx, url, headers);
  let m = memo.get(ctx.fetcher);
  if (!m) memo.set(ctx.fetcher, (m = new Map()));
  let hit = m.get(url);
  if (!hit) m.set(url, (hit = ask(ctx, url, headers)));
  return hit;
}

export async function ask(
  ctx: CheckContext,
  url: string,
  headers?: Record<string, string>,
): Promise<Asked> {
  if (!ctx.fetcher) return { none: "no fetcher" };
  try {
    const hops = await ctx.fetcher.get(url, headers ? { headers } : {});
    return hops.length > 0 ? { hops } : { none: "no answer" };
  } catch (err) {
    if (err instanceof FetchError && err.hops.length > 0) return { hops: err.hops };
    if (err instanceof NetworkError) return { none: err.message };
    throw err;
  }
}

export const NO_CONSENT_INTROSPECTION =
  "this check asks the site's GraphQL endpoint whether it answers an introspection query, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const NO_CONSENT_PREVIEW =
  "this check opens the preview addresses the page links to, with no login, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";
