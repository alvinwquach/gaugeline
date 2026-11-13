/** The agent scorecard's markup: one row per agent; a figure with nothing to measure is a blank cell in words. */
import { markup, type SafeHtml } from "./html.js";
import type { Role } from "./memberships.js";
import { scoreOf, type AgentCounts } from "./scorecard.js";

const blank = (text = "none yet"): SafeHtml => markup`<td class="num blank">${text}</td>`;
const num = (v: number | null, suffix = ""): SafeHtml =>
  v === null ? blank() : markup`<td class="num">${v}${suffix}</td>`;

function row(a: AgentCounts): SafeHtml {
  const s = scoreOf(a);
  return markup`<tr>
<th scope="row">${a.name}<br><span class="muted">${a.prefix ? `gla_${a.prefix}` : "no prefix"} - ${a.status}</span></th>
<td class="num">${s.runs}</td>
${num(s.approvalRate, "%")}
${num(s.editRate, "%")}
${num(s.costPerApproved)}
<td class="num">${s.denies}</td>
${blank("not measured")}
<td>${s.declineReasons.length ? markup`<ul>${s.declineReasons.map((r) => markup`<li>${r.reason} (${r.count})</li>`)}</ul>` : "none"}</td>
</tr>`;
}

export function scorecardBody(agents: AgentCounts[], role: Role): SafeHtml {
  if (role !== "owner" && role !== "admin")
    return markup`<p class="notice">Only owners and admins of the organisation see its agents.</p>`;
  if (agents.length === 0)
    return markup`<p class="notice">No agent is registered for this organisation yet.</p>`;
  return markup`<table class="sites agents">
<thead><tr>
<th scope="col">Agent</th>
<th scope="col" class="num">Runs</th>
<th scope="col" class="num">Approved</th>
<th scope="col" class="num">Edited before approval</th>
<th scope="col" class="num">Cost per approved draft (micro-units)</th>
<th scope="col" class="num">Denied</th>
<th scope="col" class="num">Errors</th>
<th scope="col">Decline reasons</th>
</tr></thead>
<tbody>
${agents.map(row)}
</tbody>
</table>
<p class="muted">Counted from the agent trace since it began. Runs are allowed calls; approved is the share of decided drafts approved; a blank cell has nothing to measure yet. Errors are not measured: a call that fails is undone and leaves no trace.</p>`;
}
