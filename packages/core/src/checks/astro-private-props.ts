import { isAstroSite, pageBody, readIslands } from "../astro/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

/** Field names that say a value was never meant for visitors. Matched anywhere in the name. */
const PRIVATE_NAME =
  /secret|token|passw|api[_-]?key|private|internal|credential|authorization|admin|wholesale|margin/i;

export const astroPrivateProps = defineCheck<PageSnapshot>({
  id: "astro-private-props",
  size: "M",
  done: "No island's props carry a field named like a secret or an internal note.",
  estimateChanges:
    "Each flagged field is a prop to drop; one passed whole from a database row means picking the fields the component needs.",
  area: "Security & email",
  severity: "high",
  title: "A page hands private-looking fields to the browser in an island's props",
  what: "An Astro island (a component with a client: directive) on this page has props with a field named like a secret, token, password, internal note or admin value.",
  why: "Everything passed to a client island is written into the page as readable JSON. Anyone can view source and read it, whatever the component shows.",
  fix: "Pass the island only the fields it displays. Read the private value on the server (in the frontmatter or an Action) and leave it out of the props.",
  tech: "Astro sites only, no extra request: each astro-island's props attribute in the HTML is decoded and its field names (not values) matched against secret, token, passw, api key, private, internal, credential, authorization, admin, wholesale and margin; at most 100 islands, 200,000 characters of props each; the evidence lists names, never values",
  run(page) {
    if (!isAstroSite(page)) return [];
    const { html } = pageBody(page);
    const { islands } = readIslands(html);
    const hits = islands.flatMap((i) =>
      i.fields
        .filter((f) => PRIVATE_NAME.test(f.name))
        .map((f) => `${i.component}.${f.name} (${f.kind})`),
    );
    if (hits.length === 0) return [];
    const shown = hits.slice(0, 5).join(", ");
    return [
      {
        checkId: "astro-private-props",
        severity: "high",
        title: this.title,
        evidence: `${hits.length} private-looking ${hits.length === 1 ? "field" : "fields"} in island props: ${shown}${hits.length > 5 ? ` and ${hits.length - 5} more` : ""}`,
        url: page.finalUrl,
      },
    ];
  },
});
