import { NetworkError } from "../errors.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

/** The other spelling of the site's host: www.example.com <-> example.com. */
export function alternateHost(url: string): string | undefined {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (
    /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) ||
    u.hostname.includes(":") ||
    !u.hostname.includes(".")
  ) {
    return undefined;
  }
  u.hostname = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
  u.pathname = "/";
  u.search = "";
  u.hash = "";
  return u.href;
}

export const hostDuplicate = defineCheck<PageSnapshot>({
  id: "host-duplicate",
  size: "S",
  done: "One address answers and the other redirects to it with a 301.",
  estimateChanges:
    "Mail on the second address, or a host that needs a support request to change this, add time.",
  area: "Search & sharing",
  severity: "high",
  title: "Your whole site exists at two addresses",
  what: "Both www and the bare domain load the site, instead of one redirecting to the other.",
  why: "Search engines can split your ranking between two copies of every page.",
  fix: "Pick one address and 301-redirect the other to it at your host or DNS provider.",
  tech: "the alternate host returns 200 instead of 301",
  async run(page, ctx) {
    const alternate = alternateHost(page.finalUrl);
    if (alternate === undefined || ctx.fetcher === undefined) return [];
    let hops;
    try {
      hops = await ctx.fetcher.get(alternate);
    } catch (err) {
      // No www record, refused, timed out: the alternate host does not serve a copy.
      if (err instanceof NetworkError) return [];
      throw err;
    }
    const first = hops[0];
    if (!first || first.status !== 200) return [];
    return [
      {
        checkId: "host-duplicate",
        severity: "high",
        title: this.title,
        evidence: `${alternate} returned 200 instead of a 301 to ${new URL(page.finalUrl).origin}/`,
        url: alternate,
      },
    ];
  },
});
