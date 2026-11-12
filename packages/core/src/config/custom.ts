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
        ...(fetcher ? { fetcher: { get: (url, opts) => fetcher.get(url, opts) } } : {}),
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
