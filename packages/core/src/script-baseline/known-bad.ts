import list from "../data/known-bad-script-hosts.json";

/** One host from packages/core/src/data/known-bad-script-hosts.json. */
export interface KnownBadHost {
  host: string;
  /** Month the source dates the problem from, "YYYY-MM". */
  since: string;
  note: string;
  source: { title: string; url: string };
  /** Written from a recollection of the source and not yet confirmed by a maintainer. */
  proposed: boolean;
}

export const KNOWN_BAD_HOSTS: readonly KnownBadHost[] = Object.freeze(
  (list.hosts as KnownBadHost[]).map((h) => Object.freeze({ ...h })),
);

/** The list entry a script host falls under (the host itself or any subdomain of it), if any. */
export function knownBadHost(host: string): KnownBadHost | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  return KNOWN_BAD_HOSTS.find((k) => h === k.host || h.endsWith(`.${k.host}`));
}
