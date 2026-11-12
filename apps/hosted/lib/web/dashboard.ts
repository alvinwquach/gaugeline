/**
 * What the dashboard knows about each site: the last two runs' counts, whether the site got worse, better or
 * stayed the same, and the worst finding that is new since the run before. Read as the signed-in person
 * (the policies apply); a site the person cannot see simply has no rows. Two queries for the whole list,
 * however many sites: the counts, then the newest finding of every site that has a run to compare with.
 */
import type { Tx } from "./db.js";
import type { SiteRow } from "./memberships.js";

/** Integers, never floats: they are compared and sorted, and a count of findings is a whole number. */
export interface Counts {
  high: number;
  medium: number;
  low: number;
}

export type Trend = "worse" | "better" | "still" | "first" | "unchecked";

export interface NewFinding {
  severity: "high" | "medium";
  title: string;
  evidence: string;
}

export interface SiteSummary extends SiteRow {
  lastRun: { id: string; startedAt: Date } | null;
  counts: Counts | null;
  previous: Counts | null;
  trend: Trend;
  /** The worst finding in the last run that the run before did not have; only for a site that has both. */
  newest: NewFinding | null;
}

/**
 * Fix this first decides, then Fix soon; Worth knowing does not move a site either way. No run before this
 * one is "first" (nothing to compare with), and no run at all is "unchecked".
 */
export function trendOf(now: Counts | null, prev: Counts | null): Trend {
  if (!now) return "unchecked";
  if (!prev) return "first";
  if (now.high !== prev.high) return now.high > prev.high ? "worse" : "better";
  if (now.medium !== prev.medium) return now.medium > prev.medium ? "worse" : "better";
  return "still";
}

/** Worst first: most Fix this first, then most Fix soon, then name. A site never checked goes last. */
export function sortSites<T extends Pick<SiteSummary, "name" | "id" | "counts">>(sites: T[]): T[] {
  return [...sites].sort(
    (a, b) =>
      Number(a.counts === null) - Number(b.counts === null) ||
      (b.counts?.high ?? 0) - (a.counts?.high ?? 0) ||
      (b.counts?.medium ?? 0) - (a.counts?.medium ?? 0) ||
      a.name.localeCompare(b.name, "en") ||
      a.id.localeCompare(b.id),
  );
}

export async function siteSummaries(tx: Tx, sites: SiteRow[]): Promise<SiteSummary[]> {
  if (sites.length === 0) return [];
  const ids = sites.map((s) => s.id);
  // The last two runs of each site (the index on (site_id, started_at desc) serves the inner limit) with
  // the number of findings of each level.
  const rows = await tx`
    select r.site_id, r.id as run_id, r.started_at, r.rn,
      count(f.id) filter (where f.severity = 'high')::int as high,
      count(f.id) filter (where f.severity = 'medium')::int as medium,
      count(f.id) filter (where f.severity = 'low')::int as low
    from public.sites s
    cross join lateral (
      select x.id, x.site_id, x.started_at, row_number() over (order by x.started_at desc, x.id desc) as rn
      from (
        select id, site_id, started_at from public.runs
        where site_id = s.id order by started_at desc, id desc limit 2
      ) x
    ) r
    left join public.findings f on f.run_id = r.id
    where s.id = any(${ids}::uuid[])
    group by r.site_id, r.id, r.started_at, r.rn`;
  const last = new Map<string, { id: string; startedAt: Date; counts: Counts }>();
  const before = new Map<string, { id: string; counts: Counts }>();
  for (const r of rows) {
    const counts = { high: r.high as number, medium: r.medium as number, low: r.low as number };
    if (Number(r.rn) === 1)
      last.set(r.site_id as string, {
        id: r.run_id as string,
        startedAt: r.started_at as Date,
        counts,
      });
    else before.set(r.site_id as string, { id: r.run_id as string, counts });
  }

  const pairs = [...last].flatMap(([site, l]) => {
    const p = before.get(site);
    return p ? [{ site, latest: l.id, prev: p.id }] : [];
  });
  const newest = new Map<string, NewFinding>();
  if (pairs.length > 0) {
    const found = await tx`
      select distinct on (f.site_id) f.site_id, f.severity, f.title, f.evidence
      from unnest(${pairs.map((p) => p.latest)}::uuid[], ${pairs.map((p) => p.prev)}::uuid[]) as p(latest_id, prev_id)
      join public.findings f on f.run_id = p.latest_id
      where f.severity in ('high', 'medium')
        and not exists (select 1 from public.findings q where q.run_id = p.prev_id and q.fingerprint = f.fingerprint)
      order by f.site_id, (f.severity = 'high') desc, f.id`;
    for (const r of found)
      newest.set(r.site_id as string, {
        severity: r.severity as "high" | "medium",
        title: r.title as string,
        evidence: r.evidence as string,
      });
  }

  return sortSites(
    sites.map((s): SiteSummary => {
      const l = last.get(s.id);
      const p = before.get(s.id);
      return {
        ...s,
        lastRun: l ? { id: l.id, startedAt: l.startedAt } : null,
        counts: l?.counts ?? null,
        previous: p?.counts ?? null,
        trend: trendOf(l?.counts ?? null, p?.counts ?? null),
        newest: newest.get(s.id) ?? null,
      };
    }),
  );
}
