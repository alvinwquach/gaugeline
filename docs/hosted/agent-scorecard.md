# Hosted: the agent scorecard

The hosted version of Gaugeline (in progress, not released) lets registered agents propose fixes as drafts
that a person approves ([the agent registry](./agent-registry.md), [agent policy](./agent-policy.md),
[the agent trace](./agent-trace.md)). The **Agents** page shows, for each agent of your organisation, how
it has done: how often it ran, how many of its drafts were approved, edited first or declined and why, what
it cost and how often it was refused. Owners and admins see it; members and client viewers do not (the
link is not in their menu, and the page tells them who can see it).

## What each column means

| Column                  | What it counts                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Runs                    | the agent's allowed calls (drafts and reads), from the agent trace                                               |
| Approved                | approved drafts as a whole percent of its drafts a person decided (approved or declined)                         |
| Edited before approval  | approvals of a draft a person edited first, as a whole percent of its approvals                                  |
| Cost per approved draft | the declared cost of all its calls divided by its approved drafts, in whole micro-units (10^6 to the unit)       |
| Denied                  | its refused calls, with the ones counted per minute past the trace's bound                                       |
| Errors                  | always "not measured": a hosted call that fails is undone whole and leaves no trace row, so nothing can count it |
| Decline reasons         | the three reasons people gave most often when declining its drafts, with how many times                          |

**Real numbers only.** Every figure is a count from the agent trace and the decisions log, or a ratio of
two counts worked out in whole numbers (a percent rounds half up). A figure with nothing to measure yet is
blank and says so: "none yet" for a rate before the first decision or a cost before the first approval,
never 0. Cost is 0 today because no agent call runs a model; that 0 is measured, not a placeholder. When a call
does run a model, the [budget](../model-budgets.md) works out its cost from the recorded token counts and hands
it to the trace; this page needs no change to show it.

The counts start when the trace began (migration `0015_agent_trace.sql`); calls made before it are not
in them. A token prefix is shown (`gla_1a2b3c4d`), never a token.

## An example: a bar's menu fixer and a physio's booking watcher

Northgate Studio runs two agents: one drafts emails about The Tidewater Bar's menu, the other only reads a
clinic's booking-page runs. The menu fixer ran 12 times, was refused 3 times, and of its 6 decided drafts
4 were approved (one after an edit) and 2 declined. The watcher ran 3 times and has no draft yet. This is
the table the page renders for those counts (the same markup a test renders and compares with this block):

```text title=agents.html
<table class="sites agents">
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
<tr>
<th scope="row">Menu fixer<br><span class="muted">gla_1a2b3c4d - active</span></th>
<td class="num">12</td>
<td class="num">67%</td>
<td class="num">25%</td>
<td class="num">0</td>
<td class="num">3</td>
<td class="num blank">not measured</td>
<td><ul><li>Wrong opening hours (1)</li><li>(no reason given) (1)</li></ul></td>
</tr><tr>
<th scope="row">Booking page watcher<br><span class="muted">gla_5e6f7a8b - active</span></th>
<td class="num">3</td>
<td class="num blank">none yet</td>
<td class="num blank">none yet</td>
<td class="num blank">none yet</td>
<td class="num">0</td>
<td class="num blank">not measured</td>
<td>none</td>
</tr>
</tbody>
</table>
<p class="muted">Counted from the agent trace since it began. Runs are allowed calls; approved is the share of decided drafts approved; a blank cell has nothing to measure yet. Errors are not measured: a call that fails is undone and leaves no trace.</p>
```

Read it as: 4 of 6 decided drafts approved is 67%; 1 of 4 approvals was edited first, 25%; a cost of 0 over
4 approvals is 0. The watcher has made no draft, so its rates and cost are blank, not 0.

## What it does not show

- Errors, as above. A count of errors would need a trace written outside the call's transaction.
- Anything an agent wrote or read: the page reads ids, counts, codes and the reasons people typed (escaped).
- Another organisation's agents: the page reads as you, and row-level security returns only your
  organisation's agents and traces, and only to owners and admins.
