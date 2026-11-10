import { withoutQuery, fragmentNote, tagSurvival, PROBE_TAGS, type TagProbe } from "../ads/tags.js";
import { CheckRegistry, defineCheck, type Check, type Finding } from "../model.js";
import { formatMoney } from "../products/money.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/**
 * What the check reads: for each landing page of an ads export, the hops the fetcher recorded when
 * the page was asked for with one ad's campaign tags. The requests are made before the check runs
 * (ads/check.ts), so the same hops always give the same findings.
 */
export interface CampaignTagsInput {
  probes: readonly TagProbe[];
}

const TITLE = "Campaign tags are lost";

/** An address from the checked site, for one line of evidence: no query, escaped, cut. */
const shown = (address: string): string => escapeInvisible(withoutQuery(address), 120);

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

function evidenceFor(probe: TagProbe): string | undefined {
  const survival = tagSurvival(probe.hops);
  const loss = survival.lostAt;
  if (!loss) return undefined;
  const money = probe.spend.map((s) => formatMoney({ amount: s.amount, currency: s.currency }));
  const parts = [
    `At hop ${loss.hop}, the ${loss.status} from ${shown(loss.from)} to ${shown(loss.to)} drops ${loss.keys.join(", ")}.`,
    `${probe.ads} ${plural(probe.ads, "ad sends", "ads send")} people to this page${money.length > 0 ? `, with ${money.join(" + ")} spent on it` : ""}.`,
  ];
  const later = Object.keys(survival.sent).filter(
    (k) => survival.arrived[k] !== survival.sent[k] && !loss.keys.includes(k),
  );
  if (later.length > 0)
    parts.push(
      `${later.join(", ")} ${plural(later.length, "is", "are")} also missing by the last page.`,
    );
  if (loss.inFragment) parts.push(fragmentNote(loss.inFragment));
  if (probe.source === "probe")
    parts.push(
      `No ad that links here carries tags, so the page was followed with Gaugeline's own values, not yours (${Object.entries(
        PROBE_TAGS,
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}).`,
    );
  return parts.join(" ");
}

export const campaignFieldsLost = defineCheck<CampaignTagsInput>({
  id: "campaign-fields-lost",
  area: "Visitors",
  severity: "high",
  title: TITLE,
  what: "A redirect between the ad and its landing page drops utm_source, utm_campaign, gclid or fbclid.",
  why: "The visit arrives with no sign of the ad that paid for it, so the report credits nobody, the campaign looks like it did nothing and the money is spent without a way to learn from it.",
  fix: "Make the redirect pass the query string on, or point the ad straight at the final address.",
  tech: "Per landing page, one GET of the destination with one ad's own campaign keys (utm_*, gclid, fbclid) or, when none of its ads has any, utm_source=gaugeline-check and gclid=test; the keys on the first address against the last, values compared after URL decoding and order ignored; the first redirect whose Location no longer carries a lost key is named with its status; a key moved into the fragment counts as lost; a trail that stopped early without a loss is could-not-check",
  run: (input, ctx) => {
    const findings: Finding[] = [];
    for (const probe of input.probes) {
      const last = probe.hops.at(-1);
      const text = evidenceFor(probe);
      if (text !== undefined)
        findings.push({
          checkId: "campaign-fields-lost",
          severity: "high",
          title: TITLE,
          evidence: text,
          url: probe.url,
        });
      else if (probe.error !== undefined || last === undefined)
        ctx.couldNotCheck?.(
          probe.url,
          `the redirects could not be followed to the end${probe.error ? `: ${probe.error}` : ""}`,
        );
    }
    return findings;
  },
});

/** The campaign tag checks, which read an ads export's landing pages and not one page. */
export const CAMPAIGN_CHECKS: readonly Check<CampaignTagsInput>[] = [campaignFieldsLost];

export function createCampaignRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of CAMPAIGN_CHECKS) registry.register(c);
  return registry;
}
