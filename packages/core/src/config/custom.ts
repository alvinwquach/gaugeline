import type { Check, CheckContext, Finding } from "../model.js";
import { SEVERITIES } from "../model.js";

/**
 * A check you wrote is given a smaller context than a built-in: the run's `get` (GET and HEAD only,
 * through the same fetcher guard), `warn`, `couldNotCheck` and the clock. No `query` (the one POST
 * path, for adapters), no consent value, no site readers or registry. Rule 14 still applies to what
 * it asks for: a check that requests non-public paths is a probing check, for sites you own.
 */
export type CustomCheckContext = Pick<CheckContext, "warn" | "couldNotCheck" | "now"> & {
  fetcher?: { get: NonNullable<CheckContext["fetcher"]>["get"] };
};

/** Path segments that are not public pages: a dot segment (not .well-known) or an admin area. */
const ADMIN_SEGMENT = /^(?:admin|administrator|wp-admin|wp-login\.php|phpmyadmin)$/i;
/** Headers that carry a site's keys: using one against the site's own API is a probing request. */
const KEY_HEADER =
  /^(?:authorization|proxy-authorization|cookie|apikey|api-key)$|auth|token|secret|key/i;

/**
 * Why a request is a probing request (CLAUDE.md rule 14), or undefined when it is not. There is no
 * shared list in core: the built-in probing checks each name their own routes, so this is the one place
 * for custom checks. Dot segments and the usual admin areas; a caller-set key or auth header.
 */
export function probingReason(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
): string | undefined {
  let pathname: string | undefined;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = undefined;
  }
  if (pathname !== undefined) {
    for (const segment of pathname.split("/")) {
      if (segment.startsWith(".") && segment !== ".well-known")
        return `${pathname} is not a public page (a path starting with a dot)`;
      if (ADMIN_SEGMENT.test(segment)) return `${pathname} is an admin path`;
    }
  }
  const header = Object.keys(headers ?? {}).find((h) => KEY_HEADER.test(h));
  if (header !== undefined)
    return `the header ${header} carries a key: using a site's keys against it is probing`;
  return undefined;
}

/** Wrap a validated custom check: the smaller context in, and its findings checked on the way out. */
export function sandboxCustomCheck(check: Check<unknown>): Check<unknown> {
  return Object.freeze({
    ...check,
    async run(input: unknown, ctx: CheckContext): Promise<Finding[]> {
      const fetcher = ctx.fetcher;
      const limited: CustomCheckContext = {
        warn: (m) => ctx.warn(m),
        ...(ctx.couldNotCheck ? { couldNotCheck: ctx.couldNotCheck } : {}),
        ...(ctx.now ? { now: ctx.now } : {}),
        ...(fetcher
          ? {
              fetcher: {
                get: (url, opts) => {
                  // Without the owner's consent a custom check is held to what a visitor could ask for.
                  const reason = ctx.ownerConsent ? undefined : probingReason(url, opts?.headers);
                  if (reason !== undefined)
                    throw new Error(
                      `Custom check "${check.id}" asked for a request that is a probing request: ${reason}. Probing runs only with --owner-consent, on sites you own or have permission to test.`,
                    );
                  return fetcher.get(url, opts);
                },
              },
            }
          : {}),
      };
      const found = await check.run(input, limited as CheckContext);
      if (!Array.isArray(found)) return found as never;
      for (const f of found) {
        if (f.checkId !== check.id)
          throw new TypeError(
            `Custom check "${check.id}" returned a finding for "${String(f.checkId)}": a check reports its own id only.`,
          );
        if (!(SEVERITIES as readonly string[]).includes(f.severity))
          throw new TypeError(
            `Custom check "${check.id}" returned the severity "${String(f.severity)}": use high, medium or low.`,
          );
      }
      return found;
    },
  });
}
