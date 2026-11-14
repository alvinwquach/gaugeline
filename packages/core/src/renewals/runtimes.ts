import list from "../data/vercel-node-runtimes.json";
import { daysUntil } from "./dates.js";

/** One Node.js major version Vercel has announced it will retire, from data/vercel-node-runtimes.json. */
export interface RuntimeRetirement {
  major: number;
  /** YYYY-MM-DD, UTC. */
  retires: string;
  /** The page that announces it. */
  source: string;
  /** False until someone has compared the date with its source. */
  verified: boolean;
}

export const NODE_RETIREMENTS: readonly RuntimeRetirement[] = Object.freeze(
  (list.retirements as RuntimeRetirement[]).map((r) => Object.freeze({ ...r })),
);

/** The day the list was written: the finding says so, so a stale list can be told from a current one. */
export const NODE_RETIREMENTS_WRITTEN: string = list.written;
export const NODE_RETIREMENTS_MAX_AGE_DAYS = 180;

/** The list is older than its allowed age at `now` (the data freshness test calls this). */
export function retirementsStale(now: Date, written: string = NODE_RETIREMENTS_WRITTEN): boolean {
  return -daysUntil(`${written}T00:00:00Z`, now) > NODE_RETIREMENTS_MAX_AGE_DAYS;
}

/** The major of a Vercel project's Node.js setting ("22.x", "20", "18.x"), or undefined. */
export function nodeMajor(version: string): number | undefined {
  const m = /^(\d{1,2})(?:\.[\dx]+)*$/i.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}

export interface RuntimeStatus extends RuntimeRetirement {
  /** Whole days until it retires; negative once it has. */
  days: number;
}

/** What the list says about a Node.js version: undefined when Vercel has announced nothing for it. */
export function runtimeStatus(version: string, now: Date): RuntimeStatus | undefined {
  const major = nodeMajor(version);
  const found = NODE_RETIREMENTS.find((r) => r.major === major);
  return found ? { ...found, days: daysUntil(`${found.retires}T00:00:00Z`, now) } : undefined;
}
