import { RESULT_SCHEMA_VERSION, resultSchema, type Result } from "../../packages/core/src/index.js";

const LEVEL = { high: "Fix this first", medium: "Fix soon", low: "Worth knowing" } as const;
const ORDER = { high: 0, medium: 1, low: 2 } as const;

/** Markdown for the job summary and the issue body. Validates the --json output first. */
export function summarise(json: unknown): string {
  const schema = (json as { schema?: unknown } | null)?.schema;
  if (schema !== RESULT_SCHEMA_VERSION)
    throw new Error(
      `Expected a Gaugeline result with schema ${RESULT_SCHEMA_VERSION}, got schema ${String(schema)}.`,
    );
  const result: Result = resultSchema.parse(json);
  const count = (s: keyof typeof LEVEL) => result.findings.filter((f) => f.severity === s).length;
  const lines = [
    `## Gaugeline self-check: ${result.url}`,
    "",
    `**${count("high")} to fix first**, ${count("medium")} to fix soon, ${count("low")} worth knowing.`,
    "",
  ];
  const sorted = [...result.findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  for (const f of sorted) {
    lines.push(`- ${LEVEL[f.severity]}: [${f.checkId}](/docs/checks?id=${f.checkId}) ${f.title}`);
  }
  if (result.passed.length > 0)
    lines.push("", `Passed: ${result.passed.map((id) => `\`${id}\``).join(", ")}`);
  if (result.failed.length > 0)
    lines.push("", `Could not run: ${result.failed.map((id) => `\`${id}\``).join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export const ISSUE_TITLE = "Self-check: production docs have a fix-first finding";

/** One issue, updated, never one per night; closed on the next clean run. */
export function issueAction(
  openIssue: { number: number } | undefined,
  exitCode: number,
):
  | { action: "create" }
  | { action: "edit"; number: number }
  | { action: "close"; number: number }
  | { action: "none" } {
  if (exitCode === 1)
    return openIssue ? { action: "edit", number: openIssue.number } : { action: "create" };
  if (exitCode === 0 && openIssue) return { action: "close", number: openIssue.number };
  return { action: "none" };
}
