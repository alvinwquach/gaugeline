import {
  ConfigError,
  PROBE_TAGS,
  campaignTags,
  createFetcher,
  describeTrail,
  tagSurvival,
  withCampaignTags,
  FetchError,
  type FetcherOptions,
  type Hop,
  type Outcome,
} from "@gaugeline/core";

/** What the command does not see, printed under every verdict. */
export const TAGS_LIMIT =
  "This follows redirects only. It does not run the page's JavaScript, so a script that rewrites the address after the page loads is out of scope.";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * gaugeline tags <link>: follow an ad link through every redirect, print one line per hop with the
 * campaign tags still on it, then one verdict. The hops are the fetcher's own (GET only, private
 * addresses refused unless --allow-private); the comparison is core's tagSurvival, the same one the
 * ads command uses. A link with no campaign tags is followed with Gaugeline's own and says so.
 */
export async function runTags(
  args: { address: string; allowPrivate: boolean },
  io: { stdout: { write(s: string): unknown } },
  deps: { fetcher?: FetcherOptions },
): Promise<Outcome> {
  const typed = args.address.trim();
  const hasScheme = SCHEME.test(typed);
  let url: URL;
  try {
    url = new URL(hasScheme ? typed : `https://${typed}`);
  } catch {
    throw new ConfigError(`"${args.address}" is not an address.`, {
      hint: "Paste the link the ad sends people to, for example shop.example/go?utm_source=x.",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ConfigError(`gaugeline tags follows web addresses, not ${url.protocol}`, {
      hint: "Paste an address that starts with https:// or http://.",
    });
  const probing = Object.keys(campaignTags(url.href)).length === 0;
  const asked = probing ? withCampaignTags(url.href, PROBE_TAGS) : url.href;
  const fetcher = createFetcher({
    ...deps.fetcher,
    ...(args.allowPrivate ? { allowPrivate: true, target: asked } : {}),
  });

  let hops: Hop[];
  let stopped: string | undefined;
  try {
    // A bare domain is tried as https first, then http, like the page check.
    hops = await fetcher.getSite(hasScheme ? asked : asked.replace(/^https:\/\//, ""));
  } catch (err) {
    if (!(err instanceof FetchError) || err.hops.length === 0) throw err;
    hops = err.hops;
    stopped = err.message;
  }

  const survival = tagSurvival(hops);
  const text = describeTrail(hops, survival);
  const out: string[] = [];
  if (probing)
    out.push(
      `This link carries no campaign tags, so it was followed with Gaugeline's own: ${Object.entries(
        PROBE_TAGS,
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}.`,
    );
  out.push(...text.hops, text.verdict, ...text.notes);
  if (stopped !== undefined) out.push(`The trail stopped early: ${stopped}`);
  out.push(TAGS_LIMIT);
  io.stdout.write(`${out.join("\n")}\n`);

  const lost = survival.lostAt !== undefined;
  return {
    kind: "ran",
    highFindings: lost ? 1 : 0,
    drift: false,
    // A trail that ended in an error without showing a loss has not been followed to its end.
    incomplete: stopped !== undefined && !lost,
  };
}
