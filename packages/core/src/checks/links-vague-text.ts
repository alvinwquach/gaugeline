import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { contentIndex, normaliseLabel } from "./content/parse.js";
import { VAGUE_LINK_TEXT } from "./content/lists.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const linksVagueText = defineCheck<PageSnapshot>({
  id: "links-vague-text",
  size: "S",
  done: "Each link's text names its destination, or carries an aria-label that does.",
  estimateChanges: "A shared button component used everywhere is one edit.",
  area: "Visitors",
  severity: "low",
  title: "Some links don't say where they go",
  what: 'Links whose whole text is "read more", "click here", "learn more" or "here".',
  why: 'Screen reader users often browse a page by its links, and hear a list of identical "read more"s. Search engines also read link text to understand the destination.',
  fix: 'Make the link text name the destination, such as "Read more about pricing", or add an aria-label that does.',
  tech: `a link's accessible name (aria-label, else its text) is exactly ${VAGUE_LINK_TEXT.map((t) => `"${t}"`).join(", ")} (English list)`,
  run(page) {
    const vague = new Set(VAGUE_LINK_TEXT);
    const origin = new URL(page.finalUrl).origin;
    const hits = contentIndex(page).links.filter((l) => vague.has(normaliseLabel(l.name)));
    if (hits.length === 0) return [];
    return [
      {
        checkId: "links-vague-text",
        severity: "low",
        title: this.title,
        evidence: `${hits.length} ${hits.length === 1 ? "link" : "links"}: ${firstFew(hits.map((l) => `"${l.name}" to ${shortUrl(l.href, origin)}`))}`,
        url: page.finalUrl,
      },
    ];
  },
});
