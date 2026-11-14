import { HOUSE_CONFIG_FILE, readHouseRules } from "../house-rules/index.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { capFindings } from "./hidden-text/cap.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

/**
 * HOUSE-01. A site's written style rules (headings in sentence case, no em dashes, never the word "cheap", buttons
 * that say "Book now", phone numbers in one shape) are rarely checked, because a person would have to read every
 * page. `gaugeline house-rules` turns the guide into a draft; once a person has reviewed it and named it
 * gaugeline.rules.json, this check reads the page against it. It reads the page already fetched: no request, no
 * model, and the same page and rules give the same findings. Without the file it asks nothing.
 *
 * Nothing from the file becomes a pattern, and the page is shown only as a short escaped snippet (a phone number as
 * its shape), so a hostile page can neither run a rule away nor put its own words in a report.
 *
 * // [docs] uncited: heading-case, button and phone-shape rules are this project's own plain rules, not a
 * published standard; the small-word list for title case is the common convention, from memory.
 */
export const houseRulesBroken = defineCheck<PageSnapshot>({
  id: "house-rules-broken",
  size: "S",
  done: "The page's headings, characters, words, button labels and phone numbers follow the rules in gaugeline.rules.json.",
  estimateChanges:
    "One copy edit per finding, or one change to a shared component such as a button or a footer. A rule that is wrong for the site is a one-line edit to gaugeline.rules.json.",
  area: "Visitors",
  severity: "low",
  title: "A page breaks your written house rules",
  what: "The page does not follow a rule you wrote down: its headings are in the wrong case, it uses a character or a word you ruled out, a button says something other than your label, or a phone number is written in another shape. Each finding names the rule, the page and the element.",
  why: "A style guide only works if every page follows it, and nobody reads every page. A word or a button label that is off is the kind of thing a visitor notices as the site looking careless, and the kind of thing that creeps back each time someone edits a page.",
  fix: "Change the text on the page to follow the rule, or, if the rule is out of date, change it in gaugeline.rules.json. A button label or a phone number that is set in one shared component is fixed once, there.",
  tech: `Only with a ${HOUSE_CONFIG_FILE} (headings.case, forbidChars, forbidTerms, buttonLabel, phoneFormat; a draft from gaugeline house-rules is never read until it is renamed). Reads the page already fetched, with no request: the title, the h1 to h3 headings (at most 200), the buttons and links (at most 500) and the visible text (the first 100,000 characters, scripts, styles and hidden elements left out), each cut to 2,000 characters except the page text. Nothing in the file is a pattern: a heading is judged by its words' capitals (a name, an acronym or a word with a capital inside is left alone; sentence case is broken only when at least three other words are all in capitals, and title case when a word outside a short list of small words is in lower case), a character is one of em dash, en dash, exclamation mark or ellipsis (the character or three dots), a banned word is a whole word or phrase compared as a list of lower-case words, a button counts when it says the label in other capitals or punctuation or with more words (a link only in other capitals or punctuation) and a phone number counts when it has the mask's digits in another shape. One finding per rule, naming at most three elements with a snippet of at most 48 characters; a phone number is shown as its shape (###), never its digits. A rule that cannot be read (no text, text cut at the limit with nothing found, a heading with no upper or lower case) is could-not-check, never a pass. Which button a label is meant for is not known: a button that says something else entirely is not recognised. Proper names look like title case, and the heading rule says so. No request is made; page text is never printed beyond the snippet`,
  run(page, ctx) {
    const house = ctx.house;
    if (!house || !isHtmlPage(page)) return [];
    const { violations, notChecked } = readHouseRules(house, page);
    const path = escapeInvisible(new URL(page.finalUrl).pathname || "/", 120);
    for (const n of notChecked) ctx.couldNotCheck?.(page.finalUrl, `${n.rule}: ${n.reason}`);
    return capFindings(
      violations.map((v): Finding => ({
        checkId: "house-rules-broken",
        severity: "low",
        title: this.title,
        evidence: `${v.rule} (${v.says}) on ${path}: ${v.hits.map((h) => `${h.element} "${h.snippet}"`).join("; ")}`,
        url: page.finalUrl,
      })),
    );
  },
});
