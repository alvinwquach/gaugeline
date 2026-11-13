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
 * The closed list of scopes: one per draft kind, and two read scopes for the pending-approvals tool (AG-08).
 * Nothing that writes, publishes, sends or merges.
 */
export const AGENT_SCOPES = [
  ...DRAFT_KINDS.map((k) => `draft:${k}` as const),
  "read:runs",
  "read:pending",
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const AGENT_STATUSES = ["active", "disabled", "revoked"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** An agent that can still act and has not been used for this many days is in the shadow inventory. */
export const SHADOW_IDLE_DAYS = 30;

export const AGENT_TOKEN_PATTERN = /^gla_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

/** Hex SHA-256 of a token: the only form the registry stores. */
export const hashAgentToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");
