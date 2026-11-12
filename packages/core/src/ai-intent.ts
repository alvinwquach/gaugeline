import * as z from "zod";
import { AI_AGENTS, type AiAgent, type AiPurpose } from "./ai-agents.js";
import { isAllowed, type RobotsFile } from "./robots.js";

/**
 * gaugeline.ai.json, read from the working folder like the other settings files. It says what the
 * owner wants AI crawlers to be able to do; the file is optional, and with none Gaugeline only
 * reports what robots.txt says. Nothing in it is a key.
 *
 * - allow: every known AI crawler may read the site
 * - block: none may
 * - training-block: crawlers that collect training data are blocked; search and user-triggered ones are allowed
 * - search-only: only crawlers that build a search index are allowed; training and user-triggered ones are blocked
 */
export const AI_INTENTS = ["allow", "block", "training-block", "search-only"] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

export const aiConfigSchema = z.strictObject({
  aiCrawlers: z.enum(AI_INTENTS).optional(),
});
export type AiConfig = z.infer<typeof aiConfigSchema>;

/** The file's name, for the words a finding uses. */
export const AI_CONFIG_FILE = "gaugeline.ai.json";

/** What the stated intent wants for a crawler with this purpose: true when it may read the site. */
export function wantsAllowed(intent: AiIntent, purpose: AiPurpose): boolean {
  switch (intent) {
    case "allow":
      return true;
    case "block":
      return false;
    case "training-block":
      return purpose !== "training";
    case "search-only":
      return purpose === "search";
  }
}

export interface IntentMismatch {
  agent: AiAgent;
  /** What robots.txt does for it: true when it may read the path. */
  allowed: boolean;
}

/**
 * Known AI crawlers whose access to `path` is the opposite of the stated intent, in list order. A
 * missing robots.txt (`robots` null) has no rules, so every crawler is allowed.
 */
export function intentMismatches(
  robots: RobotsFile | null,
  intent: AiIntent,
  path: string,
  agents: readonly AiAgent[] = AI_AGENTS,
): IntentMismatch[] {
  const out: IntentMismatch[] = [];
  for (const agent of agents) {
    const allowed = robots ? isAllowed(robots, agent.token, path) : true;
    if (allowed !== wantsAllowed(intent, agent.purpose)) out.push({ agent, allowed });
  }
  return out;
}
