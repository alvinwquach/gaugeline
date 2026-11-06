import { emitKeypressEvents } from "node:readline";
import { parseResult, type CheckRegistry, type Result } from "@gaugeline/core";
import { formatTerminal } from "../reporter.js";
import { initialState, reduce, render, type Dismissal, type Key } from "./state.js";

/** Narrower than this, the two panes don't fit: the plain report is printed instead. */
export const MIN_COLUMNS = 60;

export interface ViewIo {
  stdin: NodeJS.EventEmitter & {
    isTTY?: boolean;
    setRawMode?: (on: boolean) => unknown;
    resume?: () => unknown;
    pause?: () => unknown;
  };
  stdout: { isTTY?: boolean; columns?: number; rows?: number; write(chunk: string): unknown };
}

/** The plain report for a result, the fallback when the view can't be shown. */
export function plainReport(result: Result): string {
  return formatTerminal({
    result: {
      findings: result.findings,
      passed: result.passed,
      failed: result.failed.map((id) => ({ id, error: "" })),
      warnings: [],
      couldNotCheck: result.couldNotCheck,
      sampled: result.sampled,
    },
    color: false,
    origin: new URL(result.url).origin,
  });
}

/** Whether the view can be shown: a terminal on both ends, wide enough. */
export function canShowView(io: ViewIo): boolean {
  return (
    io.stdin.isTTY === true && io.stdout.isTTY === true && (io.stdout.columns ?? 0) >= MIN_COLUMNS
  );
}

/**
 * The interactive view over a finished run. It shows only what the plain report shows. Resolves
 * when the person quits; falls back to the plain report when it can't be shown.
 */
export async function runView(
  opts: ViewIo & { result: Result; registry: CheckRegistry; onDismiss: (d: Dismissal) => void },
): Promise<void> {
  const result = parseResult(opts.result);
  if (!canShowView(opts)) {
    opts.stdout.write(plainReport(result));
    return;
  }
  let state = initialState(result, opts.registry);
  const draw = () => {
    opts.stdout.write(
      `\x1b[H\x1b[2J${render(state, opts.stdout.columns ?? 80, opts.stdout.rows ?? 24)}`,
    );
  };
  emitKeypressEvents(opts.stdin as NodeJS.ReadStream);
  opts.stdin.setRawMode?.(true);
  opts.stdin.resume?.();
  draw();
  await new Promise<void>((resolve) => {
    const onKey = (_: string, key: Key | undefined) => {
      const step = reduce(state, key ?? {});
      state = step.state;
      if (step.dismissed) opts.onDismiss(step.dismissed);
      if (state.quit) {
        opts.stdin.removeListener("keypress", onKey);
        opts.stdin.setRawMode?.(false);
        opts.stdin.pause?.();
        opts.stdout.write("\x1b[H\x1b[2J");
        resolve();
        return;
      }
      draw();
    };
    opts.stdin.on("keypress", onKey);
  });
}
