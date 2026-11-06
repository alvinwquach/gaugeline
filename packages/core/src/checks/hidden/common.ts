import { isHidden } from "../../hidden.js";
import type { CheckContext } from "../../model.js";
import type { PageSnapshot } from "../../snapshot.js";

export interface HiddenLink {
  /** The public page the link is on. */
  from: string;
  href: string;
  text: string;
  /** Where it ends: the href, or the hidden address a public one redirects to. */
  target: string;
  redirect: boolean;
}

/**
 * Links from public pages into hidden sections: direct links on the checked page and the run's
 * other public pages, and sampled same-site links that redirect into one. Hidden pages the
 * pages loader read are never looked into: their content isn't checked.
 */
export async function hiddenLinks(page: PageSnapshot, ctx: CheckContext): Promise<HiddenLink[]> {
  const config = ctx.hidden;
  if (!config) return [];
  const site = page.finalUrl;
  const out: HiddenLink[] = [];
  const seen = new Set<string>();
  const pages = ((await ctx.pages?.()) ?? [page]).filter(
    (p) => !isHidden(config, p.finalUrl, site),
  );
  for (const p of pages) {
    const from = new URL(p.finalUrl).pathname;
    for (const l of p.links) {
      if (!isHidden(config, l.href, site) || seen.has(`${from} ${l.href}`)) continue;
      seen.add(`${from} ${l.href}`);
      out.push({ from, href: l.href, text: l.text.trim(), target: l.href, redirect: false });
    }
  }
  const from = new URL(page.finalUrl).pathname;
  for (const l of (await ctx.links?.())?.taken ?? []) {
    const end = l.hops.at(-1)?.url;
    if (l.hops.length < 2 || !end || isHidden(config, l.url, site) || !isHidden(config, end, site))
      continue;
    out.push({ from, href: l.url, text: l.text ?? "", target: end, redirect: true });
  }
  return out;
}
