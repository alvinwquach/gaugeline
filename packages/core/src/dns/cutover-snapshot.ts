import * as z from "zod";
import type { DnsReader } from "../dns.js";
import { FetchError, type Fetcher, type Hop } from "../fetcher.js";
import { NetworkError } from "../errors.js";
import type { Certificate } from "./certificate.js";
import { readDomainRecords, type DomainRecords } from "./records.js";

/** How one host name answers https://<host>/: its first hop, and where the trail ends. */
export type HostBehaviour =
  { status: number; location?: string; endsAt?: string } | { error: string };

/**
 * gaugeline snapshot's file: what a domain looked like before cutover, to compare with after.
 * Records, the certificate's names and expiry, and how the bare domain and www behave.
 */
export interface CutoverSnapshot {
  schema: 1;
  domain: string;
  takenAt: string;
  records: DomainRecords;
  certificate?: Certificate;
  hosts: { bare: HostBehaviour; www: HostBehaviour };
}

export const CUTOVER_RECORDS = [
  "a",
  "aaaa",
  "mx",
  "spf",
  "dmarc",
  "dkim",
  "certificate",
  "hosts",
] as const;
export type CutoverRecord = (typeof CUTOVER_RECORDS)[number];

/** gaugeline.cutover.json: the DKIM selectors to read, and the changes that were meant. */
export const cutoverConfigSchema = z
  .object({
    dkimSelectors: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).optional(),
    expectedChanges: z
      .array(z.object({ record: z.enum(CUTOVER_RECORDS), reason: z.string().min(1) }).strict())
      .optional(),
  })
  .strict();
export type CutoverConfig = z.infer<typeof cutoverConfigSchema>;

export interface CutoverSnapshotOptions {
  domain: string;
  dns: DnsReader;
  fetcher: Fetcher;
  selectors?: readonly string[];
  now?: () => Date;
  /** Request the hosts on this port (tests). Default 443. */
  port?: number;
}

/** "www.shop.example/": host and path, no scheme or port, so a snapshot reads the same anywhere. */
const strip = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname}`;
  } catch {
    return u;
  }
};

function behaviour(hops: readonly Hop[]): HostBehaviour {
  const first = hops[0];
  if (!first) return { error: "no answer" };
  const last = hops.at(-1);
  const location = first.headers.location;
  let to: string | undefined;
  if (location) {
    try {
      to = strip(new URL(location, first.url).href);
    } catch {
      to = location;
    }
  }
  return {
    status: first.status,
    ...(to ? { location: to } : {}),
    ...(last && last !== first ? { endsAt: strip(last.url) } : {}),
  };
}

/** One read of everything the cutover compares. GETs go through the fetcher; DNS through the reader. */
export async function takeCutoverSnapshot(opts: CutoverSnapshotOptions): Promise<CutoverSnapshot> {
  const domain = opts.domain
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  const port = opts.port ?? 443;
  const at = (host: string) => `https://${host}${port === 443 ? "" : `:${port}`}/`;
  const read = async (host: string): Promise<{ hops: Hop[]; b: HostBehaviour }> => {
    try {
      const hops = await opts.fetcher.get(at(host));
      return { hops, b: behaviour(hops) };
    } catch (err) {
      if (err instanceof FetchError && err.hops.length > 0)
        return { hops: err.hops, b: behaviour(err.hops) };
      if (err instanceof NetworkError) return { hops: [], b: { error: err.message } };
      throw err;
    }
  };
  const [records, bare, www] = await Promise.all([
    readDomainRecords(opts.dns, domain, opts.selectors ?? []),
    read(domain),
    read(`www.${domain}`),
  ]);
  const certificate = bare.hops[0]?.certificate ?? www.hops[0]?.certificate;
  return {
    schema: 1,
    domain,
    takenAt: (opts.now ?? (() => new Date()))().toISOString(),
    records,
    ...(certificate ? { certificate } : {}),
    hosts: { bare: bare.b, www: www.b },
  };
}
