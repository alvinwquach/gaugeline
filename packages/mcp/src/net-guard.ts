/**
 * Which addresses this server may be asked to reach. The CLI trusts the address a person typed; here
 * the address comes from a model, so the rules are stricter:
 *   - link-local, unspecified and the cloud-metadata addresses are refused ALWAYS, even with --allow-private;
 *   - --allow-private opens loopback and private ranges only;
 *   - --allow-private-host host:port (repeatable) names the only private addresses a model may reach, and
 *     then no other private address is reachable.
 * The judgement is made on the address a name resolved to, never on the name, and a name that resolves
 * to a refused address is refused by the resolver the fetcher is given.
 */
import { isIP } from "node:net";
import {
  classifyAddress,
  systemResolver,
  type Resolver,
  type ResolvedAddress,
} from "@gaugeline/core";

/** Cloud metadata addresses that are not link-local: Alibaba's 100.100.100.200 and AWS IPv6 fd00:ec2::254. */
const METADATA = new Set(["100.100.100.200", "fd00:ec2::254"]);

export const NEVER_MESSAGE =
  "Link-local and cloud-metadata addresses are never requested by this server, whatever it was started with.";

export function neverReachable(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA.has(ip)) return true;
  const c = classifyAddress(ip);
  return c === "link-local" || c === "unspecified";
}

/** The resolver the fetcher uses: the system's, refusing a name that points at a never-reachable address. */
export function guardedResolver(inner: Resolver = systemResolver): Resolver {
  return async (hostname: string): Promise<ResolvedAddress[]> => {
    const found = await inner(hostname);
    if (found.some((a) => neverReachable(a.address))) throw new Error(NEVER_MESSAGE);
    return found;
  };
}

/** host:port with the scheme's default port spelled out, lower case, no brackets around IPv6. */
export function hostPortOf(url: URL): string {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.replace(/^\[|\]$/g, "").toLowerCase()}:${port}`;
}

/** Normalises an --allow-private-host value ("127.0.0.1:3000", "[::1]:3000", "dev.test:8080"). */
export function normaliseHostPort(value: string): string {
  let u: URL;
  try {
    u = new URL(`http://${value}`);
  } catch {
    throw new Error(
      `--allow-private-host needs host:port, for example 127.0.0.1:3000 (got ${JSON.stringify(value.slice(0, 60))}).`,
    );
  }
  if (u.port === "" || u.pathname !== "/" || u.username !== "")
    throw new Error(
      `--allow-private-host needs host:port, for example 127.0.0.1:3000 (got ${JSON.stringify(value.slice(0, 60))}).`,
    );
  return hostPortOf(u);
}

/** Refuses an address literal that is never reachable, before any request. Names are judged by the resolver. */
export function checkTarget(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && neverReachable(host)) throw new Error(NEVER_MESSAGE);
}
