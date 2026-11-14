/**
 * The agent scorecard (AG-07): per registered agent of the organisation, what its trace (AG-05, migration
 * 0015) and the decisions log say. Read as the signed-in person, so row-level security decides: owners and
 * admins see their organisation's agents and traces; anyone else sees none.
 *
 * Real numbers only: every figure is a count from those tables or a ratio of two counts, in integers. A
 * figure with nothing to measure (a rate before the first decision, a cost before the first approval) is
 * null and the page shows it blank, never 0. Errors are always null: a hosted agent call that raises is
 * undone whole and leaves no trace row, so the database cannot count them.
 */
import type { Tx } from "./db.js";

export interface DeclineReason {
  reason: string;
  count: number;
}

/** What the database counts for one agent, since its trace began. */
export interface AgentCounts {
  id: string;
  name: string;
  /** `expired`: still `active` in the registry, but its token's expiry has passed (AG-02b), so it is refused. */
  status: "active" | "disabled" | "revoked" | "expired";
  prefix: string | null;
  /** Allowed calls (drafts and reads). */
  calls: number;
  /** Refused calls: trace rows plus the per-minute overflow counters. */
  denies: number;
  /** Approved drafts, an approval of an edited draft included. */
  approved: number;
  /** Of those, approved after a person edited the draft. */
  edited: number;
  declined: number;
  /** Total declared cost of the agent's calls, micro-units. */
  costMicros: number;
  /** The most common reasons people gave for declining, at most three. */
  declineReasons: DeclineReason[];
}

export interface Score {
  runs: number;
  /** Percent of decided drafts approved; null before the first decision. */
  approvalRate: number | null;
  /** Percent of approvals that came after an edit; null before the first approval. */
  editRate: number | null;
  /** Whole micro-units per approved draft; null before the first approval. */
  costPerApproved: number | null;
  denies: number;
  /** Never measured in the hosted database (see the module comment). */
  errors: null;
  declineReasons: DeclineReason[];
}

const whole = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(`Agent scorecard: ${what} must be a whole number.`);
  return n;
};

/** part / total as a whole percent, rounded half up, in integers; null when total is 0. */
export function percent(part: number, total: number): number | null {
  if (total === 0) return null;
  return Math.floor((200 * part + total) / (2 * total));
}

/**
 * Whole micro-units per approved draft, rounded half up, in BigInt so a large total cannot lose precision;
 * null with no approval.
 */
export function perApproved(costMicros: number, approved: number): number | null {
  if (approved === 0) return null;
  const c = BigInt(costMicros);
  const n = BigInt(approved);
  return Number((2n * c + n) / (2n * n));
}

export function scoreOf(c: AgentCounts): Score {
  for (const k of ["calls", "denies", "approved", "edited", "declined", "costMicros"] as const)
    whole(c[k], k);
  return {
    runs: c.calls,
    approvalRate: percent(c.approved, c.approved + c.declined),
    editRate: percent(c.edited, c.approved),
    costPerApproved: perApproved(c.costMicros, c.approved),
    denies: c.denies,
    errors: null,
    declineReasons: c.declineReasons,
  };
}

/** Every agent of `orgId` the signed-in person may see, with its counts. Four queries, none per agent. */
export async function agentScorecard(tx: Tx, orgId: string): Promise<AgentCounts[]> {
  const agents = await tx`select a.id, a.name, a.token_prefix,
      case when a.status = 'active' and a.expires_at is not null and a.expires_at <= pg_catalog.clock_timestamp()
        then 'expired' else a.status end as status
    from public.agents a
    where a.org_id = ${orgId} order by a.name, a.id`;
  if (agents.length === 0) return [];
  const trace = await tx`select t.agent_id,
      count(*) filter (where t.decision = 'allowed')::int as calls,
      count(*) filter (where t.decision = 'denied')::int as denied,
      count(*) filter (where t.decision = 'approved')::int as approved,
      count(*) filter (where t.decision = 'declined')::int as declined,
      count(*) filter (where t.decision = 'approved' and exists (select 1 from public.decisions d
        where d.draft_id = t.draft_id and d.decision = 'edited'))::int as edited,
      coalesce(sum(t.cost_micros), 0)::bigint as cost
    from public.agent_trace t where t.org_id = ${orgId} group by t.agent_id`;
  const overflow = await tx`select o.agent_id, coalesce(sum(o.calls), 0)::bigint as calls
    from public.agent_trace_overflow o where o.org_id = ${orgId} group by o.agent_id`;
  const reasons = await tx`select x.agent_id, x.reason, x.n from (
      select t.agent_id, coalesce(nullif(pg_catalog.btrim(d.reason), ''), '(no reason given)') as reason,
        count(*)::int as n,
        row_number() over (partition by t.agent_id order by count(*) desc,
          coalesce(nullif(pg_catalog.btrim(d.reason), ''), '(no reason given)')) as rn
      from public.agent_trace t
      join public.decisions d on d.draft_id = t.draft_id and d.decision = 'declined'
      where t.org_id = ${orgId} and t.decision = 'declined'
      group by t.agent_id, 2) x
    where x.rn <= 3 order by x.agent_id, x.rn`;
  const byAgent = new Map(trace.map((r) => [r.agent_id as string, r]));
  const over = new Map(overflow.map((r) => [r.agent_id as string, Number(r.calls)]));
  const why = new Map<string, DeclineReason[]>();
  for (const r of reasons) {
    const list = why.get(r.agent_id as string) ?? [];
    list.push({ reason: String(r.reason).slice(0, 120), count: Number(r.n) });
    why.set(r.agent_id as string, list);
  }
  return agents.map((a) => {
    const t = byAgent.get(a.id as string);
    return {
      id: a.id as string,
      name: a.name as string,
      status: a.status as AgentCounts["status"],
      prefix: (a.token_prefix as string | null) ?? null,
      calls: Number(t?.calls ?? 0),
      denies: Number(t?.denied ?? 0) + (over.get(a.id as string) ?? 0),
      approved: Number(t?.approved ?? 0),
      edited: Number(t?.edited ?? 0),
      declined: Number(t?.declined ?? 0),
      costMicros: Number(t?.cost ?? 0),
      declineReasons: why.get(a.id as string) ?? [],
    };
  });
}
