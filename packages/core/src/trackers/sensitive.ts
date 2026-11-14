import { isSameSite } from "../sample.js";
import { detectForms } from "../forms/providers.js";
import type { PageSnapshot } from "../snapshot.js";
import { TRACKERS_CONFIG_FILE } from "./config.js";

/** Field names a site's search box uses. A search box is a form, but it is not where anyone enters details. */
const SEARCH_FIELD =
  /^(?:q|s|search|query|keyword|keywords|term|terms|search[_-]?(?:term|query|text))$/i;

type PageForm = PageSnapshot["forms"][number];

/**
 * A form that collects something: any form except a search box (a GET form whose only visible fields
 * are named like a search). A newsletter form, a contact form, a booking form and an intake form all count.
 */
export function collectsDetails(form: PageForm): boolean {
  const hidden = new Set(form.hiddenFields);
  const visible = (form.fieldNames ?? []).filter((n) => !hidden.has(n));
  const isGet = (form.method ?? "get") === "get";
  return !(isGet && visible.length > 0 && visible.every((n) => SEARCH_FIELD.test(n)));
}

/** The host a form posts to when it is not this site's own, or undefined (a form with no address posts to its own page). */
function otherHost(form: PageForm, page: PageSnapshot): string | undefined {
  if (form.action === undefined) return undefined;
  try {
    const u = new URL(form.action);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return isSameSite(form.action, page.finalUrl) ? undefined : u.hostname;
  } catch {
    return undefined;
  }
}

/** Does `path` meet a rule: exactly, or under a "/folder/*"? The query is not part of it. */
export function pathMeets(path: string, rule: string): boolean {
  return rule.endsWith("*") ? path.startsWith(rule.slice(0, -1)) : path === rule;
}

/**
 * Why a page counts as one with sensitive details, in words a finding can use, or undefined when it does not.
 * Three ways in: it has a form (and where the form sends its data, when that is another site), it embeds a
 * form service, or its path is one the settings list. Reads the snapshot and the settings; sends nothing.
 */
export function sensitiveReason(
  page: PageSnapshot,
  rules: readonly string[] = [],
): string | undefined {
  const parts: string[] = [];
  const forms = page.forms.filter(collectsDetails);
  const hosts = [...new Set(forms.flatMap((f) => otherHost(f, page) ?? []))].sort();
  if (hosts.length > 0) parts.push(`a page with a form that sends to ${hosts.join(" and ")}`);
  else if (forms.length > 0) parts.push("a page with a form");
  else {
    const embeds = [
      ...new Set(
        detectForms(page).flatMap((s) =>
          s.provider !== "unknown" && s.kind !== "form" ? [s.provider] : [],
        ),
      ),
    ].sort();
    if (embeds.length > 0) parts.push(`a page with an embedded form (${embeds.join(", ")})`);
  }
  const path = new URL(page.finalUrl).pathname;
  const rule = rules.find((r) => pathMeets(path, r));
  if (rule !== undefined)
    parts.push(
      `${parts.length > 0 ? "listed" : "a page listed"} in ${TRACKERS_CONFIG_FILE} (${rule})`,
    );
  return parts.length > 0 ? parts.join(", ") : undefined;
}
