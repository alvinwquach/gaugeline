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
  size: "S",
  done: "The certificate is renewed with a date well ahead, and automatic renewal is working again.",
  estimateChanges:
    "If renewal stopped after a DNS or host change, finding the cause can take an afternoon. A certificate installed by hand takes minutes.",
  area: "Security & email",
  severity: "high",
  title: "The site's certificate expires soon",
  what: "The https certificate the site presented expires in under 21 days (fix soon) or under 7 (fix first), or has expired.",
  why: "When it lapses, every browser shows a full-page security warning instead of the site, and most visitors leave.",
  fix: "Renew it, or find why automatic renewal stopped (a DNS change at cutover often breaks the renewal check). Domain registration expiry is a separate date: check it at your registrar.",
  tech: "Read from the TLS connection of the page's own GET: no extra request. Days left = whole days until notAfter, by the run's clock. Plain http, or a certificate that failed verification, gives nothing here. With --renewals the certificates of the bare domain and www are read too (one HEAD each, from the connection), and one with a different expiry is reported as well. Domain registration expiry is a separate check (domain-expires-soon)",
  async run(input, ctx) {
    const { cert, url, host } = certOf(input);
    const at = ctx.now?.() ?? new Date();
    const found: Finding[] = [];
    const seen = new Set<string>();
    const key = (c: Certificate) => `${c.names.join(",")}|${c.validTo}`;
    if (cert && cert.validTo !== "") {
      seen.add(key(cert));
      const f = expiryFinding(cert, at, url, host);
      if (f) found.push(f);
    }
    // With --renewals, the other of the bare domain and www may be served by a different certificate.
    if (ctx.renewals && "hops" in input && host !== "") {
      for (const read of await ctx.renewals.certificates(host)) {
        if (read.kind !== "cert" || read.cert.validTo === "" || seen.has(key(read.cert))) continue;
        seen.add(key(read.cert));
        const f = expiryFinding(read.cert, at, `https://${read.host}/`, read.host);
        if (f) found.push(f);
      }
    }
    return found;
  },
});
