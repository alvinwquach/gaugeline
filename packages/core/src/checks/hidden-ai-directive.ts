import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { capFindings } from "./hidden-text/cap.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { scanText } from "./hidden-text/scan.js";
import { isHtmlPage } from "./page.js";

export const hiddenAiDirective = defineCheck<PageSnapshot>({
  id: "hidden-ai-directive",
  size: "L",
  done: "The hidden text is gone, the source that put it there is found and closed, and the passwords that could reach it are changed.",
  estimateChanges:
    "Finding how it got in (a plugin, a content field, an injected script) is the unknown. More than one way in multiplies the work.",
  area: "Security & email",
  severity: "high",
  title: "Hidden text on the page gives orders to AI assistants",
  what: "Text that visitors can't see, or a comment in the page's code, speaks to an AI assistant (for example 'ignore previous instructions').",
  why: "It is one of the commonest signs a site has been tampered with. Assistants and crawlers read text that visitors never see, so whoever planted it can steer what they say about your business.",
  fix: "Find where the text comes from (a plugin, a theme file, a content field or an injected script) and remove it. Then find out how it got there, and change the passwords and keys that could have put it there.",
  tech: "text under hidden, aria-hidden, display:none, visibility:hidden, font-size:0, opacity:0, an off-screen left or top, text coloured as its own background, noscript, or an HTML comment, containing a phrase from data/ai-directives.json",
  run(page) {
    if (!isHtmlPage(page)) return [];
    const found = scanText(page).hidden.filter((h) => h.directive !== undefined);
    return capFindings(
      found.map((h) => {
        const shown = `"${escapeInvisible(h.text, 120)}"`;
        const lead =
          h.how === "HTML comment"
            ? `HTML comment in ${escapeInvisible(h.where, 80)}`
            : `${escapeInvisible(h.where, 80)} (hidden by ${h.how})`;
        return {
          checkId: "hidden-ai-directive",
          severity: "high" as const,
          title: this.title,
          evidence: `${lead}: ${shown}, which contains "${h.directive}"`,
          url: page.finalUrl,
        };
      }),
    );
  },
});
