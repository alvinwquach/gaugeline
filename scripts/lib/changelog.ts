export interface ChangelogEntry {
  version: string;
  /** yyyy-mm-dd from the release tag, or null before the version is tagged. */
  date: string | null;
  headline: string | null;
  items: string[];
}

const SECTION_ORDER = ["major", "minor", "patch"] as const;
export type ChangelogSection = (typeof SECTION_ORDER)[number];

/** One bullet of a Changesets CHANGELOG.md, with the section it sat in. */
export interface ChangelogItem {
  version: string;
  section: ChangelogSection;
  /** The lines joined with single spaces. */
  text: string;
  /** The lines as written (the commit hash is already gone from the first). */
  lines: string[];
}

/** Every version heading and every bullet of a Changesets CHANGELOG.md, in file order. */
export function scanChangelog(markdown: string): { versions: string[]; items: ChangelogItem[] } {
  const versions: string[] = [];
  const items: ChangelogItem[] = [];
  let version: string | undefined;
  let section: ChangelogSection = "patch";
  let lines: string[] | undefined;
  const flush = () => {
    if (version !== undefined && lines) {
      const text = lines.join(" ").replace(/\s+/g, " ").trim();
      if (text !== "") items.push({ version, section, text, lines });
    }
    lines = undefined;
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^## (\d+\.\d+\.\d+\S*)\s*$/.exec(line);
    if (heading) {
      flush();
      version = heading[1] ?? "";
      versions.push(version);
      section = "patch";
      continue;
    }
    const kind = /^### (Major|Minor|Patch) Changes/i.exec(line);
    if (kind) {
      flush();
      section = (kind[1] ?? "patch").toLowerCase() as ChangelogSection;
      continue;
    }
    const bullet = /^- (?:[0-9a-f]{7,40}: )?(.*)$/.exec(line);
    if (bullet && version !== undefined) {
      flush();
      lines = [bullet[1] ?? ""];
      continue;
    }
    if (lines && /^\s+\S/.test(line)) lines.push(line.trim());
    else if (line.trim() === "") flush();
  }
  flush();
  return { versions, items };
}

/** Parse a Changesets CHANGELOG.md into entries, newest first. */
export function parseChangelog(markdown: string): Omit<ChangelogEntry, "date">[] {
  const { versions, items } = scanChangelog(markdown);
  return versions
    .map((version) => {
      let headline: string | null = null;
      const own = items.filter((i) => i.version === version);
      const kept: ChangelogItem[] = [];
      for (const i of own) {
        if (/^Headline:/i.test(i.text)) headline = i.text.replace(/^Headline:\s*/i, "");
        else if (!i.text.startsWith("(internal)")) kept.push(i);
      }
      return {
        version,
        headline,
        items: SECTION_ORDER.flatMap((s) => kept.filter((i) => i.section === s).map((i) => i.text)),
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Generated entries plus hand-backfilled ones the changelog does not have, newest first. */
export function mergeEntries(
  generated: ChangelogEntry[],
  backfill: ChangelogEntry[],
): ChangelogEntry[] {
  const seen = new Set(generated.map((e) => e.version));
  return [...generated, ...backfill.filter((e) => !seen.has(e.version))].sort((a, b) =>
    compareVersions(b.version, a.version),
  );
}

/** The anchor of a release heading on the changelog page. Fixed by hand so it never depends on the slugger. */
export function releaseAnchor(version: string): string {
  return `release-${version.replace(/[^0-9A-Za-z]+/g, "-")}`;
}

/**
 * One bullet as a reader sees it. A breaking change starts with `BREAKING:` and may carry a
 * `Migration: <slug>` line, which resolves to docs/migrations/<slug>.md.
 */
export function splitItem(text: string): {
  breaking: boolean;
  body: string;
  migration: string | null;
} {
  const migration = MIGRATION_TEXT.exec(text)?.[1] ?? null;
  const rest = text.replace(MIGRATION_TEXT, " ").replace(/\s+/g, " ").trim();
  const breaking = /^BREAKING:\s*/.test(rest);
  return { breaking, body: rest.replace(/^BREAKING:\s*/, ""), migration };
}
/** `Migration: node-22`, with or without a closing full stop, anywhere in the joined text. */
const MIGRATION_TEXT = /(?:^|\s)Migration:\s*([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.(?=\s|$))?/;

export interface MigrationGuide {
  slug: string;
  title: string;
}

/**
 * docs/changelog.md: date, version, headline, bullets. Versions with no user-facing items are skipped.
 * A breaking bullet is marked and links its migration guide; the guides are listed at the top.
 */
export function renderChangelogPage(
  entries: ChangelogEntry[],
  extras: { migrations?: MigrationGuide[] } = {},
): string {
  const out = [
    "# Changelog",
    "",
    "<!-- Generated by pnpm docs:changelog from packages/cli/CHANGELOG.md and docs/changelog.backfill.json. Do not edit. -->",
    "",
    // A plain anchor: the feed is a file in docs/public, not a page, and VitePress would call a Markdown link to it dead.
    'Follow new releases in a feed reader: <a href="/changelog.atom">Atom feed</a>. Every breaking change links a migration guide.',
    "",
  ];
  const guides = extras.migrations ?? [];
  if (guides.length > 0) {
    out.push("## Migration guides", "");
    for (const g of guides) out.push(`- [${g.title}](/docs/migrations/${g.slug})`);
    out.push("");
  }
  for (const e of entries) {
    if (e.items.length === 0) continue;
    out.push(
      `## ${e.version}${e.headline ? `: ${e.headline}` : ""} {#${releaseAnchor(e.version)}}`,
      "",
      e.date ? `Released ${e.date}.` : "Not released yet.",
      "",
    );
    for (const i of e.items) {
      const { breaking, body, migration } = splitItem(i);
      out.push(
        `- ${breaking ? "**Breaking:** " : ""}${body}${migration ? ` [Migration guide](/docs/migrations/${migration})` : ""}`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}
