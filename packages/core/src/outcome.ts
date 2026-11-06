import type { GaugelineError } from "./errors.js";

export type Outcome =
  | {
      kind: "ran";
      highFindings: number;
      drift: boolean;
      /** Something planned could not be read (a page that asked for a password): exit 2. */
      incomplete?: boolean;
    }
  | { kind: "could-not-run"; error: GaugelineError };

/**
 * The one place an outcome becomes an exit code, for every command.
 * 0 ran; 1 --ci with a "Fix this first" finding or plan drift; 2 could not run, or ran without
 * reading everything it was asked to (a plan page behind a password).
 */
export function exitCodeFor(outcome: Outcome, opts: { ci: boolean }): 0 | 1 | 2 {
  switch (outcome.kind) {
    case "could-not-run":
      return 2;
    case "ran":
      if (outcome.incomplete) return 2;
      return opts.ci && (outcome.highFindings > 0 || outcome.drift) ? 1 : 0;
    default: {
      const never: never = outcome;
      return never;
    }
  }
}
