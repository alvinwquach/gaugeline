/** The dashboard's markup: a table of sites, worst first. Words for the trend, never colour alone. */
import { SEVERITY_LABEL } from "@gaugeline/core";
import type { SiteSummary, Trend } from "./dashboard.js";
import { markup, pageText, type SafeHtml } from "./html.js";
import type { Role } from "./memberships.js";

const TREND_WORDS: Record<Trend, string> = {
  worse: "Worse",
  better: "Better",
  still: "Still",
  first: "First check",
  unchecked: "Not checked yet",
};

/** "12 Nov 2026, 03:00" in the site's own timezone; UTC (named) when the zone is not a real one. */
export function formatWhen(at: Date, timezone: string): string {
  const parts = (zone: string) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
  try {
    const p = parts(timezone);
    return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
  } catch {
    const p = parts("UTC");
    return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} UTC`;
  }
}

function row(s: SiteSummary): SafeHtml {
  return markup`<tr>
<th scope="row">${s.name}<br><span class="muted">${s.url}</span></th>
<td class="num">${s.counts ? s.counts.high : "-"}</td>
<td class="num">${s.counts ? s.counts.medium : "-"}</td>
<td><span class="trend trend-${s.trend}">${TREND_WORDS[s.trend]}</span></td>
<td>${s.lastRun ? formatWhen(s.lastRun.startedAt, s.timezone) : "-"}</td>
<td>${
    s.newest
      ? markup`<strong>${SEVERITY_LABEL[s.newest.severity]}:</strong> ${pageText(s.newest.title, "title")}<br><span class="muted">${pageText(s.newest.evidence, "evidence")}</span>`
      : ""
  }</td>
</tr>`;
}

export function dashboardBody(sites: SiteSummary[], role: Role): SafeHtml {
  if (sites.length === 0)
    return role === "client"
      ? markup`<p class="notice">No site has been shared with you yet. Ask the team that looks after your site to share it.</p>`
      : markup`<p class="notice">No sites yet. A site appears here after its first run is uploaded (<code>gaugeline --upload</code>); its results show up the next morning.</p>`;
  return markup`<table class="sites">
<caption>Sites, worst first</caption>
<thead><tr>
<th scope="col">Site</th>
<th scope="col" class="num">${SEVERITY_LABEL.high}</th>
<th scope="col" class="num">${SEVERITY_LABEL.medium}</th>
<th scope="col">Since the run before</th>
<th scope="col">Last checked</th>
<th scope="col">New since then</th>
</tr></thead>
<tbody>${sites.map(row)}</tbody>
</table>`;
}
