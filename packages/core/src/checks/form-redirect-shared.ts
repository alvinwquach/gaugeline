import { LEAK_LABEL, leakKindsOnLine } from "../field-findings/scrub.js";
import { detectForms } from "../forms/providers.js";
import { flatName } from "../forms/redirect-fields.js";
import type { PageSnapshot } from "../snapshot.js";
import { collectsDetails } from "../trackers/sensitive.js";
import { joined } from "./crm-shared.js";
import { drawnByScript, jsReason, labelOf } from "./forms.js";
import { escapeInvisible } from "./hidden-text/escape.js";

export { REDIRECT_FIELD_NAMES, isRedirectFieldName } from "../forms/redirect-fields.js";

/**
 * What form-redirect-leaks-details reads: the addresses a form is built to send a visitor to, in the page's own
 * HTML, and whether a visitor's email or phone number is written into one. It reads the snapshot only and sends
 * nothing: it never submits a form and never asks for a thank-you address. A value that is a person's detail is
 * never kept in a line of evidence: the line names the parameter and masks every value.
 */

type Kind = "email" | "phone";

/** What one reading found: the lines for findings, and the reasons something could not be seen. */
export type RedirectReading = { hits: string[]; unseen: string[] };

/** Longest address examined, most parameters read in one address, and how many addresses deep one may nest. */
const ADDRESS_MAX = 2000;
const PARAMS_MAX = 50;
const DEPTH_MAX = 2;
const SHOWN_MAX = 160;
const MASK = "***";

/** Parameter names that a form fills with the visitor's own details when it is submitted. */
const DETAIL_PARAMS: ReadonlySet<string> = new Set(
  "email emailaddress mail phone phonenumber tel telephone mobile mobilephone cell msisdn".split(
    " ",
  ),
);
/** A value that is a template slot, not a value: {{email}}, {email}, ${email}, [email], %email%, <email>, __email__. */
const PLACEHOLDER = /^(?:\{\{.*\}\}|\{.*\}|\$\{.*\}|\[.*\]|%[^%]+%|<.*>|__.+__)$/;

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** The kind of detail a piece of text holds somewhere in it, by the scrub's rules (field-findings/scrub.ts). */
function kindIn(text: string): Kind | undefined {
  const kinds = leakKindsOnLine(text.trim().replace(/^(?:mailto|tel|sms):/i, ""), undefined);
  return kinds.includes("email") ? "email" : kinds.includes("phone") ? "phone" : undefined;
}

/**
 * The kind of detail a whole value is, or undefined: an email address on its own, a phone number on its own
 * (an optional mailto:, tel: or sms: in front, percent-encoding undone). A web address that holds one is not.
 */
export function redirectShape(value: string): Kind | undefined {
  const text = decoded(value).trim();
  const body = text.replace(/^(?:mailto|tel|sms):/i, "");
  const bare = /^mailto:/i.test(text) ? (body.split("?")[0] ?? "") : body;
  if (bare === "" || /[/#?]/.test(bare)) return undefined;
  const kind = kindIn(bare);
  if (kind === "email") return /^\S+$/.test(bare) ? kind : undefined;
  return kind === "phone" && /^[+\d\s().-]+$/.test(bare) ? kind : undefined;
}

type Pair = { name: string; value: string; where: "query" | "fragment" | "bare-fragment" };

/** The parameters of an address: query then fragment (read as parameters when it has an "="). */
function pairsOf(u: URL): Pair[] {
  const out: Pair[] = [];
  for (const [name, value] of u.searchParams) out.push({ name, value, where: "query" });
  const frag = u.hash.slice(1);
  if (frag.includes("="))
    for (const [name, value] of new URLSearchParams(frag))
      out.push({ name, value, where: "fragment" });
  else if (frag !== "") out.push({ name: "", value: decoded(frag), where: "bare-fragment" });
  return out.slice(0, PARAMS_MAX);
}

/** The address as a web address (http or https only), relative ones resolved against `base`; long ones cut. */
function toUrl(value: string, base: string): URL | undefined {
  try {
    const u = new URL(value.trim().slice(0, ADDRESS_MAX), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
}

const showName = (name: string): string => (kindIn(name) ? "[masked]" : escapeInvisible(name, 40));

/** The address with every value masked, and a path segment that holds a detail masked too. */
function masked(u: URL): string {
  const path = u.pathname
    .split("/")
    .map((segment) => (kindIn(decoded(segment)) ? "[masked]" : segment))
    .join("/");
  const pairs = pairsOf(u);
  const query = pairs.filter((p) => p.where === "query").map((p) => `${showName(p.name)}=${MASK}`);
  const frag = pairs.filter((p) => p.where !== "query");
  const hash =
    frag.length === 0
      ? ""
      : frag[0]?.where === "bare-fragment"
        ? `#${MASK}`
        : `#${frag.map((p) => `${showName(p.name)}=${MASK}`).join("&")}`;
  const shown = `${u.origin}${path}${query.length > 0 ? `?${query.join("&")}` : ""}${hash}`;
  return escapeInvisible(shown, SHOWN_MAX);
}

type Scan = { leaks: string[]; unfilled: string[] };

/** Every parameter of an address, and of an address that is a parameter's value (two deep at most). */
function scan(u: URL, depth: number, trail: readonly string[], into: Scan): void {
  for (const pair of pairsOf(u)) {
    const label =
      pair.where === "bare-fragment"
        ? "the fragment"
        : `the "${[...trail, showName(pair.name)].join(" > ")}" parameter`;
    const nameKind = pair.name === "" ? undefined : kindIn(pair.name);
    if (nameKind) into.leaks.push(`a parameter name holds ${LEAK_LABEL[nameKind]}`);
    const kind = kindIn(pair.value);
    if (kind) {
      into.leaks.push(`${label} holds ${LEAK_LABEL[kind]}`);
      continue;
    }
    if (
      DETAIL_PARAMS.has(flatName(pair.name)) &&
      (pair.value === "" || PLACEHOLDER.test(pair.value))
    )
      into.unfilled.push([...trail, showName(pair.name)].join(" > "));
    const inner = depth < DEPTH_MAX && /^(?:https?:)?\/|^https?:/i.test(pair.value);
    const next = inner ? toUrl(pair.value, u.href) : undefined;
    if (next) scan(next, depth + 1, [...trail, showName(pair.name)], into);
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Where each form of the page sends a visitor, as far as the HTML says: the form's own action (when it is a
 * web address of its own) and any input named like a thank-you or redirect target (retURL, redirect_to, next,
 * success_url...). A hit is one address with a detail in its query string or fragment, or a field whose whole
 * value is a detail. `unseen` says what only a submit or a script would show.
 */
export function readRedirectLeaks(page: PageSnapshot): RedirectReading {
  const hits = new Set<string>();
  const unseen: string[] = [];
  let noAddress = 0;
  const here = new URL(page.finalUrl);
  here.hash = "";
  for (const form of page.forms) {
    const sources: { subject: (shown: string) => string; value: string; field?: string }[] = [];
    const action = form.action === undefined ? undefined : toUrl(form.action, page.finalUrl);
    if (action) {
      const own = new URL(action.href);
      own.hash = "";
      if (own.href !== here.href)
        sources.push({ subject: (s) => `Form action ${s}`, value: action.href });
    }
    for (const f of form.redirectFields ?? [])
      sources.push({
        subject: (s) => `The "${escapeInvisible(f.name, 40)}" field sends visitors to ${s}`,
        value: f.value,
        field: f.name,
      });
    const hasAction = sources.some((s) => s.field === undefined);
    const ignored = form.action !== undefined && /^(?:mailto|tel|sms):/i.test(form.action);
    if (!hasAction && (form.redirectFields ?? []).length === 0 && !ignored && collectsDetails(form))
      noAddress += 1;
    for (const source of sources) {
      const whole = source.field === undefined ? undefined : redirectShape(source.value);
      if (whole && source.field !== undefined) {
        hits.add(
          `The "${escapeInvisible(source.field, 40)}" field holds ${LEAK_LABEL[whole]} instead of an address to go to.`,
        );
        continue;
      }
      const u = toUrl(source.value, page.finalUrl);
      if (!u) continue;
      const found: Scan = { leaks: [], unfilled: [] };
      scan(u, 0, [], found);
      const subject = source.subject(masked(u));
      if (found.leaks.length > 0) hits.add(`${subject}: ${joined(found.leaks)}.`);
      if (found.unfilled.length > 0) {
        const names = joined(found.unfilled.map((n) => `"${n}"`));
        unseen.push(
          `${subject}: the ${names} ${found.unfilled.length === 1 ? "parameter has" : "parameters have"} no value in the HTML, so what ${found.unfilled.length === 1 ? "it holds is" : "they hold are"} only known after the form is submitted`,
        );
      }
    }
  }
  if (noAddress > 0)
    unseen.unshift(
      `${plural(noAddress, "form has", "forms have")} no address of its own to read (no action, or an action of # or javascript:) and no thank-you field, so where it sends a visitor is only known after it is submitted or a script runs`,
    );
  const sightings = detectForms(page);
  for (const s of sightings) {
    if (s.kind !== "iframe" || s.provider === "unknown" || s.src === undefined) continue;
    let host = "an address Gaugeline could not read";
    try {
      host = new URL(s.src).host;
    } catch {
      // keep the plain words
    }
    const line = `the ${labelOf(s.provider)} form at ${escapeInvisible(host, 80)} is another document, so where it sends a visitor after it is submitted is not visible`;
    if (!unseen.includes(line)) unseen.push(line);
  }
  for (const id of drawnByScript(sightings, () => true))
    unseen.push(jsReason(id, "Gaugeline cannot see where it sends a visitor once it is filled in"));
  return { hits: [...hits], unseen };
}
