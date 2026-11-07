import { DnsLookupError, type DnsReader } from "../dns.js";

/**
 * A domain's records as the cutover snapshot keeps them: address, mail, SPF, DKIM and DMARC.
 * Every list is sorted, so two snapshots compare as sets and order is never a change.
 */
export interface DomainRecords {
  a: string[];
  aaaa: string[];
  /** "10 mx1.mail.example", by priority then host. */
  mx: string[];
  /** TXT records at the domain starting v=spf1 (more than one is itself a mistake). */
  spf: string[];
  /** TXT records at _dmarc.<domain> starting v=DMARC1. */
  dmarc: string[];
  /** Selector -> TXT records at <selector>._domainkey.<domain>. Only the selectors in the config. */
  dkim: Record<string, string[]>;
  /** Lookups that failed for a reason other than "no records": "MX example.com (ETIMEOUT)". */
  failed: string[];
}

/** An SPF record's parts: what it includes and how it ends. */
export interface Spf {
  mechanisms: string[];
  includes: string[];
  all?: string;
}

export function isSpfRecord(txt: string): boolean {
  return /^v=spf1(?:\s|$)/i.test(txt.trim());
}

export function parseSpf(txt: string): Spf | undefined {
  if (!isSpfRecord(txt)) return undefined;
  const mechanisms = txt.trim().split(/\s+/).slice(1);
  const includes = mechanisms
    .filter((m) => /^[+~?-]?include:/i.test(m))
    .map((m) => m.replace(/^[+~?-]?include:/i, "").toLowerCase());
  const all = mechanisms.find((m) => /^[+~?-]?all$/i.test(m));
  return { mechanisms, includes, ...(all ? { all: all.toLowerCase() } : {}) };
}

/** A DMARC record's tags, lower-case names: { v: "DMARC1", p: "reject", rua: "mailto:…" }. */
export function parseDmarc(txt: string): Record<string, string> | undefined {
  if (!/^v=dmarc1(?:\s*;|\s*$)/i.test(txt.trim())) return undefined;
  const out: Record<string, string> = {};
  for (const part of txt.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Read the records once each. A failed lookup is listed in `failed`, never read as "none". */
export async function readDomainRecords(
  dns: DnsReader,
  domain: string,
  selectors: readonly string[] = [],
): Promise<DomainRecords> {
  const failed: string[] = [];
  const safe = async <T>(p: Promise<T[]>): Promise<T[]> => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof DnsLookupError) {
        failed.push(`${err.rrtype} ${err.hostname} (${err.reason})`);
        return [];
      }
      throw err;
    }
  };
  const sort = (xs: string[]) => [...new Set(xs)].sort();
  const [a, aaaa, mx, txt, dmarc] = await Promise.all([
    safe(dns.a ? dns.a(domain) : Promise.resolve([])),
    safe(dns.aaaa ? dns.aaaa(domain) : Promise.resolve([])),
    safe(dns.mx(domain)),
    safe(dns.txt(domain)),
    safe(dns.txt(`_dmarc.${domain}`)),
  ]);
  const dkim: Record<string, string[]> = {};
  for (const sel of [...selectors].sort())
    dkim[sel] = sort(await safe(dns.txt(`${sel}._domainkey.${domain}`)));
  return {
    a: sort(a),
    aaaa: sort(aaaa),
    mx: [...mx]
      .sort((x, y) => x.priority - y.priority || x.exchange.localeCompare(y.exchange))
      .map((m) => `${m.priority} ${m.exchange.toLowerCase().replace(/\.$/, "")}`),
    spf: sort(txt.filter(isSpfRecord)),
    dmarc: sort(dmarc.filter((t) => parseDmarc(t) !== undefined)),
    dkim,
    failed: failed.sort(),
  };
}
