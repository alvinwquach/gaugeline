import {
  certificateFromPeer,
  covers,
  type Certificate,
  type PeerCertificate,
} from "../dns/certificate.js";
import { FetchError, type Fetcher } from "../fetcher.js";
import { registrableOf } from "./suffix.js";

/** What one host's certificate looked like. */
export type CertRead =
  /** The certificate it presented, read from the connection of one HEAD request. */
  | { host: string; kind: "cert"; cert: Certificate }
  /** The handshake failed because the certificate does not name this host (`names` are the ones it does). */
  | { host: string; kind: "name-mismatch"; names: string[]; validTo?: string }
  /** The name does not exist in DNS: the site has no such host (many sites have no www), so there is nothing to check. */
  | { host: string; kind: "absent" }
  | { host: string; kind: "unreadable"; reason: string };

/**
 * The hosts whose certificates are read for a page's host: the bare domain and its www for a site on
 * its own domain, just the host for a subdomain, a platform address or anything else.
 */
export function certificateHosts(host: string): string[] {
  const clean = host.toLowerCase().replace(/\.$/, "");
  const r = registrableOf(clean);
  if (r.kind === "domain" && (clean === r.domain || clean === `www.${r.domain}`))
    return [r.domain, `www.${r.domain}`];
  return r.kind === "none" ? [] : [clean];
}

/** The hostname-mismatch error Node raises, anywhere in a cause chain. */
function mismatch(err: unknown, depth = 0): { cert?: PeerCertificate } | undefined {
  if (depth > 5 || err === null || typeof err !== "object") return undefined;
  if ((err as { code?: unknown }).code === "ERR_TLS_CERT_ALTNAME_INVALID")
    return {
      ...((err as { cert?: PeerCertificate }).cert
        ? { cert: (err as { cert: PeerCertificate }).cert }
        : {}),
    };
  return mismatch((err as { cause?: unknown }).cause, depth + 1);
}

/** The TLS error codes in a cause chain, for a plain reason ("CERT_HAS_EXPIRED"). */
function tlsCode(err: unknown, depth = 0): string | undefined {
  if (depth > 5 || err === null || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))
    return code;
  return tlsCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Read the certificate each host presents. One HEAD of https://<host>/ through the fetcher, without
 * following a redirect: the names and dates come off the connection, the same way the page check
 * reads them, and nothing is downloaded. A host whose certificate does not name it fails the
 * handshake; Node's error carries the certificate, so the names it does cover are still read.
 */
export async function readCertificates(
  hosts: readonly string[],
  fetcher: Fetcher,
  port = 443,
): Promise<CertRead[]> {
  return Promise.all(
    hosts.map(async (host): Promise<CertRead> => {
      try {
        const hops = await fetcher.get(`https://${host}${port === 443 ? "" : `:${port}`}/`, {
          method: "HEAD",
          maxRedirects: 0,
        });
        const cert = hops[0]?.certificate;
        return cert
          ? { host, kind: "cert", cert }
          : { host, kind: "unreadable", reason: `${host} presented no certificate` };
      } catch (err) {
        if (err instanceof FetchError && err.reason === "not-found")
          return { host, kind: "absent" };
        const wrong = mismatch(err);
        if (wrong) {
          const cert = certificateFromPeer(wrong.cert);
          return {
            host,
            kind: "name-mismatch",
            names: cert?.names ?? [],
            ...(cert?.validTo ? { validTo: cert.validTo } : {}),
          };
        }
        const code = tlsCode(err);
        if (err instanceof FetchError && err.reason === "tls")
          return {
            host,
            kind: "unreadable",
            reason: `${host}'s certificate could not be verified${code ? ` (${code})` : ""}`,
          };
        return {
          host,
          kind: "unreadable",
          reason: err instanceof Error ? err.message : `${host} could not be reached`,
        };
      }
    }),
  );
}

/** Whether a read certificate names the host (exactly or by a one-label wildcard). */
export function names(read: CertRead): string[] {
  return read.kind === "cert" ? read.cert.names : read.kind === "name-mismatch" ? read.names : [];
}

export const coversHost = (read: CertRead): boolean =>
  read.kind === "cert" && read.cert.names.some((n) => covers(n, read.host));
