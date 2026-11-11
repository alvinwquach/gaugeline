/**
 * Preview and deploy addresses of four hosts (Vercel, Netlify, Cloudflare Pages, AWS Amplify):
 * pure string rules, no requests. A preview address is a copy of the site the host makes for a
 * commit, a branch or a pull request; it is not the site's live address.
 *
 * Patterns, with where they come from (docs reachable 11 Nov 2026 only through search snippets):
 * - Netlify: `deploy-preview-<n>--<site>.netlify.app` (deploy previews) and
 *   `<branch>--<site>.netlify.app` (branch deploys) [docs: docs.netlify.com/deploy/deploy-types/];
 *   `<deploy id>--<site>` for one deploy (24 hex characters, as in the agent run example: uncited).
 * - Cloudflare Pages: `<hash>.<project>.pages.dev` and `<branch>.<project>.pages.dev`
 *   [docs: developers.cloudflare.com/pages/configuration/preview-deployments/]; the hash is 8 hex
 *   characters (uncited).
 * - Amplify: `pr-<n>.<app id>.amplifyapp.com` and `<branch>.<app id>.amplifyapp.com`
 *   [docs: docs.aws.amazon.com/amplify/latest/userguide/pr-previews.html].
 * - Vercel: `<project>-<hash>-<team>.vercel.app` and `<project>-git-<branch>-<team>.vercel.app`
 *   (task brief; the 9-character hash is uncited, so a name only counts when the hash holds a digit).
 * A project's own address (`project.vercel.app`, `site.netlify.app`) is not a preview address, and
 * neither is a branch named main, master, prod or production: those are the live copy's aliases.
 */
import type { SiteContext } from "./site-context.js";
import type { PageSnapshot } from "./snapshot.js";

export type PreviewVendor = "vercel" | "netlify" | "cloudflare-pages" | "amplify";
export type PreviewKind = "deploy" | "branch" | "pull-request" | "preview";

export interface PreviewAddress {
  vendor: PreviewVendor;
  kind: PreviewKind;
  /** The lower-case host, no trailing dot. */
  host: string;
}

export const VENDOR_NAMES: Readonly<Record<PreviewVendor, string>> = Object.freeze({
  vercel: "Vercel",
  netlify: "Netlify",
  "cloudflare-pages": "Cloudflare Pages",
  amplify: "AWS Amplify",
});

const LIVE_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "prod", "production"]);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** What is left of `host` before `.suffix`, or undefined when it does not end exactly there. */
function under(host: string, suffix: string): string | undefined {
  return host.endsWith(`.${suffix}`) ? host.slice(0, -(suffix.length + 1)) : undefined;
}

function vercel(sub: string): PreviewKind | undefined {
  if (sub.includes(".") || !LABEL.test(sub)) return undefined;
  // The branch and the team share one run of characters, so a branch named main cannot be told apart.
  if (/-git-[a-z0-9-]+$/.test(sub)) return "branch";
  // <project>-<hash>[-<team>]: a 9-character token that has a digit, so a word is not a hash.
  const parts = sub.split("-");
  const at = parts.findIndex(
    (p, i) => i > 0 && p.length === 9 && /^[a-z0-9]+$/.test(p) && /\d/.test(p),
  );
  return at > 0 ? "deploy" : undefined;
}

function netlify(sub: string): PreviewKind | undefined {
  if (sub.includes(".") || !LABEL.test(sub) || sub.startsWith("xn--")) return undefined;
  const cut = sub.indexOf("--");
  if (cut <= 0 || cut + 2 >= sub.length) return undefined;
  const lead = sub.slice(0, cut);
  if (/^deploy-preview-\d+$/.test(lead)) return "pull-request";
  if (/^[0-9a-f]{24}$/.test(lead) || /^agent-[0-9a-f]{24}$/.test(lead)) return "deploy";
  return LIVE_BRANCHES.has(lead) ? undefined : "branch";
}

/** Two labels under the suffix: `<first>.<project or app id>`. */
function twoLabels(sub: string): { first: string } | undefined {
  const labels = sub.split(".");
  if (labels.length !== 2 || !labels.every((l) => LABEL.test(l))) return undefined;
  return { first: labels[0] ?? "" };
}

function pages(sub: string): PreviewKind | undefined {
  const two = twoLabels(sub);
  if (!two) return undefined;
  if (/^[0-9a-f]{8}$/.test(two.first)) return "deploy";
  return LIVE_BRANCHES.has(two.first) ? undefined : "branch";
}

function amplify(sub: string): PreviewKind | undefined {
  const two = twoLabels(sub);
  if (!two) return undefined;
  if (/^pr-\d+$/.test(two.first)) return "pull-request";
  return LIVE_BRANCHES.has(two.first) ? undefined : "branch";
}

/** The preview address a host name is, or undefined. Pass a host name, as URL gives it. */
export function classifyPreviewHost(hostname: string): PreviewAddress | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const rules: [string, PreviewVendor, (sub: string) => PreviewKind | undefined][] = [
    ["vercel.app", "vercel", vercel],
    ["netlify.app", "netlify", netlify],
    ["pages.dev", "cloudflare-pages", pages],
    ["amplifyapp.com", "amplify", amplify],
  ];
  for (const [suffix, vendor, rule] of rules) {
    const sub = under(host, suffix);
    if (sub === undefined) continue;
    const kind = rule(sub);
    return kind ? { vendor, kind, host } : undefined;
  }
  return undefined;
}

/** The preview address an http(s) URL names, or undefined. A relative or other-scheme string is not one. */
export function previewAddressOf(url: string): PreviewAddress | undefined {
  try {
    const u = new URL(url.startsWith("//") ? `https:${url}` : url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return classifyPreviewHost(u.hostname);
  } catch {
    return undefined;
  }
}

/** host and path only, never the query or a fragment: what a finding shows. */
export function hostAndPath(url: string): string {
  try {
    const u = new URL(url.startsWith("//") ? `https:${url}` : url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "";
  }
}

export function describePreview(a: PreviewAddress): string {
  const what =
    a.kind === "pull-request"
      ? "pull request preview"
      : a.kind === "branch"
        ? "branch deploy"
        : a.kind === "deploy"
          ? "deploy"
          : "preview";
  return `${VENDOR_NAMES[a.vendor]} ${what}`;
}

/** A place the live site's own markup or files name a preview address. */
export interface PreviewMention {
  where: string;
  url: string;
  address: PreviewAddress;
}

const MAX_PER_SOURCE = 2000;

export interface MentionOptions {
  /** Leave out what next-preview-canonical already reports: canonical, og:url and the sitemap. */
  skipCovered?: boolean;
  /** Also take page links (temp-host-links reports those, so the "named" check leaves them). */
  links?: boolean;
}

/**
 * Every preview address the page's own markup, the sitemaps and the feeds name, in a fixed order,
 * once per (where, address). Reads what the production site already serves; asks for nothing.
 * Each list is cut at 2000 entries so a hostile file costs a bounded scan.
 */
export function previewMentions(
  page: PageSnapshot,
  site: SiteContext | undefined,
  opts: MentionOptions = {},
): PreviewMention[] {
  const out: PreviewMention[] = [];
  const seen = new Set<string>();
  const add = (where: string, url: string | undefined) => {
    if (!url) return;
    const address = previewAddressOf(url);
    if (!address) return;
    const key = `${where}\n${hostAndPath(url)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ where, url, address });
  };
  const each = <T>(list: readonly T[] | undefined, f: (x: T) => void) => {
    for (const x of (list ?? []).slice(0, MAX_PER_SOURCE)) f(x);
  };
  if (!opts.skipCovered) {
    each(page.canonicals, (c) => add("canonical", c));
    add("og:url", page.og["og:url"]);
  }
  each(page.hreflang, (h) => add(`hreflang ${h.hreflang}`, h.href));
  each(page.scripts, (s) => add("script", s));
  each(page.feeds, (f) => add("feed link", f.href));
  if (opts.links) each(page.links, (l) => add("link", l.href));
  if (site) {
    if (!opts.skipCovered) each(site.sitemapUrls, (u) => add("sitemap", u));
    each(site.sitemapAlternates, (a) => add(`sitemap hreflang ${a.hreflang}`, a.href));
    for (const feed of site.feeds.slice(0, 50)) each(feed.itemLinks, (u) => add("feed item", u));
  }
  return out;
}

const NOINDEX = /(^|[\s,:])(noindex|none)(\s*(,|$)|$)/i;

/** True when a robots value (a meta tag's content or an X-Robots-Tag header) says noindex or none. */
export function saysNoindex(value: string | undefined): boolean {
  return value !== undefined && NOINDEX.test(value);
}
