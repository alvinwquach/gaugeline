/**
 * What happened last night: for each site, its last run set against the run before it, by fingerprint.
 * New means the fingerprint is in the last run and not in the run before; still open, in both; closed, in
 * the run before and not in the last. One query for every site, listing at most five of each kind (worst
 * first) and counting the rest, so a night with hundreds of findings stays one small page.
 */
import { siteSummaries, type SiteSummary } from "./dashboard.js";
import type { Tx } from "./db.js";
import type { SiteRow } from "./memberships.js";

export const LISTED = 5;

export interface Item {
  severity: "high" | "medium" | "low";
  title: string;
  evidence: string;
}

export interface Changes {
  opened: Item[];
  openedTotal: number;
  stillOpen: number;
  closed: Item[];
  closedTotal: number;
}

export interface NightSite extends SiteSummary {
  /** Null for a site with fewer than two runs: there is nothing to set the last run against. */
  changes: Changes | null;
}

export async function lastNight(tx: Tx, sites: SiteRow[]): Promise<NightSite[]> {
  const summaries = await siteSummaries(tx, sites);
  const ids = new Map<string, { latest: string; prev: string }>();
  const pairs = await tx`
    select r.site_id, r.id, r.rn from (
      select x.site_id, x.id, row_number() over (partition by x.site_id order by x.started_at desc, x.id desc) as rn
      from public.sites s
      cross join lateral (
        select id, site_id, started_at from public.runs where site_id = s.id order by started_at desc, id desc limit 2
      ) x
      where s.id = any(${summaries.map((s) => s.id)}::uuid[])
    ) r`;
  for (const r of pairs) {
    const e = ids.get(r.site_id as string) ?? { latest: "", prev: "" };
    if (Number(r.rn) === 1) e.latest = r.id as string;
    else e.prev = r.id as string;
    ids.set(r.site_id as string, e);
  }
  const both = [...ids].filter(([, e]) => e.latest && e.prev);
  const changes = new Map<string, Changes>(
    both.map(([site]) => [
      site,
      { opened: [], openedTotal: 0, stillOpen: 0, closed: [], closedTotal: 0 },
    ]),
  );
  if (both.length > 0) {
    const rows = await tx`
      with pairs as (
        select * from unnest(${both.map(([s]) => s)}::uuid[], ${both.map(([, e]) => e.latest)}::uuid[], ${both.map(([, e]) => e.prev)}::uuid[])
          as p(site_id, latest_id, prev_id)
      ),
      cls as (
        select distinct on (p.site_id, kind, f.fingerprint) p.site_id, kind, f.severity, f.title, f.evidence, f.fingerprint, f.id
        from pairs p
        join public.findings f on f.run_id in (p.latest_id, p.prev_id)
        cross join lateral (
          select case
            when f.run_id = p.latest_id and not exists (select 1 from public.findings q where q.run_id = p.prev_id and q.fingerprint = f.fingerprint) then 'new'
            when f.run_id = p.latest_id then 'still'
            when not exists (select 1 from public.findings q where q.run_id = p.latest_id and q.fingerprint = f.fingerprint) then 'closed'
          end as kind
        ) k
        where kind is not null
        order by p.site_id, kind, f.fingerprint, f.id
      ),
      ranked as (
        select cls.*,
          row_number() over (partition by site_id, kind order by (severity = 'high') desc, (severity = 'medium') desc, id) as rn,
          count(*) over (partition by site_id, kind) as total
        from cls
      )
      select site_id, kind, severity, title, evidence, rn, total from ranked
      where (kind <> 'still' and rn <= ${LISTED}) or (kind = 'still' and rn = 1)
      order by site_id, kind, rn`;
    for (const r of rows) {
      const c = changes.get(r.site_id as string)!;
      const item: Item = {
        severity: r.severity as Item["severity"],
        title: r.title as string,
        evidence: r.evidence as string,
      };
      const total = Number(r.total);
      if (r.kind === "new") {
        c.opened.push(item);
        c.openedTotal = total;
      } else if (r.kind === "closed") {
        c.closed.push(item);
        c.closedTotal = total;
      } else c.stillOpen = total;
    }
  }
  return summaries.map((s) => ({ ...s, changes: changes.get(s.id) ?? null }));
}

export type GroupKey = "new" | "closed" | "quiet" | "first" | "unchecked";

const GROUP_TITLES: Record<GroupKey, string> = {
  new: "New problems",
  closed: "Problems closed",
  quiet: "No change",
  first: "First check",
  unchecked: "Not checked yet",
};

function groupOf(s: NightSite): GroupKey {
  if (!s.counts) return "unchecked";
  if (!s.changes) return "first";
  if (s.changes.openedTotal > 0) return "new";
  if (s.changes.closedTotal > 0) return "closed";
  return "quiet";
}

/** Sites grouped by what happened, in the order a person reads them. Within a group the order is kept (worst first). */
export function groupNight(
  sites: NightSite[],
): { key: GroupKey; title: string; sites: NightSite[] }[] {
  const order: GroupKey[] = ["new", "closed", "quiet", "first", "unchecked"];
  return order
    .map((key) => ({
      key,
      title: GROUP_TITLES[key],
      sites: sites.filter((s) => groupOf(s) === key),
    }))
    .filter((g) => g.sites.length > 0);
}

export function nightSentence(sites: NightSite[]): string {
  const n = (k: GroupKey) => sites.filter((s) => groupOf(s) === k).length;
  const parts = [
    n("new") && `${n("new")} ${n("new") === 1 ? "has" : "have"} new problems`,
    n("closed") && `${n("closed")} had problems closed`,
    n("quiet") && `${n("quiet")} ${n("quiet") === 1 ? "is" : "are"} unchanged`,
    n("first") && `${n("first")} had a first check`,
    n("unchecked") &&
      `${n("unchecked")} ${n("unchecked") === 1 ? "has" : "have"} not been checked yet`,
  ].filter(Boolean);
  return `${sites.length} ${sites.length === 1 ? "site" : "sites"}. ${parts.join(", ")}.`;
}
