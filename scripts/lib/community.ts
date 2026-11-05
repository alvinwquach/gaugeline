import { parse } from "yaml";

/** Issue forms: valid YAML with name, description and body; field ids unique. config.yml is not a form. */
export function checkForm(file: string, text: string): string[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return [
      `${file}: not valid YAML (${err instanceof Error ? err.message.split("\n")[0] : String(err)}).`,
    ];
  }
  const problems: string[] = [];
  const form = (doc ?? {}) as { name?: unknown; description?: unknown; body?: unknown };
  for (const key of ["name", "description", "body"] as const) {
    if (form[key] === undefined) problems.push(`${file}: the issue form has no "${key}".`);
  }
  if (form.body !== undefined && !Array.isArray(form.body))
    problems.push(`${file}: "body" must be a list of fields.`);
  const ids = (Array.isArray(form.body) ? (form.body as { id?: string }[]) : [])
    .map((f) => f.id)
    .filter((id): id is string => !!id);
  for (const id of new Set(ids))
    if (ids.filter((x) => x === id).length > 1)
      problems.push(`${file}: the field id "${id}" is used twice.`);
  return problems;
}

/** GitHub's heading anchor: lowercase, punctuation removed, spaces to hyphens. */
export function slugHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function headingsOf(markdown: string): Set<string> {
  return new Set(
    [...markdown.replace(/\r\n/g, "\n").matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
      slugHeading(m[1] ?? ""),
    ),
  );
}

/**
 * Relative links in a Markdown file must resolve to a file, and an anchor to a heading in it.
 * `read(path)` returns the target's text, or undefined when it does not exist.
 */
export function checkLinks(
  file: string,
  markdown: string,
  read: (path: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const text = markdown.replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = m[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // https:, mailto:
    const [path = "", anchor] = link.split("#");
    const target = path === "" ? file : normalisePath(`${dir}${path}`);
    const content = read(target);
    if (content === undefined) {
      problems.push(`${file}: the link "${link}" points at ${target}, which does not exist.`);
      continue;
    }
    if (anchor && target.endsWith(".md") && !headingsOf(content).has(anchor)) {
      problems.push(
        `${file}: the link "${link}" names the heading #${anchor}, which ${target} does not have.`,
      );
    }
  }
  return problems;
}

function normalisePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
export const ALLOW_EMAIL_MARKER = "check-community: allow-email";

/**
 * Addresses do not belong in the repository. Allowed: fixture sites, docs site pages, and files that
 * say why with the allow-email marker.
 */
export function findEmails(file: string, text: string): string[] {
  if (
    file.startsWith("packages/fixtures/") ||
    (file.startsWith("docs/") && file.endsWith(".md") && !file.startsWith("docs/adr/"))
  )
    return [];
  if (text.includes(ALLOW_EMAIL_MARKER)) return [];
  return text
    .split(/\r?\n/)
    .flatMap((line, i) =>
      EMAIL.test(line)
        ? [
            `${file}:${i + 1}: looks like an email address. Remove it, or mark the file with "${ALLOW_EMAIL_MARKER}" and a reason.`,
          ]
        : [],
    );
}
