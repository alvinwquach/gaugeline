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
  FetchError,
  LIMITS,
  classifyAddress,
  systemResolver,
  type Fetcher,
  type GetOptions,
  type Hop,
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

/** The four bytes as dotted decimal. */
const dotted = (a: number, b: number, c: number, d: number) =>
  `${a & 255}.${b & 255}.${c & 255}.${d & 255}`;

/**
 * Every IPv4 address an IPv6 one may carry: ::ffff:a.b.c.d, ::ffff:0:a.b.c.d, ::a.b.c.d, NAT64 64:ff9b::/96,
 * local-use NAT64 64:ff9b:1::/48 (both as the last 32 bits and in the RFC 6052 /48 layout) and 6to4 2002::/16.
 * More than one candidate is returned where a form is ambiguous: any of them being never-reachable refuses.
 */
function embeddedIPv4s(g: number[]): string[] {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const tail = dotted(g6 >> 8, g6, g7 >> 8, g7);
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  const out: string[] = [];
  if (zeros(5) && g5 === 0xffff) out.push(tail);
  if (zeros(4) && g4 === 0xffff && g5 === 0) out.push(tail);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) out.push(tail);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) {
    out.push(tail);
    out.push(dotted(g3 >> 8, g3, g4, g5 >> 8));
  }
  if (g0 === 0x2002) out.push(dotted(g1 >> 8, g1, g2 >> 8, g2));
  if (zeros(6) && g6 !== 0) out.push(tail);
  return out;
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
    if (embeddedIPv4s(g).some(neverReachable)) return true;
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
 * Wraps the core fetcher so that EVERY hop of a request is judged here, not only the first address. The
 * core fetcher follows redirects itself; this wrapper asks it for one hop at a time (`maxRedirects: 0`) and
 * follows the Location header itself, so on each hop:
 *   - the host literal is checked against the never-list (canonicalised, every IPv6 spelling of an IPv4
 *     address): a hop to such an address is refused before a socket opens. Host NAMES are judged on what they
 *     resolve to, by the resolver the fetcher was given (guardedResolver);
 *   - with `origin` (plan_check), the hop's origin must be exactly the configured one, user info and all; a
 *     redirect that leaves it is not followed: the trail stops at the redirect itself, as core stops at a
 *     redirect it will not follow, and nothing is sent to the other host;
 *   - request headers are not carried to another origin;
 *   - the hop count is core's own limit (LIMITS.redirectHops), and a loop is refused, as in core.
 * It has no `query`, so it cannot POST. Chosen over a per-hop hook in core so core is unchanged.
 */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const stripHash = (href: string) => href.replace(/#.*$/, "");

export function guardedFetcher(
  inner: Fetcher,
  opts: { origin?: string; maxHops?: number } = {},
): Fetcher {
  const maxHops = opts.maxHops ?? LIMITS.redirectHops;
  type Fetch = (address: string, o: GetOptions) => Promise<Hop[]>;

  const judge = (address: string): "ok" | "never" | "off" => {
    let u: URL;
    try {
      u = new URL(address);
    } catch {
      return "off";
    }
    if (neverReachable(u.hostname)) return "never";
    if (
      opts.origin !== undefined &&
      (u.origin !== opts.origin || u.username !== "" || u.password !== "")
    )
      return "off";
    return "ok";
  };

  async function walk(start: string, o: GetOptions, first: Fetch): Promise<Hop[]> {
    const hops: Hop[] = [];
    const visited = new Set<string>();
    let startOrigin: string;
    try {
      startOrigin = new URL(start).origin;
    } catch {
      throw new ToolError(opts.origin === undefined ? NEVER_MESSAGE : OFF_BASE);
    }
    let current = start;
    for (;;) {
      const verdict = judge(current);
      if (verdict === "never") {
        if (hops.length === 0) throw new ToolError(NEVER_MESSAGE);
        throw new FetchError("private-address-refused", NEVER_MESSAGE, current, [
          ...hops,
          { url: current, status: 0, headers: {}, ms: 0, error: "private-address-refused" },
        ]);
      }
      if (verdict === "off") {
        if (hops.length === 0) throw new ToolError(OFF_BASE);
        return hops; // the trail ends at the redirect that points off the base; nothing is sent there
      }
      visited.add(stripHash(current));
      // No credentials or headers across origins; one hop at a time.
      const sameOrigin = new URL(current).origin === startOrigin;
      const hopOptions: GetOptions = {
        ...o,
        maxRedirects: 0,
        ...(sameOrigin ? {} : { headers: {} }),
      };
      let step: Hop[];
      try {
        step = await (hops.length === 0 ? first : inner.get.bind(inner))(current, hopOptions);
      } catch (err) {
        if (
          err instanceof FetchError &&
          err.reason === "private-address-refused" &&
          hops.length > 0
        )
          throw new FetchError(err.reason, err.message, err.url, [
            ...hops,
            { url: current, status: 0, headers: {}, ms: 0, error: "private-address-refused" },
          ]);
        if (err instanceof FetchError)
          throw new FetchError(err.reason, err.message, err.url, hops, err.cause, err.hint);
        throw err;
      }
      hops.push(...step);
      const last = step.at(-1);
      const location = last && REDIRECTS.has(last.status) ? last.headers.location : undefined;
      if (location === undefined || location === null || location === "") return hops;
      if (o.maxRedirects !== undefined && hops.length > o.maxRedirects) return hops;
      let next: string;
      try {
        next = new URL(String(location).trim(), current).href;
      } catch {
        return hops;
      }
      if (visited.has(stripHash(next)))
        throw new FetchError("loop", "The address redirects in a loop.", start, hops);
      if (hops.length >= maxHops)
        throw new FetchError(
          "too-many-redirects",
          `Stopped after ${maxHops} redirects (too many redirects).`,
          start,
          hops,
        );
      current = next;
    }
  }

  return {
    get: (url, o = {}) => walk(url, o, (a, x) => inner.get(a, x)),
    getSite: (address, o = {}) => walk(address, o, (a, x) => inner.getSite(a, x)),
    get stats() {
      return inner.stats;
    },
    ...(inner.history ? { history: () => inner.history?.() ?? [] } : {}),
  };
}

export const OFF_BASE =
  "A plan address points off the preview it is being checked against. Nothing was requested for it.";
