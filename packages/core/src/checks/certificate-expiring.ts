import { covers, daysLeft, EXPIRY_DAYS, SOON_DAYS, type Certificate } from "../dns/certificate.js";
import type { CutoverSnapshot } from "../dns/cutover-snapshot.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

/** Either input carries a certificate: a page run's first hop, or the cutover's fresh snapshot. */
type CertInput = PageSnapshot | { now: CutoverSnapshot };

function certOf(input: CertInput): { cert?: Certificate; url: string; host: string } {
  if ("hops" in input) {
    const hop = input.hops[0];
    let host = "";
    try {
      host = new URL(hop?.url ?? input.finalUrl).hostname;
    } catch {
      host = "";
    }
    return { ...(hop?.certificate ? { cert: hop.certificate } : {}), url: input.finalUrl, host };
  }
  const s = input.now;
  return {
    ...(s.certificate ? { cert: s.certificate } : {}),
    url: `https://${s.domain}/`,
    host: s.domain,
  };
}

const day = (iso: string) => iso.slice(0, 10);

/** The expiry finding for one certificate, if it expires within 21 days (or has). Pure. */
export function expiryFinding(
  cert: Certificate,
  now: Date,
  url: string,
  host: string,
): Finding | undefined {
  const left = daysLeft(cert, now);
  if (left >= EXPIRY_DAYS) return undefined;
  const name = cert.names.find((n) => covers(n, host)) ?? cert.names[0] ?? host;
  const evidence =
    left < 0
      ? `The certificate for ${name} expired on ${day(cert.validTo)}, ${-left} day${left === -1 ? "" : "s"} ago`
      : `The certificate for ${name} expires on ${day(cert.validTo)}: ${left} day${left === 1 ? "" : "s"} left${cert.issuer ? ` (issued by ${cert.issuer})` : ""}`;
  return {
    checkId: "certificate-expiring",
    severity: left < SOON_DAYS ? "high" : "medium",
    title: "The site's certificate expires soon",
    evidence,
    url,
  };
}

export const certificateExpiring = defineCheck<CertInput>({
  id: "certificate-expiring",
  area: "Security & email",
  severity: "high",
  title: "The site's certificate expires soon",
  what: "The https certificate the site presented expires in under 21 days (fix soon) or under 7 (fix first), or has expired.",
  why: "When it lapses, every browser shows a full-page security warning instead of the site, and most visitors leave.",
  fix: "Renew it, or find why automatic renewal stopped (a DNS change at cutover often breaks the renewal check). Domain registration expiry is a separate date: check it at your registrar.",
  tech: "Read from the TLS connection of the page's own GET: no extra request. Days left = whole days until notAfter, by the run's clock. Plain http, or a certificate that failed verification, gives nothing here. Domain registration expiry needs registrar access and is not checked",
  run(input, ctx) {
    const { cert, url, host } = certOf(input);
    if (!cert || cert.validTo === "") return [];
    const f = expiryFinding(cert, ctx.now?.() ?? new Date(), url, host);
    return f ? [f] : [];
  },
});
