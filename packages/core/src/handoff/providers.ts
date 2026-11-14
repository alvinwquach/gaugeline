import data from "../data/handoff-providers.json";

export interface ManualSpec {
  id: string;
  name: string;
  why: string;
  help?: string;
  /** Host names a page uses when the site is wired to it. */
  detect: readonly string[];
}

interface DnsSpec {
  name: string;
  suffixes?: readonly string[];
  contains?: readonly string[];
  help?: string;
}

/** The systems read by hand, in the order a report lists them. */
export const MANUAL_SYSTEMS: readonly ManualSpec[] = Object.freeze(
  (data.manual as ManualSpec[]).map((m) => Object.freeze({ ...m })),
);

/** The day the list was written, and whether anyone has compared its addresses with the pages. */
export const PROVIDERS_WRITTEN: string = data.written;
export const PROVIDERS_VERIFIED: boolean = data.verified;

const DNS: readonly DnsSpec[] = data.dnsProviders as DnsSpec[];

/** Where the owner adds a member to a system, with `{projectId}` filled in when it is known. */
export function helpFor(system: string, vars: { projectId?: string } = {}): string | undefined {
  const entry = (data.systems as Record<string, { help?: string }>)[system];
  const help = entry?.help;
  if (help === undefined) return undefined;
  if (help.includes("{projectId}"))
    return vars.projectId !== undefined
      ? help.replace("{projectId}", encodeURIComponent(vars.projectId))
      : "https://www.sanity.io/manage";
  return help;
}

export interface DnsProvider {
  name: string;
  help?: string;
}

/**
 * The DNS host a list of name servers belongs to, by their names: "Cloudflare", or "Cloudflare and
 * Vercel" when they are mixed. Undefined when none is recognised: the name servers are listed as they
 * are and no provider is guessed. Pure; a name server is matched as a whole label suffix.
 */
export function dnsProviderOf(nameservers: readonly string[]): DnsProvider | undefined {
  const found = new Map<string, DnsSpec>();
  for (const raw of nameservers) {
    const ns = raw.toLowerCase().replace(/\.$/, "");
    const hit = DNS.find(
      (p) =>
        (p.suffixes ?? []).some((s) => ns === s || ns.endsWith(`.${s}`)) ||
        (p.contains ?? []).some((c) => ns.includes(c)),
    );
    if (hit && !found.has(hit.name)) found.set(hit.name, hit);
  }
  const hits = [...found.values()];
  const first = hits[0];
  if (!first) return undefined;
  const name = hits.map((h) => h.name).join(" and ");
  return hits.length === 1 && first.help ? { name, help: first.help } : { name };
}
