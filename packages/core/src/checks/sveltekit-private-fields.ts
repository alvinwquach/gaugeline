import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isSveltekitSite, literalKeys, privateNames, readBootstrap } from "../sveltekit/detect.js";
import { pageData } from "../sveltekit/read.js";
import { isHtmlPage } from "./page.js";

const names = (list: readonly string[]): string =>
  list.slice(0, 8).join(", ") + (list.length > 8 ? `, and ${list.length - 8} more` : "");

export const sveltekitPrivateFields = defineCheck<PageSnapshot>({
  id: "sveltekit-private-fields",
  size: "M",
  done: "The page's data holds only what the page shows: no field named for a password, token, secret or private note.",
  estimateChanges:
    "Each field is dropped in the load function that returns it; a field several pages read needs each of them checked.",
  area: "Security & email",
  severity: "high",
  title: "The data sent with a page has fields that look private",
  what: "The state SvelteKit embeds in this page, or its __data.json, has fields named like something private (password, token, secret, apiKey, private notes).",
  why: "Everything a load function returns is sent to every visitor, whether or not the page shows it. A field that is only used on the server still travels with the page.",
  fix: "Return only the fields the page shows from load. Keep secrets in $env/static/private or $env/dynamic/private, and read them only in server code.",
  tech: "SvelteKit sites only. Names only, never values: the property names in the embedded state (the data literal of the inline __sveltekit_ script, read as text, strings skipped) and in the page's own __data.json (one GET of <page>/__data.json, devalue payload walked to depth 6, capped), matched by word against password, passwd, secret, token, private, credential, ssn, salt, bearer, authorization, cvv, iban, apiKey, accessKey, secretKey, privateKey, internalNotes. A payload that cannot be read is could not check. The names are matched by their words, which is a guess (uncited)",
  async run(page, ctx) {
    if (!isSveltekitSite(page) || !isHtmlPage(page)) return [];
    const found: string[] = [];
    const boot = readBootstrap(page);
    if (boot?.stateUnread) ctx.couldNotCheck?.(page.finalUrl, boot.stateUnread);
    const inState = boot?.state ? privateNames(literalKeys(boot.state)) : [];
    if (inState.length > 0) found.push(`the embedded state has ${names(inState)}`);
    if (ctx.fetcher) {
      const data = await pageData(page, ctx);
      if ("unread" in data.read) ctx.couldNotCheck?.(data.url, data.read.unread);
      else {
        const leaf = (p: string) => p.split(".").at(-1)?.replace(/\[\]$/, "") ?? p;
        const inData = privateNames([
          ...new Set(data.read.nodes.flatMap((n) => n.map((f) => leaf(f.path)))),
        ]);
        if (inData.length > 0) found.push(`${new URL(data.url).pathname} has ${names(inData)}`);
      }
    }
    if (found.length === 0) return [];
    const finding: Finding = {
      checkId: "sveltekit-private-fields",
      severity: "high",
      title: this.title,
      evidence: `${found.join("; ")} (field names only)`,
      url: page.finalUrl,
    };
    return [finding];
  },
});
