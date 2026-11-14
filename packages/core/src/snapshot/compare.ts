import * as z from "zod";
import type { ContentSnapshot } from "./page-snapshot.js";

/**
 * A page measured against itself between two runs. Losses are findings; gains are information.
 * Pure: the caller reads the pages.
 */
export type ContentNow =
  | { kind: "page"; snap: ContentSnapshot }
  | { kind: "gone"; status: number; leadsTo?: string }
  | { kind: "unread"; reason: string };

/** More than this share of the main content gone is a loss. */
export const LOST_SHARE = 0.4;

/** gaugeline.pages.json: pages whose loss was intended, each with its reason. */
export const pagesConfigSchema = z
  .object({
    expectedChanges: z
      .array(z.object({ path: z.string().min(1), reason: z.string().min(1) }).strict())
      .min(1),
  })
  .strict();
export type PagesConfig = z.infer<typeof pagesConfigSchema>;

const n = (v: number) => v.toLocaleString("en-GB");

/** Words down by more than 40%, or a whole section (a heading and what is under it) gone. */
export function lostContent(prev: ContentSnapshot, now: ContentSnapshot): string | undefined {
  const share = prev.words === 0 ? 0 : (prev.words - now.words) / prev.words;
  const headingsNow = new Set(now.sections.map((s) => s.heading.toLowerCase()));
  const gone = prev.sections.filter(
    (s) => s.heading !== "" && !headingsNow.has(s.heading.toLowerCase()),
  );
  if (share <= LOST_SHARE && gone.length === 0) return undefined;
  const parts = [
    `${n(prev.words)} words, now ${n(now.words)}${now.words < prev.words ? ` (−${Math.round(share * 100)}%)` : ""}`,
  ];
  if (gone.length > 0)
    parts.push(
      `section${gone.length === 1 ? "" : "s"} gone: ${gone.map((s) => `"${s.heading}"`).join(", ")}`,
    );
  return parts.join("; ");
}

/** Each repeated list with fewer items than before, by its key. */
export function lostItems(prev: ContentSnapshot, now: ContentSnapshot): string[] {
  const out: string[] = [];
  const nowLists = new Map(now.lists.map((l) => [l.key, l]));
  for (const l of prev.lists) {
    const after = nowLists.get(l.key);
    const items = after?.items ?? 0;
    if (items >= l.items) continue;
    const kept = new Set(after?.links ?? []);
    const goneLinks = l.links.filter((h) => !kept.has(h));
    const paths = goneLinks.map((h) => {
      try {
        return new URL(h).pathname;
      } catch {
        return h;
      }
    });
    out.push(
      `the list "${l.key}" had ${l.items} items, now ${items}${paths.length > 0 ? `; gone: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` and ${paths.length - 5} more` : ""}` : ""}${l.paginated || after?.paginated ? " (a paginated list: the first page is compared)" : ""}`,
    );
  }
  return out;
}

/** Structured-data types present before and missing now. */
export function lostTypes(prev: ContentSnapshot, now: ContentSnapshot): string[] {
  const have = new Set(now.types);
  return prev.types.filter((t) => !have.has(t));
}

/** New pages, new sections, longer lists: said once, never findings. */
export function contentGains(
  prev: Readonly<Record<string, ContentSnapshot>>,
  now: Readonly<Record<string, ContentSnapshot>>,
): string[] {
  const out: string[] = [];
  for (const [key, snap] of Object.entries(now)) {
    const was = prev[key];
    if (!was) {
      out.push(`New page: ${key}`);
      continue;
    }
    const before = new Set(was.sections.map((s) => s.heading.toLowerCase()));
    for (const s of snap.sections)
      if (s.heading && !before.has(s.heading.toLowerCase()))
        out.push(`${key} has a new section: "${s.heading}"`);
    const lists = new Map(was.lists.map((l) => [l.key, l]));
    for (const l of snap.lists) {
      const old = lists.get(l.key);
      if (old && l.items > old.items)
        out.push(`${key}: the list "${l.key}" has ${l.items} items, was ${old.items}`);
    }
  }
  return out;
}
