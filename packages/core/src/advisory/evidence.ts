import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { dnsName, registrableDomain, type DnsReader } from "../dns.js";
import { NetworkError } from "../errors.js";
import type { Fetcher, Hop } from "../fetcher.js";
import { dnsProviderOf } from "../handoff/providers.js";
import { detect, looksMinified, MAX_SCRIPT_CHARS } from "../libraries/detect.js";
import { LIBRARY_SCRIPT_CAP, MAX_SCRIPT_BYTES } from "../libraries/reader.js";
import type { LibraryId } from "../libraries/advisories.js";
import { isNextSite } from "../next/detect.js";
import { inKind } from "../request-log.js";
import { registrableOf } from "../renewals/suffix.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import {
  generatorOf,
  hostingOf,
  nextVersionOf,
  phpFromHeaders,
  wordpressOf,
  type WordPressAsset,
  type WordPressRead,
} from "./signals.js";

const clip = (s: string, n = 80): string => escapeInvisible(s, n);

/** WordPress facts another part of Gaugeline has read (C-01), used in place of the page's own signs when given. */
export interface WordPressData {
  version?: string;
  plugins?: { slug: string; version?: string }[];
  themes?: { slug: string; version?: string }[];
}

export interface GatherOptions {
  fetcher: Fetcher;
  /** The site as typed. */
  address: string;
  /** Other hostnames the person named (old subdomains, legacy hosts), each required to answer. */
  hosts: readonly string[];
  /** What the question needs read: nothing is requested beyond it. */
  needs: { next: boolean; libraries: boolean };
  /** With --dns: the name servers are read. */
  dns?: DnsReader;
  wordpress?: WordPressData;
}

/** A library found in a script a page names, as E-12's detection reads it. */
export interface ServedLibrary {
  library: LibraryId;
  name: string;
  version: string | null;
  how: "banner" | "version-string" | "file-name" | "name";
  /** The script's address with no query or fragment. */
  script: string;
}

export interface HostEvidence {
  /** The hostname as asked for. */
  host: string;
  /** Asked for by the person: a host that does not answer then stops a "not seen" from being a verdict. */
  required: boolean;
  read: { ok: true; origin: string; status: number } | { ok: false; reason: string };
  hosting?: string;
  cdn?: string;
  /** What the host positively is: Next.js, WordPress, PHP, a generator, an X-Powered-By value. */
  stacks: string[];
  generator?: string;
  next?: { version?: string; how?: string };
  php?: { version?: string; how: string };
  wordpress?: WordPressRead;
  libraries: ServedLibrary[];
  scriptsRead: number;
  scriptsUnread: number;
  /** Minified scripts with no library name or version in them. */
  scriptsUnidentified: number;
  /** Set when what this host sent cannot show what is behind it, and why. */
  opaque?: string;
  dns?: { nameservers: string[]; provider?: string };
  /** Things not read or cut short on this host, in words. */
  limits: string[];
}

export interface Evidence {
  hosts: HostEvidence[];
  /** What was not read, and why, for the whole run. */
  notes: string[];
}

/** At most this many hostnames are read: the typed one, its www twin, the ones named, and links to subdomains. */
const MAX_HOSTS = 6;
const MAX_LINKED_HOSTS = 3;
const NEXT_SCRIPT_CAP = 8;

const isHttp = (u: string): boolean => /^https?:\/\//i.test(u);
const withoutQuery = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return u;
  }
};

function normaliseAddress(address: string): URL {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`);
  } catch {
    throw new NetworkError(`"${clip(address)}" is not an address.`, { url: address });
  }
}

/** The www twin of a host: www.x for x, x for www.x. Not for an address, a bare name or a platform's subdomain. */
function twinOf(host: string): string | undefined {
  if (registrableOf(host).kind !== "domain") return undefined;
  return host.startsWith("www.") ? host.slice(4) : `www.${host}`;
}

interface ScriptRead {
  url: string;
  text?: string;
}

async function readScript(fetcher: Fetcher, url: string): Promise<ScriptRead> {
  try {
    const last = (
      await inKind("script", () => fetcher.get(url, { maxBytes: MAX_SCRIPT_BYTES }))
    ).at(-1);
    if (!last || last.status < 200 || last.status >= 300) return { url };
    const body = last.body ?? "";
    return { url, text: body.length > MAX_SCRIPT_CHARS ? body.slice(0, MAX_SCRIPT_CHARS) : body };
  } catch (err) {
    if (err instanceof NetworkError) return { url };
    throw err;
  }
}

function mergeWordPress(read: WordPressRead | undefined, data: WordPressData): WordPressRead {
  const base: WordPressRead = read ?? { signs: [], plugins: [], themes: [] };
  const fold = (rows: WordPressAsset[], given: { slug: string; version?: string }[] = []) => {
    const out = rows.map((r) => ({ ...r }));
    for (const g of given) {
      const slug = g.slug.toLowerCase();
      const at = out.find((r) => r.slug === slug);
      const versions = g.version ? [g.version] : [];
      if (at) {
        if (versions.length > 0) at.versions = versions;
      } else out.push({ slug, versions });
    }
    return out;
  };
  return {
    signs: [...base.signs, "the WordPress read (C-01)"],
    ...(data.version
      ? { version: { value: data.version, how: "the WordPress read (C-01)" } }
      : base.version
        ? { version: base.version }
        : {}),
    plugins: fold(base.plugins, data.plugins),
    themes: fold(base.themes, data.themes),
  };
}

async function readHost(
  opts: GatherOptions,
  host: string,
  url: string,
  required: boolean,
  primary: boolean,
): Promise<{ evidence: HostEvidence; page?: PageSnapshot; finalHost?: string }> {
  const empty: HostEvidence = {
    host,
    required,
    read: { ok: false, reason: "" },
    stacks: [],
    libraries: [],
    scriptsRead: 0,
    scriptsUnread: 0,
    scriptsUnidentified: 0,
    limits: [],
  };
  let hops: Hop[];
  try {
    hops = await opts.fetcher.getSite(url);
  } catch (err) {
    if (err instanceof NetworkError) {
      if (primary)
        throw new NetworkError(`${clip(host)} could not be reached: ${err.message}`, {
          url,
          ...(err.hint ? { hint: err.hint } : {}),
        });
      return { evidence: { ...empty, read: { ok: false, reason: err.message } } };
    }
    throw err;
  }
  const last = hops.at(-1);
  if (!last) return { evidence: { ...empty, read: { ok: false, reason: "it gave no answer" } } };
  const finalUrl = last.url;
  const headers = last.headers;
  const body = last.body ?? "";
  let page: PageSnapshot | undefined;
  try {
    page = buildSnapshot(hops);
  } catch {
    page = undefined;
  }
  const stacks: string[] = [];
  const limits: string[] = [];
  const { hosting, cdn } = hostingOf(headers);
  const generator = generatorOf(body);
  const power = (headers["x-powered-by"] ?? "").trim();
  const nextHeader = /next\.js/i.test(power);
  const isNext = nextHeader || (page ? isNextSite(page) : false);
  if (isNext) stacks.push("Next.js");
  let wordpress = wordpressOf(body, headers);
  if (primary && opts.wordpress) wordpress = mergeWordPress(wordpress, opts.wordpress);
  if (wordpress) stacks.push("WordPress");
  let php = phpFromHeaders(headers);
  if (!php && page?.links.some((l) => /\.php(?:[?#]|$)/i.test(l.href.split("?")[0] ?? "")))
    php = { how: "a link to a .php address" };
  if (!php && wordpress) php = { how: "WordPress runs on PHP" };
  if (php) stacks.push("PHP");
  if (generator && !/^WordPress\b/i.test(generator))
    stacks.push(clip(generator.split(/\s+/)[0] ?? generator, 40));
  if (power !== "" && !nextHeader && !/^PHP\b/i.test(power))
    stacks.push(clip(power.split(/[/\s]/)[0] ?? power, 40));
  if (last.truncated)
    limits.push("the page is longer than Gaugeline reads, so only its start was searched");

  // Scripts are read only when the question needs them, and only the ones the page's own HTML names.
  const named = [...new Set((page?.scripts ?? []).filter(isHttp))];
  const wanted = opts.needs.libraries
    ? named.slice(0, LIBRARY_SCRIPT_CAP)
    : opts.needs.next
      ? named.filter((s) => /\/_next\/static\//.test(s)).slice(0, NEXT_SCRIPT_CAP)
      : [];
  if (opts.needs.libraries && named.length > LIBRARY_SCRIPT_CAP)
    limits.push(
      `${named.length - LIBRARY_SCRIPT_CAP} scripts were not read: at most ${LIBRARY_SCRIPT_CAP} are read for one page`,
    );
  const reads = await Promise.all(wanted.map((u) => readScript(opts.fetcher, u)));
  const libraries: ServedLibrary[] = [];
  let nextVersion: { version: string; how: string } | undefined;
  let unidentified = 0;
  for (const r of reads) {
    if (r.text === undefined) continue;
    const v = opts.needs.next ? nextVersionOf(r.text) : undefined;
    if (v && !nextVersion)
      nextVersion = {
        version: v,
        how: `window.next.version in the script ${clip(new URL(r.url).pathname.split("/").pop() ?? "", 100)}`,
      };
    if (opts.needs.libraries) {
      const found = detect(r.text, r.url);
      for (const d of found)
        libraries.push({
          library: d.library,
          name: d.name,
          version: d.version,
          how: d.evidence.how,
          script: withoutQuery(r.url),
        });
      if (found.length === 0 && looksMinified(r.text)) unidentified++;
    }
  }
  if (nextVersion && !stacks.includes("Next.js")) stacks.push("Next.js");
  const opaque =
    last.status >= 400
      ? `the page answered ${last.status}, so what it says about itself is limited`
      : stacks.length === 0 && cdn !== undefined && hosting === undefined
        ? `${cdn} is in front of the site and removes the headers that would name what is behind it, and the page names nothing`
        : undefined;
  const evidence: HostEvidence = {
    host,
    required,
    read: { ok: true, origin: new URL(finalUrl).origin, status: last.status },
    ...(hosting ? { hosting } : {}),
    ...(cdn ? { cdn } : {}),
    stacks,
    ...(generator ? { generator: clip(generator) } : {}),
    ...(isNext
      ? { next: nextVersion ? { version: nextVersion.version, how: nextVersion.how } : {} }
      : {}),
    ...(php ? { php } : {}),
    ...(wordpress ? { wordpress } : {}),
    libraries,
    scriptsRead: reads.filter((r) => r.text !== undefined).length,
    scriptsUnread: reads.filter((r) => r.text === undefined).length,
    scriptsUnidentified: unidentified,
    ...(opaque ? { opaque } : {}),
    limits,
  };
  return { evidence, ...(page ? { page } : {}), finalHost: new URL(finalUrl).hostname };
}

/**
 * Read the typed site's home page, the same page on its www twin, any hostname the person named, and up to
 * three other subdomains of the same domain that the home page links to: one GET each, plus the script files
 * the question needs from the pages' own HTML. Nothing is requested that a page does not name, no path is
 * guessed, and nothing is sent.
 */
export async function gatherEvidence(opts: GatherOptions): Promise<Evidence> {
  const url = normaliseAddress(opts.address);
  const hosts: HostEvidence[] = [];
  const notes: string[] = [];
  const seen = new Set<string>([url.hostname]);
  const finals = new Map<string, string>();
  const swap = (host: string): string => {
    const u = new URL(url.href);
    u.hostname = host;
    u.pathname = "/";
    u.search = "";
    return u.href;
  };

  const first = await readHost(opts, url.hostname, url.href, false, true);
  hosts.push(first.evidence);
  if (first.finalHost) finals.set(first.finalHost, url.hostname);

  const queue: { host: string; required: boolean }[] = [];
  const twin = twinOf(url.hostname);
  if (twin) queue.push({ host: twin, required: false });
  for (const h of opts.hosts) queue.push({ host: h.toLowerCase(), required: true });
  const own = registrableOf(url.hostname);
  if (own.kind === "domain" && first.page) {
    const linked = new Set<string>();
    for (const l of first.page.links) {
      try {
        const h = new URL(l.href).hostname.toLowerCase();
        const r = registrableOf(h);
        if (isHttp(l.href) && r.kind === "domain" && r.domain === own.domain) linked.add(h);
      } catch {
        // not an address
      }
    }
    for (const h of [...linked].slice(0, MAX_LINKED_HOSTS))
      queue.push({ host: h, required: false });
  }
  for (const q of queue) {
    if (seen.has(q.host)) continue;
    if (hosts.length >= MAX_HOSTS) {
      notes.push(`${q.host} was not read: at most ${MAX_HOSTS} hostnames are read in one run.`);
      continue;
    }
    seen.add(q.host);
    const r = await readHost(opts, q.host, swap(q.host), q.required, false);
    // A twin that redirects to a host already read is the same site, not another one.
    const same = r.finalHost !== undefined ? finals.get(r.finalHost) : undefined;
    if (same !== undefined && same !== q.host && r.evidence.read.ok && !q.required) {
      notes.push(`${q.host} redirects to ${same}, so it is the same site.`);
      continue;
    }
    if (r.finalHost) finals.set(r.finalHost, q.host);
    hosts.push(r.evidence);
  }

  if (opts.dns) {
    for (const h of hosts) {
      if (!h.read.ok) continue;
      const name = dnsName(h.read.origin);
      if (!name || !opts.dns.ns || opts.dns.skips?.(name)) continue;
      try {
        const nameservers = (await opts.dns.ns(registrableDomain(name))).map((n) =>
          n.toLowerCase(),
        );
        if (nameservers.length > 0) {
          const provider = dnsProviderOf(nameservers)?.name;
          h.dns = { nameservers: nameservers.slice(0, 6), ...(provider ? { provider } : {}) };
        }
      } catch {
        notes.push(`The name servers of ${h.host} could not be read.`);
      }
    }
  } else {
    notes.push("DNS records were not read: add --dns to read the name servers of each hostname.");
  }
  return { hosts, notes };
}
