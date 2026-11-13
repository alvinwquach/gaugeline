/**
 * The agent registry (AG-02): the constants the database's own rules use, and the token an agent is given.
 * The SQL in db/migrations/0012_agent_registry.sql is the source of truth; a test keeps these equal to it.
 *
 * A token is `gla_<8 hex prefix>_<43 base64url characters>` (256 bits). The database mints it
 * (private.register_agent) and returns it once; the registry keeps its SHA-256 and the prefix that finds the
 * row in a list, never the token. Nobody signed in chooses a token, a hash or a prefix.
 */
import { createHash } from "node:crypto";
import { DRAFT_KINDS } from "../inbox/kinds.js";

/**
 * The closed list of scopes: one per draft kind, two read scopes for the pending-approvals tool (AG-08) and
 * two for the agents that read a local file (AG-15's `read:notes`, AG-17's `read:rules-file`). Nothing that
 * writes, publishes, sends or merges.
 */
export const AGENT_SCOPES = [
  ...DRAFT_KINDS.map((k) => `draft:${k}` as const),
  "read:runs",
  "read:pending",
  "read:notes",
  "read:rules-file",
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/**
 * Scopes the registry accepts that the policy's closed tool list (private.agent_authorize, 0013) does not hold
 * yet: a call with either is refused as `tool-not-allowed`, so registering an agent with one lets it do
 * nothing until a later, reviewed change adds the tool. A test keeps this list and the policy's equal.
 */
export const SCOPES_NOT_YET_IN_POLICY = ["read:notes", "read:rules-file"] as const;

export const AGENT_STATUSES = ["active", "disabled", "revoked"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** An agent that can still act and has not been used for this many days is in the shadow inventory. */
export const SHADOW_IDLE_DAYS = 30;

export const AGENT_TOKEN_PATTERN = /^gla_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

/** Hex SHA-256 of a token: the only form the registry stores. */
export const hashAgentToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");
