import { CHECK_TEXT } from "../check-titles";
import type { Finding } from "../types";

/**
 * The note for a developer, as plain text for email, Slack, Jira or a text message: no Markdown
 * and no HTML, so it reads the same in all of them. The order is fixed: the title, the page address,
 * why it matters, how to fix it, the technical line, the evidence and the check id. A section with
 * nothing in it is left out whole, its label with it. The page's own words (the title and the
 * evidence) go in as they are; they are text in a note and are never turned into markup.
 */
export function buildNote(finding: Finding, run: { url: string }): string {
  const text = CHECK_TEXT[finding.checkId];
  const section = (label: string, body: string | undefined): string[] => {
    const value = clean(body ?? "");
    return value === "" ? [] : [`${label}:\n${value}`];
  };
  return [
    clean(finding.title),
    ...(clean(finding.url || run.url) === "" ? [] : [`Page: ${clean(finding.url || run.url)}`]),
    ...section("Why it matters", text?.[1]),
    ...section("How to fix it", text?.[2]),
    ...section("Technical detail", text?.[3]),
    ...section("Evidence", finding.evidence),
    `Check: ${finding.checkId}`,
  ]
    .filter((s) => s !== "")
    .join("\n\n");
}

/** Line feeds only, and no blank space around the ends. */
function clean(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}
