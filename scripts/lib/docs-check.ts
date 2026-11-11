export interface DocsCheckInput {
  /** Slugs in sidebar order, with their group, as NAV lists them. */
  nav: { group: string; slug: string }[];
  /** Pages that build but are not in the sidebar. */
  unlisted: string[];
  /** Markdown files under docs/, as slugs ("quick-start", "reference/json-schema"). */
  files: string[];
  /** Internal links found in each file: target slugs. */
  links: Record<string, string[]>;
}

export function checkDocs(input: DocsCheckInput): string[] {
  const problems: string[] = [];
  const files = new Set(input.files);
  const seen = new Map<string, string>();
  for (const { group, slug } of input.nav) {
    const first = seen.get(slug);
    if (first !== undefined)
      problems.push(`Slug "${slug}" is in two groups: ${first} and ${group}.`);
    else seen.set(slug, group);
    if (!files.has(slug))
      problems.push(`NAV lists "${slug}" (${group}) but docs/${slug}.md does not exist.`);
  }
  // A folder's index page (integrations/index) is linked as /docs/integrations/.
  const known = new Set(
    [...seen.keys(), ...input.unlisted].flatMap((s) =>
      s.endsWith("/index") ? [s, s.slice(0, -6)] : [s],
    ),
  );
  for (const slug of input.unlisted) {
    if (!files.has(slug))
      problems.push(`UNLISTED names "${slug}" but docs/${slug}.md does not exist.`);
  }
  for (const file of input.files) {
    if (!known.has(file))
      problems.push(`docs/${file}.md is not in NAV (or UNLISTED) in docs/nav.ts.`);
  }
  for (const [file, targets] of Object.entries(input.links)) {
    for (const t of targets) {
      if (!known.has(t))
        problems.push(`docs/${file}.md links to /docs/${t}, which does not exist.`);
    }
  }
  return problems;
}

/** Internal docs links in a Markdown page: /docs/<slug>, <slug>.md and ./<slug>.md, without query or anchor. */
export function extractLinks(markdown: string, fromSlug: string): string[] {
  const out = new Set<string>();
  const dir = fromSlug.includes("/") ? fromSlug.slice(0, fromSlug.lastIndexOf("/") + 1) : "";
  const text = markdown.replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(
    /(?:\]\(|href=")(\/docs\/[^)"\s#?]+|[^)"\s:#?]+\.md)(?:[?#][^)"\s]*)?[)"]/g,
  )) {
    const raw = m[1] ?? "";
    if (raw.startsWith("/docs/")) out.add(raw.slice("/docs/".length).replace(/\/$/, ""));
    else {
      const parts = `${dir}${raw.replace(/^\.\//, "")}`.replace(/\.md$/, "").split("/");
      const resolved: string[] = [];
      for (const p of parts) {
        if (p === "..") resolved.pop();
        else if (p !== ".") resolved.push(p);
      }
      out.add(resolved.join("/"));
    }
  }
  return [...out];
}
