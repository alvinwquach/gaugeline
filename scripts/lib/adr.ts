export const ADR_HEADINGS = [
  "## Context",
  "## Decision",
  "## Alternatives",
  "## Cost",
  "## What would change it",
  "## Enforced by",
] as const;

export interface AdrFile {
  name: string;
  text: string;
}

/** Problems with the decision records: names, numbering, headings, status links and the index. */
export function checkAdrs(files: AdrFile[], readme: string): string[] {
  const problems: string[] = [];
  const records = files.filter((f) => f.name !== "README.md");
  const numbers = new Map<string, string[]>();
  for (const f of records) {
    const m = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(f.name);
    if (!m) {
      problems.push(`${f.name}: decision records are named NNNN-kebab-title.md.`);
      continue;
    }
    numbers.set(m[1] ?? "", [...(numbers.get(m[1] ?? "") ?? []), f.name]);
  }
  for (const [n, names] of numbers)
    if (names.length > 1)
      problems.push(`ADR ${n} is used by ${names.length} files: ${names.join(", ")}.`);
  const sorted = [...numbers.keys()].map(Number).sort((a, b) => a - b);
  sorted.forEach((n, i) => {
    if (n !== i)
      problems.push(
        `ADR numbers have a gap: expected ${String(i).padStart(4, "0")}, found ${String(n).padStart(4, "0")}.`,
      );
  });
  const existing = new Set(sorted.map((n) => String(n).padStart(4, "0")));
  for (const f of records) {
    if (f.name.startsWith("0000-")) continue; // the template: placeholders allowed, not indexed
    const text = f.text.replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    if (!/^# ADR-\d{4}: \S/.test(lines[0] ?? ""))
      problems.push(`${f.name}: the first line must be "# ADR-NNNN: <title>".`);
    const status =
      /^Status: (proposed|accepted|superseded by ADR-(\d{4}))\s+Date: \d{4}-\d{2}-\d{2}$/m.exec(
        text,
      );
    if (!status)
      problems.push(
        `${f.name}: needs a "Status: proposed | accepted | superseded by ADR-NNNN   Date: YYYY-MM-DD" line.`,
      );
    else if (status[2] && !existing.has(status[2]))
      problems.push(`${f.name}: superseded by ADR-${status[2]}, which does not exist.`);
    for (const h of ADR_HEADINGS)
      if (!lines.includes(h)) problems.push(`${f.name}: missing the heading "${h}".`);
    if (!readme.includes(`(${f.name})`))
      problems.push(`${f.name} is not listed in docs/adr/README.md.`);
  }
  return problems;
}

/** Repository paths named in backticks under "## Enforced by". */
export function enforcedPaths(text: string): string[] {
  const t = text.replace(/\r\n/g, "\n");
  const start = t.indexOf("## Enforced by");
  if (start === -1) return [];
  const section = t.slice(start).split(/\n## /)[0] ?? "";
  return [...section.matchAll(/`([\w./-]+\.(?:ts|js|mjs|json|md|yml))`/g)].map((m) => m[1] ?? "");
}
