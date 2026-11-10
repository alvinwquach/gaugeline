import { createCampaignRegistry } from "../checks/campaign-fields-lost.js";
import { FetchError, type Fetcher } from "../fetcher.js";
import { NetworkError } from "../errors.js";
import type { Finding } from "../model.js";
import type { CouldNotCheck } from "../runner.js";
import { runChecks } from "../run.js";
import type { Destination } from "./export.js";
import { PROBE_TAGS, withCampaignTags, type TagProbe } from "./tags.js";

/**
 * The checks of the ads command that need the pages. Each landing page is asked for once, with one
 * ad's own campaign tags (or Gaugeline's, when none of its ads has any), through the run's fetcher:
 * GET only, five at a time, private addresses refused. The hops are kept on the probe so the checks
 * that come after this one (a page that does not load, a sold-out product) read the same answers
 * and ask for nothing twice.
 */
export interface AdsCheckOutcome {
  findings: Finding[];
  /** Ids of the checks that ran over every page and found nothing. */
  passed: string[];
  /** Ids of checks that threw; the run goes on without them. */
  failed: string[];
  couldNotCheck: CouldNotCheck[];
  /** One per destination, in the export's order. */
  probes: TagProbe[];
}

/** The first ad that carries any tags gives the values: its real ones are what the marketer will be paying for. */
function chooseTags(d: Destination): {
  source: TagProbe["source"];
  tags: Record<string, string>;
} {
  const own = d.tags.find((t) => Object.keys(t).length > 0);
  return own ? { source: "export", tags: own } : { source: "probe", tags: { ...PROBE_TAGS } };
}

async function probe(d: Destination, fetcher: Fetcher): Promise<TagProbe> {
  const { source, tags } = chooseTags(d);
  const spend = [...d.spendByCurrency].map(([currency, amount]) => ({ currency, amount }));
  const base = { url: d.url, source, tags, ads: d.ads.length, spend };
  let requested = d.url;
  try {
    requested = withCampaignTags(d.url, tags);
    return { ...base, requested, hops: await fetcher.get(requested) };
  } catch (err) {
    if (err instanceof FetchError)
      return { ...base, requested, hops: err.hops, error: err.message };
    if (err instanceof NetworkError || err instanceof TypeError)
      return { ...base, requested, hops: [], error: err.message };
    throw err;
  }
}

/**
 * Ask for every destination once, then run the checks over what came back. Requests are made
 * together and the fetcher lets five through at a time.
 */
export async function checkAdLandingPages(
  groups: ReadonlyMap<string, Destination>,
  ctx: { fetcher: Fetcher },
): Promise<AdsCheckOutcome> {
  const probes = await Promise.all([...groups.values()].map((d) => probe(d, ctx.fetcher)));
  const ran = await runChecks({ probes }, createCampaignRegistry());
  // With nothing to ask about, the check has not passed: it has not run.
  const passed = probes.length === 0 ? [] : ran.passed;
  return {
    findings: ran.findings,
    passed,
    failed: ran.failed.map((f) => f.id),
    couldNotCheck: ran.couldNotCheck,
    probes,
  };
}
