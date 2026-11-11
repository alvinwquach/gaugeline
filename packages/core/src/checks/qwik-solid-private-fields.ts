import { defineCheck, type Finding } from "../model.js";
import { privateNames, readState } from "../qwik/detect.js";
import { pageQData } from "../qwik/read.js";
import type { PageSnapshot } from "../snapshot.js";
import { readHydration } from "../solidstart/detect.js";
import { isHtmlPage } from "./page.js";
import { frameworkOf, names } from "./qwik-solid-shared.js";

export const qwikSolidPrivateFields = defineCheck<PageSnapshot>({
  id: "qwik-solid-private-fields",
  size: "M",
  done: "The page's data holds only what the page shows: no field named for a password, token, secret or private note.",
  estimateChanges:
    "Each field is dropped in the loader or server function that returns it; a field several pages read needs each of them checked.",
  area: "Security & email",
  severity: "high",
  title: "The data a Qwik or SolidStart page sends has fields that look private",
  what: "The state Qwik or SolidStart embeds in this page (Qwik's qwik/json script, SolidStart's _$HY hydration data), or this Qwik page's q-data.json, has fields named like something private (password, token, secret, apiKey, private notes).",
  why: "Everything a loader or a hydrated component holds is sent to every visitor, whether or not the page shows it. A field that is only used on the server still travels with the page.",
  fix: "Return only the fields the page shows from the routeLoader$ or the server function. Keep secrets in server-only environment variables and read them only in server code.",
  tech: "Qwik and SolidStart sites only. Names only, never values: the property names of the objects in the embedded state (Qwik: the objs list of <script type=\"qwik/json\">; SolidStart: the literals of the inline scripts that write to _$HY.r, read as text, strings skipped) and, for Qwik, in the page's own q-data.json (one GET of <page>/q-data.json, _objs list, capped), matched by word against password, passwd, secret, token, private, credential, ssn, salt, bearer, authorization, cvv, iban, apiKey, accessKey, secretKey, privateKey, internalNotes. A state that cannot be read (including Qwik 2's format, uncited) is could not check. The names are matched by their words, which is a guess (uncited)",
  async run(page, ctx) {
    const framework = frameworkOf(page);
    if (framework === undefined || !isHtmlPage(page)) return [];
    const found: string[] = [];
    const state = framework === "qwik" ? readState(page) : readHydration(page);
    if (state && "unread" in state) ctx.couldNotCheck?.(page.finalUrl, state.unread);
    else if (state) {
      const inState = privateNames(state.names);
      if (inState.length > 0) found.push(`the embedded state has ${names(inState)}`);
    }
    if (framework === "qwik" && ctx.fetcher) {
      const data = await pageQData(page, ctx);
      if ("unread" in data.read) ctx.couldNotCheck?.(data.url, data.read.unread);
      else {
        const inData = privateNames(data.read.names);
        if (inData.length > 0) found.push(`${new URL(data.url).pathname} has ${names(inData)}`);
      }
    }
    if (found.length === 0) return [];
    const finding: Finding = {
      checkId: "qwik-solid-private-fields",
      severity: "high",
      title: this.title,
      evidence: `${found.join("; ")} (field names only)`,
      url: page.finalUrl,
    };
    return [finding];
  },
});
