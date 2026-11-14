/** The last-night page's markup. Findings' titles and evidence are page text: cleaned, then escaped. */
import { SEVERITY_LABEL } from "@gaugeline/core";
import { formatWhen } from "./dashboard-view.js";
import { markup, pageText, type SafeHtml } from "./html.js";
import { groupNight, LISTED, nightSentence, type Item, type NightSite } from "./last-night.js";
import type { Role } from "./memberships.js";

const items = (list: Item[], total: number): SafeHtml =>
  markup`<ul>${list.map((i) => markup`<li><strong>${SEVERITY_LABEL[i.severity]}:</strong> ${pageText(i.title, "title")}${i.evidence ? markup`<br><span class="muted">${pageText(i.evidence, "evidence")}</span>` : ""}</li>`)}${
    total > list.length ? markup`<li class="muted">and ${total - list.length} more</li>` : ""
  }</ul>`;

function site(s: NightSite): SafeHtml {
  const c = s.changes;
  return markup`<section class="night-site">
<h3>${s.name}</h3>
<p class="muted">${s.url} - last checked ${s.lastRun ? formatWhen(s.lastRun.startedAt, s.timezone) : "never"}</p>
${
  c
    ? markup`<p>${c.openedTotal} new, ${c.stillOpen} still open, ${c.closedTotal} closed.</p>
${c.openedTotal ? markup`<h4>New</h4>${items(c.opened, c.openedTotal)}` : ""}
${c.closedTotal ? markup`<h4>Closed</h4>${items(c.closed, c.closedTotal)}` : ""}`
    : s.counts
      ? markup`<p>First check: ${s.counts.high} ${SEVERITY_LABEL.high}, ${s.counts.medium} ${SEVERITY_LABEL.medium}. There is no earlier night to compare with yet.</p>`
      : markup`<p>No run has arrived for this site yet.</p>`
}
</section>`;
}

export function nightBody(sites: NightSite[], role: Role): SafeHtml {
  if (sites.length === 0)
    return role === "client"
      ? markup`<p class="notice">No site has been shared with you yet.</p>`
      : markup`<p class="notice">No sites yet. A site appears after its first run is uploaded (<code>gaugeline --upload</code>).</p>`;
  return markup`<p>${nightSentence(sites)}</p>
${groupNight(sites).map(
  (g) => markup`<h2>${g.title}</h2>
${g.sites.map(site)}`,
)}
<p class="muted">New, still open and closed compare each site's last run with the run before it, by fingerprint. At most ${LISTED} of each are listed, worst first.</p>`;
}
