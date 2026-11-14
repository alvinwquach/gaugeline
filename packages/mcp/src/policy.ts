/**
 * The agent policy in front of every tool (AG-03, ADR-0014 "deny by default"). The server has one caller
 * identity (the operator who started it; over HTTP one token covers every caller), so the policy has one
 * agent: this server. Before a tool body runs, the core policy decides: the global kill switch
 * (GAUGELINE_AGENTS_OFF, read at every call), the tools the operator allowed (--allow-tool; every tool when
 * none is named, as before), a rate limit per minute and a daily cost ceiling. A denied call is a tool error
 * with the reason only; the deny is logged as one line with the tool and the reason, never the arguments.
 */
import { createAgentPolicy, type AgentDenyLog, type AgentPolicy } from "@gaugeline/core";
import { TOOLS } from "./registry.js";
import { DEFAULT_CALL_MS, type ServerOptions } from "./state.js";

/** The id this server's calls are decided under. */
export const MCP_AGENT_ID = "gaugeline-mcp";
/** Generous enough for an assistant working by hand; it stops a loop. */
export const DEFAULT_CALLS_PER_MINUTE = 120;
/** No tool calls a model or costs anything today: each declares 0, so this matters only when one does. */
export const DEFAULT_COST_CEILING_MICROS = 1_000_000;
/** What every tool call declares today (micro-units). */
export const TOOL_COST_MICROS = 0;

/** One stderr line: the tool (a registry name) and the reason, never the call's arguments. */
export const denyLine = (e: AgentDenyLog): string =>
  `gaugeline-mcp: denied tool=${e.tool ?? "-"} reason=${e.reason} at=${e.at}\n`;

export function createServerPolicy(options: ServerOptions): AgentPolicy {
  const tools = Object.keys(TOOLS);
  const now = options.now;
  return createAgentPolicy({
    tools,
    agents: new Map([
      [
        MCP_AGENT_ID,
        {
          status: "active",
          tools: options.allowedTools ?? tools,
          limits: {
            callsPerWindow: options.callsPerMinute ?? DEFAULT_CALLS_PER_MINUTE,
            windowMs: 60_000,
            costCeilingMicros: options.costCeilingMicros ?? DEFAULT_COST_CEILING_MICROS,
            timeoutMs: options.maxCallMs ?? DEFAULT_CALL_MS,
          },
        },
      ],
    ]),
    env: options.env ?? process.env,
    ...(now ? { now: () => now().getTime() } : {}),
    onDeny: options.onDeny ?? ((e) => process.stderr.write(denyLine(e))),
  });
}

/** The tool error a denied call gets: fixed words and a reason from the closed list. */
export const refusal = (reason: string): string =>
  `Refused by this server's agent policy: ${reason}.`;
