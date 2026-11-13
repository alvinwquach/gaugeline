/**
 * The draft as Markdown (AG-15): plain text a person reads, edits and decides on. A pure function of the draft:
 * no clock, no network. Every word that came from a note is escaped (a note's text is data, never a heading, a
 * link or a table) and every example sits in a fenced block that its own text cannot close. The draft names no
 * note and no client, and proposes no code: the person writes the check.
 */
import { forMarkdown } from "../untrusted-output.js";
import type { FieldFindingsDraft } from "./mine.js";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fenced = (text: string) => ["```text", text.replace(/`/g, "'"), "```"];

export function renderFieldFindingsMarkdown(d: FieldFindingsDraft): string {
  const lines = [
    "# Check candidates (DRAFT)",
    "",
    "A person reviews this draft. Nothing here is a check: no check, fixture or code was added to the repository, and nothing was sent anywhere. Each candidate is a pattern that recurred in the review notes, with a failing and a passing example for the person who writes the check to start from.",
    "",
    `Read ${plural(d.notesRead, "review note", "review notes")} and ${plural(d.linesRead, "tagged line", "tagged lines")}. The scrub checked ${plural(d.scrub.linesChecked, "line", "lines")} and found no client name, address, email or phone number.`,
  ];
  if (d.candidates.length === 0)
    lines.push(
      "",
      "No pattern recurred with a failing and a passing example, so there is nothing to propose.",
    );
  for (const c of d.candidates) {
    lines.push(
      "",
      `## Candidate: ${c.pattern}`,
      "",
      `Seen in ${plural(c.seenIn, "note", "notes")}, ${plural(c.mentions, "time", "times")} in all.`,
      "",
      forMarkdown(c.summary, 320),
      "",
      "Failing example:",
      "",
      ...fenced(c.failing),
      "",
      "Passing example:",
      "",
      ...fenced(c.passing),
    );
  }
  const n = d.notProposed;
  const left = [
    n.belowThreshold > 0
      ? `${plural(n.belowThreshold, "pattern", "patterns")} seen in only one note.`
      : "",
    n.missingFixture > 0
      ? `${plural(n.missingFixture, "pattern", "patterns")} seen in two or more notes but missing a failing or a passing example.`
      : "",
    n.omitted > 0
      ? `${plural(n.omitted, "more candidate", "more candidates")} left out to keep the draft short.`
      : "",
    n.instructionLines > 0
      ? `${plural(n.instructionLines, "tagged line", "tagged lines")} that gave an order to an assistant, ignored.`
      : "",
    n.badTags > 0
      ? `${plural(n.badTags, "line", "lines")} that started with a tag that is not a pattern name.`
      : "",
  ].filter((x) => x !== "");
  if (left.length > 0) lines.push("", "## Not proposed", "", ...left.map((x) => `- ${x}`));
  lines.push("", "Nothing here is final: a person decides which candidates become checks.");
  return `${lines.join("\n")}\n`;
}
