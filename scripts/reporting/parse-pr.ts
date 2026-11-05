/**
 * Read what a pull request body says about itself: its changelog line, the section it belongs to,
 * and the time spent (from Time-Spent trailers, never guessed).
 */
export const SECTIONS = [
  "Search & sharing",
  "Visitors",
  "Sales & prices",
  "Leads",
  "Security & email",
  "Launch day",
  "Reliability",
  "Docs",
  "Tooling",
] as const;
export type Section = (typeof SECTIONS)[number];
export const FALLBACK_SECTION: Section = "Reliability";

/** Text that means "I did not fill this in". A body still holding one cannot merge. */
const PLACEHOLDERS = [
  /One line a user would understand/i,
  /One sentence, written for the person who runs the tool/i,
  /<(?:one line|summary|description|what changed|change|slug)[^>]*>/i,
  /\bTODO\b/,
];
const NO_USER_CHANGE = /^(?:no user-facing change\.?|\(internal\).*)$/i;
/** "`.changeset/x.md` (gaugeline: minor): Sentence." keeps only the sentence. */
const CHANGESET_PREFIX = /^`?\.changeset\/[^`\s]+`?(?:\s*\([^)]*\))?:\s*/;

function normalise(body: string): string {
  return body.replace(/\r\n?/g, "\n");
}

/** The text of a "## Heading" section, up to the next heading of the same or higher level. */
export function section(body: string, heading: string): string | undefined {
  const lines = normalise(body).split("\n");
  const start = lines.findIndex(
    (l) =>
      l
        .replace(/^#+\s*/, "")
        .trim()
        .toLowerCase() === heading.toLowerCase() && /^#{1,3}\s/.test(l),
  );
  if (start === -1) return undefined;
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  const end = lines.findIndex(
    (l, i) => i > start && /^(#+)\s/.test(l) && (/^#+/.exec(l)?.[0].length ?? 9) <= level,
  );
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/** A "Name: value" line anywhere in the body. */
export function field(body: string, name: string): string | undefined {
  const m = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "im").exec(normalise(body));
  return m?.[1];
}

/** Minutes from "1h30m", "45m", "2h", "1.5h". */
export function parseDuration(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  const m = /^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+)m)?$/.exec(t);
  if (!m || (!m[1] && !m[2])) return undefined;
  return Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0));
}

/** Every "Time-Spent:" trailer in the body and in commit messages, added up. */
export function trailers(texts: string[]): { minutes: number; problems: string[] } {
  let minutes = 0;
  const problems: string[] = [];
  for (const text of texts) {
    for (const m of normalise(text).matchAll(/^\s*Time-Spent:\s*(.+?)\s*$/gim)) {
      const d = parseDuration(m[1] ?? "");
      if (d === undefined)
        problems.push(`"Time-Spent: ${m[1]}" is not a duration like 1h30m, 45m, 2h or 1.5h.`);
      else minutes += d;
    }
  }
  return { minutes, problems };
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
}

export interface ParsedPr {
  changelog: string | null;
  section: Section;
  minutes: number;
  problems: string[];
}

/** Everything the merge report needs, plus the problems that should stop a merge. */
export function parsePr(body: string, commitMessages: string[] = []): ParsedPr {
  const problems: string[] = [];
  const changelogText = section(body, "Changelog");
  if (changelogText === undefined) problems.push('The body has no "## Changelog" section.');
  const time = trailers([body, ...commitMessages]);
  problems.push(...time.problems);
  const firstLine =
    (changelogText ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  let changelog: string | null =
    firstLine.replace(/^[-*]\s+/, "").replace(CHANGESET_PREFIX, "") || null;
  if (
    changelog &&
    PLACEHOLDERS.some((p) => p.test(changelog?.replace(/^\(<time>\)\s*/, "") ?? ""))
  ) {
    problems.push(`The Changelog still holds a placeholder: "${changelog}".`);
  }
  if (changelog && NO_USER_CHANGE.test(changelog.replace(/^\(<time>\)\s*/, ""))) changelog = null;
  if (changelog) changelog = changelog.replace(/^\(<time>\)/, `(${formatMinutes(time.minutes)})`);
  if (changelogText !== undefined && !firstLine) problems.push("The Changelog section is empty.");
  const named = field(body, "Section");
  const sectionName = (SECTIONS as readonly string[]).includes(named ?? "")
    ? (named as Section)
    : FALLBACK_SECTION;
  return { changelog, section: sectionName, minutes: time.minutes, problems };
}

/** The calendar day in Pacific time (the team's day), as yyyy-mm-dd, and its ISO week. */
export function pacificDay(iso: string): { day: string; week: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  const d = new Date(`${parts}T00:00:00Z`);
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return { day: parts, week: `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}` };
}
