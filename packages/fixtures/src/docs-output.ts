import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DOCS_DIR = fileURLToPath(new URL("../../../docs/", import.meta.url));

/**
 * The intended output a docs page shows: the first fenced block titled Output (or a Terminal block
 * with no "$" line) under the named heading. Lines starting "$" are the command, not output.
 * Trailing whitespace is trimmed; blank lines inside the block are kept; CRLF reads as LF.
 */
export function expectedOutput(slug: string, heading: string, docsDir = DOCS_DIR): string {
  const file = `${docsDir}${slug}.md`;
  if (!existsSync(file))
    throw new Error(
      `expectedOutput: no docs page "${slug}" (looked for docs/${slug}.md, heading "${heading}").`,
    );
  const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  const headingAt = lines.flatMap((l, i) =>
    /^#{1,6} /.test(l) && l.replace(/^#+ /, "").trim() === heading ? [i] : [],
  );
  if (headingAt.length === 0)
    throw new Error(`expectedOutput: docs/${slug}.md has no heading "${heading}".`);
  if (headingAt.length > 1) {
    throw new Error(
      `expectedOutput: docs/${slug}.md has the heading "${heading}" ${headingAt.length} times; use a more specific heading.`,
    );
  }
  const start = headingAt[0] ?? 0;
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 2;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const next = /^(#+) /.exec(line);
    if (next && (next[1]?.length ?? 0) <= level) break;
    const fence = /^```(\S*)(.*)$/.exec(line);
    if (!fence) continue;
    const info = `${fence[1] ?? ""}${fence[2] ?? ""}`;
    const end = lines.findIndex((l, j) => j > i && l.startsWith("```"));
    const body = lines.slice(i + 1, end === -1 ? lines.length : end);
    i = end === -1 ? lines.length : end;
    const isOutput = /title=Output\b/.test(info);
    const isTerminal = /title=Terminal\b/.test(info);
    if (!isOutput && !(isTerminal && !body.some((l) => l.startsWith("$")))) {
      if (!(
        isTerminal &&
        body.some((l) => l.startsWith("$")) &&
        body.some((l) => !l.startsWith("$") && l.trim() !== "")
      ))
        continue;
    }
    return body
      .filter((l) => !l.startsWith("$"))
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");
  }
  throw new Error(`expectedOutput: docs/${slug}.md has no Output block under "${heading}".`);
}
