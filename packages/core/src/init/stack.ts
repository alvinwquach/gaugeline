import { detectAdapters, signsOf, type AdapterSighting } from "./hints.js";
import { dnsName, registrableDomain, type DnsReader } from "../dns.js";
import { NetworkError } from "../errors.js";
import type { Fetcher, Hop } from "../fetcher.js";
import { hostingOf } from "../advisory/signals.js";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { PROVIDERS as FORM_PROVIDERS, detectForms } from "../forms/providers.js";
import { dnsProviderOf } from "../handoff/providers.js";
import { isNextSite } from "../next/detect.js";
import { configValue, extractPayments } from "../payments/extract.js";
import { KIND_NAME, type PaymentKind } from "../payments/types.js";
import { providerFor } from "../run-snapshot.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import { findTrackers } from "../trackers/fingerprints.js";

/** One thing the site shows, and the sign that said so. */
export interface Sighting {
  /** A stable id: an adapter id, a tracker kind, a form service. */
  id: string;
  name: string;
  /** One line a person can check by looking at the page. */
  evidence: string;
}

/** A payment detail the site shows, as `gaugeline.payments.json` writes it. */
export interface PaymentSighting {
  kind: PaymentKind;
  value: string;
  evidence: string;
}

/** What `gaugeline init` found out from outside. Plain data: the same pages give the same report. */
export interface StackReport {
  /** The site's address as it answered, without a path. */
  site: string;
  /** The paths read: the home page first, then the pages it links to. */
  pages: string[];
  /** The content systems, in the order of the adapter entries. Empty: none was recognised. */
  adapters: AdapterSighting[];
  framework?: Sighting;
  hosting?: Sighting;
  cdn?: Sighting;
  dns?: Sighting;
  forms: Sighting[];
  payments: PaymentSighting[];
  /** Analytics and tag managers. */
  analytics: Sighting[];
  /** Business listings the site links to (Google, Yelp, TripAdvisor). */
  listings: Sighting[];
  /** The Yelp business alias, read from a link to the business's Yelp page. */
  yelpBusiness?: string;
  /** The Sanity project id, read from the address of an image or file the page loads. */
  sanityProjectId?: string;
  /** Things that were not read, and why. */
  notes: string[];
}

/** How many pages the home page links to are read besides it. */
export const LINKED_PAGES = 4;

const clip = (s: string, n = 80): string => escapeInvisible(s, n);

/** Paths a link may name but init never asks for: a login, an admin screen, an API, a file. Rule 14: looks, never pokes. */
const NOT_PUBLIC_PAGE =
  /(?:^|\/)(?:wp-admin|wp-login\.php|wp-json|xmlrpc\.php|admin|login|log-in|signin|sign-in|account|cart|checkout|api|\.env|\.git)(?:\/|$)/i;
const FILE_LIKE = /\.(?!html?$|php$|aspx?$)[a-z0-9]{2,5}$/i;

/** The paths of up to `LINKED_PAGES` same-site pages the page links to, in the order it links them. */
export function linkedPaths(page: PageSnapshot): string[] {
  const home = new URL(page.finalUrl);
  const out: string[] = [];
  for (const l of page.links) {
    let u: URL;
    try {
      u = new URL(l.href, page.finalUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (u.hostname.toLowerCase() !== home.hostname.toLowerCase()) continue;
    const path = u.pathname.replace(/\/{2,}/g, "/");
    if (path === "/" || path === home.pathname) continue;
    if (NOT_PUBLIC_PAGE.test(path) || FILE_LIKE.test(path)) continue;
    if (!out.includes(path)) out.push(path);
    if (out.length === LINKED_PAGES) break;
  }
  return out;
}

const LISTINGS: readonly {
  id: string;
  name: string;
  test: (u: URL) => boolean;
}[] = [
  {
    id: "google-maps",
    name: "Google Maps listing",
    test: (u) =>
      u.hostname === "g.page" ||
      u.hostname === "maps.app.goo.gl" ||
      ((u.hostname === "www.google.com" || u.hostname === "google.com") &&
        u.pathname.startsWith("/maps")) ||
      u.hostname === "maps.google.com",
  },
  {
    id: "yelp",
    name: "Yelp page",
    test: (u) => /(?:^|\.)yelp\.com$/.test(u.hostname) && /^\/biz\//.test(u.pathname),
  },
  {
    id: "tripadvisor",
    name: "TripAdvisor page",
    test: (u) =>
      /(?:^|\.)tripadvisor\.[a-z.]+$/.test(u.hostname) &&
      /^\/(?:Restaurant|Hotel|Attraction)/i.test(u.pathname),
  },
];

/** What a Sanity image or file address carries: the project id. */
const SANITY_ASSET = /cdn\.sanity\.io\/(?:images|files)\/([a-z0-9]{4,20})\//;
const YELP_ALIAS = /^\/biz\/([A-Za-z0-9][A-Za-z0-9_%-]{1,127})\/?$/;

const FRAMEWORKS = "Next.js";

interface PageRead {
  path: string;
  page: PageSnapshot;
  hops: Hop[];
}

async function read(fetcher: Fetcher, url: string): Promise<PageRead | undefined> {
  const hops = await fetcher.getSite(url);
  const last = hops.at(-1);
  if (!last || last.status < 200 || last.status >= 400) return undefined;
  try {
    const page = buildSnapshot(hops);
    return { path: new URL(page.finalUrl).pathname, page, hops };
  } catch {
    return undefined;
  }
}

export interface DetectOptions {
  fetcher: Fetcher;
  /** The site as typed. */
  address: string;
  /** With --dns: the name servers are read to name the DNS host. */
  dns?: DnsReader;
}

/**
 * Detect a site's stack from outside, from public signs only. The home page and up to four pages it links to
 * are read with GET (the fetcher's budgets and address rules apply); the rest is pure functions of what they
 * returned, reusing the detectors the checks use: the adapter entries' `detect` hints, the form providers,
 * the payment extractor, the tracker fingerprints and the host and DNS tables. No path is guessed: the pages
 * read are the ones the home page names, minus any that look like a login, an admin screen or an API.
 */
export async function detectStack(opts: DetectOptions): Promise<StackReport> {
  const notes: string[] = [];
  let home: PageRead | undefined;
  try {
    home = await read(opts.fetcher, opts.address);
  } catch (err) {
    if (err instanceof NetworkError)
      throw new NetworkError(`${clip(opts.address)} could not be reached: ${err.message}`, {
        url: opts.address,
        ...(err.hint ? { hint: err.hint } : {}),
      });
    throw err;
  }
  if (!home)
    throw new NetworkError(`${clip(opts.address)} did not give a page to read.`, {
      url: opts.address,
      hint: "Check the address in a browser, then run gaugeline init again.",
    });
  const reads: PageRead[] = [home];
  for (const path of linkedPaths(home.page)) {
    try {
      const r = await read(opts.fetcher, new URL(path, home.page.finalUrl).href);
      if (r) reads.push(r);
      else notes.push(`${path} did not give a page, so it was left out.`);
    } catch (err) {
      if (!(err instanceof NetworkError)) throw err;
      notes.push(`${path} could not be read (${clip(err.message, 100)}), so it was left out.`);
    }
  }

  const origin = new URL(home.page.finalUrl);
  const headers = home.hops.at(-1)?.headers ?? {};
  const adapters = new Map<string, AdapterSighting>();
  const forms = new Map<string, Sighting>();
  const payments = new Map<string, PaymentSighting>();
  const analytics = new Map<string, Sighting>();
  const listings = new Map<string, Sighting>();
  let sanityProjectId: string | undefined;
  let yelpBusiness: string | undefined;
  let framework: Sighting | undefined;

  for (const r of reads) {
    const body = r.hops.at(-1)?.body ?? "";
    const where = r === home ? "the home page" : r.path;
    const signs = signsOf(body, r.page.finalUrl, r.hops.at(-1)?.headers ?? {});
    for (const a of detectAdapters(signs))
      if (!adapters.has(a.id)) adapters.set(a.id, { ...a, evidence: `${a.evidence} on ${where}` });
    if (!framework && isNextSite(r.page))
      framework = {
        id: "nextjs",
        name: FRAMEWORKS,
        evidence: `/_next/ files or a Next.js header on ${where}`,
      };
    for (const f of detectForms(r.page)) {
      let id: string = f.provider;
      let name = f.provider as string;
      if (f.provider === "unknown") {
        let host = "";
        try {
          host = f.action ? new URL(f.action, r.page.finalUrl).hostname : "";
        } catch {
          host = "";
        }
        // Only a form that posts to another host is a form service; a form to the site's own address is the site's.
        if (host === "" || host === origin.hostname) continue;
        const label = providerFor(host);
        if (label === "unknown") continue;
        id = label.toLowerCase().replace(/\s+/g, "-");
        name = label;
      }
      if (!forms.has(id))
        forms.set(id, {
          id,
          name: FORM_PROVIDERS.find((p) => p.id === id)?.label ?? name,
          evidence: `a ${f.kind === "embed-script" ? "script" : f.kind} on ${where}`,
        });
    }
    for (const p of extractPayments(r.page)) {
      // A payment detail is a public handle or link; the config schema must accept what is written.
      const value = configValue(p.kind, p.value) === undefined ? p.raw.trim() : p.value;
      if (configValue(p.kind, value) === undefined) continue;
      const key = `${p.kind}:${value}`;
      if (!payments.has(key))
        payments.set(key, { kind: p.kind, value, evidence: `${KIND_NAME[p.kind]} on ${where}` });
    }
    for (const t of findTrackers(r.page)) {
      if (t.group !== "analytics" && t.group !== "tag-manager") continue;
      if (!analytics.has(t.kind))
        analytics.set(t.kind, {
          id: t.kind,
          name: t.label,
          evidence: `${t.ids[0] ?? "a script"} on ${where}`,
        });
    }
    for (const l of r.page.links) {
      let u: URL;
      try {
        u = new URL(l.href, r.page.finalUrl);
      } catch {
        continue;
      }
      const hit = LISTINGS.find((x) => x.test(u));
      if (hit && !listings.has(hit.id))
        listings.set(hit.id, { id: hit.id, name: hit.name, evidence: `a link on ${where}` });
      if (hit?.id === "yelp" && yelpBusiness === undefined)
        yelpBusiness = YELP_ALIAS.exec(u.pathname)?.[1];
    }
    if (sanityProjectId === undefined) sanityProjectId = SANITY_ASSET.exec(body)?.[1];
  }

  const { hosting, cdn } = hostingOf(headers);
  let dns: Sighting | undefined;
  if (opts.dns) {
    const name = dnsName(origin.href);
    if (name && opts.dns.ns && !opts.dns.skips?.(name)) {
      try {
        const ns = (await opts.dns.ns(registrableDomain(name))).map((n) => n.toLowerCase());
        const provider = dnsProviderOf(ns);
        if (provider)
          dns = {
            id: provider.name.toLowerCase().replace(/\s+/g, "-"),
            name: provider.name,
            evidence: `name servers ${ns.slice(0, 2).join(", ")}`,
          };
        else if (ns.length > 0)
          notes.push("The name servers belong to a DNS host Gaugeline does not know.");
      } catch {
        notes.push(`The name servers of ${name} could not be read.`);
      }
    }
  } else {
    notes.push("DNS was not read: add --dns to name the DNS host from the name servers.");
  }
  if (adapters.size === 0)
    notes.push("No content system was recognised from the pages, so no CMS adapter is chosen.");

  return {
    site: origin.origin,
    pages: reads.map((r) => r.path),
    adapters: [...adapters.values()],
    ...(framework ? { framework } : {}),
    ...(hosting
      ? {
          hosting: {
            id: hosting.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            name: hosting,
            evidence: "the response headers",
          },
        }
      : {}),
    ...(cdn
      ? {
          cdn: {
            id: cdn.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            name: cdn,
            evidence: "the response headers",
          },
        }
      : {}),
    ...(dns ? { dns } : {}),
    forms: [...forms.values()].sort((a, b) => a.id.localeCompare(b.id)),
    payments: [...payments.values()].sort((a, b) =>
      `${a.kind}:${a.value}`.localeCompare(`${b.kind}:${b.value}`),
    ),
    analytics: [...analytics.values()],
    listings: [...listings.values()],
    ...(yelpBusiness ? { yelpBusiness } : {}),
    ...(sanityProjectId ? { sanityProjectId } : {}),
    notes,
  };
}
