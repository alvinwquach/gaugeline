/**
 * Analytics, advertising and session-replay hosts a rendered page may never reach. A rendered run loads the
 * page the way a visitor would, and a visitor's page view is a hit in the site's analytics: Gaugeline must
 * add none. A request to one of these is aborted and recorded (ADR-0009, owner decision of 13 Nov 2026), and
 * no setting turns the list off.
 *
 * The tracker checks' fingerprint table (trackers/fingerprints.ts) matches script text, not hosts, so there
 * was no host list to share: this is the hosts of the same trackers, plus the common collection endpoints
 * of the analytics tools sites use. A test names every fingerprinted kind and asserts a host here covers it.
 *
 * An entry is a host (it also covers every subdomain) and, for a host the site may use for other things,
 * a path. An entry with a path and no host is an analytics file or endpoint a site serves from its own
 * address (a tag manager proxied through the site, Vercel's and Cloudflare's collection endpoints, a
 * self-hosted Matomo): it is blocked on any host. A path matches itself and everything under it.
 *
 * What this cannot do: a first-party analytics endpoint under a name it does not list is not recognised, so
 * a rendered page's own requests to the site's own analytics may still arrive (through the gate, as GET or
 * HEAD). The docs say so.
 */
export interface DenyEntry {
  /** Absent: any host (a same-origin path). */
  host?: string;
  /** Only requests at this path or under it. */
  path?: string;
}

const e = (host: string, path?: string): DenyEntry =>
  path === undefined ? { host } : { host, path };
const own = (path: string): DenyEntry => ({ path });

export const ANALYTICS_HOSTS: readonly DenyEntry[] = Object.freeze([
  // Google
  e("google-analytics.com"),
  e("analytics.google.com"),
  e("googletagmanager.com"),
  e("googleadservices.com"),
  e("googlesyndication.com"),
  e("doubleclick.net"),
  e("google.com", "/g/collect"),
  e("google.com", "/ccm/collect"),
  e("google.com", "/pagead"),
  // Advertising pixels
  e("connect.facebook.net"),
  e("facebook.com", "/tr"),
  e("snap.licdn.com"),
  e("px.ads.linkedin.com"),
  e("ads.linkedin.com"),
  e("analytics.tiktok.com"),
  e("business-api.tiktok.com"),
  e("ads-twitter.com"),
  e("analytics.twitter.com"),
  e("ct.pinterest.com"),
  e("bat.bing.com"),
  e("static.criteo.net"),
  // Session replay and heatmaps
  e("hotjar.com"),
  e("hotjar.io"),
  e("clarity.ms"),
  e("fullstory.com"),
  e("logrocket.io"),
  e("lr-ingest.io"),
  e("lr-in.com"),
  e("mouseflow.com"),
  // Product analytics and tag platforms
  e("segment.com"),
  e("segment.io"),
  e("mixpanel.com"),
  e("amplitude.com"),
  e("heap.io"),
  e("heapanalytics.com"),
  e("plausible.io"),
  e("usefathom.com"),
  e("omtrdc.net"),
  e("demdex.net"),
  // Marketing automation tracking code (the providers the lead checks recognise)
  e("hs-scripts.com"),
  e("hs-analytics.net"),
  e("hsforms.com", "/embed"),
  e("track.hubspot.com"),
  e("pi.pardot.com"),
  e("munchkin.marketo.net"),
  // Others a site loads: Yandex Metrica, Cloudflare Web Analytics, Vercel, Matomo and Piwik hosted
  e("mc.yandex.ru"),
  e("mc.yandex.com"),
  e("cloudflareinsights.com"),
  e("vercel-insights.com"),
  e("matomo.cloud"),
  e("piwik.pro"),
  // The same files and endpoints, served from the site's own address
  own("/gtm.js"),
  own("/gtag/js"),
  own("/_vercel/insights"),
  own("/_vercel/speed-insights"),
  own("/matomo.js"),
  own("/matomo.php"),
  own("/piwik.js"),
  own("/piwik.php"),
  own("/cdn-cgi/rum"),
  own("/cdn-cgi/beacon"),
]);

const atPath = (pathname: string, path: string): boolean =>
  pathname === path || pathname.startsWith(`${path}/`);

/** Whether a request is to an analytics, advertising or session-replay host, or an analytics path. */
export function isAnalyticsRequest(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return ANALYTICS_HOSTS.some(
    (entry) =>
      (entry.host === undefined || host === entry.host || host.endsWith(`.${entry.host}`)) &&
      (entry.path === undefined || atPath(url.pathname, entry.path)),
  );
}
