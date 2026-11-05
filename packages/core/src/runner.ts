import type { Check, CheckContext, Finding } from "./model.js";
import { redact } from "./redact.js";

export interface RunOutcome {
  findings: Finding[];
  /** Check ids that ran and found nothing. */
  passed: string[];
  /** Check ids that threw. The run continues without them. */
  failed: string[];
  /** The same failures, with the (redacted) reason. */
  failures: { id: string; error: string }[];
  /** Developer notes, for the caller to print where it chooses. */
  warnings: string[];
}

/** Clean a finding before it leaves core: redact secrets from every text field. */
export function sanitiseFinding(f: Finding): Finding {
  const out: Finding = {
    ...f,
    title: redact(f.title),
    evidence: redact(f.evidence),
    url: redact(f.url),
  };
  if (f.source) out.source = { ...f.source };
  return out;
}

/** Runs each check once, in order. A check that throws is recorded in failed; the rest still run. */
export async function runCheckList<I>(
  checks: readonly Check<I>[],
  input: I,
  baseCtx: Partial<CheckContext> = {},
): Promise<RunOutcome> {
  const result: RunOutcome = { findings: [], passed: [], failed: [], failures: [], warnings: [] };
  const ctx: CheckContext = {
    ...baseCtx,
    warn: (message) => {
      result.warnings.push(message);
      baseCtx.warn?.(message);
    },
  };
  for (const check of checks) {
    let found: Finding[] | undefined;
    try {
      found = (await check.run(input, ctx)) as Finding[] | undefined;
    } catch (err) {
      result.failed.push(check.id);
      const reason = err instanceof Error ? err.message : String(err);
      result.failures.push({ id: check.id, error: redact(reason) });
      ctx.warn(`Check "${check.id}" failed to run: ${redact(reason)}`);
      continue;
    }
    if (found === undefined || found === null) {
      ctx.warn(
        `Check "${check.id}" returned ${String(found)} instead of an array; treated as no findings.`,
      );
      found = [];
    }
    if (found.length === 0) result.passed.push(check.id);
    else result.findings.push(...found.map(sanitiseFinding));
  }
  return result;
}
