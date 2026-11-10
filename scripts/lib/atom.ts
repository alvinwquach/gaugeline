/** The changelog as an Atom 1.0 feed (RFC 4287). No dependency: the feed is small and fixed in shape. */
import { releaseAnchor, splitItem, type ChangelogEntry } from "./changelog.js";

/** Escape text for XML and drop the characters XML 1.0 cannot hold at all. */
export function escapeXml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

/** The entry body as HTML (escaped again when it goes into the XML). */
function contentHtml(entry: ChangelogEntry, site: string): string {
  const items = entry.items.map((text) => {
    const { breaking, body, migration } = splitItem(text);
    const link = migration
      ? ` <a href="${escapeXml(`${site}/docs/migrations/${migration}`)}">Migration guide</a>`
      : "";
    return `<li>${breaking ? "<strong>Breaking:</strong> " : ""}${escapeXml(body)}${link}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

/**
 * One <entry> per released version (it has a date and at least one user-facing item). Ids are URNs
 * built from the version, so they do not change when the site moves; links use the site address.
 */
export function renderAtom(entries: readonly ChangelogEntry[], opts: { site: string }): string {
  const site = opts.site.replace(/\/+$/, "");
  const released = entries.filter(
    (e): e is ChangelogEntry & { date: string } => e.date !== null && e.items.length > 0,
  );
  const stamp = (date: string) => `${date}T00:00:00Z`;
  const latest = released
    .map((e) => e.date)
    .sort()
    .at(-1);
  const out = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "  <id>urn:gaugeline:changelog</id>",
    "  <title>Gaugeline changelog</title>",
    "  <subtitle>What changed in each release, and the migration guide for every breaking change.</subtitle>",
    `  <updated>${stamp(latest ?? "1970-01-01")}</updated>`,
    "  <author><name>Gaugeline</name></author>",
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(`${site}/changelog.atom`)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(`${site}/docs/changelog`)}"/>`,
  ];
  for (const e of released) {
    const title = `${e.version}${e.headline ? `: ${e.headline}` : ""}`;
    out.push(
      "  <entry>",
      `    <id>urn:gaugeline:changelog:${escapeXml(e.version)}</id>`,
      `    <title>${escapeXml(title)}</title>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(`${site}/docs/changelog#${releaseAnchor(e.version)}`)}"/>`,
      `    <updated>${stamp(e.date)}</updated>`,
      `    <published>${stamp(e.date)}</published>`,
      `    <content type="html">${escapeXml(contentHtml(e, site))}</content>`,
      "  </entry>",
    );
  }
  out.push("</feed>", "");
  return out.join("\n");
}
