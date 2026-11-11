import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { DnsReader } from "../dns.js";
import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { gatherEvidence, type WordPressData } from "./evidence.js";
import { createOsv, OsvError } from "./osv.js";
import { ADVISORY_SCHEMA_VERSION, type AdvisoryResult } from "./schema.js";
import { isAdvisoryId, normaliseId, parseSpec, type Advisory } from "./target.js";
import { decide, needsOf } from "./verdict.js";

export interface AdvisoryOptions {
  fetcher: Fetcher;
  /** The site as typed. */
  address: string;
  /** An advisory id (CVE-..., GHSA-...) or a package and range (next@>=15.0.0 <15.2.3). */
  spec: string;
  /**
   * Packages and ranges given directly. With these, an id is only a label: OSV is not asked, which is the way
   * out when OSV cannot be reached or does not have the id.
   */
  packages?: readonly string[];
  /** Other hostnames to look at (old subdomains, legacy hosts), each required to answer. */
  hosts?: readonly string[];
  /** With DNS: the name servers are read. */
  dns?: DnsReader;
  /** The WordPress read of C-01, when it exists, in place of the page's own signs. */
  wordpress?: WordPressData;
  now?: () => Date;
}

const OUT =
  "Pass the package and range yourself instead: gaugeline advisory <site> CVE-... --package next@>=15.0.0 <15.2.3 (the affected versions are on the advisory's own page).";

/** The advisory as the run will use it: read from OSV for an id, or built from what was typed. */
async function resolve(opts: AdvisoryOptions): Promise<Advisory> {
  const given = opts.packages ?? [];
  const spec = opts.spec.trim();
  const id = isAdvisoryId(spec);
  if (given.length > 0 || !id) {
    const components = [...(id ? [] : parseSpec(spec)), ...given.flatMap((p) => parseSpec(p))];
    return {
      id: id ? normaliseId(spec) : escapeInvisible(spec, 120),
      aliases: [],
      source: "given",
      components,
    };
  }
  try {
    return await createOsv(opts.fetcher).get(spec);
  } catch (err) {
    if (err instanceof OsvError)
      throw new ConfigError(err.message, {
        hint:
          err.kind === "not-found"
            ? `OSV lists some advisories only under their GHSA id: try that. ${OUT}`
            : OUT,
      });
    throw err;
  }
}

/**
 * Answer "is this site affected by this advisory?" from outside only. The advisory is read from OSV (one GET)
 * or typed; the site's home page, its www twin, hostnames the person named and a few linked subdomains are read
 * with GET; the verdict compares what they show with the affected versions. Looks only: nothing is submitted,
 * no exploit is tried and no path is guessed.
 */
export async function checkAdvisory(opts: AdvisoryOptions): Promise<AdvisoryResult> {
  const advisory = await resolve(opts);
  const evidence = await gatherEvidence({
    fetcher: opts.fetcher,
    address: opts.address,
    hosts: opts.hosts ?? [],
    needs: needsOf(advisory.components),
    ...(opts.dns ? { dns: opts.dns } : {}),
    ...(opts.wordpress ? { wordpress: opts.wordpress } : {}),
  });
  const d = decide(advisory, evidence);
  const summary = advisory.summary ? escapeInvisible(advisory.summary, 200) : undefined;
  const first = evidence.hosts[0];
  return {
    schemaVersion: ADVISORY_SCHEMA_VERSION,
    advisory: {
      id: advisory.id,
      aliases: advisory.aliases.map((a) => escapeInvisible(a, 60)),
      ...(summary ? { summary } : {}),
      ...(advisory.withdrawn ? { withdrawn: escapeInvisible(advisory.withdrawn, 40) } : {}),
      source: advisory.source,
      packages: advisory.components.map((c) => ({
        ecosystem: escapeInvisible(c.label, 40),
        name: escapeInvisible(c.name, 100),
        affectedVersions: c.rangeText,
      })),
    },
    site: {
      address: first?.read.ok ? first.read.origin : opts.address,
      checkedAt: (opts.now ?? (() => new Date()))().toISOString(),
      hostnames: evidence.hosts.map((h) => ({
        host: h.host,
        reached: h.read.ok,
        ...(!h.read.ok
          ? { note: escapeInvisible(h.read.reason, 120) }
          : h.opaque
            ? { note: h.opaque }
            : {}),
      })),
    },
    verdict: d.verdict,
    headline: d.headline,
    evidence: d.evidence,
    components: d.components.map((c) => ({
      ecosystem: escapeInvisible(c.component.label, 40),
      name: escapeInvisible(c.component.name, 100),
      verdict: c.verdict,
      evidence: c.evidence,
      ...(c.fixedIn ? { fixedIn: c.fixedIn } : {}),
    })),
    checkInside: d.checkInside,
    couldNotCheck: d.couldNotCheck,
  };
}
