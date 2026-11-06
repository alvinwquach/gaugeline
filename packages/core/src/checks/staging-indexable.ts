import { dnsName } from "../dns.js";
import { defineCheck } from "../model.js";
import { getOrNull } from "../probe.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import { isTemporaryHost } from "./launch/hosts.js";

const NOINDEX = /\b(?:noindex|none)\b/i;

export const stagingIndexable = defineCheck<PageSnapshot>({
  id: "staging-indexable",
  area: "Launch day",
  severity: "high",
  title: "Your staging site can be found by search engines",
  what: "staging.<your domain> answers with a page and doesn't ask search engines to stay away.",
  why: "Search engines can index the unfinished copy alongside the real site, with old prices, test content or duplicate pages competing with yours.",
  fix: 'Put the staging site behind a password, or send X-Robots-Tag: noindex (or <meta name="robots" content="noindex">) on every staging page.',
  tech: "One GET of <scheme>://staging.<host without www.>/: a final 200 on the staging host with no noindex or none in meta robots or X-Robots-Tag. A staging host that doesn't resolve, asks for a login or redirects away is a pass",
  async run(page, ctx) {
    if (!ctx.fetcher) return [];
    const u = new URL(page.finalUrl);
    const domain = dnsName(page.finalUrl);
    if (!domain || isTemporaryHost(domain) || domain.startsWith("staging.")) return [];
    const host = `staging.${domain}`;
    const url = `${u.protocol}//${host}/`;
    const hops = await getOrNull(ctx.fetcher, url);
    const last = hops.at(-1);
    if (!last || last.status !== 200 || new URL(last.url).hostname !== host) return [];
    if (NOINDEX.test(last.headers["x-robots-tag"] ?? "")) return [];
    if (NOINDEX.test(buildSnapshot(hops).metaRobots ?? "")) return [];
    return [
      {
        checkId: "staging-indexable",
        severity: "high",
        title: this.title,
        evidence: `${url} answers 200 with no noindex in meta robots or X-Robots-Tag`,
        url: page.finalUrl,
      },
    ];
  },
});
