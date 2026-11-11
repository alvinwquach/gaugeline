import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { EXPIRY_DAYS, SOON_DAYS } from "../dns/certificate.js";
import { certificateHosts, readCertificates, type CertRead } from "./certs.js";
import type { RenewalsConfig } from "./config.js";
import { urgency } from "./dates.js";
import { createRdapClient, isHold, type RegistrationRead } from "./rdap.js";
import { runtimeStatus } from "./runtimes.js";
import { registrableOf } from "./suffix.js";
import {
  GITHUB_TOKEN_VAR,
  VERCEL_TOKEN_VAR,
  readGithubToken,
  readVercelProject,
  readVercelToken,
  type ProjectRuntime,
  type TokenRead,
} from "./tokens.js";

/** Domain registration: under 30 days is fix soon, under 7 fix first. */
export const DOMAIN_SOON_DAYS = 30;
export const DOMAIN_FIRST_DAYS = 7;
/** Certificates and tokens: under 21 days is fix soon, under 7 fix first (the certificate check's own numbers). */
export const CERT_SOON_DAYS = EXPIRY_DAYS;
export const CERT_FIRST_DAYS = SOON_DAYS;
export const TOKEN_SOON_DAYS = EXPIRY_DAYS;
export const TOKEN_FIRST_DAYS = SOON_DAYS;
/** A retirement announced this many days out or fewer is fix soon; sooner than FIRST, or past, is fix first. */
export const RUNTIME_SOON_DAYS = 90;
export const RUNTIME_FIRST_DAYS = 7;

export interface RenewalsSettings {
  config: RenewalsConfig;
  /** The two token variables, already copied from the environment. */
  env: Env;
  /** Tests: the port the site's hosts answer https on. Default 443. */
  port?: number;
  /** Tests: where IANA's bootstrap file is. */
  bootstrapUrl?: string;
}

/** The Vercel projects' Node.js versions, or why none could be asked. */
export interface RuntimesRead {
  projects: ProjectRuntime[];
  /** Set when nothing was asked: no project listed, or no token. */
  notAsked?: string;
}

/** One line of the Renewals section: a thing that lapses, with its date. */
export interface RenewalRow {
  kind: "domain" | "certificate" | "token" | "runtime";
  subject: string;
  /** ISO time it expires (or retires). Absent when the provider reports none. */
  date?: string;
  /** What else is worth saying on the line: the registrar, "no expiry reported", why it could not be read. */
  note?: string;
  level: "first" | "soon" | "fine" | "unknown";
}

/**
 * What the renewals checks read, once each and shared: the domain's registration (RDAP), the
 * certificates of the bare domain and its www, the tokens the user configured and their Vercel
 * projects' Node.js versions. Every read is a GET (or HEAD) through the fetcher; nothing here
 * keeps more than a date, a name and a count.
 */
export interface Renewals {
  readonly config: RenewalsConfig;
  registration(host: string): Promise<RegistrationRead>;
  certificates(host: string): Promise<CertRead[]>;
  tokens(): Promise<TokenRead[]>;
  runtimes(): Promise<RuntimesRead>;
  /** Everything read so far, sorted by date: for the Renewals section. Reads nothing new. */
  rows(now: Date): Promise<RenewalRow[]>;
}

export function createRenewals(settings: RenewalsSettings, fetcher: Fetcher): Renewals {
  const { config, env } = settings;
  const rdap = createRdapClient({
    fetcher,
    ...(settings.bootstrapUrl ? { bootstrapUrl: settings.bootstrapUrl } : {}),
  });
  const registrations = new Map<string, Promise<RegistrationRead>>();
  const certificates = new Map<string, Promise<CertRead[]>>();
  let tokens: Promise<TokenRead[]> | undefined;
  let runtimes: Promise<RuntimesRead> | undefined;

  const registration = (host: string): Promise<RegistrationRead> => {
    const r = registrableOf(config.domain ?? host);
    const key = r.kind === "domain" ? r.domain : host;
    let p = registrations.get(key);
    if (!p) {
      p =
        r.kind === "domain"
          ? rdap.lookup(r.domain, r.tld)
          : Promise.resolve<RegistrationRead>({
              ok: false,
              domain: host,
              reason:
                r.kind === "platform"
                  ? `${r.host} is an address on ${r.platform}, which owns the domain: there is no registration of the client's to check. Check the client's own domain instead`
                  : r.reason,
            });
      registrations.set(key, p);
    }
    return p;
  };

  const certs = (host: string): Promise<CertRead[]> => {
    const hosts = certificateHosts(host);
    const key = hosts.join(" ");
    let p = certificates.get(key);
    if (!p) {
      p = readCertificates(hosts, fetcher, settings.port);
      certificates.set(key, p);
    }
    return p;
  };

  const readTokens = (): Promise<TokenRead[]> => {
    tokens ??= Promise.all(
      [readGithubToken(env, fetcher), readVercelToken(env, fetcher)].flatMap((p) => (p ? [p] : [])),
    );
    return tokens;
  };

  const readRuntimes = (): Promise<RuntimesRead> => {
    runtimes ??= (async (): Promise<RuntimesRead> => {
      const projects = config.vercel?.projects ?? [];
      if (projects.length === 0)
        return {
          projects: [],
          notAsked: 'no Vercel project is listed under "vercel" in gaugeline.renewals.json',
        };
      if ((env[VERCEL_TOKEN_VAR] ?? "").trim() === "")
        return {
          projects: [],
          notAsked: `${VERCEL_TOKEN_VAR} is not set, so Vercel was not asked`,
        };
      return {
        projects: await Promise.all(
          projects.map((p) => readVercelProject(env, fetcher, p, config.vercel?.teamId)),
        ),
      };
    })();
    return runtimes;
  };

  return {
    config,
    registration,
    certificates: certs,
    tokens: readTokens,
    runtimes: readRuntimes,
    async rows(now) {
      const rows: RenewalRow[] = [];
      for (const p of registrations.values()) {
        const read = await p;
        if (!read.ok) continue;
        const { expiresAt, registrar } = read.registration;
        const notes = [
          ...(registrar ? [`registrar ${registrar}`] : []),
          ...(expiresAt ? [] : ["the registry publishes no expiry date"]),
          ...(read.registration.statuses.some(isHold) ? ["on hold, so it does not resolve"] : []),
        ];
        rows.push({
          kind: "domain",
          subject: read.domain,
          ...(expiresAt ? { date: expiresAt } : {}),
          ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
          level: read.registration.statuses.some(isHold)
            ? "first"
            : expiresAt
              ? urgency(expiresAt, now, DOMAIN_SOON_DAYS, DOMAIN_FIRST_DAYS)
              : "unknown",
        });
      }
      for (const p of certificates.values()) {
        for (const read of await p) {
          if (read.kind === "cert")
            rows.push({
              kind: "certificate",
              subject: read.host,
              date: read.cert.validTo,
              level: urgency(read.cert.validTo, now, CERT_SOON_DAYS, CERT_FIRST_DAYS),
            });
          else if (read.kind === "name-mismatch")
            rows.push({
              kind: "certificate",
              subject: read.host,
              note: `its certificate does not name it${read.names.length > 0 ? ` (it names ${read.names.join(", ")})` : ""}`,
              level: "first",
            });
        }
      }
      for (const t of await readTokens())
        rows.push({
          kind: "token",
          subject: `${t.provider} token (${t.variable})`,
          ...(t.expiresAt ? { date: t.expiresAt } : {}),
          ...(t.failed ? { note: t.failed } : !t.expiresAt ? { note: "no expiry reported" } : {}),
          level: t.expiresAt
            ? urgency(t.expiresAt, now, TOKEN_SOON_DAYS, TOKEN_FIRST_DAYS)
            : "unknown",
        });
      for (const r of (await readRuntimes()).projects) {
        const status = r.nodeVersion ? runtimeStatus(r.nodeVersion, now) : undefined;
        rows.push({
          kind: "runtime",
          subject: `Vercel project ${r.project}, Node.js ${r.nodeVersion ?? "?"}`,
          ...(status ? { date: `${status.retires}T00:00:00.000Z` } : {}),
          ...(r.failed ? { note: r.failed } : !status ? { note: "no retirement announced" } : {}),
          level: status
            ? urgency(`${status.retires}T00:00:00.000Z`, now, RUNTIME_SOON_DAYS, RUNTIME_FIRST_DAYS)
            : "unknown",
        });
      }
      // Already broken with no date (a name the certificate lacks, a hold) leads; then by date; then what has none.
      const band = (r: RenewalRow) => (r.date !== undefined ? 1 : r.level === "first" ? 0 : 2);
      return rows.sort(
        (a, b) =>
          band(a) - band(b) ||
          (a.date ?? "").localeCompare(b.date ?? "") ||
          a.subject.localeCompare(b.subject),
      );
    },
  };
}

export { GITHUB_TOKEN_VAR, VERCEL_TOKEN_VAR };
