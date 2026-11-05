/** Keys that are going away, with the version that deprecated them and the one that removes them. */
export interface Deprecation {
  since: string;
  removeIn: string;
  use?: string;
}

/**
 * Everything deprecated, by key ("--flag", "check:<id>", "env:NAME"). A public item may only be
 * removed when it is listed here and the package version has reached removeIn (see STABILITY.md).
 */
export const DEPRECATED: ReadonlyMap<string, Deprecation> = new Map<string, Deprecation>([]);

/** Keys already warned about in this process: one warning per key per run. */
const seen = new Set<string>();

/**
 * Warn once per run that `key` is going away. Core never touches the process: the caller passes
 * the sink (the CLI passes stderr). Nothing is ever written to stdout.
 */
export function deprecate(
  key: string,
  opts: Deprecation,
  sink: (line: string) => void = () => undefined,
): void {
  if (seen.has(key)) return;
  seen.add(key);
  sink(
    `Deprecated: ${key} will be removed in ${opts.removeIn}.${opts.use ? ` Use ${opts.use} instead.` : ""}`,
  );
}

/** For tests and long-lived callers that start a new run. */
export function resetDeprecations(): void {
  seen.clear();
}
