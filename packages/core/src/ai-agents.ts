import list from "./data/ai-agents.json";

/** What an AI crawler fetches pages for. */
export type AiPurpose = "training" | "search" | "user";

export interface AiAgent {
  /** The robots.txt user-agent token, as the owner documents it. */
  token: string;
  /** Plain-English name for the report. */
  name: string;
  owner: string;
  purpose: AiPurpose;
  /** The owner's page that documents the token. */
  docs: string;
  /** YYYY-MM-DD: when this entry was last checked against `docs`. */
  lastVerified: string;
}

/** Known AI crawlers, from packages/core/src/data/ai-agents.json. Data, versioned, dated. */
export const AI_AGENTS: readonly AiAgent[] = Object.freeze(
  (list.agents as AiAgent[]).map((a) => Object.freeze({ ...a })),
);

/** How old an entry may get before the data freshness test fails. */
export const AI_AGENTS_MAX_AGE_DAYS = 180;

/** Entries last verified more than `maxDays` before `now`, oldest first. */
export function staleAgents(
  agents: readonly AiAgent[],
  now: Date,
  maxDays = AI_AGENTS_MAX_AGE_DAYS,
): AiAgent[] {
  // Whole days: an entry verified exactly maxDays ago (by UTC date) is still fresh.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const limit = today - maxDays * 24 * 60 * 60 * 1000;
  return agents
    .filter((a) => {
      const t = Date.parse(`${a.lastVerified}T00:00:00Z`);
      // A date that does not parse counts as stale: it cannot show the entry was checked.
      return Number.isNaN(t) || t < limit;
    })
    .sort((a, b) => a.lastVerified.localeCompare(b.lastVerified));
}
