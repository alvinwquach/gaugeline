import { describeRetry } from "../connectors/http.js";
import { isRecord } from "../connectors/get-json.js";
import { NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { isoOf } from "./dates.js";

/** IANA's RDAP bootstrap file for domain names (RFC 9224): which registry answers for which TLD. */
export const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

/** What the registry says about a domain. Dates and names only: no contact, no registrant. */
export interface Registration {
  /** ISO time of the "expiration" event. Absent when the registry does not publish one. */
  expiresAt?: string;
  registrar?: string;
  /** The RDAP status values as the registry wrote them ("client hold"). */
  statuses: string[];
  /** The name servers the registry lists (lower case, sorted). Absent when it lists none. */
  nameservers?: string[];
  /**
   * What the registry shows of the registrant, never the registrant: "redacted" (the entity or a
   * redaction notice says so) or "published". Absent when the answer has no registrant entity.
   */
  registrant?: "redacted" | "published";
}

export type RegistrationRead =
  | { ok: true; domain: string; registration: Registration }
  | { ok: false; domain: string; reason: string };

export interface RdapDomain extends Registration {
  /** How many "expiration" events the answer held (the earliest is used). */
  expirationEvents: number;
}

/** clientHold and serverHold, whether written "client hold", "clientHold" or "server-hold". */
export function isHold(status: string): boolean {
  const s = status.toLowerCase().replace(/[^a-z]/g, "");
  return s === "clienthold" || s === "serverhold";
}

/** The registrar's name from a registrar entity's jCard ("fn"), or undefined. */
function registrarName(entities: unknown): string | undefined {
  if (!Array.isArray(entities)) return undefined;
  for (const e of entities) {
    if (!isRecord(e) || !Array.isArray(e.roles) || !e.roles.includes("registrar")) continue;
    const card = e.vcardArray;
    const props = Array.isArray(card) && Array.isArray(card[1]) ? (card[1] as unknown[]) : [];
    for (const p of props)
      if (Array.isArray(p) && p[0] === "fn" && typeof p[3] === "string" && p[3].trim() !== "")
        return p[3].trim();
  }
  return undefined;
}

/** The name servers' host names, lower case and sorted, from the domain's nameservers list. */
function nameserverNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names = list.flatMap((n) =>
    isRecord(n) && typeof n.ldhName === "string" && n.ldhName.trim() !== ""
      ? [n.ldhName.trim().toLowerCase().replace(/\.$/, "")]
      : [],
  );
  return [...new Set(names)].sort();
}

/** True when a value, a remark or a notice says the data was removed ("REDACTED FOR PRIVACY"). */
const saysRedacted = (v: unknown): boolean => /redact/i.test(JSON.stringify(v ?? ""));

/**
 * Whether the registry shows the registrant: an entity with the role "registrant" whose card or remarks
 * say "redacted" is redacted, one with a name is published, and a domain with no registrant entity says
 * nothing (undefined). Only the fact is kept: the registrant's name or contact never leaves this function.
 */
function registrantState(body: Record<string, unknown>): "redacted" | "published" | undefined {
  const entities = Array.isArray(body.entities) ? body.entities : [];
  const registrant = entities.find(
    (e): e is Record<string, unknown> =>
      isRecord(e) && Array.isArray(e.roles) && e.roles.includes("registrant"),
  );
  if (registrant) return saysRedacted(registrant) ? "redacted" : "published";
  // RFC 9537's redacted array names the fields a registry removed.
  return Array.isArray(body.redacted) &&
    body.redacted.some((r) => /registrant/i.test(JSON.stringify(r)))
    ? "redacted"
    : undefined;
}

/**
 * An RDAP domain object (RFC 9083) reduced to what the renewals checks use: the "expiration" event
 * (the earliest, if the registry lists more than one), the registrar's name and the statuses. Any
 * other answer (an error object, a different object class, not an object) is undefined.
 */
export function parseRdapDomain(body: unknown): RdapDomain | undefined {
  if (!isRecord(body)) return undefined;
  if (body.objectClassName !== undefined && body.objectClassName !== "domain") return undefined;
  if (body.objectClassName === undefined && body.ldhName === undefined) return undefined;
  const events = Array.isArray(body.events) ? body.events : [];
  const expirations = events
    .filter((e): e is Record<string, unknown> => isRecord(e) && e.eventAction === "expiration")
    .map((e) => ({ at: isoOf(e.eventDate) }));
  const dates = expirations.flatMap((e) => (e.at ? [e.at] : [])).sort();
  const registrar = registrarName(body.entities);
  const nameservers = nameserverNames(body.nameservers);
  const registrant = registrantState(body);
  return {
    ...(dates[0] ? { expiresAt: dates[0] } : {}),
    ...(registrar ? { registrar } : {}),
    ...(nameservers.length > 0 ? { nameservers } : {}),
    ...(registrant ? { registrant } : {}),
    statuses: Array.isArray(body.status)
      ? body.status.filter((s): s is string => typeof s === "string")
      : [],
    expirationEvents: expirations.length,
  };
}

export interface RdapClient {
  lookup(domain: string, tld: string): Promise<RegistrationRead>;
}

export interface RdapOptions {
  fetcher: Fetcher;
  /** Tests: where the bootstrap file is. */
  bootstrapUrl?: string;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * The RDAP client: one GET of the bootstrap file for the run (kept), then one GET of the registry's
 * own server for each domain. Public data, no key, GET only through the fetcher. A registry with no
 * RDAP service, an outage, a rate limit or an answer that is not RDAP is a `reason` and never a
 * guess; WHOIS (port 43 or a web page) is never used.
 */
export function createRdapClient(options: RdapOptions): RdapClient {
  const { fetcher } = options;
  const bootstrapUrl = options.bootstrapUrl ?? IANA_BOOTSTRAP;
  let bootstrap: Promise<Map<string, string> | string> | undefined;

  /** A Map of TLD to its registry's base URL, or the reason the file could not be read. */
  const loadBootstrap = async (): Promise<Map<string, string> | string> => {
    const unreadable =
      "IANA's RDAP bootstrap file could not be read, so no registry could be found";
    try {
      const hops = await fetcher.get(bootstrapUrl, { headers: { accept: "application/json" } });
      const last = hops.at(-1);
      if (!last || last.status < 200 || last.status >= 300)
        return `${unreadable} (HTTP ${last?.status ?? "no answer"}).`;
      const body: unknown = JSON.parse(last.body ?? "");
      const services = isRecord(body) && Array.isArray(body.services) ? body.services : [];
      const map = new Map<string, string>();
      for (const s of services) {
        if (!Array.isArray(s) || !Array.isArray(s[0]) || !Array.isArray(s[1])) continue;
        const urls = (s[1] as unknown[]).filter((u): u is string => typeof u === "string");
        const base = urls.find((u) => u.startsWith("https://")) ?? urls[0];
        if (base)
          for (const tld of s[0] as unknown[])
            if (typeof tld === "string") map.set(tld.toLowerCase(), base);
      }
      return map;
    } catch (err) {
      return err instanceof NetworkError ? `${unreadable}: ${err.message}` : `${unreadable}.`;
    }
  };

  return {
    async lookup(domain, tld) {
      const fail = (reason: string): RegistrationRead => ({ ok: false, domain, reason });
      bootstrap ??= loadBootstrap();
      const services = await bootstrap;
      if (typeof services === "string") return fail(services);
      const base = services.get(tld.toLowerCase());
      if (base === undefined)
        return fail(
          `.${tld} has no RDAP service in IANA's bootstrap file (some registries publish only WHOIS), and Gaugeline does not read WHOIS`,
        );
      const url = `${base.endsWith("/") ? base : `${base}/`}domain/${encodeURIComponent(domain)}`;
      const registry = hostOf(base);
      let hop;
      try {
        hop = (await fetcher.get(url, { headers: { accept: "application/rdap+json" } })).at(-1);
      } catch (err) {
        return fail(
          `the .${tld} registry's RDAP server (${registry}) could not be reached${err instanceof NetworkError ? `: ${err.message}` : ""}`,
        );
      }
      if (!hop) return fail(`the .${tld} registry's RDAP server (${registry}) did not answer`);
      if (hop.status === 429) {
        const retry = describeRetry(hop.headers);
        return fail(
          `the .${tld} registry's RDAP server (${registry}) is rate limiting lookups (HTTP 429). ${retry ? `Try again ${retry}.` : "It did not say when to try again."}`,
        );
      }
      if (hop.status === 404)
        return fail(
          `the .${tld} registry (${registry}) has no record of ${domain} (HTTP 404). If ${domain} is not the name you registered, set "domain" in gaugeline.renewals.json`,
        );
      if (hop.status < 200 || hop.status >= 300)
        return fail(`the .${tld} registry's RDAP server (${registry}) answered HTTP ${hop.status}`);
      let parsed: RdapDomain | undefined;
      try {
        parsed = parseRdapDomain(JSON.parse(hop.body ?? ""));
      } catch {
        parsed = undefined;
      }
      if (!parsed)
        return fail(`the .${tld} registry (${registry}) answered with something that is not RDAP`);
      const { expirationEvents: _events, ...registration } = parsed;
      return { ok: true, domain, registration };
    },
  };
}
