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
  type Fetcher,
  type Resolver,
  type ResolvedAddress,
} from "@gaugeline/core";
import { ToolError } from "./errors.js";

/** Cloud metadata addresses that are not link-local: Alibaba's 100.100.100.200 and Azure's wire server 168.63.129.16. */
const METADATA_V4 = new Set(["100.100.100.200", "168.63.129.16"]);
/** AWS's IPv6 metadata address fd00:ec2::254, as eight groups. */
const AWS_V6 = "fd00:ec2:0:0:0:0:0:254";

export const NEVER_MESSAGE =
  "Link-local and cloud-metadata addresses are never requested by this server, whatever it was started with.";

/** Eight 16-bit groups of an IPv6 address, however it is spelled ("::", an IPv4 tail, brackets, a zone). */
function groupsOf(ip: string): number[] | undefined {
  const text = (ip.replace(/^\[|\]$/g, "").split("%")[0] ?? "").toLowerCase();
  if (isIP(text) !== 6) return undefined;
  let head = text;
  let tail: number[] | undefined;
  const last = text.lastIndexOf(":");
  const v4 = text.slice(last + 1);
  if (v4.includes(".")) {
    const b = v4.split(".").map(Number);
    tail = [((b[0] ?? 0) << 8) | (b[1] ?? 0), ((b[2] ?? 0) << 8) | (b[3] ?? 0)];
    head = `${text.slice(0, last + 1)}0:0`;
  }
  const [left = "", right] = head.split("::");
  const hex = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const l = hex(left);
  const r = right === undefined ? [] : hex(right);
  const groups =
    right === undefined
      ? l
      : [...l, ...Array<number>(Math.max(0, 8 - l.length - r.length)).fill(0), ...r];
  if (groups.length !== 8) return undefined;
  if (tail) groups.splice(6, 2, ...tail);
  return groups;
}

/** The IPv4 address an IPv6 one carries (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d, ::ffff:0:a.b.c.d), if it carries one. */
function embeddedIPv4(g: number[]): string | undefined {
  const [g6 = 0, g7 = 0] = [g[6], g[7]];
  const v4 = `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && g[5] === 0xffff) return v4;
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return v4;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4;
  if (zeros(6) && g6 !== 0) return v4;
  return undefined;
}

/**
 * Whether an address is one this server never requests. The address is canonicalised first (expanded,
 * and the IPv4 address inside a mapped or translated IPv6 form pulled out), so no spelling gets past.
 */
export function neverReachable(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const g = groupsOf(ip);
  if (g) {
    if (g.map((x) => x.toString(16)).join(":") === AWS_V6) return true;
    const inner = embeddedIPv4(g);
    if (inner !== undefined && neverReachable(inner)) return true;
  }
  if (METADATA_V4.has(ip)) return true;
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

/**
 * A fetcher that sends a request only to one origin: scheme, host and port exactly as configured, no
 * user name or password in the address. It wraps the real one (and drops `query`, so it cannot POST). A
 * request for anything else is refused before it is sent. A second line of defence behind the plan
 * check's own row check: a plan cell such as "//evil.example/x" is a protocol-relative address that
 * replaces the host when core joins it onto the base.
 */
export function onlyOrigin(inner: Fetcher, origin: string): Fetcher {
  const allow = (address: string) => {
    let u: URL;
    try {
      u = new URL(address);
    } catch {
      throw new ToolError(OFF_BASE);
    }
    if (u.origin !== origin || u.username !== "" || u.password !== "")
      throw new ToolError(OFF_BASE);
  };
  return {
    get: async (url, opts) => {
      allow(url);
      return inner.get(url, opts);
    },
    getSite: async (address, opts) => {
      allow(address);
      return inner.getSite(address, opts);
    },
    get stats() {
      return inner.stats;
    },
    ...(inner.history ? { history: () => inner.history?.() ?? [] } : {}),
  };
}

export const OFF_BASE =
  "A plan address points off the preview it is being checked against. Nothing was requested for it.";
