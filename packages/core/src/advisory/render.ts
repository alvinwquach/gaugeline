import { escapeMarkdown } from "../report/brief.js";
import type { AdvisoryResult, Verdict } from "./schema.js";

const LABEL: Record<Verdict, string> = {
  "likely-affected": "Likely affected",
  "likely-not-affected": "Likely not affected",
  "cannot-tell": "Cannot tell",
};

const bullets = (lines: readonly string[]): string[] => lines.map((l) => `  - ${l}`);

/** What the person reads in the terminal: the answer, then the evidence, then what only the inside can show. */
export function renderTerminal(r: AdvisoryResult): string {
  const out: string[] = [r.headline, ""];
  const title = r.advisory.summary ? ` - ${r.advisory.summary}` : "";
  out.push(`Advisory: ${r.advisory.id}${title}`);
  if (r.advisory.aliases.length > 0) out.push(`Also known as: ${r.advisory.aliases.join(", ")}`);
  for (const p of r.advisory.packages)
    out.push(
      `Affects: ${p.name} (${p.ecosystem})${p.affectedVersions ? ` ${p.affectedVersions}` : ""}`,
    );
  out.push(`Site: ${r.site.address}, looked at ${r.site.checkedAt.slice(0, 10)}`, "");
  out.push(`${LABEL[r.verdict]}. What was found:`, ...bullets(r.evidence), "");
  out.push(
    "Check inside (only the repository or the server can show this):",
    ...bullets(r.checkInside),
  );
  if (r.couldNotCheck.length > 0) out.push("", "Could not check:", ...bullets(r.couldNotCheck));
  out.push(
    "",
    "Gaugeline looked from outside only: a request for each page and file the site's own pages name, nothing sent.",
  );
  return `${out.join("\n")}\n`;
}

const md = (s: string): string => escapeMarkdown(s);
const NOTE_LINES = 6;

/**
 * A short note the freelancer can paste into an email: the answer first, what it rests on, what still has to be
 * checked inside. It is Markdown; every piece of text from OSV or a page is escaped. It never says the site is
 * safe, because looking from outside cannot show that.
 */
export function renderNote(r: AdvisoryResult): string {
  const what = r.advisory.summary ? ` (${md(r.advisory.summary)})` : "";
  const answer: Record<Verdict, string> = {
    "likely-affected":
      "From the outside I found signs that the site is likely affected, so I am treating it as affected until I have checked inside.",
    "likely-not-affected":
      "From the outside I found no sign of the affected component on the site, so it is likely not affected. That is what a visitor can see, so I will confirm it inside.",
    "cannot-tell":
      "From the outside I cannot tell yet. What a visitor can see does not settle it, so I will check inside.",
  };
  const fixes = r.components
    .filter((c) => c.fixedIn)
    .map((c) => `${md(c.name)} ${md(c.fixedIn ?? "")}`);
  const lines: string[] = [
    // The subject is plain text, not Markdown.
    `Subject: Are we affected by ${r.advisory.id}?`,
    "",
    "Hi,",
    "",
    `You asked whether the site is affected by ${md(r.advisory.id)}${what}.`,
    "",
    `**Short answer: ${md(LABEL[r.verdict])}.** ${answer[r.verdict]}`,
    "",
    "**What I found**",
    ...r.evidence.slice(0, NOTE_LINES).map((l) => `- ${md(l)}`),
  ];
  if (r.verdict === "likely-affected" && fixes.length > 0)
    lines.push(
      "",
      `**The fix:** update to ${fixes.join(" or ")} or later, then I will check the live site again.`,
    );
  lines.push(
    "",
    "**What I still need to check inside**",
    ...r.checkInside.slice(0, 4).map((l) => `- ${md(l)}`),
  );
  lines.push(
    "",
    `I looked at the site on ${md(r.site.checkedAt.slice(0, 10))} with Gaugeline, from outside only.`,
  );
  return `${lines.join("\n")}\n`;
}
