import * as z from "zod";
import { EMAIL_PRESET, PROBING_CHECKS, checkSite, createPageRegistry } from "@gaugeline/core";
import { ToolError, probingAllowedFor, remember, type ToolContext } from "../state.js";
import { couldNotCheckForAgent, findingsForAgent, idToken, urlSchema } from "./shared.js";

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
    .optional()
    .describe(
      "Ignored. A tool call cannot turn on probing checks; only the person who started this server can, with --allow-probing and --probing-origin. Do not pass it.",
    ),
};

/** What the operator, not the caller, must do. Fixed text: no caller or page text is ever in it. */
const OPERATOR_MUST =
  "Probing checks run only if the operator (the person who runs this server) started it with --allow-probing and --probing-origin <this site's origin>; a tool call cannot turn them on.";
const OWNER_CONSENT_IGNORED =
  "ownerConsent has no effect: a tool call cannot turn on probing checks. Only the person who runs this server can, with --allow-probing and --probing-origin <the site's origin>.";

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
    throw new ToolError(
      `Unknown check id: ${[...new Set(unknown)].slice(0, 5).map(idToken).join(", ")}. See list_checks.`,
    );
  // Probing is the operator's decision (flag + origin list), never the caller's: ownerConsent is ignored.
  const consent = probingAllowedFor(ctx.options, args.url);
  const ignored =
    args.ownerConsent === undefined ? {} : { ownerConsentIgnored: OWNER_CONSENT_IGNORED };
  // A probing check asked for by id still needs the grant: it is dropped here, and said so.
  const withheld = consent ? [] : (args.checks ?? []).filter((id) => PROBING_CHECKS.includes(id));
  const only = args.checks?.filter((id) => !withheld.includes(id));
  if (args.checks !== undefined && (only?.length ?? 0) === 0)
    throw new ToolError(
      `${withheld.join(", ")} ${withheld.length === 1 ? "is a probing check" : "are probing checks"}. ${OPERATOR_MUST} Nothing was requested.`,
    );
  const dnsOff = EMAIL_PRESET.filter((id) => registry.has(id));
  const startedAt = ctx.now();
  const { snapshot, result, budget, unreachable } = await checkSite({
    tolerateUnreachable: true,
    address: args.url,
    // With probing on, every request of the call stays on the origin the operator named: a redirect to
    // another origin is not followed, so the grant cannot reach a site the operator did not list.
    fetcher: ctx.fetcherFor(args.url, consent ? new URL(args.url).origin : undefined),
    registry,
    ...(only ? { only } : {}),
    skip: [...skip, ...dnsOff],
    ...(consent ? { ownerConsent: true } : {}),
    now: ctx.now,
  });
  // A page that cannot be read (a refused redirect, a name that does not answer) is a could-not-check
  // entry, not a failed call: the reason is labelled, and no checks are run over a page that is not there.
  if (unreachable !== undefined)
    return {
      kind: "read",
      url: args.url,
      summary: { high: 0, medium: 0, low: 0, passed: 0, couldNotCheck: 1 },
      findings: [],
      ...couldNotCheckForAgent([{ id: "page", reason: unreachable }]),
      probingConsent: consent,
      ...ignored,
    };
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
    ...couldNotCheckForAgent(result.couldNotCheck),
    notRun: {
      dns: { ids: dnsOff, hint: "DNS checks are opt-in and this server does not read DNS." },
      ...(withheld.length > 0 ? { probing: { ids: withheld, hint: OPERATOR_MUST } } : {}),
    },
    sampled: budget.summary(),
    probingConsent: consent,
    ...ignored,
  };
}
