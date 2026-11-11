/**
 * The certificate a site presented, as read from the TLS connection of an ordinary GET: its
 * names, its validity and who issued it. Nothing else is kept (no key, no fingerprint chain).
 */
export interface Certificate {
  /** The DNS names it covers (subjectAltName), else its common name. Lower case, sorted. */
  names: string[];
  /** ISO times. */
  validFrom: string;
  validTo: string;
  issuer?: string;
}

/** The fields of node:tls's getPeerCertificate() this reads. */
export interface PeerCertificate {
  subject?: { CN?: string | string[] };
  issuer?: { O?: string | string[]; CN?: string | string[] };
  subjectaltname?: string;
  valid_from?: string;
  valid_to?: string;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The certificate on a socket, or undefined for plain http or a socket with none. */
export function certificateOf(socket: unknown): Certificate | undefined {
  const get = (socket as { getPeerCertificate?: (detailed?: boolean) => PeerCertificate })
    ?.getPeerCertificate;
  if (typeof get !== "function") return undefined;
  let peer: PeerCertificate;
  try {
    peer = get.call(socket, false);
  } catch {
    return undefined;
  }
  return certificateFromPeer(peer);
}

/**
 * The same reading for a certificate object that is not on a socket: the `cert` Node attaches to a
 * hostname-mismatch error, which is how a name that the certificate does not cover is still read.
 */
export function certificateFromPeer(peer: PeerCertificate | undefined): Certificate | undefined {
  if (!peer || !peer.valid_to) return undefined;
  const san = (peer.subjectaltname ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4).toLowerCase());
  const cn = one(peer.subject?.CN);
  const names = [...new Set(san.length > 0 ? san : cn ? [cn.toLowerCase()] : [])].sort();
  const iso = (s: string | undefined) => {
    const d = new Date(s ?? "");
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  };
  const issuer = one(peer.issuer?.O) ?? one(peer.issuer?.CN);
  return {
    names,
    validFrom: iso(peer.valid_from),
    validTo: iso(peer.valid_to),
    ...(issuer ? { issuer } : {}),
  };
}

/** Whether a certificate name covers a host: exactly, or a wildcard for one label (*.shop.example). */
export function covers(name: string, host: string): boolean {
  const n = name.toLowerCase();
  const h = host.toLowerCase().replace(/\.$/, "");
  if (n === h) return true;
  if (!n.startsWith("*.")) return false;
  const rest = n.slice(1);
  return h.endsWith(rest) && !h.slice(0, -rest.length).includes(".") && h.length > rest.length;
}

/** Whole days from `now` until the certificate expires; negative once it has. */
export function daysLeft(cert: Pick<Certificate, "validTo">, now: Date): number {
  return Math.floor((new Date(cert.validTo).getTime() - now.getTime()) / 86_400_000);
}

/** Under this many days left is fix soon; under SOON_DAYS, fix first. */
export const EXPIRY_DAYS = 21;
export const SOON_DAYS = 7;
