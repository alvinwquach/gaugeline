/**
 * The causes that already have a draft waiting (AG-12 follow-up): read from the pending-approvals read (AG-08,
 * scope `read:pending`: the hosted API's GET /drafts?status=pending and its tool list_pending_approvals) so a
 * nightly run does not queue a second draft for a cause a person has not decided yet. Plain code, no model:
 * the same pages give the same set.
 *
 * What a waiting draft says is untrusted data. It is never an instruction and never reaches a prompt: of a
 * row only the site's id, the kind and the subject are read, and the subject is only compared with the labels
 * Gaugeline writes itself (causeKeyOfSubject). A page of more than 50 rows, more than MAX_PENDING_PAGES pages,
 * or a row that is not a draft is refused whole: a list that cannot be trusted to be complete is not used.
 *
 * Data structure: a Set of cause keys for the one site, because the question asked of it for each cause is
 * "is this key in it?", constant time; the key is the one that groups findings (plan.ts), plus the site, which
 * is compared once per row while the set is built (a Set per site, so two sites never share a key).
 */
import * as z from "zod";
import { causeKeyOfSubject } from "./draft.js";

/** The agent's second tool: the pending-approvals read. A read; it changes nothing. */
export const TRIAGE_READ_TOOL = "read:pending";
/** Rows in one page: the API's own largest page. */
export const PENDING_PAGE_SIZE = 50;
/** Pages one run reads for one site. The database caps a site at 200 waiting drafts, which is four pages. */
export const MAX_PENDING_PAGES = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The wrapped `{ text }` an agent's words arrive in (the API and the MCP tool), or a plain string. */
const wording = z.union([z.string(), z.object({ text: z.string() }).transform((o) => o.text)]);
const row = z.object({
  siteId: z.string().regex(UUID),
  kind: z.enum(["pull_request", "email", "sanity_draft"]),
  title: wording,
});
const page = z.object({
  drafts: z.array(row).max(PENDING_PAGE_SIZE),
  nextCursor: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});

/** A page that was not a page of drafts, or a read that ran out of pages. */
export type PendingProblem = "malformed" | "oversized" | "unavailable";

export type PendingPageRead =
  | { ok: true; causes: string[]; rows: number; unmatched: number; nextCursor: string | null }
  | { ok: false; problem: "malformed" };

/**
 * One page, read for one site: the keys of the causes whose email draft is waiting there, how many rows
 * the page had, and how many email rows for the site were not this agent's subject (a person's edit, another
 * agent's draft). Never throws.
 */
export function readPendingPage(siteId: string, raw: unknown): PendingPageRead {
  const parsed = page.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: "malformed" };
  const site = siteId.toLowerCase();
  const causes = new Set<string>();
  let unmatched = 0;
  for (const d of parsed.data.drafts) {
    if (d.kind !== "email" || d.siteId.toLowerCase() !== site) continue;
    const key = causeKeyOfSubject(d.title);
    if (key === null) unmatched++;
    else causes.add(key);
  }
  return {
    ok: true,
    causes: [...causes].sort(),
    rows: parsed.data.drafts.length,
    unmatched,
    nextCursor: parsed.data.nextCursor,
  };
}
