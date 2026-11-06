import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Public DNS reads, for the email record checks: TXT and MX only. This module never opens a
 * connection to a mail server and never sends mail. Answers are whatever the machine's resolver
 * returns, so a network with its own internal DNS can see different records than the public does.
 */
export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface DnsReader {
  /** TXT records at the name, each record's chunks joined into one string. [] when there are none. */
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<MxRecord[]>;
}

/** The two node:dns/promises calls the reader makes. Injectable so tests never touch a resolver. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<MxRecord[]>;
}

/** A lookup that failed for a reason other than "no records": the checks report could-not-check. */
export class DnsLookupError extends Error {
  constructor(
    readonly rrtype: "TXT" | "MX",
    readonly hostname: string,
    readonly reason: string,
  ) {
    super(
      `The ${rrtype} lookup for ${hostname} failed (${reason}), so its records could not be checked`,
    );
    this.name = "DnsLookupError";
  }
}

/** "No such name" and "no records of that type": both mean there is nothing published. */
const NO_RECORDS: ReadonlySet<string> = new Set(["ENOTFOUND", "ENODATA"]);

/**
 * Names reserved for documentation and testing (RFC 2606, RFC 6761): they have no public records,
 * so they are never sent to a resolver. This also keeps every test that uses them off the network.
 */
export function isReservedName(name: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, "");
  return (
    /(?:^|\.)(?:example|test|invalid|localhost)$/.test(n) ||
    /(?:^|\.)example\.(?:com|net|org)$/.test(n)
  );
}

export interface DnsReaderOptions {
  timeoutMs?: number;
  resolver?: DnsResolver;
  /** Ask about reserved names too. For tests with a fake resolver only. */
  askReserved?: boolean;
}

/** TXT and MX reads through node:dns/promises, memoised by name in a Map. */
export function createDnsReader({
  timeoutMs = 5000,
  resolver,
  askReserved = false,
}: DnsReaderOptions = {}): DnsReader {
  const r: DnsResolver = resolver ?? new Resolver({ timeout: timeoutMs, tries: 2 });
  const memo = new Map<string, Promise<unknown>>();
  function read<T>(rrtype: "TXT" | "MX", name: string, ask: () => Promise<T[]>): Promise<T[]> {
    const host = name.toLowerCase().replace(/\.$/, "");
    if (!askReserved && isReservedName(host)) return Promise.resolve([]);
    const key = `${rrtype} ${host}`;
    let pending = memo.get(key) as Promise<T[]> | undefined;
    if (!pending) {
      pending = ask().catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code === "string" && NO_RECORDS.has(code)) return [];
        throw new DnsLookupError(rrtype, host, typeof code === "string" ? code : "no answer");
      });
      memo.set(key, pending);
    }
    return pending;
  }
  return {
    txt: (name) =>
      read("TXT", name, async () => (await r.resolveTxt(name)).map((chunks) => chunks.join(""))),
    mx: (name) => read("MX", name, () => r.resolveMx(name)),
  };
}

/**
 * The domain whose records are read: the host as given, without a leading www. The organisational
 * domain is not guessed (that needs the public suffix list), so app.example.com is read as is.
 */
export function registrableDomain(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

/** The name to read records for, or undefined for an IP address or localhost (no public records). */
export function dnsName(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
  if (host === "" || isIP(host) !== 0 || host.toLowerCase() === "localhost") return undefined;
  return registrableDomain(host);
}
