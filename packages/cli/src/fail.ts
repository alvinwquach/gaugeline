import { CouldNotRunError, isGaugelineError, redact, type Outcome } from "@gaugeline/core";

const GENERIC = "Something went wrong inside Gaugeline.";

/** Remove query strings from any address in a one-line message, then redact what looks secret. */
function scrub(text: string): string {
  return redact(text.replace(/(https?:\/\/[^\s?#"']+)\?[^\s#"']*/g, "$1"));
}

function sentenceFor(err: unknown): { line: string; hint?: string } {
  if (isGaugelineError(err)) {
    return { line: scrub(err.message), ...(err.hint ? { hint: scrub(err.hint) } : {}) };
  }
  return {
    line: GENERIC,
    hint: "Run again with --verbose and include the output in a bug report.",
  };
}

function chain(err: unknown): string[] {
  const out: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 10; depth++) {
    if (current instanceof Error) {
      const text = current.stack ?? `${current.name}: ${current.message}`;
      out.push(depth === 0 ? scrubStack(text) : `Caused by: ${scrubStack(text)}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      out.push(`${depth === 0 ? "" : "Caused by: "}${scrub(String(current))}`);
      break;
    }
  }
  return out;
}

/** Stacks keep the full technical detail, minus query strings and secrets. */
function scrubStack(text: string): string {
  return scrub(text);
}

/**
 * Line 1: one plain sentence (no class names, no ENOTFOUND). Line 2: "Try: <hint>" when there is one.
 * With verbose: a blank line, then the stack and every cause. Writes nothing itself.
 */
export function formatError(err: unknown, opts: { verbose: boolean }): string {
  const { line, hint } = sentenceFor(err);
  const lines = [line];
  if (hint) lines.push(`Try: ${hint}`);
  if (opts.verbose) lines.push("", ...chain(err));
  return lines.join("\n");
}

/** Anything thrown becomes an outcome; unknown throwables are "something went wrong inside". */
export function toOutcome(err: unknown): Outcome {
  if (isGaugelineError(err)) return { kind: "could-not-run", error: err };
  return {
    kind: "could-not-run",
    error: new CouldNotRunError(GENERIC, { cause: err }),
  };
}
