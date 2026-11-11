import { detectBuilder } from "../cost/builders.js";
import type { PageSnapshot } from "../snapshot.js";
import type { BackupsReading } from "./types.js";

/**
 * A system the page is built on whose backup status Gaugeline cannot read: no documented read-only API
 * for it, or none Gaugeline has confirmed. It becomes a line to check by hand, in the report and in the
 * handoff, never a guess.
 */
export interface ManualBackup {
  id: string;
  name: string;
  /** The checklist line, written for the person who has to do it. */
  line: string;
}

const HOST_SIGNS: readonly {
  id: string;
  name: string;
  hosts: readonly string[];
  generator?: string;
  line: string;
}[] = [
  {
    id: "wordpress",
    name: "WordPress",
    hosts: [],
    generator: "wordpress",
    line: "WordPress: backups come from a plugin or the host, and Gaugeline cannot read either. Find out which, check that the last backup is recent and that it includes the database and the uploads folder, and try a restore on a copy once.",
  },
  {
    id: "shopify",
    name: "Shopify",
    hosts: ["cdn.shopify.com", "myshopify.com"],
    line: "Shopify: Gaugeline cannot read a store's backup status. Check what the store's admin can export (products, customers, orders, theme) and keep a recent export of your own.",
  },
  {
    id: "supabase",
    name: "Supabase",
    hosts: ["supabase.co"],
    line: "Supabase: the page talks to a Supabase project. Name its project reference under supabase in gaugeline.backups.json and set SUPABASE_ACCESS_TOKEN, and Gaugeline reads its backups.",
  },
  {
    id: "sanity",
    name: "Sanity",
    hosts: ["cdn.sanity.io", "sanity.io"],
    line: "Sanity: the content lives in a Sanity dataset. Set SANITY_TOKEN and SANITY_PROJECT_ID and Gaugeline reads its dataset backups where the plan has them; otherwise export the dataset on a schedule and point gaugeline.backups.json at the folder.",
  },
];

const hostIn = (host: string, wanted: readonly string[]): boolean =>
  wanted.some((w) => host === w || host.endsWith(`.${w}`));

const generatorOf = (html: string): string => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']generator["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return (content?.[1] ?? content?.[2] ?? "").toLowerCase();
  }
  return "";
};

/**
 * The systems the page shows it is built on whose backups Gaugeline cannot read here, from the page
 * alone: hosted builders, WordPress, Shopify, and a Supabase or Sanity the settings do not set up yet.
 * `reading` removes a platform that was read (or asked) so it is not listed twice. A word in the page's
 * text is never a sign; hosts of scripts, images and the generator tag are. Pure.
 */
export function manualBackups(
  page: PageSnapshot,
  reading: Pick<BackupsReading, "platforms" | "exports"> | undefined,
): ManualBackup[] {
  const out: ManualBackup[] = [];
  const builder = detectBuilder(page);
  if (builder)
    out.push({
      id: builder.id,
      name: builder.name,
      line: `${builder.name}: Gaugeline cannot read ${builder.name}'s backup status. Open its dashboard and check that a copy of the site (its version history or an export) exists and when it was last made, and keep an export of the content yourself.`,
    });
  const hosts = new Set<string>();
  for (const url of [...page.scripts, ...page.images.map((i) => i.src)])
    try {
      hosts.add(new URL(url, page.finalUrl).hostname.toLowerCase());
    } catch {
      // not an address
    }
  const generator = generatorOf(page.hops.at(-1)?.body ?? "");
  const asked = new Set((reading?.platforms ?? []).map((p) => p.id));
  for (const sign of HOST_SIGNS) {
    if (
      asked.has(sign.id) &&
      reading?.platforms.some((p) => p.id === sign.id && (p.ok || p.configured))
    )
      continue;
    const seen =
      (sign.generator !== undefined && generator.startsWith(sign.generator)) ||
      [...hosts].some((h) => hostIn(h, sign.hosts));
    if (seen) out.push({ id: sign.id, name: sign.name, line: sign.line });
  }
  return out;
}

/** The line that says where backups are kept, when nothing at all could be read and nothing was recognised. */
export const NOTHING_READ_LINE =
  "Write down where this site's content and database are backed up, how often, and who can restore them. Gaugeline read no backup status, so this is the one thing to know before something is wiped.";
