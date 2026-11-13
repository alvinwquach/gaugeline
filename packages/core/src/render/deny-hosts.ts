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
 * a path prefix.
 */
export interface DenyEntry {
  host: string;
  /** Only requests whose path starts with this. */
  path?: string;
}

const e = (host: string, path?: string): DenyEntry =>
  path === undefined ? { host } : { host, path };

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
]);

/** Whether a request is to an analytics, advertising or session-replay host. */
export function isAnalyticsRequest(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return ANALYTICS_HOSTS.some(
    (entry) =>
      (host === entry.host || host.endsWith(`.${entry.host}`)) &&
      (entry.path === undefined || url.pathname.startsWith(entry.path)),
  );
}
