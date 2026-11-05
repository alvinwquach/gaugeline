import { ConfigError } from "./errors.js";
import type { CheckContext, CheckRegistry, Finding } from "./model.js";
import { SEVERITY_ORDER } from "./model.js";
import { runCheckList } from "./runner.js";

export interface RunOptions {
  /** Run only these check ids. */
  only?: readonly string[];
  /** Skip these check ids. */
  skip?: readonly string[];
  ctx?: Partial<CheckContext>;
}

export interface RunResult {
  /** High, then medium, then low; within a severity, in registration order. */
  findings: Finding[];
  passed: string[];
  failed: { id: string; error: string }[];
  warnings: string[];
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
  const out = await runCheckList(selected, input, opts.ctx);
  const findings = out.findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] ||
        (order.get(a.f.checkId) ?? 0) - (order.get(b.f.checkId) ?? 0) ||
        a.i - b.i,
    )
    .map(({ f }) => f);
  return { findings, passed: out.passed, failed: out.failures, warnings: out.warnings };
}
