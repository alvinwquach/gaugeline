/**
 * The triage agent on the hosted draft path (AG-12). Core plans, polices and traces the run
 * (packages/core/src/agents/triage); this binds each draft to the agent's own entry,
 * `createAgentDrafts(...).draft`, which is `private.agent_insert_draft`: the database authorizes the token
 * against the registry (scope `draft:email`), counts the call against the agent's limits, checks the
 * payload's shape, and writes the draft in nobody's name and one trace row. The agent can do nothing else:
 * its login holds no privilege on any table.
 */
import type { TriageDraftCall, TriageDraftResult } from "@gaugeline/core";
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
