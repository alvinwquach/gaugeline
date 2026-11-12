import { defineCheck, type Finding } from "../model.js";
import { isNuxtSite } from "../nuxt/detect.js";
import { readNuxtState } from "../nuxt/read.js";
import { privateKindOf, type PrivateKind } from "../nuxt/state.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

/** Fields named in one finding; the rest are counted. */
const NAMED = 5;
const SHOWN_KINDS = new Set(["text", "number", "object", "list"]);

export const nuxtPrivateState = defineCheck<PageSnapshot>({
  id: "nuxt-private-state",
  size: "M",
  done: "The page's embedded state and public runtime config hold only what a visitor may see.",
  estimateChanges:
    "Moving a value from runtimeConfig.public to the private runtimeConfig is one line, but the key it names may also need rotating, and any server code that used it from the browser needs a server route.",
  area: "Security & email",
  severity: "high",
  title: "A Nuxt page sends fields that look private to every visitor",
  what: "The page's embedded state (the __NUXT_DATA__ payload, or its _payload.json) or its public runtime config (window.__NUXT__) has a field whose name says it is a secret, password, private key, service role key, access token or API key, with a value in it.",
  why: "Everything in that state is in the page's source for anyone to read. A field named like a secret usually is one: a key someone put under runtimeConfig.public, or a whole server record returned to the page.",
  fix: "Keep the value in the private runtimeConfig (outside public) and use it only in server routes, return only the fields the page shows from useAsyncData and useFetch (pick or transform them), and rotate any key that has been public.",
  tech: "Nuxt sites only: the __NUXT_DATA__ script (a flat JSON array, read as the page was sent), the page's own /_payload.json when the data script points at one (one GET, same site only), and the window.__NUXT__ config literal, each read up to 2 MB or 256 KB by a single linear scan, never evaluated. Every object key is split into words (camelCase and snake_case alike) and matched against service role, secret, password, private key, access/auth/bearer/refresh/session token and API key; a field with an empty, null or true/false value is not reported. A name containing only API key is medium, the rest high. Only field names and the kind of place are shown, never a value; names are held in a Map keyed by name so a repeated field counts once, and a __proto__ key is an ordinary name. A payload that is cut, too large or not JSON is could-not-check, not a pass",
  async run(page, ctx) {
    if (!isNuxtSite(page) || !isHtmlPage(page)) return [];
    const read = await readNuxtState(page, ctx);
    for (const reason of read.unread) ctx.couldNotCheck?.(page.finalUrl, reason);
    const found = new Map<string, { kind: PrivateKind; where: string }>();
    for (const f of read.fields) {
      if (!SHOWN_KINDS.has(f.kind)) continue;
      const kind = privateKindOf(f.name);
      if (kind !== undefined && !found.has(f.name))
        found.set(f.name, { kind, where: f.where === "config" ? "public config" : "payload" });
    }
    if (found.size === 0) return [];
    const names = [...found.keys()].sort();
    const shown = names
      .slice(0, NAMED)
      .map((n) => {
        const f = found.get(n);
        return `${escapeInvisible(n, 60)} (${f?.kind ?? ""}, in the ${f?.where ?? ""})`;
      })
      .join(", ");
    const more = names.length > NAMED ? ` and ${names.length - NAMED} more` : "";
    const onlyApiKeys = [...found.values()].every((f) => f.kind === "an API key");
    const finding: Finding = {
      checkId: "nuxt-private-state",
      severity: onlyApiKeys ? "medium" : "high",
      title: this.title,
      evidence: `${names.length} field${names.length === 1 ? "" : "s"} in the page's embedded state look${names.length === 1 ? "s" : ""} private: ${shown}${more}. Values are not shown`,
      url: page.finalUrl,
    };
    return [finding];
  },
});
