import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AgentDenyReason, agentTraceRecord, traceHash } from "@gaugeline/core";
import {
  TOOLS,
  assertLabelled,
  assertUntrustedSlots,
  describeTool,
  type ToolDef,
} from "./registry.js";
import { DEFAULT_CALL_MS, contextFor, createState, type ServerOptions } from "./state.js";
import { ToolError } from "./errors.js";
import { asToolError } from "./tools/shared.js";
import { MCP_AGENT_ID, TOOL_COST_MICROS, createServerPolicy, refusal } from "./policy.js";

export const SERVER_NAME = "gaugeline";
export const SERVER_VERSION = "0.1.0";

/**
 * An MCP server over the registry's tools. It holds no logic of its own: every tool calls the same core
 * functions as the CLI, and every request goes through the core fetcher.
 */
/** How long after a call's own time limit the caller is still waited for before it is answered regardless. */
const SLACK_MS = 2000;

export function createGaugelineServer(options: ServerOptions = {}): McpServer {
  assertLabelled(TOOLS);
  assertUntrustedSlots(TOOLS);
  const state = options.state ?? createState();
  const ctx = contextFor(options, state);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const limit = options.maxActiveCalls ?? 16;
  state.policy ??= createServerPolicy(options);
  const policy = state.policy;
  const clock = () => (options.now ? options.now().getTime() : Date.now());
  // The operator's own plan bases stay readable in an error; every other address is withheld.
  const keep = (options.planBases ?? []).flatMap((b) =>
    URL.canParse(b) ? [new URL(b).origin, new URL(b).host] : [],
  );
  for (const [name, def] of Object.entries(TOOLS) as [string, ToolDef][]) {
    if (def.enabled && !def.enabled(options)) continue;
    server.registerTool(
      name,
      {
        title: def.title,
        description: describeTool(def),
        inputSchema: def.inputSchema,
        annotations: {
          title: def.title,
          // True for every tool: none changes anything. `draft` returns text and applies nothing.
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: def.requests,
        },
        // Fixed text only: the kind, and the places in a result where text from the site sits.
        _meta: { "gaugeline/kind": def.kind, "gaugeline/untrustedSlots": def.untrustedSlots ?? [] },
      },
      async (args: unknown) => {
        const started = clock();
        const cost = options.toolCostMicros?.(name) ?? TOOL_COST_MICROS;
        // One trace line per call, written after the call is answered (AG-05). Failure-safe: nothing the
        // trace does can change or fail the call. Only hashes of the arguments and result are kept.
        const trace = (outcome: { reason?: AgentDenyReason; data?: unknown; error?: boolean }) => {
          const sink = options.trace;
          if (!sink) return;
          const ended = clock();
          setImmediate(() => {
            try {
              sink.write(
                agentTraceRecord({
                  at: new Date(started).toISOString(),
                  agentId: MCP_AGENT_ID,
                  tool: name,
                  inputSha256: traceHash(args),
                  outputSha256: "data" in outcome ? traceHash(outcome.data) : null,
                  latencyMs: Math.max(0, Math.floor(ended - started)),
                  tokens: 0,
                  costMicros: Number.isSafeInteger(cost) && cost >= 0 ? cost : 0,
                  decision: outcome.reason ? "denied" : "allowed",
                  reason: outcome.reason ?? null,
                  error: outcome.error === true,
                }),
              );
            } catch {
              // A trace that cannot be built or written is dropped; the call has been answered.
            }
          });
        };
        // The policy first: before the busy check, the tool body and any request. A deny says the reason only.
        const decision = policy.decide({
          agentId: MCP_AGENT_ID,
          tool: name,
          costMicros: cost,
        });
        if (!decision.allowed) {
          trace({ reason: decision.reason ?? "bad-input" });
          return {
            isError: true,
            content: [{ type: "text" as const, text: refusal(decision.reason ?? "bad-input") }],
          };
        }
        // Calls that make requests wait behind one shared in-flight limit; the waiting line is bounded, so
        // a flood is refused with a clear message instead of queueing memory and time without end.
        if (def.requests && state.active >= limit) {
          trace({ error: true });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `The server is busy: ${state.active} checks are already running or waiting. Try again shortly.`,
              },
            ],
          };
        }
        // The slot is held until the WORK settles, not until the caller is answered: a call that hit its
        // time limit is still running below for a moment, and it must still count against the cap.
        const work = (async () => def.run(args as never, ctx))();
        if (def.requests) {
          state.active++;
          const release = () => {
            state.active--;
          };
          work.then(release, release);
        }
        try {
          const data = await withDeadline(work, (options.maxCallMs ?? DEFAULT_CALL_MS) + SLACK_MS);
          trace({ data });
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const e = asToolError(err, keep);
          trace({ error: true });
          return { isError: true, content: [{ type: "text" as const, text: e.message }] };
        }
      },
    );
  }
  return server;
}

/**
 * Answers at the limit even if something below is stuck. The work itself is stopped by the hop-level
 * deadline; this only makes sure the caller is not left waiting, and that a late failure of the abandoned
 * work is swallowed here and never becomes an unhandled rejection.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolError("This check ran past its time limit and was stopped.")),
      ms,
    );
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
