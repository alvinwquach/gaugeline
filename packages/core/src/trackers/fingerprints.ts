import { PROVIDERS } from "../forms/providers.js";
import type { PageSnapshot } from "../snapshot.js";

/**
 * What each tracker looks like in a page. One table, so adding a tracker is one entry and one test row.
 * Public identifiers only: a pixel id, a measurement id or a container id appears in the page's own code,
 * and that is all that is read. Nothing here reads a cookie, a request a script makes or a visitor's data.
 *
 * The patterns come from each vendor's own install snippet, written from the snippet's shape and not
 * checked against the vendor's page in the build session (the pages were unreachable): the pull
 * request marks them uncited, and every pattern has a row in fingerprints.test.ts.
 */

export type TrackerGroup =
  "advertising" | "analytics" | "tag-manager" | "session-replay" | "form-provider";

export interface Fingerprint {
  kind: string;
  /** What the report calls it: "Meta pixel". */
  label: string;
  group: TrackerGroup;
  /** Matched in a script's address and in the code of an inline script. A named group `id` is the identifier. */
  script: readonly RegExp[];
  /** Matched in the page's HTML, for the tag a visitor with JavaScript off gets (noscript). */
  markup?: readonly RegExp[];
  /** Matched only in a tag manager container's code, where tags are stored as text. */
  container?: readonly RegExp[];
}

const ID = {
  digits: "\\d{6,20}",
  tiktok: "[A-Z0-9]{10,30}",
  ga4: "G-[A-Z0-9]{6,12}",
  gtm: "GTM-[A-Z0-9]{4,10}",
} as const;

const g = (source: string, flags = "gi"): RegExp => new RegExp(source, flags);

const OWN: readonly Fingerprint[] = [
  {
    kind: "meta-pixel",
    label: "Meta pixel",
    group: "advertising",
    script: [
      g("connect\\.facebook\\.net/[^/\"'\\s]+/fbevents\\.js"),
      g(`\\bfbq\\(\\s*['"]init['"]\\s*,\\s*['"]?(?<id>${ID.digits})`),
    ],
    markup: [g(`facebook\\.com/tr/?\\?[^"'\\s>]*?\\bid=(?<id>${ID.digits})`)],
  },
  {
    kind: "tiktok-pixel",
    label: "TikTok pixel",
    group: "advertising",
    script: [
      g("analytics\\.tiktok\\.com/i18n/pixel/(?:events|sdk)\\.js"),
      g(`i18n/pixel/(?:events|sdk)\\.js\\?sdkid=(?<id>${ID.tiktok})`),
      g(`\\bttq\\.load\\(\\s*['"](?<id>${ID.tiktok})['"]`),
    ],
  },
  {
    kind: "linkedin-insight",
    label: "LinkedIn Insight Tag",
    group: "advertising",
    script: [
      g("snap\\.licdn\\.com/li\\.lms-analytics/insight(?:\\.min)?\\.js"),
      g("\\b_linkedin_partner_id\\s*=\\s*['\"]?(?<id>\\d{4,12})"),
      g("\\b_linkedin_data_partner_ids\\s*(?:\\.push\\(|=\\s*\\[)\\s*['\"]?(?<id>\\d{4,12})"),
    ],
    markup: [g("px\\.ads\\.linkedin\\.com/collect/?\\?[^\"'\\s>]*?\\bpid=(?<id>\\d{4,12})")],
  },
  {
    kind: "ga4",
    label: "Google Analytics 4",
    group: "analytics",
    script: [
      g(`googletagmanager\\.com/gtag/js\\?(?:[^"'\\s]*?&(?:amp;)?)?id=(?<id>${ID.ga4})`),
      g(`\\bgtag\\(\\s*['"]config['"]\\s*,\\s*['"](?<id>${ID.ga4})['"]`),
    ],
    container: [g(`\\bvtp_measurementId(?:Override)?["']?\\s*:\\s*["'](?<id>${ID.ga4})["']`)],
  },
  {
    kind: "gtm",
    label: "Google Tag Manager container",
    group: "tag-manager",
    script: [
      g(`googletagmanager\\.com/gtm\\.js\\?(?:[^"'\\s]*?&(?:amp;)?)?id=(?<id>${ID.gtm})`),
      g(`['"]script['"]\\s*,\\s*['"]\\w+['"]\\s*,\\s*['"](?<id>${ID.gtm})['"]`),
    ],
    markup: [g(`googletagmanager\\.com/ns\\.html\\?id=(?<id>${ID.gtm})`)],
  },
  {
    kind: "hotjar",
    label: "Hotjar session replay",
    group: "session-replay",
    script: [
      g("static\\.hotjar\\.com/c/hotjar-(?<id>\\d{4,10})\\.js"),
      g("\\bhjid\\s*:\\s*(?<id>\\d{4,10})"),
    ],
  },
  {
    kind: "clarity",
    label: "Microsoft Clarity session replay",
    group: "session-replay",
    script: [
      g("clarity\\.ms/tag/(?<id>[a-z0-9]{8,12})\\b"),
      g("clarity\\.ms/tag/"),
      g("['\"]clarity['\"]\\s*,\\s*['\"]script['\"]\\s*,\\s*['\"](?<id>[a-z0-9]{8,12})['\"]"),
    ],
  },
  {
    kind: "fullstory",
    label: "FullStory session replay",
    group: "session-replay",
    script: [
      g("(?:edge\\.)?fullstory\\.com/s/fs\\.js"),
      g("\\b_fs_org\\s*=\\s*['\"](?<id>[A-Z0-9]{3,12})['\"]"),
    ],
  },
  {
    kind: "logrocket",
    label: "LogRocket session replay",
    group: "session-replay",
    script: [
      g("cdn\\.(?:lr-ingest\\.io|logrocket\\.io|lr-in\\.com)/LogRocket\\.min\\.js"),
      g("\\bLogRocket\\.init\\(\\s*['\"](?<id>[a-z0-9]{4,12}/[a-z0-9-]{1,40})['\"]"),
    ],
  },
  {
    kind: "mouseflow",
    label: "Mouseflow session replay",
    group: "session-replay",
    script: [g("cdn\\.mouseflow\\.com/projects/(?<id>[0-9a-f-]{36})\\.js")],
  },
];

/**
 * The tracking code of the form services the lead checks already recognise (HubSpot, Pardot, Marketo): the
 * same expression, read from each provider's own record, so there is one list of what a tracking script
 * looks like. These have no identifier in the pattern.
 */
const FROM_FORM_PROVIDERS: readonly Fingerprint[] = PROVIDERS.flatMap((p) =>
  p.trackingScript
    ? [
        {
          kind: `${p.id}-tracking`,
          label: `${p.label} tracking code`,
          group: "form-provider" as const,
          script: [new RegExp(p.trackingScript.source, "gi")],
        },
      ]
    : [],
);

export const FINGERPRINTS: readonly Fingerprint[] = Object.freeze([...OWN, ...FROM_FORM_PROVIDERS]);

/** One tracker found: its kind, the identifiers read from the code (sorted, once each) and how it was seen. */
export interface Tracker {
  kind: string;
  label: string;
  group: TrackerGroup;
  ids: string[];
  /** "script": a script address or the code of a script. "markup": only in the HTML (a noscript tag). */
  how: "script" | "markup";
}

/** An identifier is at most this long, so nothing but an id can be carried into a finding. */
const ID_MAX = 64;

interface Hit {
  scriptSeen: boolean;
  ids: Set<string>;
}

function scan(
  texts: readonly string[],
  patterns: readonly RegExp[] | undefined,
  into: Hit,
  asScript: boolean,
): void {
  for (const pattern of patterns ?? [])
    for (const text of texts)
      for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
        if (asScript) into.scriptSeen = true;
        const id = m.groups?.["id"];
        if (id !== undefined && id.length <= ID_MAX) into.ids.add(id);
      }
}

function collect(
  scripts: readonly string[],
  markup: readonly string[],
  container: boolean,
): Tracker[] {
  const out: Tracker[] = [];
  for (const f of FINGERPRINTS) {
    const script: Hit = { scriptSeen: false, ids: new Set() };
    const html: Hit = { scriptSeen: false, ids: new Set() };
    scan(scripts, f.script, script, true);
    scan(markup, f.markup, html, false);
    if (container) {
      scan(scripts, f.container, script, true);
      scan(scripts, f.markup, script, true);
    }
    const seen = script.scriptSeen || script.ids.size > 0;
    const ids = [...new Set([...script.ids, ...html.ids])].sort();
    const inHtml = html.ids.size > 0;
    if (!seen && !inHtml) continue;
    out.push({
      kind: f.kind,
      label: f.label,
      group: f.group,
      ids,
      how: seen ? "script" : "markup",
    });
  }
  return out;
}

/**
 * The trackers on a page, in the table's order: from every script address and every inline script, and, for the
 * noscript fallback tags, the page's HTML. Reads what the snapshot kept; sends nothing. A tag a script adds
 * after the page loads is not seen.
 */
export function findTrackers(page: PageSnapshot): Tracker[] {
  const scripts = (page.scriptTags ?? []).map((t) => t.src ?? t.inline ?? "");
  const markup = page.hops.at(-1)?.body ?? "";
  return collect(scripts, [markup], false);
}

/** The ids of the Google Tag Manager containers a page loads, sorted. */
export function containerIds(trackers: readonly Tracker[]): string[] {
  return trackers.find((t) => t.kind === "gtm")?.ids ?? [];
}

/**
 * GTM stores each custom tag's HTML as a string: quotes, angle brackets and slashes come as \x27, \u0027,
 * \" and the like. They are put back before matching, so the tag reads as it was written.
 */
export function decodeContainer(text: string): string {
  return text
    .replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["'/])/g, "$1");
}

/** The trackers a tag manager container's code holds. The container is text; none of it is run. */
export function findTrackersInContainer(text: string): Tracker[] {
  const decoded = decodeContainer(text);
  // A container does not hold itself: a GTM id inside it is another container's, not a tracker to list.
  return collect([decoded], [decoded], true).filter((t) => t.kind !== "gtm");
}
