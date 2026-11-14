import { covers } from "../dns/certificate.js";
import type { CheckContext, Finding, Severity } from "../model.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { daysUntil, expiryPhrase } from "../renewals/dates.js";
import { isHold } from "../renewals/rdap.js";
import {
  DOMAIN_FIRST_DAYS,
  DOMAIN_SOON_DAYS,
  RUNTIME_FIRST_DAYS,
  RUNTIME_SOON_DAYS,
  TOKEN_FIRST_DAYS,
  TOKEN_SOON_DAYS,
  type Renewals,
} from "../renewals/reader.js";
import { NODE_RETIREMENTS_WRITTEN, runtimeStatus } from "../renewals/runtimes.js";
import { writeDate } from "../renewals/dates.js";
import { names as certNames } from "../renewals/certs.js";

const hostOf = (page: PageSnapshot): string => {
  try {
    return new URL(page.finalUrl).hostname;
  } catch {
    return "";
  }
};

const clip = (text: string): string => escapeInvisible(text, 120);

/** The renewals reader, or undefined when the run did not ask for renewals. Without it these checks do nothing. */
function reader(ctx: CheckContext): Renewals | undefined {
  return ctx.renewals;
}

const now = (ctx: CheckContext): Date => ctx.now?.() ?? new Date();

function severityFor(
  days: number,
  expired: boolean,
  soon: number,
  first: number,
): Severity | undefined {
  if (expired || days < first) return "high";
  return days < soon ? "medium" : undefined;
}

export const domainExpiresSoon = defineCheck<PageSnapshot>({
  id: "domain-expires-soon",
  size: "S",
  done: "The domain is renewed at the registrar, with a registration date a year or more ahead and automatic renewal on.",
  estimateChanges:
    "Minutes when you hold the registrar login. Days when the client or a former agency does, because someone has to be reached to approve the renewal.",
  area: "Security & email",
  severity: "medium",
  title: "The domain's registration runs out soon",
  what: "The domain's registration expires in under 30 days (fix soon) or under 7 (fix first), by the date the registry publishes.",
  why: "When a domain lapses the site and every email address on it stop working, and a lapsed name can be bought by someone else. The first you hear of it is usually the owner on the phone.",
  fix: "Renew it at the registrar the finding names, and turn on automatic renewal. If the client holds the account, send them the date and ask them to renew, or ask for access so it is not left to a card that may have expired.",
  tech: "RDAP, the registries' public replacement for WHOIS: IANA's bootstrap file (data.iana.org/rdap/dns.json) names the registry's server for the TLD, then one GET of /domain/<name> there, no key. The date is the earliest \"expiration\" event; the registrar is the name in the registrar entity. Whole days from the run's clock in UTC. A registry with no RDAP service, a rate limit, an outage, a platform address (name.vercel.app) or a registry that hides its dates is could-not-check with the reason, never a guess; WHOIS is never read",
  async run(page, ctx) {
    const renewals = reader(ctx);
    if (!renewals) return [];
    const read = await renewals.registration(hostOf(page));
    if (!read.ok) {
      ctx.couldNotCheck?.(page.finalUrl, read.reason);
      return [];
    }
    const { expiresAt, registrar } = read.registration;
    if (!expiresAt) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        `the registry publishes no expiry date for ${read.domain}`,
      );
      return [];
    }
    const at = now(ctx);
    if (Date.parse(expiresAt) <= at.getTime()) return [];
    const severity = severityFor(
      daysUntil(expiresAt, at),
      false,
      DOMAIN_SOON_DAYS,
      DOMAIN_FIRST_DAYS,
    );
    if (!severity) return [];
    return [
      {
        checkId: "domain-expires-soon",
        severity,
        title: this.title,
        evidence: `${clip(read.domain)} ${expiryPhrase(expiresAt, at)}${registrar ? ` (registrar ${clip(registrar)})` : ""}`,
        url: `domain:${clip(read.domain)}`,
      },
    ];
  },
});

export const domainExpired = defineCheck<PageSnapshot>({
  id: "domain-expired",
  size: "S",
  done: "The domain is renewed, and it resolves again.",
  estimateChanges:
    "Often minutes at the registrar, but a name past its grace period costs a redemption fee and can take days to come back.",
  area: "Security & email",
  severity: "high",
  title: "The domain's registration has passed its expiry date",
  what: "The expiration date the registry publishes for the domain is in the past.",
  why: "A domain past its expiry can be switched off at any moment, and after the registrar's grace period it can be released to anyone. The site and its email depend on it.",
  fix: "Renew it at the registrar now. Many registrars allow it for a short time after the date at the normal price; later it costs more.",
  tech: 'RDAP, as domain-expires-soon: the earliest "expiration" event is before the run\'s clock. A registry that publishes no date is could-not-check, not expired',
  async run(page, ctx) {
    const renewals = reader(ctx);
    if (!renewals) return [];
    const read = await renewals.registration(hostOf(page));
    if (!read.ok) {
      ctx.couldNotCheck?.(page.finalUrl, read.reason);
      return [];
    }
    const { expiresAt, registrar } = read.registration;
    if (!expiresAt) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        `the registry publishes no expiry date for ${read.domain}`,
      );
      return [];
    }
    const at = now(ctx);
    if (Date.parse(expiresAt) > at.getTime()) return [];
    return [
      {
        checkId: "domain-expired",
        severity: "high",
        title: this.title,
        evidence: `${clip(read.domain)} ${expiryPhrase(expiresAt, at)}${registrar ? ` (registrar ${clip(registrar)})` : ""}`,
        url: `domain:${clip(read.domain)}`,
      },
    ];
  },
});

export const domainStatusHold = defineCheck<PageSnapshot>({
  id: "domain-status-hold",
  size: "S",
  done: "The hold is lifted at the registrar (or the registry), and the domain resolves again.",
  estimateChanges:
    "A hold for an unpaid renewal clears in minutes once it is paid. A hold for a complaint or a dispute is the registrar's to lift and can take days.",
  area: "Security & email",
  severity: "high",
  title: "The domain is on hold, so it resolves nowhere",
  what: "The registry reports the status clientHold or serverHold for the domain.",
  why: "A domain on hold is removed from DNS: the site and email do not work for anyone, and no change to the site fixes it.",
  fix: "Ask the registrar why (an unpaid renewal, an unverified contact email and an abuse complaint are the usual reasons) and clear it. clientHold is set by the registrar, serverHold by the registry.",
  tech: 'RDAP status values of the domain, as domain-expires-soon reads them: "client hold" or "server hold" (spelled with spaces, camel case or hyphens), matched after removing everything that is not a letter',
  async run(page, ctx) {
    const renewals = reader(ctx);
    if (!renewals) return [];
    const read = await renewals.registration(hostOf(page));
    if (!read.ok) {
      ctx.couldNotCheck?.(page.finalUrl, read.reason);
      return [];
    }
    const holds = read.registration.statuses.filter(isHold);
    if (holds.length === 0) return [];
    return [
      {
        checkId: "domain-status-hold",
        severity: "high",
        title: this.title,
        evidence: `${clip(read.domain)} has the status ${holds.map((h) => `"${clip(h)}"`).join(" and ")}, so it does not resolve`,
        url: `domain:${clip(read.domain)}`,
      },
    ];
  },
});

export const certNameMismatch = defineCheck<PageSnapshot>({
  id: "cert-name-mismatch",
  size: "S",
  done: "One certificate names both the bare domain and www, and both addresses open in a browser with no warning.",
  estimateChanges:
    "Adding the missing name to a managed certificate is a setting at the host. A hand-installed certificate has to be reissued with both names.",
  area: "Security & email",
  severity: "high",
  title: "The bare domain or www is not covered by the certificate",
  what: "The https certificate served for the bare domain or for its www host does not name that host.",
  why: "A visitor who types or follows the uncovered address gets a full-page browser warning instead of the site. A link from a business card or a social profile is often the one that is not covered.",
  fix: "Add the missing name to the certificate (most hosts do it from the domain's settings), or point that address at the host that serves it. Then open both addresses in a browser to confirm.",
  tech: "One HEAD request, not followed, to https://<domain>/ and https://www.<domain>/ through the fetcher: the names (subjectAltName, else the common name) come off the connection. When the handshake fails because the certificate does not name the host, Node's error carries the certificate and its names are read from it. A one-label wildcard covers a host. A www that does not exist in DNS is skipped; a certificate that fails for another reason is could-not-check with the code",
  async run(page, ctx) {
    const renewals = reader(ctx);
    if (!renewals) return [];
    const reads = await renewals.certificates(hostOf(page));
    const out: Finding[] = [];
    for (const read of reads) {
      if (read.kind === "unreadable") {
        ctx.couldNotCheck?.(`https://${read.host}/`, read.reason);
        continue;
      }
      if (read.kind === "absent") continue;
      const listed = certNames(read);
      if (read.kind === "cert" && read.cert.names.some((n) => covers(n, read.host))) continue;
      out.push({
        checkId: "cert-name-mismatch",
        severity: "high",
        title: this.title,
        evidence: `${clip(read.host)} is not covered by its certificate${listed.length > 0 ? `, which names ${listed.map(clip).join(", ")}` : ""}`,
        url: `https://${clip(read.host)}/`,
      });
    }
    return out;
  },
});

export const tokenExpiresSoon = defineCheck<PageSnapshot>({
  id: "token-expires-soon",
  size: "S",
  done: "A new token is created with a date well ahead, the deploy or sync that uses it is updated, and the old one is revoked.",
  estimateChanges:
    "Minutes for one token. Longer when it is copied into several places (a CI secret, a hosting setting, a teammate's machine) and nobody remembers where.",
  area: "Security & email",
  severity: "medium",
  title: "An access token expires soon",
  what: "A GitHub or Vercel token you set up for Gaugeline reports an expiry date within 21 days (fix soon) or 7 (fix first), or in the past.",
  why: "When a token lapses, whatever uses it stops with no warning: a deploy hook, a content sync, a scheduled job. It usually shows up as a site that quietly stops updating.",
  fix: 'Create a replacement with a later date, update everything that uses the old one, then revoke the old one. A token with no expiry is listed as "no expiry reported", not as a problem.',
  tech: "Only tokens you put in GAUGELINE_GITHUB_TOKEN or GAUGELINE_VERCEL_TOKEN are asked. GitHub: one GET of /rate_limit, reading the GitHub-Authentication-Token-Expiration response header. Vercel: one GET of /v5/user/tokens/current, reading expiresAt. Only the date is kept, and the token is never printed, logged or put in a result. A token whose provider reports no date is could-not-check (no expiry reported); nothing is created or revoked",
  async run(page, ctx) {
    const renewals = reader(ctx);
    if (!renewals) return [];
    const tokens = await renewals.tokens();
    if (tokens.length === 0) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        "no token is set up (set GAUGELINE_GITHUB_TOKEN or GAUGELINE_VERCEL_TOKEN to check one)",
      );
      return [];
    }
    const at = now(ctx);
    const out: Finding[] = [];
    for (const t of tokens) {
      const label = `${t.provider} token (${t.variable})`;
      if (t.failed) {
        ctx.couldNotCheck?.(`token:${t.provider.toLowerCase()}`, t.failed);
        continue;
      }
      if (!t.expiresAt) {
        ctx.couldNotCheck?.(
          `token:${t.provider.toLowerCase()}`,
          `no expiry reported for the ${label}`,
        );
        continue;
      }
      const expired = Date.parse(t.expiresAt) <= at.getTime();
      const severity = severityFor(
        daysUntil(t.expiresAt, at),
        expired,
        TOKEN_SOON_DAYS,
        TOKEN_FIRST_DAYS,
      );
      if (!severity) continue;
      out.push({
        checkId: "token-expires-soon",
        severity,
        title: this.title,
        evidence: `The ${label} ${expiryPhrase(t.expiresAt, at)}`,
        url: `token:${t.provider.toLowerCase()}`,
      });
    }
    return out;
  },
});

export const runtimeDeprecated = defineCheck<PageSnapshot>({
  id: "runtime-deprecated",
  size: "M",
  done: "The Vercel project builds and runs on a Node.js version Vercel supports, set in the project's settings and in package.json.",
  estimateChanges:
    "Changing the setting takes a minute. Moving a project across two majors can turn up packages that no longer install or code that relied on old behaviour, so test it on a preview first.",
  area: "Security & email",
  severity: "medium",
  title: "A Vercel project runs a Node.js version Vercel is retiring",
  what: "A Vercel project you listed in gaugeline.renewals.json uses a Node.js version that Vercel has announced it will stop supporting (or already has).",
  why: "Once Vercel retires a version, new deployments of the project can fail to build, and a site nobody touched for months stops being deployable the day someone needs to fix something.",
  fix: "Set the project's Node.js version to a current one (Project Settings, then Node.js Version, and the engines field in package.json), deploy a preview and check the site before promoting it.",
  tech: "GET /v9/projects/<name> on Vercel with GAUGELINE_VERCEL_TOKEN, reading only nodeVersion. The version's major is looked up in packages/core/src/data/vercel-node-runtimes.json: a dated list of the versions Vercel has announced for retirement, each with the page that says so. A version that is not in the list has no announced retirement and is not a finding. Under 7 days or past is high, under 90 days medium, further out low",
  async run(page, ctx) {
    const renewals = reader(ctx);
    if (!renewals) return [];
    const read = await renewals.runtimes();
    if (read.notAsked) {
      ctx.couldNotCheck?.(page.finalUrl, read.notAsked);
      return [];
    }
    const at = now(ctx);
    const out: Finding[] = [];
    for (const p of read.projects) {
      if (p.failed || !p.nodeVersion) {
        ctx.couldNotCheck?.(
          `vercel:${clip(p.project)}`,
          p.failed ?? `Vercel reported no Node.js version for ${p.project}`,
        );
        continue;
      }
      const status = runtimeStatus(p.nodeVersion, at);
      if (!status) continue;
      const severity: Severity =
        status.days < RUNTIME_FIRST_DAYS
          ? "high"
          : status.days < RUNTIME_SOON_DAYS
            ? "medium"
            : "low";
      out.push({
        checkId: "runtime-deprecated",
        severity,
        title: this.title,
        evidence: `Vercel project ${clip(p.project)} uses Node.js ${clip(p.nodeVersion)}, which ${expiryPhrase(`${status.retires}T00:00:00.000Z`, at, ["retires", "retired"])} (Gaugeline's list, written ${writeDate(`${NODE_RETIREMENTS_WRITTEN}T00:00:00Z`)}; source ${status.source})`,
        url: `vercel:${clip(p.project)}`,
      });
    }
    return out;
  },
});

export const RENEWALS_CHECKS = [
  domainExpiresSoon,
  domainExpired,
  domainStatusHold,
  certNameMismatch,
  tokenExpiresSoon,
  runtimeDeprecated,
] as const;
