import type { PageSnapshot } from "../snapshot.js";
import type { FormProviderId, FormSighting } from "./types.js";

/**
 * The host of an address, lower-cased with any trailing dot removed, or undefined when it has none
 * (a relative address, a mailto:, text that is not an address). A protocol-relative address
 * ("//host/path") is read as https. The WHATWG parser decides what the host is, so an
 * address with the provider's name in its user-info part is read as the host after it.
 */
export function urlParts(raw: string | undefined): { host: string; path: string } | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const u = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const host = u.hostname.toLowerCase().replace(/\.+$/, "");
    return host === "" ? undefined : { host, path: u.pathname.toLowerCase() };
  } catch {
    return undefined;
  }
}

/**
 * Is `host` the domain or one of its subdomains? The match is on a label boundary: for the domain
 * "hubspot.com", "forms.hubspot.com" matches and "example-hubspot.com" does not.
 */
export function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Where one provider's evidence is, as data: the detector below reads it for every provider. */
export type Evidence = {
  /** Domains whose forms and iframes count: a form action or an iframe src on one of them. */
  hosts: string[];
  /** A path test for the form action (Web-to-Lead is one servlet on a shared Salesforce host). */
  actionPath?: RegExp;
  /** Script addresses that draw a form: a domain and, to keep other scripts out, a path test. */
  scripts: { domain: string; path: RegExp }[];
  /** Inline calls that draw a form. */
  inline: RegExp[];
  /** Iframe addresses that count, when narrower than `hosts`. */
  iframeHosts?: string[];
};

const matchesAny = (host: string, domains: readonly string[]): boolean =>
  domains.some((d) => onDomain(host, d));

/** Every sighting of one provider on the page, in the order the snapshot lists them. */
export function sightingsFor(
  provider: FormProviderId,
  s: PageSnapshot,
  e: Evidence,
): FormSighting[] {
  const out: FormSighting[] = [];
  for (const [i, f] of s.forms.entries()) {
    const u = urlParts(f.action);
    if (!u || !matchesAny(u.host, e.hosts)) continue;
    if (e.actionPath && !e.actionPath.test(u.path)) continue;
    out.push({
      provider,
      kind: "form",
      position: f.position ?? i,
      ...(f.action === undefined ? {} : { action: f.action }),
      hiddenFields: [...f.hiddenFields],
    });
  }
  for (const frame of s.iframes ?? []) {
    const u = urlParts(frame.src);
    if (!u || !matchesAny(u.host, e.iframeHosts ?? e.hosts)) continue;
    if (e.actionPath) continue;
    out.push({
      provider,
      kind: "iframe",
      position: frame.position,
      src: frame.src,
      hiddenFields: [],
    });
  }
  for (const tag of s.scriptTags ?? []) {
    if (tag.src !== undefined) {
      const u = urlParts(tag.src);
      const hit = u && e.scripts.some((x) => onDomain(u.host, x.domain) && x.path.test(u.path));
      if (hit)
        out.push({
          provider,
          kind: "embed-script",
          position: tag.position,
          src: tag.src,
          hiddenFields: [],
        });
    } else if (tag.inline !== undefined && e.inline.some((re) => re.test(tag.inline ?? ""))) {
      out.push({ provider, kind: "embed-script", position: tag.position, hiddenFields: [] });
    }
  }
  return out;
}
