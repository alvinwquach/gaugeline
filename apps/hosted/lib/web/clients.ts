/**
 * The agency's pages (X66): all clients, worst first, and a preview of a client's weekly update. Staff only;
 * a client viewer is sent to their own site's page. Everything is read as the signed-in person, so the
 * policies decide what exists (0006): another organisation's client is simply not found.
 */
import { loadClientWeek, weekStartOf } from "../../agency/weekly-store.js";
import {
  composeWeeklyUpdate,
  siteWeek,
  sortClientsWorstFirst,
  type ClientRow,
} from "../../agency/weekly-update.js";
import type { Tx } from "./db.js";
import type { WebDeps } from "./deps.js";
import { signedIn } from "./handlers.js";
import { markup } from "./html.js";
import { redirect, respondHtml, respondText } from "./layout.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ClientSummary extends ClientRow {
  id: string;
  sites: number;
  state: string;
}

/** Where this week's update is: not drafted, waiting in the inbox, approved, declined or sent. */
async function updateState(
  tx: Tx,
  clientId: string,
  weekStart: string,
): Promise<{ state: string; subject?: string; body?: string }> {
  const [u] = await tx`
    select u.subject, u.body, st.decision, s.subject as sent_subject, s.body as sent_body, s.sent_at
    from public.weekly_updates u
    join public.draft_state st on st.draft_id = u.draft_id
    left join public.weekly_update_sends s on s.update_id = u.id
    where u.client_id = ${clientId} and u.week_start = ${weekStart}`;
  if (!u) return { state: "Not drafted yet (drafted on Friday into the inbox)" };
  if (u.sent_at)
    return {
      state: `Sent on ${(u.sent_at as Date).toISOString().slice(0, 10)}`,
      subject: u.sent_subject as string,
      body: u.sent_body as string,
    };
  const words: Record<string, string> = {
    pending: "Waiting for approval in the inbox",
    approved: "Approved, sending next",
    edited: "Edited and approved, sending next",
    declined: "Declined: not sent",
  };
  return {
    state: words[u.decision as string] ?? "Waiting",
    subject: u.subject as string,
    body: u.body as string,
  };
}

export function clientsPage(request: Request, deps: WebDeps): Promise<Response> {
  return signedIn(request, deps, async ({ tx, shell }) => {
    if (!shell || shell.current.role === "client") return redirect("/");
    const week = weekStartOf(deps.now());
    const clients = await tx`select id from public.clients
      where org_id = ${shell.current.orgId} order by name, id`;
    const rows: ClientSummary[] = [];
    for (const c of clients) {
      const loaded = await loadClientWeek(tx, c.id as string, week);
      if (!loaded) continue;
      const weeks = loaded.input.sites.map(siteWeek);
      rows.push({
        id: c.id as string,
        name: loaded.input.clientName,
        sites: weeks.length,
        high: weeks.reduce((n, w) => n + w.high, 0),
        open: weeks.reduce((n, w) => n + w.counts.new + w.counts.waiting, 0),
        changed: weeks.reduce((n, w) => n + w.counts.new + w.counts.fixed, 0),
        state: (await updateState(tx, c.id as string, week)).state,
      });
    }
    const body =
      rows.length === 0
        ? markup`<p class="notice">No clients with sites yet. Group a site under a client to see it here.</p>`
        : markup`<table class="sites">
<thead><tr><th scope="col">Client</th><th scope="col" class="num">Sites</th><th scope="col" class="num">Fix this first</th><th scope="col" class="num">Open</th><th scope="col" class="num">Changed this week</th><th scope="col">This week's update</th></tr></thead>
<tbody>${sortClientsWorstFirst(rows).map(
            (r) => markup`<tr>
<th scope="row">${r.name}</th><td class="num">${r.sites}</td><td class="num">${r.high}</td><td class="num">${r.open}</td><td class="num">${r.changed}</td>
<td><a href="/clients/update?client=${r.id}">${r.state}</a></td></tr>`,
          )}</tbody></table>`;
    return respondHtml(
      200,
      "Clients",
      markup`<h1>Clients</h1>
<p class="muted">${shell.current.orgName}: worst first, week of ${week}.</p>
${body}`,
      shell,
    );
  });
}

export function clientUpdatePage(request: Request, deps: WebDeps): Promise<Response> {
  const clientId = new URL(request.url).searchParams.get("client") ?? "";
  if (!UUID.test(clientId)) return Promise.resolve(notFound());
  return signedIn(request, deps, async ({ tx, shell }) => {
    if (!shell || shell.current.role === "client") return redirect("/");
    const week = weekStartOf(deps.now());
    const loaded = await loadClientWeek(tx, clientId, week);
    if (!loaded || loaded.orgId !== shell.current.orgId) return notFound();
    const stored = await updateState(tx, clientId, week);
    const text = stored.subject
      ? { subject: stored.subject, body: stored.body ?? "" }
      : composeWeeklyUpdate(loaded.input);
    return respondHtml(
      200,
      "Weekly update",
      markup`<h1>${loaded.input.clientName}: this week's update</h1>
<p class="notice">${stored.state}.${stored.subject ? "" : " This is a preview of what Friday's draft would say now."}</p>
<p><strong>From:</strong> ${loaded.input.agencyName}<br><strong>Subject:</strong> ${text.subject}</p>
<pre class="update">${text.body}</pre>
<p><a href="/clients">All clients</a></p>`,
      shell,
    );
  });
}

const notFound = (): Response => respondText(404, "Not found", "text/plain; charset=utf-8");
