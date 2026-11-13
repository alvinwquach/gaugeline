import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findAiWidgets, isAllowedWidget, type WidgetSighting } from "../ai-widgets/vendors.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

const clip = (text: string): string => escapeInvisible(text, 120);

function describe(s: WidgetSighting): string {
  return `${s.label} (${s.ai ? "AI assistant" : "chat"}, ${s.host})`;
}

function join(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * AI-11. Chat and AI assistant widgets are scripts a visitor's browser loads from another company, and what a
 * visitor types into one goes to that company. Many small sites have one nobody remembers adding. The check lists
 * the widgets a page loads (from a fixed table of vendors, by script and iframe address and by the snippet that sets
 * one up) and flags the ones that are not on the list the owner supplied in gaugeline.ai.json (`aiWidgets.allowed`).
 * With no list it says what it found, as a low finding, so the owner can write the list. It reads the page only.
 *
 * // [docs] uncited: the vendors' hosts and snippets are from memory; their sites were unreachable when this was written.
 */
export const aiWidgetInventory = defineCheck<PageSnapshot>({
  id: "ai-widget-inventory",
  size: "S",
  done: "Every chat or AI widget on the page is one you chose, and each is in the aiWidgets list in gaugeline.ai.json.",
  estimateChanges:
    "Finding who added a widget (a plugin, the tag manager, a theme setting) is the work; adding a name to the list takes a minute. A widget loaded by the tag manager has to be found there.",
  area: "Security & email",
  severity: "medium",
  title: "A chat or AI widget loads on your page that you have not listed",
  what: "A chat or AI assistant widget from another company loads on the page, and it is not on the allowed list in gaugeline.ai.json (or you have no list yet). Gaugeline names each one and where it loads from.",
  why: "What a visitor types into a widget goes to its company, and many sites have a widget nobody remembers adding: a trial left on, a plugin's default, an assistant a salesperson turned on. The owner should know which ones are there.",
  fix: "For each one, find who added it (a plugin, the tag manager, a theme setting). Remove the ones you do not want. Put the ones you do want in aiWidgets.allowed in gaugeline.ai.json, by name or by host, and the finding goes.",
  tech: "Script and iframe addresses and inline scripts in the page's HTML (the first 16,384 characters of each inline script) matched against a fixed table of 23 vendors (packages/core/src/ai-widgets/vendors.ts), once per vendor; a host matches itself and its subdomains, never a look-alike; page text and comments are never read as a widget. With aiWidgets.allowed in gaugeline.ai.json, one medium finding lists the widgets not on it (an entry is a vendor id or a host or a parent of it; an empty list allows none); with no list, one low finding lists what loads. A widget a script adds after the page loads, and a widget loaded by a tag manager container, are not seen; vendor hosts are from memory (uncited). No request is made.",
  run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const seen = findAiWidgets(page);
    if (seen.length === 0) return [];
    const path = clip(new URL(page.finalUrl).pathname);
    const list = ctx.ai?.aiWidgets?.allowed;
    if (list === undefined) {
      return [
        finding(
          page,
          "low",
          `${join(seen.map(describe))} ${seen.length === 1 ? "loads" : "load"} on ${path}; there is no aiWidgets list in gaugeline.ai.json, so none is marked as allowed`,
        ),
      ];
    }
    const unlisted = seen.filter((s) => !isAllowedWidget(s, list));
    if (unlisted.length === 0) return [];
    return [
      finding(
        page,
        "medium",
        `${join(unlisted.map(describe))} ${unlisted.length === 1 ? "loads on" : "load on"} ${path} and ${unlisted.length === 1 ? "is" : "are"} not in the aiWidgets list in gaugeline.ai.json`,
      ),
    ];
  },
});

function finding(page: PageSnapshot, severity: Finding["severity"], evidence: string): Finding {
  return {
    checkId: "ai-widget-inventory",
    severity,
    title: aiWidgetInventory.title,
    evidence,
    url: page.finalUrl,
  };
}
