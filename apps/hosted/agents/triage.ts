/**
 * The triage agent on the hosted draft path (AG-12). Core plans, polices and traces the run
 * (packages/core/src/agents/triage); this binds each draft to the agent's own entry,
 * `createAgentDrafts(...).draft`, which is `private.agent_insert_draft`: the database authorizes the token
 * against the registry (scope `draft:email`), counts the call against the agent's limits, checks the
 * payload's shape, and writes the draft in nobody's name and one trace row. The agent can do nothing else:
 * its login holds no privilege on any table.
 *
 * It also reads which causes already have a draft waiting, through the AG-08 read path (scope `read:pending`):
 * `triagePendingSource` calls the API's own handler for GET /drafts?status=pending in this process, with the
 * agent's own token and the agent's own login (`private.agent_list_pending`), so the kill switch, the policy,
 * the redaction and the paging are the API's, not copied here. No request leaves the process.
 */
import {
  isAgentDenyReason,
  type TriageDraftCall,
  type TriageDraftResult,
  type TriagePendingCall,
  type TriagePendingResult,
} from "@gaugeline/core";
import { getPendingDrafts, type AgentReadDeps } from "../lib/api/agent-reads.js";
import type { AgentDraftCall, AgentDraftResult } from "./draft.js";

/** A function `runTriage` can call as its `draft`, holding the agent's token. The token is used for nothing else. */
export function triageDraftSink(
  drafts: { draft(call: AgentDraftCall): Promise<AgentDraftResult> },
  token: string,
): (call: TriageDraftCall) => Promise<TriageDraftResult> {
  return (call) =>
    drafts.draft({
      token,
      siteId: call.siteId,
      kind: call.kind,
      payload: call.payload,
      findingIds: call.findingIds,
    });
}

/**
 * A function `runTriage` can call as its `readPending`: one page of the site's waiting drafts, read as the
 * agent. A refusal from the API (the policy's closed reasons) is a refusal; any other failure throws, and
 * the run treats the read as unavailable and drafts nothing.
 */
export function triagePendingSource(
  deps: AgentReadDeps,
  token: string,
): (call: TriagePendingCall) => Promise<TriagePendingResult> {
  return async (call) => {
    const q = new URLSearchParams({
      status: "pending",
      site: call.siteId,
      limit: String(call.limit),
    });
    if (call.cursor !== null) q.set("cursor", call.cursor);
    const res = await getPendingDrafts(
      new Request(`http://agent.invalid/drafts?${q.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      deps,
    );
    const body: unknown = await res.json().catch(() => undefined);
    if (res.status === 200) return { read: true, page: body };
    const reason = (body as { reason?: unknown } | undefined)?.reason;
    if (isAgentDenyReason(reason)) return { read: false, reason };
    throw new Error(`The pending read failed with status ${res.status}.`);
  };
}
