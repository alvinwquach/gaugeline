/** The oldest Node major Gaugeline supports. Node 20 reached end of life in April 2026. */
export const MIN_NODE_MAJOR = 22;

/**
 * One line to print when this Node is too old, or undefined when it is fine.
 * Takes the version as an argument so a test can try any version; the entry point passes
 * process.versions.node. Kept free of imports: it has to run before anything else loads.
 */
export function nodeVersionProblem(version: string): string | undefined {
  const major = Number(/^(\d+)\./.exec(version)?.[1]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return undefined;
  return `Gaugeline needs Node ${MIN_NODE_MAJOR} or newer. This is Node ${version}.`;
}
