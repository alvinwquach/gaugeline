import type { CheckContext, Finding, Severity } from "../model.js";
import { PROVIDERS, detectForms } from "../forms/providers.js";
import type { FormProvider, FormProviderId, FormSighting } from "../forms/types.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

/**
 * What the form checks share: one reading of the page's sightings (G25) and tracking tags, and the
 * wording for them. Every function reads the snapshot only and sends no request, so the same page
 * always gives the same findings. The checks themselves are in their own files, one id each.
 */

/** Providers by id, so a sighting finds its label and its tracking pattern in one lookup. */
const BY_ID: ReadonlyMap<FormProviderId, FormProvider> = new Map(PROVIDERS.map((p) => [p.id, p]));

/** Providers whose forms post a lead into a CRM that maps campaign fields (the spec's four). */
const CAMPAIGN_PROVIDERS: ReadonlySet<FormProviderId> = new Set([
  "pardot",
  "salesforce-web-to-lead",
  "hubspot",
  "marketo",
]);

/** The tracking script of a provider on the page, where it sits, and whether a window load starts it. */
export type TrackingTag = {
  provider: FormProviderId;
  position: number;
  src?: string;
  onLoad: boolean;
};

/**
 * Inline code that waits for the window's load event: addEventListener("load"), attachEvent("onload"),
 * window.onload = and jQuery's $(window).on("load"). The standard Pardot snippet is one.
 */
const WINDOW_LOAD =
  /\b(?:addEventListener|attachEvent)\s*\(\s*['"](?:on)?load['"]|\bwindow\s*\.\s*onload\s*=|\$\(\s*window\s*\)\s*\.\s*on\s*\(\s*['"]load/i;

/** Every script that is a recognised tracking code, in document order. */
export function trackingTags(page: PageSnapshot): TrackingTag[] {
  const out: TrackingTag[] = [];
  for (const tag of page.scriptTags ?? []) {
    const text = tag.src ?? tag.inline ?? "";
    for (const p of PROVIDERS) {
      if (!p.trackingScript?.test(text)) continue;
      out.push({
        provider: p.id,
        position: tag.position,
        ...(tag.src === undefined ? {} : { src: tag.src }),
        onLoad: tag.inline !== undefined && WINDOW_LOAD.test(tag.inline),
      });
    }
  }
  return out.sort((a, b) => a.position - b.position);
}

/** A field name with case, spaces, hyphens and underscores removed: "Lead_Source" is "leadsource". */
const flat = (name: string): string => name.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Does a form carry something that records where the lead came from? Any hidden input named utm_*,
 * gclid or a lead source, or one of the provider's own default mapped fields. Case is ignored. Only
 * hidden field names are passed in, so a visible input named utm_source never counts.
 */
export function hasCampaignField(hidden: readonly string[], provider: FormProviderId): boolean {
  const own = new Set((BY_ID.get(provider)?.campaignFields ?? []).map(flat));
  return hidden.some((raw) => {
    const name = raw.trim().toLowerCase();
    return (
      name.startsWith("utm_") ||
      name === "gclid" ||
      flat(name) === "leadsource" ||
      own.has(flat(name))
    );
  });
}

/** An address for one line of evidence: no query or fragment, escaped, cut. */
function plain(address: string | undefined): string {
  if (address === undefined) return "";
  let shown: string;
  try {
    const u = new URL(address);
    shown = `${u.origin}${u.pathname}`;
  } catch {
    shown = address.split(/[?#]/)[0] ?? address;
  }
  return escapeInvisible(shown, 120);
}

export const labelOf = (id: FormProviderId | "unknown"): string =>
  id === "unknown" ? "Form" : (BY_ID.get(id)?.label ?? id);

/** "iframe https://...", "form posting to https://..." */
function where(s: FormSighting): string {
  if (s.kind === "iframe") return `iframe ${plain(s.src)}`;
  if (s.kind === "embed-script")
    return s.src ? `form script ${plain(s.src)}` : "inline form script";
  return s.action ? `form posting to ${plain(s.action)}` : "form";
}

/** A form or an iframe, as against the script that draws one. */
const isForm = (s: FormSighting): boolean => s.kind !== "embed-script";

/** Names in a sentence: "A", "A and B", "A, B and C". */
function joined(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** The evidence of one finding. `findings` wraps each into the check's Finding. */
export type Hit = string;

export function findings(
  meta: { id: string; severity: Severity; title: string },
  hits: readonly Hit[],
  url: string,
): Finding[] {
  return hits.map((evidence) => ({
    checkId: meta.id,
    severity: meta.severity,
    title: meta.title,
    evidence,
    url,
  }));
}

/**
 * Providers whose embed script is on the page and whose form is not in the HTML: drawn by JavaScript
 * after the page loads. Gaugeline does not run it, so a check says so instead of guessing.
 */
export function drawnByScript(
  sightings: readonly FormSighting[],
  wanted: (id: FormProviderId) => boolean,
): FormProviderId[] {
  const inHtml = new Set<string>(sightings.filter(isForm).map((s) => s.provider));
  const ids = new Set<FormProviderId>();
  for (const s of sightings) {
    if (s.kind !== "embed-script" || s.provider === "unknown") continue;
    if (!inHtml.has(s.provider) && wanted(s.provider)) ids.add(s.provider);
  }
  return [...ids];
}

export const jsReason = (id: FormProviderId, rest: string): string =>
  `the ${labelOf(id)} form is drawn by JavaScript (its embed script is on the page, its form is not in the HTML), so it is not visible without running JavaScript; ${rest}`;

const hasTrackingCode = (id: FormProviderId): boolean =>
  BY_ID.get(id)?.trackingScript !== undefined;

/** crm-no-tracking: a provider's form is on the page and that provider's tracking code is not. */
export function noTracking(page: PageSnapshot, ctx: CheckContext): Hit[] {
  if (!isHtmlPage(page)) return [];
  const sightings = detectForms(page);
  const tracked = new Set(trackingTags(page).map((t) => t.provider));
  const hits: Hit[] = [];
  for (const s of sightings) {
    if (!isForm(s) || s.provider === "unknown" || !hasTrackingCode(s.provider)) continue;
    if (tracked.has(s.provider)) continue;
    hits.push(`${labelOf(s.provider)} ${where(s)}: its tracking code is not on the page.`);
  }
  for (const id of drawnByScript(sightings, (p) => hasTrackingCode(p) && !tracked.has(p)))
    ctx.couldNotCheck?.(
      page.finalUrl,
      jsReason(id, "Gaugeline does not say its tracking code is missing"),
    );
  return hits;
}

/**
 * crm-late-tracking: the tracking code sits after the form in document order, or a window load
 * handler starts it while the form is an iframe (an iframe loads before the handler runs).
 */
export function lateTracking(page: PageSnapshot, ctx: CheckContext): Hit[] {
  if (!isHtmlPage(page)) return [];
  const sightings = detectForms(page);
  const tags = trackingTags(page);
  const hits: Hit[] = [];
  for (const s of sightings) {
    if (!isForm(s) || s.provider === "unknown") continue;
    const mine = tags.filter((t) => t.provider === s.provider);
    if (mine.length === 0) continue;
    const before = mine.filter((t) => t.position < s.position);
    if (before.some((t) => !(s.kind === "iframe" && t.onLoad))) continue;
    const reason =
      before.length > 0
        ? "its tracking code is loaded by a window load handler, so it starts after the iframed form has loaded."
        : "its tracking code comes after the form in the page's HTML.";
    hits.push(
      `${labelOf(s.provider)} ${where(s)}: ${reason} Load the tracking script in the head, before the form.`,
    );
  }
  const tracked = new Set(tags.map((t) => t.provider));
  for (const id of drawnByScript(sightings, (p) => tracked.has(p)))
    ctx.couldNotCheck?.(
      page.finalUrl,
      jsReason(id, "Gaugeline cannot say whether its tracking code loads first"),
    );
  return hits;
}

const PLAIN_HTTP = /^http:\/\//i;

/**
 * crm-insecure: an http address in a form action, a recognised iframe src, an embed script or a
 * tracking script, on an https page. Only a script's src is read, never the code in an inline
 * script (Pardot's own snippet names an http address for the pages that are not https).
 */
export function insecure(page: PageSnapshot): Hit[] {
  if (!isHtmlPage(page) || !/^https:/i.test(page.finalUrl)) return [];
  const sightings = detectForms(page);
  const found: { position: number; evidence: string }[] = [];
  const reported = new Set<number>();
  for (const s of sightings) {
    const address = s.kind === "form" ? s.action : s.src;
    if (address === undefined || !PLAIN_HTTP.test(address)) continue;
    const subject =
      s.kind === "form"
        ? `${labelOf(s.provider)}${s.provider === "unknown" ? "" : " form"} action`
        : s.kind === "iframe"
          ? `${labelOf(s.provider)} iframe`
          : `${labelOf(s.provider)} form script`;
    reported.add(s.position);
    found.push({
      position: s.position,
      evidence: `${subject} ${plain(address)} is plain http on an https page.`,
    });
  }
  const present = new Set<string>(sightings.map((s) => s.provider));
  for (const t of trackingTags(page)) {
    if (t.src === undefined || !PLAIN_HTTP.test(t.src) || !present.has(t.provider)) continue;
    if (reported.has(t.position)) continue;
    found.push({
      position: t.position,
      evidence: `${labelOf(t.provider)} tracking script ${plain(t.src)} is plain http on an https page.`,
    });
  }
  return found.sort((a, b) => a.position - b.position).map((f) => f.evidence);
}

/** How many hidden field names a line of evidence lists before it says "and N more". */
const FIELDS_SHOWN = 10;

function fieldList(names: readonly string[]): string {
  if (names.length === 0) return "none";
  const shown = names.slice(0, FIELDS_SHOWN).map((n) => escapeInvisible(n, 40));
  return names.length > FIELDS_SHOWN
    ? `${shown.join(", ")} and ${names.length - FIELDS_SHOWN} more`
    : shown.join(", ");
}

/**
 * crm-no-campaign-fields: a form posting to Pardot, Web-to-Lead, HubSpot or Marketo with no utm_*,
 * gclid or lead source input among its hidden fields. An iframe holds another document: it is
 * could-not-check, never a pass or a fail.
 */
export function noCampaignFields(page: PageSnapshot, ctx: CheckContext): Hit[] {
  if (!isHtmlPage(page)) return [];
  const sightings = detectForms(page);
  const hits: Hit[] = [];
  for (const s of sightings) {
    if (s.provider === "unknown" || !CAMPAIGN_PROVIDERS.has(s.provider)) continue;
    if (s.kind === "iframe") {
      ctx.couldNotCheck?.(
        page.finalUrl,
        `could not see inside the embedded form: the ${labelOf(s.provider)} ${where(s)} is another document`,
      );
    } else if (s.kind === "form" && !hasCampaignField(s.hiddenFields, s.provider)) {
      hits.push(
        `${labelOf(s.provider)} ${where(s)} has no utm_*, gclid or lead source field; hidden fields found: ${fieldList(s.hiddenFields)}.`,
      );
    }
  }
  for (const id of drawnByScript(sightings, (p) => CAMPAIGN_PROVIDERS.has(p)))
    ctx.couldNotCheck?.(page.finalUrl, jsReason(id, "Gaugeline cannot read its fields"));
  return hits;
}

/** forms-many-providers: more than one provider on one page, listed in the order they appear. */
export function manyProviders(page: PageSnapshot): Hit[] {
  if (!isHtmlPage(page)) return [];
  const names = new Set<FormProviderId>();
  for (const s of detectForms(page)) if (s.provider !== "unknown") names.add(s.provider);
  if (names.size < 2) return [];
  return [
    `Forms from ${names.size} services are on this page: ${joined([...names].map(labelOf))}.`,
  ];
}
