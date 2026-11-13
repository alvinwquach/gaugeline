/**
 * The triage agent's run (AG-12): plan the findings, then make ONE inbox draft per cause through the draft
 * path it is handed. The four rules every phase-4 agent follows are in this file:
 *
 *   DRAFT-ONLY   the tools are `draft:email` and the read `read:pending`; there is no write tool, and nothing
 *                here sends, publishes or edits. A draft waits in the inbox until a person approves it
 *                (ADR-0010). `read:pending` lists the drafts already waiting so a cause is not drafted twice.
 *   LIMITED      before every draft the agent's policy (AG-03) decides: allowlist, rate, cost, timeout, kill
 *                switches, deny by default. The first refusal, from the policy or from the database's own
 *                check of the same rules, stops the run: later causes are listed as not drafted.
 *   TRACED       every call, allowed or denied, makes one trace record (AG-05): ids, SHA-256 hashes of the
 *                redacted call and answer, whole numbers, a closed reason. Never a title or a draft's text.
 *   REGISTERED   TRIAGE_REGISTRATION is the entry an owner registers (docs/hosted/agent-triage.md).
 *
 * A read is a call like any other: the policy decides it first, it counts against the same rate limit and it
 * is traced. If the read cannot be trusted (refused, malformed, too long, down) the run makes NO drafts and
 * says why: a second draft for a cause that waits is the thing it is there to prevent.
 *
 * No model is called, so the declared cost of every call is 0 and the registered ceiling is 0: if a later
 * version adds a model it must declare its cost and the ceiling refuses it until a person raises it.
 * The clock, the policy, the draft path and the trace sink are all handed in; nothing reads the environment
 * or the real clock here.
 */
import {
  createAgentPolicy,
  isAgentDenyReason,
  type AgentDenyReason,
  type AgentLimits,
  type AgentPolicy,
} from "../../agent-policy.js";
import { agentTraceRecord, traceHash, type AgentTraceRecord } from "../../agent-trace.js";
import { triageEmail, type TriageEmail } from "./draft.js";
import {
  MAX_PENDING_PAGES,
  PENDING_PAGE_SIZE,
  TRIAGE_READ_TOOL,
  readPendingPage,
  type PendingProblem,
} from "./pending.js";
import { planTriage, type TriageFinding, type TriagePlan } from "./plan.js";

export const TRIAGE_AGENT_ID = "triage";
/** The agent's two tools: the hosted entry's own name for an email draft, and the pending-approvals read. */
export const TRIAGE_TOOLS = ["draft:email", TRIAGE_READ_TOOL] as const;
/** The most drafts one run makes (the registered rate limit); more causes are listed as not drafted. */
export const MAX_DRAFTS_PER_RUN = 20;

/** What an owner registers (hosted: `private.register_agent`, then the four limits), and what is enforced. */
export const TRIAGE_REGISTRATION = {
  name: "Triage agent",
  scopes: TRIAGE_TOOLS,
  limits: {
    // One draft per cause (20) and at most five pages of the pending read: the database counts both.
    callsPerWindow: MAX_DRAFTS_PER_RUN + MAX_PENDING_PAGES,
    windowMs: 60_000,
    // No model is called, so no cost is ever declared: a ceiling of 0 refuses one that is.
    costCeilingMicros: 0,
    timeoutMs: 10_000,
  } satisfies AgentLimits,
} as const;

export interface TriagePolicyOptions {
  /** The live environment, read at every call for the global kill switch. */
  env: Readonly<Record<string, string | undefined>>;
  now?: (() => number) | undefined;
  limits?: Partial<AgentLimits> | undefined;
  status?: "active" | "disabled" | "revoked" | undefined;
  onDeny?: Parameters<typeof createAgentPolicy>[0]["onDeny"];
}

/** The agent's policy, from its registration: one agent, one tool, the registered limits. */
export function createTriagePolicy(opts: TriagePolicyOptions): AgentPolicy {
  return createAgentPolicy({
    tools: TRIAGE_TOOLS,
    agents: new Map([
      [
        TRIAGE_AGENT_ID,
        {
          status: opts.status ?? "active",
          tools: TRIAGE_TOOLS,
          limits: { ...TRIAGE_REGISTRATION.limits, ...opts.limits },
        },
      ],
    ]),
    env: opts.env,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.onDeny ? { onDeny: opts.onDeny } : {}),
  });
}

export interface TriageDraftCall {
  siteId: string;
  kind: "email";
  payload: TriageEmail;
  findingIds: string[];
}
/** The draft path's answer: the same two shapes the hosted agent entry returns. */
export type TriageDraftResult =
  { inserted: true; draftId: string } | { inserted: false; reason: AgentDenyReason };

export interface TriageDeps {
  policy: AgentPolicy;
  /** The existing draft path (hosted: the agent's own entry). The only thing the agent writes through. */
  draft(call: TriageDraftCall): Promise<TriageDraftResult>;
  /** Milliseconds since the epoch. */
  now(): number;
  trace?: ((record: AgentTraceRecord) => void) | undefined;
  /**
   * The pending-approvals read (hosted: `triagePendingSource`), one page for one site. When it is given, the
   * run reads every page before it drafts and skips the causes whose draft already waits.
   */
  readPending?: ((call: TriagePendingCall) => Promise<TriagePendingResult>) | undefined;
  /** Cause keys the caller already knows have a draft waiting: not drafted again. */
  alreadyDrafted?: ReadonlySet<string> | undefined;
}

export interface TriagePendingCall {
  siteId: string;
  /** The `nextCursor` of the page before, or null for the first. */
  cursor: string | null;
  limit: number;
}
/** The read's answer: one page as the hosted API sends it (checked here), or the policy's refusal. */
export type TriagePendingResult =
  { read: true; page: unknown } | { read: false; reason: AgentDenyReason };

export interface TriagePendingReport {
  /** True when a read was made (false: no `readPending` was given, only `alreadyDrafted` counted). */
  read: boolean;
  pages: number;
  rows: number;
  /** Email rows of this site that were not one of this agent's subjects (an edit, another agent). */
  unmatched: number;
  /** Why the read could not be used, or null. With a problem the run drafts nothing. */
  problem: PendingProblem | null;
}

export interface TriageOutcome {
  plan: TriagePlan;
  created: { causeKey: string; draftId: string }[];
  /** Causes left alone because a draft is already waiting. */
  skipped: { causeKey: string; reason: "already waiting" }[];
  pending: TriagePendingReport;
  /** Causes with no draft because the run stopped or reached its cap. */
  notDrafted: string[];
  /** The refusal that stopped the run, or null. */
  stopped: AgentDenyReason | null;
}

const TIMEOUT = Symbol("timeout");

/**
 * Reads every page of the site's waiting drafts, each page one policy-checked, traced call of `read:pending`,
 * and returns the cause keys whose draft waits. Anything that makes the answer untrustworthy (a refusal, a
 * page that is not drafts, more pages than MAX_PENDING_PAGES, a read that fails or takes too long) sets
 * `out.pending.problem` and returns nothing: the caller then drafts nothing.
 */
async function readWaiting(
  siteId: string,
  readPending: NonNullable<TriageDeps["readPending"]>,
  deps: TriageDeps,
  out: TriageOutcome,
  record: (r: Parameters<typeof agentTraceRecord>[0]) => void,
): Promise<Set<string>> {
  const causes = new Set<string>();
  const fail = (problem: PendingProblem): Set<string> => {
    out.pending.problem = problem;
    return new Set();
  };
  let cursor: string | null = null;
  for (;;) {
    if (out.pending.pages >= MAX_PENDING_PAGES) return fail("oversized");
    const call: TriagePendingCall = { siteId, cursor, limit: PENDING_PAGE_SIZE };
    const startedAt = deps.now();
    const base = {
      at: new Date(startedAt).toISOString(),
      agentId: TRIAGE_AGENT_ID,
      tool: TRIAGE_READ_TOOL,
      inputSha256: traceHash(call),
      tokens: 0,
      costMicros: 0,
    };
    const decision = deps.policy.decide({
      agentId: TRIAGE_AGENT_ID,
      tool: TRIAGE_READ_TOOL,
      costMicros: 0,
    });
    if (!decision.allowed) {
      const reason = decision.reason ?? "bad-input";
      record({ ...base, outputSha256: null, latencyMs: 0, decision: "denied", reason });
      out.stopped = reason;
      return fail("unavailable");
    }
    const latency = (): number => Math.max(0, Math.floor(deps.now() - startedAt));
    out.pending.pages++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: TriagePendingResult | typeof TIMEOUT;
    try {
      const wait = Math.max(0, (decision.deadlineMs ?? startedAt) - startedAt);
      result = await Promise.race([
        readPending(call),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), wait);
        }),
      ]);
    } catch {
      // The read's own error may carry an address or a message: only the fact is kept.
      record({
        ...base,
        outputSha256: null,
        latencyMs: latency(),
        decision: "allowed",
        error: true,
      });
      return fail("unavailable");
    } finally {
      clearTimeout(timer);
    }
    if (result === TIMEOUT) {
      record({
        ...base,
        outputSha256: null,
        latencyMs: latency(),
        decision: "allowed",
        error: true,
      });
      return fail("unavailable");
    }
    if (!result.read) {
      const reason = isAgentDenyReason(result.reason) ? result.reason : "bad-input";
      record({ ...base, outputSha256: null, latencyMs: latency(), decision: "denied", reason });
      out.stopped = reason;
      return fail("unavailable");
    }
    const page = readPendingPage(siteId, result.page);
    record({
      ...base,
      outputSha256: traceHash(result.page),
      latencyMs: latency(),
      decision: "allowed",
      ...(page.ok ? {} : { error: true }),
    });
    if (!page.ok) return fail(page.problem);
    out.pending.rows += page.rows;
    out.pending.unmatched += page.unmatched;
    for (const key of page.causes) causes.add(key);
    if (page.nextCursor === null) return causes;
    cursor = page.nextCursor;
  }
}

export async function runTriage(
  input: { siteId: string; findings: readonly TriageFinding[] },
  deps: TriageDeps,
): Promise<TriageOutcome> {
  const plan = planTriage(input.findings);
  const out: TriageOutcome = {
    plan,
    created: [],
    skipped: [],
    pending: { read: false, pages: 0, rows: 0, unmatched: 0, problem: null },
    notDrafted: [],
    stopped: null,
  };
  const record = (r: Parameters<typeof agentTraceRecord>[0]): void => {
    try {
      deps.trace?.(agentTraceRecord(r));
    } catch {
      // A trace that cannot be written must not change what the agent did or did not do.
    }
  };

  // The causes whose draft already waits: what the caller knows, then what the pending read says.
  const waiting = new Set(deps.alreadyDrafted);
  if (deps.readPending && plan.groups.length > 0) {
    out.pending.read = true;
    const read = await readWaiting(input.siteId, deps.readPending, deps, out, record);
    for (const key of read) waiting.add(key);
  }

  for (const g of plan.groups) {
    // A read that could not be trusted: nothing is drafted this run, and the causes are listed.
    if (out.pending.problem !== null) {
      out.notDrafted.push(g.causeKey);
      continue;
    }
    if (waiting.has(g.causeKey)) {
      out.skipped.push({ causeKey: g.causeKey, reason: "already waiting" });
      continue;
    }
    if (out.stopped !== null || out.created.length >= MAX_DRAFTS_PER_RUN) {
      out.notDrafted.push(g.causeKey);
      continue;
    }
    const { payload, findingIds } = triageEmail(g);
    const call: TriageDraftCall = { siteId: input.siteId, kind: "email", payload, findingIds };
    const startedAt = deps.now();
    const base = {
      at: new Date(startedAt).toISOString(),
      agentId: TRIAGE_AGENT_ID,
      tool: TRIAGE_TOOLS[0],
      inputSha256: traceHash(call),
      tokens: 0,
      costMicros: 0,
    };

    const decision = deps.policy.decide({
      agentId: TRIAGE_AGENT_ID,
      tool: TRIAGE_TOOLS[0],
      costMicros: 0,
    });
    if (!decision.allowed) {
      const reason = decision.reason ?? "bad-input";
      record({ ...base, outputSha256: null, latencyMs: 0, decision: "denied", reason });
      out.stopped = reason;
      out.notDrafted.push(g.causeKey);
      continue;
    }

    const latency = (): number => Math.max(0, Math.floor(deps.now() - startedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: TriageDraftResult | typeof TIMEOUT;
    try {
      // The policy's deadline is enforced here: a draft call that outlasts it is abandoned and traced.
      const wait = Math.max(0, (decision.deadlineMs ?? startedAt) - startedAt);
      result = await Promise.race([
        deps.draft(call),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), wait);
        }),
      ]);
    } catch (err) {
      record({
        ...base,
        outputSha256: null,
        latencyMs: latency(),
        decision: "allowed",
        error: true,
      });
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (result === TIMEOUT) {
      record({
        ...base,
        outputSha256: null,
        latencyMs: latency(),
        decision: "allowed",
        error: true,
      });
      throw new Error("The draft call took longer than the agent's timeout.");
    }
    if (!result.inserted) {
      const reason = isAgentDenyReason(result.reason) ? result.reason : "bad-input";
      record({ ...base, outputSha256: null, latencyMs: latency(), decision: "denied", reason });
      out.stopped = reason;
      out.notDrafted.push(g.causeKey);
      continue;
    }
    record({
      ...base,
      outputSha256: traceHash({ draftId: result.draftId }),
      latencyMs: latency(),
      decision: "allowed",
    });
    out.created.push({ causeKey: g.causeKey, draftId: result.draftId });
  }
  return out;
}
