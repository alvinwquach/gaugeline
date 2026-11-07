import { blockedRange } from "../addresses.js";

/**
 * Where a request may go, judged on the address a name resolved to, never the name itself: names
 * lie, an integer or hex literal can spell 127.0.0.1, and a second lookup can answer differently.
 * The fetcher connects to the address it classified.
 */
export type AddressClass = "public" | "loopback" | "private" | "link-local" | "unspecified";

export function classifyAddress(ip: string): AddressClass {
  const range = blockedRange(ip);
  if (range === undefined) return "public";
  if (range === "loopback") return "loopback";
  if (range === "link-local") return "link-local";
  if (range === "unspecified") return "unspecified";
  // private, unique-local (fc00::/7), CGNAT (100.64/10), multicast and broadcast: not the internet.
  return "private";
}

/** host:port with the scheme's default port spelt out, so http://a/ and http://a:80/ are one. */
function hostPort(u: URL): string {
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `${u.hostname.toLowerCase()}:${port}`;
}

/**
 * The address the person typed (the target) may be public, private or loopback: it is trusted the
 * way their own terminal is. Every other request (a redirect hop, a link, a sitemap or feed entry,
 * a script, an address in structured data) must resolve to a public address, unless its host and
 * port are the target's.
 */
export function createAddressPolicy(
  target: URL,
): (url: URL, resolvedIp: string, kind: "target" | "followed") => boolean {
  const own = hostPort(target);
  return (url, resolvedIp, kind) =>
    kind === "target" || hostPort(url) === own || classifyAddress(resolvedIp) === "public";
}

/** Whether a request is to the target itself: the same host and port. */
export const isTarget = (url: URL, target: URL) => hostPort(url) === hostPort(target);
