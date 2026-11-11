import type { Env } from "../connectors/types.js";
import type { DnsReader } from "../dns.js";
import type { Fetcher } from "../fetcher.js";
import { registrableOf } from "../renewals/suffix.js";
import type { Renewals } from "../renewals/reader.js";
import type { PageSnapshot } from "../snapshot.js";
import { GOOGLE_BUSINESS_TOKEN } from "../listings/sources/google.js";
import { SANITY_PROJECT_ID, SANITY_TOKEN } from "../connectors/sanity.js";
import { VERCEL_TOKEN_VAR } from "../renewals/tokens.js";
import type { HandoffConfig } from "./config.js";
import { readGoogleAdmins } from "./google.js";
import { clip } from "./http.js";
import { createPeople, keyOf, maskEmail, type People } from "./people.js";
import { MANUAL_SYSTEMS, dnsProviderOf, helpFor } from "./providers.js";
import { readSanity } from "./sanity.js";
import type {
  DnsSystem,
  DomainSystem,
  Member,
  PeopleSystem,
  RawMember,
  SourceRead,
  System,
  UnreadSystem,
} from "./types.js";
import { readVercel } from "./vercel.js";

/** The variables a handoff reads: the three tokens and the Sanity project. Names only, never values. */
export const HANDOFF_ENV_VARS = [
  VERCEL_TOKEN_VAR,
  SANITY_TOKEN,
  SANITY_PROJECT_ID,
  GOOGLE_BUSINESS_TOKEN,
] as const;

/**
 * A system another part of Gaugeline can add to a handoff: a content adapter that can list who may edit
 * a site. `members` is optional. Where a platform's API offers no read of a site's contributors, or the
 * key cannot reach it, leave it out and give `why`: the system becomes a line to check by hand, never a
 * guess.
 */
export interface HandoffSource {
  id: string;
  name: string;
  help?: string;
  members?(fetcher: Fetcher): Promise<SourceRead>;
  why?: string;
}

export interface HandoffSettings {
  config: HandoffConfig;
  /** The variables in HANDOFF_ENV_VARS, already copied from the environment. */
  env: Env;
  /** The Business Profile location from gaugeline.listings.json ("locations/123"): without it Google is a line to check by hand. */
  googleLocation?: string;
  /** --dns: read the name servers from DNS as well as from the registry's record. */
  dns?: DnsReader;
  /** Other systems that list their members (content adapters). */
  sources?: readonly HandoffSource[];
}

/**
 * Everything a handoff report is about, read once and shared by the three checks and the report: every
 * system's holder, as far as the tokens the freelancer already has and the public record can say.
 */
export interface Handoff {
  readonly config: HandoffConfig;
  readonly people: People;
  systems(page: PageSnapshot): Promise<System[]>;
}

const hostOf = (page: PageSnapshot): string => {
  try {
    return new URL(page.finalUrl).hostname;
  } catch {
    return "";
  }
};

/** The host names the page is wired to, from its scripts, links and images. */
function pageHosts(page: PageSnapshot): Set<string> {
  const hosts = new Set<string>();
  for (const url of [
    ...page.scripts,
    ...page.links.map((l) => l.href),
    ...page.images.map((i) => i.src),
  ]) {
    try {
      hosts.add(new URL(url, page.finalUrl).hostname.toLowerCase());
    } catch {
      // not an address
    }
  }
  return hosts;
}

const usesHost = (hosts: ReadonlySet<string>, wanted: readonly string[]): boolean =>
  wanted.some((w) => [...hosts].some((h) => h === w || h.endsWith(`.${w}`)));

/** What a provider's member list becomes: a masked, classified member. The address goes no further than this function. */
function toMember(
  raw: RawMember,
  system: string,
  index: number,
  people: People,
  name: string,
): Member {
  const base = {
    role: raw.role,
    rawRole: raw.rawRole,
    pending: raw.pending === true,
    token: raw.token === true,
  };
  if (raw.token === true)
    return {
      ...base,
      who: "an API token",
      party: "other",
      person: keyOf(`${system}:token:${raw.id ?? index}`),
    };
  if (raw.email === undefined)
    return {
      ...base,
      who: `an account whose address ${name} does not show`,
      party: "unknown",
      person: keyOf(`${system}:account:${raw.id ?? index}`),
    };
  return {
    ...base,
    who: maskEmail(raw.email),
    party: people.partyOf(raw.email),
    person: people.personOf(raw.email),
  };
}

function peopleSystem(
  id: string,
  name: string,
  read: SourceRead,
  people: People,
  help: string | undefined,
): PeopleSystem | UnreadSystem {
  if (!read.ok)
    return { kind: "could-not-check", id, name, reason: read.reason, ...(help ? { help } : {}) };
  return {
    kind: "people",
    id,
    name,
    subject: read.subject,
    account: read.account,
    members: read.members.map((m, i) => toMember(m, id, i, people, name)),
    notes: read.notes,
    ...(help ? { help } : {}),
  };
}

export function createHandoff(
  settings: HandoffSettings,
  fetcher: Fetcher,
  renewals: Renewals,
): Handoff {
  const { config, env } = settings;
  const people = createPeople(config);
  const memo = new Map<string, Promise<System[]>>();

  async function domainAndDns(
    host: string,
  ): Promise<[DomainSystem | UnreadSystem, DnsSystem | UnreadSystem]> {
    const read = await renewals.registration(host);
    const registrable = registrableOf(host);
    const domain = read.ok
      ? read.domain
      : registrable.kind === "domain"
        ? registrable.domain
        : host;
    const domainSystem: DomainSystem | UnreadSystem = read.ok
      ? {
          kind: "domain",
          id: "domain",
          name: "Domain registration",
          subject: clip(read.domain),
          ...(read.registration.registrar ? { registrar: clip(read.registration.registrar) } : {}),
          registrant: read.registration.registrant ?? "not-listed",
          notes: [],
        }
      : {
          kind: "could-not-check",
          id: "domain",
          name: "Domain registration",
          subject: clip(domain),
          reason: read.reason,
        };

    const notes: string[] = [];
    let live: string[] | undefined;
    if (settings.dns?.ns && registrable.kind === "domain") {
      try {
        const found = (await settings.dns.ns(registrable.domain))
          .map((n) => n.toLowerCase().replace(/\.$/, ""))
          .sort();
        if (found.length > 0) live = [...new Set(found)];
      } catch (err) {
        notes.push(
          `The live name server lookup failed (${err instanceof Error ? err.message : "no answer"}), so the registry's record is used.`,
        );
      }
    }
    const registry = read.ok ? (read.registration.nameservers ?? []) : [];
    const names = live ?? (registry.length > 0 ? registry : undefined);
    if (!names) {
      const why = read.ok ? "the registry lists no name servers for the domain" : read.reason;
      return [
        domainSystem,
        {
          kind: "could-not-check",
          id: "dns",
          name: "DNS",
          subject: clip(domain),
          reason: `${why}${settings.dns ? "" : ". Add --dns to read the name servers from DNS instead"}`,
        },
      ];
    }
    if (live && registry.length > 0 && registry.join(" ") !== live.join(" "))
      notes.push(
        "The registry's record lists different name servers from DNS. A recent change may still be spreading: the live ones are shown.",
      );
    const provider = dnsProviderOf(names);
    return [
      domainSystem,
      {
        kind: "dns",
        id: "dns",
        name: "DNS",
        subject: clip(domain),
        ...(provider ? { provider: provider.name } : {}),
        nameservers: names.map((n) => clip(n)),
        source: live ? "dns" : "registry",
        ...(provider?.help ? { help: provider.help } : {}),
        notes,
      },
    ];
  }

  async function build(page: PageSnapshot): Promise<System[]> {
    const host = hostOf(page);
    const hosts = pageHosts(page);
    const final = page.hops.at(-1);
    const onVercel =
      final !== undefined &&
      (final.headers["x-vercel-id"] !== undefined || /vercel/i.test(final.headers.server ?? ""));
    const sanityProject = config.sanity?.projectId ?? env[SANITY_PROJECT_ID]?.trim();
    const systems: System[] = [...(await domainAndDns(host))];

    if (config.vercel || onVercel)
      systems.push(
        peopleSystem(
          "vercel",
          "Vercel",
          await readVercel({
            env,
            fetcher,
            project: config.vercel?.project,
            teamId: config.vercel?.teamId,
          }),
          people,
          helpFor("vercel"),
        ),
      );

    if (config.sanity || (sanityProject ?? "") !== "" || usesHost(hosts, ["cdn.sanity.io"]))
      systems.push(
        peopleSystem(
          "sanity",
          "Sanity",
          await readSanity({ env, fetcher, projectId: config.sanity?.projectId }),
          people,
          helpFor("sanity", sanityProject ? { projectId: sanityProject } : {}),
        ),
      );

    if (settings.googleLocation)
      systems.push(
        peopleSystem(
          "google-business",
          "Google Business Profile",
          await readGoogleAdmins({ env, fetcher, location: settings.googleLocation }),
          people,
          helpFor("google-business"),
        ),
      );
    else
      systems.push({
        kind: "manual",
        id: "google-business",
        name: "Google Business Profile",
        why: "Gaugeline reads a Business Profile's administrators only when gaugeline.listings.json names the location, so this is a line to check by hand, never a finding.",
        detected: false,
        ...(helpFor("google-business") ? { help: helpFor("google-business") as string } : {}),
      });

    for (const source of settings.sources ?? []) {
      if (source.members)
        systems.push(
          peopleSystem(source.id, source.name, await source.members(fetcher), people, source.help),
        );
      else
        systems.push({
          kind: "manual",
          id: source.id,
          name: source.name,
          why:
            source.why ??
            `${source.name}'s API offers no read of who can edit a site, so this is a line to check by hand, never a finding.`,
          detected: false,
          ...(source.help ? { help: source.help } : {}),
        });
    }

    const asked = new Set(config.also ?? []);
    for (const spec of MANUAL_SYSTEMS) {
      const detected = usesHost(hosts, spec.detect);
      if (!detected && !asked.has(spec.id as never)) continue;
      systems.push({
        kind: "manual",
        id: spec.id,
        name: spec.name,
        why: spec.why,
        detected,
        ...(spec.help ? { help: spec.help } : {}),
      });
    }
    return systems;
  }

  return {
    config,
    people,
    systems(page) {
      const key = hostOf(page);
      let pending = memo.get(key);
      if (!pending) {
        pending = build(page);
        memo.set(key, pending);
      }
      return pending;
    },
  };
}
