import { isAngularSite, pageBody, readStateScripts } from "../angular/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

/** Field names that say a value was never meant for visitors. Matched anywhere in the name. */
const PRIVATE_NAME =
  /secret|token|passw|api[_-]?key|private|internal|credential|authorization|admin|wholesale|margin/i;

export const angularStatePrivateFields = defineCheck<PageSnapshot>({
  id: "angular-state-private-fields",
  size: "M",
  done: "The page's transfer state carries no field named like a secret or an internal note.",
  estimateChanges:
    "Each flagged field is a value to drop; a whole API response stored as is means mapping it to the fields the page shows.",
  area: "Security & email",
  severity: "high",
  title: "A page hands private-looking fields to the browser in its transfer state",
  what: "The server-rendered state Angular embeds in this page (the ng-state script) has a field named like a secret, token, password, internal note or admin value.",
  why: "Angular writes everything stored in TransferState, and every cached HttpClient response, into the page as readable JSON. Anyone can view source and read it, whatever the page shows.",
  fix: "Store only what the page displays: map an API response to the fields the template uses before it reaches TransferState, or turn off the HttpClient transfer cache for that request. Read the private value on the server and leave it out.",
  tech: "Angular sites only, no extra request: each application/json script whose id ends in -state (ng-state, serverApp-state) in the HTML is parsed (at most 5 scripts, 500,000 characters each) and its field names, not values, matched against secret, token, passw, api key, private, internal, credential, authorization, admin, wholesale and margin; a state that cannot be parsed is reported as unread",
  run(page, ctx) {
    if (!isAngularSite(page)) return [];
    const { html, unread } = pageBody(page);
    const state = readStateScripts(html);
    const hits = state.fields
      .filter((f) => PRIVATE_NAME.test(f.name))
      .map((f) => `${f.name} (${f.kind})`);
    if (hits.length === 0) {
      if (state.unread > 0)
        ctx.couldNotCheck?.(
          page.finalUrl,
          `the transfer state is too large or is not JSON (${state.unread} ${state.unread === 1 ? "script" : "scripts"} unread)`,
        );
      else if (unread && state.found === 0)
        ctx.couldNotCheck?.(page.finalUrl, "the page was cut at Gaugeline's size limit");
      return [];
    }
    const shown = [...new Set(hits)].slice(0, 5).join(", ");
    return [
      {
        checkId: "angular-state-private-fields",
        severity: "high",
        title: this.title,
        evidence: `${hits.length} private-looking ${hits.length === 1 ? "field" : "fields"} in the transfer state: ${shown}${hits.length > 5 ? ` and ${hits.length - 5} more` : ""}`,
        url: page.finalUrl,
      },
    ];
  },
});
