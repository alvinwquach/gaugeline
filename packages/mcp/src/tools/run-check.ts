import * as z from "zod";
import { EMAIL_PRESET, PROBING_CHECKS, checkSite, createPageRegistry } from "@gaugeline/core";
import { ToolError, remember, type ToolContext } from "../state.js";
import { findingsForAgent, urlSchema } from "./shared.js";

export const runCheckInput = {
  url: urlSchema.describe("The page to check, as a full http or https address."),
  checks: z
    .array(z.string().min(1).max(80))
    .max(60)
    .optional()
    .describe("Check ids to run. Omit to run the default set. See list_checks for the ids."),
  flags: z
    .object({
      skip: z
        .array(z.string().min(1).max(80))
        .max(100)
        .optional()
        .describe("Check ids to leave out."),
    })
    .strict()
    .optional()
    .describe(
      "The CLI flags that are safe to pass from an assistant. Flags that read a config file or a credential are not offered.",
    ),
  ownerConsent: z
    .boolean()
    .default(false)
    .describe(
      "Probing checks ask for non-public paths. They run only when this is true, set by the person who owns the site, for this call only. Never infer it.",
    ),
};

/** The checks Gaugeline lists as could-not-run when DNS is off (this server never reads DNS). */
/** The page as served, kept only if it is HTML and small enough to build a patch against. */
function pageOf(snapshot: { finalUrl: string; hops: { body?: string; truncated?: boolean }[] }) {
  const last = snapshot.hops.at(-1);
  return last?.body !== undefined && last.truncated !== true && last.body.length <= 512 * 1024
    ? { page: { url: snapshot.finalUrl, html: last.body } }
    : {};
}

export async function runCheck(args: z.infer<z.ZodObject<typeof runCheckInput>>, ctx: ToolContext) {
  const registry = createPageRegistry();
  const skip = args.flags?.skip ?? [];
  const unknown = [...(args.checks ?? []), ...skip].filter((id) => !registry.has(id));
  if (unknown.length > 0)
    throw new ToolError(`Unknown check id: ${[...new Set(unknown)].join(", ")}. See list_checks.`);
  const consent = args.ownerConsent === true;
  // A probing check asked for by id still needs consent: it is dropped here, and said so.
  const withheld = consent ? [] : (args.checks ?? []).filter((id) => PROBING_CHECKS.includes(id));
  const only = args.checks?.filter((id) => !withheld.includes(id));
  if (args.checks !== undefined && (only?.length ?? 0) === 0)
    throw new ToolError(
      `${withheld.join(", ")} ${withheld.length === 1 ? "is a probing check" : "are probing checks"} and run only when the site's owner passes ownerConsent: true. Nothing was requested.`,
    );
  const dnsOff = EMAIL_PRESET.filter((id) => registry.has(id));
  const startedAt = ctx.now();
  const { snapshot, result, budget } = await checkSite({
    address: args.url,
    fetcher: ctx.fetcherFor(args.url),
    registry,
    ...(only ? { only } : {}),
    skip: [...skip, ...dnsOff],
    ...(consent ? { ownerConsent: true } : {}),
    now: ctx.now,
  });
  const run = remember(ctx.state, {
    kind: "site",
    url: snapshot.requestedUrl,
    startedAt: startedAt.toISOString(),
    findings: result.findings,
    passed: result.passed,
    failed: [...result.failed.map((f) => f.id), ...dnsOff],
    couldNotCheck: result.couldNotCheck,
    registry,
    ...pageOf(snapshot),
  });
  const count = (s: string) => result.findings.filter((f) => f.severity === s).length;
  return {
    runId: run.id,
    kind: "read",
    url: run.url,
    summary: {
      high: count("high"),
      medium: count("medium"),
      low: count("low"),
      passed: result.passed.length,
      couldNotCheck: result.couldNotCheck.length,
    },
    ...findingsForAgent(run, ctx.maxFindings),
    couldNotCheck: result.couldNotCheck.map((c) => ({ id: c.id, reason: c.reason })),
    notRun: {
      dns: { ids: dnsOff, hint: "DNS checks are opt-in and this server does not read DNS." },
      ...(withheld.length > 0
        ? { probing: { ids: withheld, hint: "Needs ownerConsent: true on this call." } }
        : {}),
    },
    sampled: budget.summary(),
    probingConsent: consent,
  };
}
