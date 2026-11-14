/**
 * Agent policy (AG-03, ADR-0014 "deny by default"): whether one agent call may run, decided BEFORE it runs.
 * The hosted database decides its own agents' calls in SQL (private.agent_authorize, migration 0013); this is
 * the same rule, with the same closed reasons in the same order, for callers that are not the database: the
 * MCP server's tool dispatch, and the hosted code's environment kill switch.
 *
 * Pure and deterministic: no I/O, no model call, no timer. The clock and the environment are handed in, and
 * the environment is read at every call (not once at start), so a kill switch takes effect on the next call.
 * Integers only: cost in micro-units (10^6 to the unit), time in milliseconds. Every deny is handed to the
 * sink with the time, the agent id, the tool (only a name on the closed list) and the reason, nothing else.
 */

/** The closed list of reasons, the SQL's words (`agent_denies_reason_known` in 0013_agent_policy.sql). */
export const AGENT_DENY_REASONS = [
  "unknown-agent",
  "revoked",
  "disabled",
  "scope",
  "tool-not-allowed",
  "rate-limit",
  "cost-ceiling",
  "timeout",
  "kill-switch-agent",
  "kill-switch-global",
  "bad-input",
] as const;
export type AgentDenyReason = (typeof AGENT_DENY_REASONS)[number];

const REASONS: ReadonlySet<string> = new Set(AGENT_DENY_REASONS);
export const isAgentDenyReason = (v: unknown): v is AgentDenyReason =>
  typeof v === "string" && REASONS.has(v);

/** The global kill switch: set on the process that runs agents, it stops every agent at its next call. */
export const AGENTS_OFF_ENV = "GAUGELINE_AGENTS_OFF";

/**
 * True when every agent must stop. Fails closed: only an unset variable or the exact string "0" leaves agents
 * running. Anything else, an empty or garbled value included, stops them, and so does an environment that
 * cannot be read.
 */
export function agentsOff(env: Readonly<Record<string, string | undefined>>): boolean {
  try {
    const v = env[AGENTS_OFF_ENV];
    return !(v === undefined || v === "0");
  } catch {
    return true;
  }
}

/** The largest cost one call may declare, and the largest ceiling (10^12 micro-units), as in the SQL. */
export const MAX_COST_MICROS = 1_000_000_000_000;
const MAX_TOOL_LENGTH = 64;
const DAY_MS = 86_400_000;

export interface AgentLimits {
  /** Calls allowed in one fixed window, 0 to 10000 (0 stops the agent). */
  callsPerWindow: number;
  /** The window, 1000 ms to one day. */
  windowMs: number;
  /** Cost allowed per UTC day, in micro-units, 0 to 10^12. */
  costCeilingMicros: number;
  /** The longest a call may take, from when it was received, 100 ms to one hour. */
  timeoutMs: number;
}

const RANGES: Record<keyof AgentLimits, readonly [number, number]> = {
  callsPerWindow: [0, 10_000],
  windowMs: [1_000, DAY_MS],
  costCeilingMicros: [0, MAX_COST_MICROS],
  timeoutMs: [100, 3_600_000],
};

export interface AgentRule {
  status: "active" | "disabled" | "revoked";
  /** The tools this agent may call. A name not on the policy's closed list is never callable. */
  tools: readonly string[];
  limits: AgentLimits;
  /** The operator's stop for this one agent (reason `kill-switch-agent`). */
  stopped?: boolean;
}

export interface AgentPolicyConfig {
  /** The closed list of tools. Anything else is `tool-not-allowed`. */
  tools: readonly string[];
  /** Every agent there is. Any other id is `unknown-agent`. */
  agents: ReadonlyMap<string, AgentRule>;
  /** Read at every call for the global kill switch (pass the live process.env). */
  env: Readonly<Record<string, string | undefined>>;
  /** Milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /** Called once for every deny, before decide returns. A sink that throws does not change the decision. */
  onDeny?: (entry: AgentDenyLog) => void;
  /** The most agents the policy keeps counters for (default 1024); a larger configuration is refused. */
  maxTracked?: number;
}

/** One call, as the caller received it. Every field is checked: nothing here is trusted. */
export interface AgentCall {
  agentId: unknown;
  tool: unknown;
  /** The cost the call declares, whole micro-units. Required: a call that names none is `bad-input`. */
  costMicros: unknown;
  /** When the call was received, if it waited before being decided. */
  receivedAtMs?: unknown;
}

export interface AgentDecision {
  allowed: boolean;
  reason: AgentDenyReason | null;
  /** The agent's id when it is a registered agent; null otherwise (an unknown id is the caller's text). */
  agentId: string | null;
  /** The tool when it is on the closed list; null otherwise. */
  tool: string | null;
  /** When it was decided (ms). */
  at: number;
  /** When an allowed call must have finished (ms); null when denied. */
  deadlineMs: number | null;
}

/** What a deny log line holds: nothing but these four. */
export interface AgentDenyLog {
  at: string;
  agentId: string | null;
  tool: string | null;
  reason: AgentDenyReason;
}

export interface AgentPolicy {
  decide(call: AgentCall): AgentDecision;
  /** How many agents have counters (at most one entry per registered agent). */
  tracked(): number;
}

interface Counters {
  windowStart: number;
  calls: number;
  day: number;
  spent: number;
}

const whole = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

function checkRule(id: string, rule: AgentRule): void {
  if (!["active", "disabled", "revoked"].includes(rule.status))
    throw new Error(`Agent ${id}: unknown status.`);
  for (const [k, [min, max]] of Object.entries(RANGES) as [keyof AgentLimits, [number, number]][])
    if (!whole(rule.limits[k], min, max))
      throw new Error(`Agent ${id}: limit ${k} must be a whole number from ${min} to ${max}.`);
}

export function createAgentPolicy(config: AgentPolicyConfig): AgentPolicy {
  const maxTracked = config.maxTracked ?? 1024;
  if (config.agents.size > maxTracked)
    throw new Error(`The policy tracks at most ${maxTracked} agent(s).`);
  for (const [id, rule] of config.agents) checkRule(id, rule);
  const closed: ReadonlySet<string> = new Set(config.tools);
  const allowed = new Map(
    [...config.agents].map(([id, r]) => [id, new Set(r.tools.filter((t) => closed.has(t)))]),
  );
  const now = config.now ?? Date.now;
  // One entry per registered agent, created at its first allowed or counted call. Unknown ids never get one.
  const counters = new Map<string, Counters>();

  function decide(call: AgentCall): AgentDecision {
    const raw = now();
    const at = Number.isFinite(raw) ? Math.floor(raw) : Number.NaN;
    const id = typeof call.agentId === "string" ? call.agentId : undefined;
    const rule = id !== undefined ? config.agents.get(id) : undefined;
    const agentId = rule ? (id as string) : null;
    const tool = typeof call.tool === "string" && closed.has(call.tool) ? call.tool : null;
    const deny = (reason: AgentDenyReason): AgentDecision => {
      try {
        config.onDeny?.({
          at: Number.isNaN(at) ? "invalid" : new Date(at).toISOString(),
          agentId,
          tool,
          reason,
        });
      } catch {
        // The decision stands; a sink that fails must not turn a deny into an allow.
      }
      return { allowed: false, reason, agentId, tool, at, deadlineMs: null };
    };

    if (!rule) return deny("unknown-agent");
    if (rule.status === "revoked") return deny("revoked");
    if (agentsOff(config.env)) return deny("kill-switch-global");
    if (rule.status !== "active") return deny("disabled");
    if (rule.stopped === true) return deny("kill-switch-agent");
    const cost = call.costMicros;
    if (
      typeof call.tool !== "string" ||
      call.tool.length > MAX_TOOL_LENGTH ||
      !whole(cost, 0, MAX_COST_MICROS) ||
      (call.receivedAtMs !== undefined && !whole(call.receivedAtMs, 0, Number.MAX_SAFE_INTEGER))
    )
      return deny("bad-input");
    if (tool === null) return deny("tool-not-allowed");
    if (!allowed.get(agentId as string)?.has(tool)) return deny("scope");
    const { limits } = rule;
    if (Number.isNaN(at)) return deny("timeout");
    if (typeof call.receivedAtMs === "number" && at - call.receivedAtMs > limits.timeoutMs)
      return deny("timeout");

    const c = counters.get(agentId as string);
    const day = Math.floor(at / DAY_MS);
    // A clock that goes back keeps the current window and the day's cost: it never opens a fresh one.
    const fresh = !c || at >= c.windowStart + limits.windowMs;
    const calls = fresh || !c ? 0 : c.calls;
    const spent = c && day <= c.day ? c.spent : 0;
    if (calls >= limits.callsPerWindow) return deny("rate-limit");
    if (spent + cost > limits.costCeilingMicros) return deny("cost-ceiling");
    counters.set(agentId as string, {
      windowStart: fresh || !c ? at : c.windowStart,
      calls: calls + 1,
      day: c ? Math.max(day, c.day) : day,
      spent: spent + cost,
    });
    return {
      allowed: true,
      reason: null,
      agentId,
      tool,
      at,
      deadlineMs: at + limits.timeoutMs,
    };
  }

  return { decide, tracked: () => counters.size };
}
