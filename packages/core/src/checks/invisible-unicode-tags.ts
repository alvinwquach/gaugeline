import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { capFindings } from "./hidden-text/cap.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { scanText } from "./hidden-text/scan.js";
import { isHtmlPage } from "./page.js";

export const invisibleUnicodeTags = defineCheck<PageSnapshot>({
  id: "invisible-unicode-tags",
  size: "M",
  done: "The invisible characters are gone from their source and the content's history shows who or what put them there.",
  estimateChanges:
    "How they got in (a paste, a script, a compromise) matters more than removing them. Several fields multiply the cleanup.",
  area: "Security & email",
  severity: "high",
  title: "The page carries text in invisible characters",
  what: "Characters from the Unicode tag block are in the page's text. They show nothing on screen but each one stands for a letter.",
  why: "They have no ordinary use on a web page, and AI assistants can read the message they spell. Seeing them is a sign of tampering or of text pasted in from somewhere untrusted.",
  fix: "Delete them from the field or file they came from, then check who and what can edit that content.",
  tech: "code points U+E0000 to U+E007F in a text node or comment, other than the England, Scotland and Wales flag emoji (U+1F3F4, tag letters, U+E007F)",
  run(page) {
    if (!isHtmlPage(page)) return [];
    return capFindings(
      scanText(page).tags.map((t) => ({
        checkId: "invisible-unicode-tags",
        severity: "high" as const,
        title: this.title,
        evidence: `${escapeInvisible(t.where, 80)}: ${t.count} tag character${t.count === 1 ? "" : "s"}, reading "${escapeInvisible(t.decoded, 120)}"`,
        url: page.finalUrl,
      })),
    );
  },
});
