import { ConfigError } from "./errors.js";
import type { CheckContext, CheckRegistry, Finding } from "./model.js";
import { SEVERITY_ORDER } from "./model.js";
import type { ProgressSink } from "./progress.js";
import type { BudgetKind, SampleCount } from "./limits.js";
import { runCheckList, type CouldNotCheck } from "./runner.js";

export interface RunOptions {
  /** Run only these check ids. */
  only?: readonly string[];
  /** Skip these check ids. */
  skip?: readonly string[];
  ctx?: Partial<CheckContext>;
  /** Receives warnings as they happen. Core never prints. */
  onProgress?: ProgressSink;
}

export interface RunResult {
  /** High, then medium, then low; within a severity, in registration order. */
  findings: Finding[];
  passed: string[];
  failed: { id: string; error: string }[];
  warnings: string[];
  /** Checks that could not read what they needed (a refusal), with the reason and the address. */
  couldNotCheck: CouldNotCheck[];
  /** How much of each kind was found and read (checkSite fills it from the run's budget). */
  sampled: Partial<Record<BudgetKind, SampleCount>>;
}

function unknownIds(ids: readonly string[] | undefined, registry: CheckRegistry): string[] {
  return (ids ?? []).filter((id) => !registry.has(id));
}

/** Run every registered check once against one input. A check that throws never stops the run. */
export async function runChecks<I>(
  input: I,
  registry: CheckRegistry,
  opts: RunOptions = {},
): Promise<RunResult> {
  const unknown = [...unknownIds(opts.only, registry), ...unknownIds(opts.skip, registry)];
  if (unknown.length > 0) {
    throw new ConfigError(`Unknown check id: ${unknown.join(", ")}.`, {
      hint: "See the checks reference for the list of ids.",
    });
  }
  const only = opts.only ? new Set(opts.only) : undefined;
  const skip = new Set(opts.skip ?? []);
  const all = registry.all();
  const order = new Map(all.map((c, i) => [c.id, i] as const));
  const selected = all.filter((c) => (only === undefined || only.has(c.id)) && !skip.has(c.id));
  const sink = opts.onProgress;
  const ctx: Partial<CheckContext> = {
    ...opts.ctx,
    warn: (message) => {
      opts.ctx?.warn?.(message);
      sink?.({ step: "warn", message });
    },
  };
  const out = await runCheckList(selected, input, ctx);
  const findings = out.findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] ||
        (order.get(a.f.checkId) ?? 0) - (order.get(b.f.checkId) ?? 0) ||
        a.i - b.i,
    )
    .map(({ f }) => f);
  return {
    findings,
    passed: out.passed,
    failed: out.failures,
    warnings: out.warnings,
    couldNotCheck: out.couldNotCheck,
    sampled: {},
  };
}
