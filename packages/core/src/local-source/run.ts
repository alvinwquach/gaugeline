import { indexingSwitchLoose } from "../checks/static/indexing-switch-loose.js";
import { noindexSmokeProduction } from "../checks/static/noindex-smoke-production.js";
import { pageRobotsOverridesLayout } from "../checks/static/page-robots-overrides-layout.js";
import { robotsDisallowHidesNoindex } from "../checks/static/robots-disallow-hides-noindex.js";
import { sitemapWhileIndexingOff } from "../checks/static/sitemap-while-indexing-off.js";
import { sanityCdnTaggedReads } from "../checks/static/sanity-cdn-tagged-reads.js";
import { webhookSignatureComparedPlainly } from "../checks/static/webhook-signature-compared-plainly.js";
import { webhookTimestampUnbounded } from "../checks/static/webhook-timestamp-unbounded.js";
import { revalidateTimeAndTagMixed } from "../checks/static/revalidate-time-and-tag-mixed.js";
import { webhookBodyReadUnsafely } from "../checks/static/webhook-body-read-unsafely.js";
import { webhookLogsPrivateValues } from "../checks/static/webhook-logs-private-values.js";
import { webhookMissingSecretStatus } from "../checks/static/webhook-missing-secret-status.js";
import { CheckRegistry, type Check } from "../model.js";
import { buildResult, type Result } from "../result.js";
import { runChecks } from "../run.js";
import { cmsTokenInClientCode } from "../checks/static/cms-token-in-client-code.js";
import { formValuesInLogs } from "../checks/static/form-values-in-logs.js";
import { personalDataInAnalytics } from "../checks/static/personal-data-in-analytics.js";
import { webhookUrlHardcoded } from "../checks/static/webhook-url-hardcoded.js";
import type { SkipReason, SourceTree } from "./read.js";

/**
 * The static check pack (batch FF): checks that read a repository's files, not a site. A static
 * check makes no request (CLAUDE.md rule 6) and runs no code; it gets the text of the files the
 * local source reader (read.ts) kept, and says what it finds in them. Plain rules (rule 7): the same
 * files give the same findings.
 *
 * The input is `LocalSourceInput`, its own kind. A page check is handed a page, a plan check a
 * plan, a static check a SourceTree; the registry below holds only static checks, so a page run can
 * never reach one and one of these can never be handed a page.
 *
 * To add a static check: write it with `defineCheck<LocalSourceInput>` under checks/static/, add it
 * to `STATIC_CHECKS` here. The four lists that name every pack (cli builtin-ids.ts, core index.ts,
 * scripts/gen-checks.ts and scripts/lib/catalogue-ids.ts) already include that array. The checks
 * reference, the id lock and the "Since" badge are then generated from the check itself.
 *
 * What a static check must do about "not sure": a file it needs that is absent or was not read
 * (`staticFile`) is `ctx.couldNotCheck(...)`, never a pass and never a finding. `runStaticChecks`
 * adds the one rule that needs no check's help: a folder the reader could not finish never passes a
 * check.
 */
export interface LocalSourceInput {
  kind: "local-source";
  tree: SourceTree;
}

/** What a check can say about a file it needs: its text, that it was not read (and why), or that it is not there. */
export type StaticFile =
  { state: "read"; text: string } | { state: "skipped"; reason: SkipReason } | { state: "absent" };

/** Looks one file up by its path under the folder (`package.json`, `app/layout.tsx`). */
export function staticFile(input: LocalSourceInput, path: string): StaticFile {
  const text = input.tree.files.get(path);
  if (text !== undefined) return { state: "read", text };
  const reason = input.tree.skipped.get(path);
  return reason === undefined ? { state: "absent" } : { state: "skipped", reason };
}

/** Every static check, in the order the report lists them. */
export const STATIC_CHECKS: readonly Check<LocalSourceInput>[] = [
  pageRobotsOverridesLayout,
  sitemapWhileIndexingOff,
  robotsDisallowHidesNoindex,
  indexingSwitchLoose,
  noindexSmokeProduction,
  webhookMissingSecretStatus,
  sanityCdnTaggedReads,
  cmsTokenInClientCode,
  webhookUrlHardcoded,
  webhookSignatureComparedPlainly,
  webhookTimestampUnbounded,
  personalDataInAnalytics,
  formValuesInLogs,
  webhookBodyReadUnsafely,
  webhookLogsPrivateValues,
  revalidateTimeAndTagMixed,
];

export function createStaticRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of STATIC_CHECKS) registry.register(c);
  return registry;
}

/**
 * Runs the static checks on a folder's tree. `registry` defaults to the whole pack (tests pass their
 * own). The result's address is `source:<folder as typed>`.
 */
export async function runStaticChecks(options: {
  tree: SourceTree;
  now: Date;
  registry?: CheckRegistry;
  only?: readonly string[];
  skip?: readonly string[];
}): Promise<Result> {
  const { tree } = options;
  const input: LocalSourceInput = { kind: "local-source", tree };
  const url = `source:${tree.label}`;
  const ran = await runChecks(input, options.registry ?? createStaticRegistry(), {
    ...(options.only === undefined ? {} : { only: options.only }),
    ...(options.skip === undefined ? {} : { skip: options.skip }),
  });
  // A check that found nothing in a folder that was only partly read has not passed: what it did
  // not read may hold the problem. It is unsure, with Gaugeline's reason.
  const passed = tree.truncated ? [] : ran.passed;
  const unsure = tree.truncated
    ? ran.passed.map((id) => ({
        id,
        reason:
          "the folder has more files than Gaugeline reads, so it cannot say nothing is wrong in the files it left out",
        url,
      }))
    : [];
  return buildResult({
    url,
    startedAt: options.now,
    findings: ran.findings,
    passed,
    failed: ran.failed.map((f) => f.id),
    couldNotCheck: [...ran.couldNotCheck, ...unsure],
  });
}
