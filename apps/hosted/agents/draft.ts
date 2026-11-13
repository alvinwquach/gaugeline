/**
 * The hosted agent's way to propose a draft, in TypeScript (AG-03 part 2c). Two checks, in this order, before
 * anything is inserted:
 *
 *   1. the global kill switch GAUGELINE_AGENTS_OFF in this process's environment, read at every call: when it
 *      is set to anything but "0", the call is refused here and the database is not called at all;
 *   2. private.agent_insert_draft, through the agent's own login, which runs private.agent_authorize first
 *      (migration 0013: the token, the registry status, the operator's switches, the scope, the timeout, the
 *      rate limit and the cost ceiling), counts the call or writes the deny row, and only then looks at the
 *      site, the findings and the payload.
 *
 * The SQL refuses with null and one WARNING, `agent call denied: <reason>`; this maps that warning to the
 * same closed reason (packages/core AGENT_DENY_REASONS) and logs it through the sink. Every deny, from either
 * check, is logged with the time, the tool (only `draft:<kind>` for a real kind) and the reason: never the
 * token, payload, site or any text. The agent id is null here; the database's deny row holds it.
 *
 * Calls run one at a time on one connection, so each warning belongs to the call that is running.
 */
import {
  agentsOff,
  isAgentDenyReason,
  type AgentDenyLog,
  type AgentDenyReason,
} from "@gaugeline/core";
import type postgres from "postgres";
import { DRAFT_KINDS } from "../inbox/kinds.js";

export interface AgentDraftCall {
  token: string;
  siteId: string;
  kind: string;
  payload: unknown;
  findingIds?: string[];
}

export type AgentDraftResult =
  { inserted: true; draftId: string } | { inserted: false; reason: AgentDenyReason };

export interface AgentDraftDeps {
  /** Opens the agent's own login (a member of gaugeline_agent only), routing its notices to `onnotice`. */
  connect(onnotice: (n: postgres.Notice) => void): postgres.Sql;
  /** Read at every call for GAUGELINE_AGENTS_OFF (the worker's live process.env). */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  /** Called once for every deny. */
  onDeny(entry: AgentDenyLog): void;
}

const DENIED = /^agent call denied: ([a-z-]+)$/;

/** The reason in the policy's own warning, or null when there is none (or it is not on the closed list). */
export function denyReasonOf(
  notices: readonly { severity?: string; message?: string }[],
): AgentDenyReason | null {
  for (const n of notices) {
    const m = n.severity === "WARNING" ? DENIED.exec(n.message ?? "") : null;
    if (m && isAgentDenyReason(m[1])) return m[1];
  }
  return null;
}

const KINDS: ReadonlySet<string> = new Set(DRAFT_KINDS);

export function createAgentDrafts(deps: AgentDraftDeps) {
  let sql: postgres.Sql | undefined;
  let notices: postgres.Notice[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const now = deps.now ?? (() => new Date());

  const deny = (kind: string, reason: AgentDenyReason): AgentDraftResult => {
    try {
      deps.onDeny({
        at: now().toISOString(),
        agentId: null,
        tool: KINDS.has(kind) ? `draft:${kind}` : null,
        reason,
      });
    } catch {
      // The refusal stands even if the log cannot be written.
    }
    return { inserted: false, reason };
  };

  async function run(call: AgentDraftCall): Promise<AgentDraftResult> {
    if (agentsOff(deps.env)) return deny(call.kind, "kill-switch-global");
    sql ??= deps.connect((n) => notices.push(n));
    notices = [];
    const db = sql;
    const id = await db.begin(async (tx) => {
      await tx.unsafe("set local role gaugeline_agent");
      // The refusal arrives as a WARNING: make sure the session does not hide it.
      await tx.unsafe("set local client_min_messages = warning");
      const [row] = await tx`select private.agent_insert_draft(${call.token}, ${call.siteId},
        ${call.kind}, ${tx.json(call.payload as never)}, ${call.findingIds ?? []}::uuid[]) as id`;
      return (row?.id as string | null | undefined) ?? null;
    });
    if (id !== null) return { inserted: true, draftId: id };
    const reason = denyReasonOf(notices);
    // Null with no reason cannot come from the policy: refuse to guess, and insert nothing (none was).
    if (reason === null) throw new Error("The agent's draft was refused without a policy reason.");
    return deny(call.kind, reason);
  }

  return {
    /** One call at a time: each waits for the one before it. */
    draft(call: AgentDraftCall): Promise<AgentDraftResult> {
      const next = queue.then(() => run(call));
      queue = next.catch(() => undefined);
      return next;
    },
    async end(): Promise<void> {
      await queue;
      await sql?.end();
    },
  };
}
