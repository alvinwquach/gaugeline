import { defineCheck } from "../model.js";
import { isNuxtSite } from "../nuxt/detect.js";
import { readNuxtState } from "../nuxt/read.js";
import { hasDevtoolsState } from "../nuxt/state.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** Vite's dev server serves these under the build assets folder; a production build never references them. */
const DEV_SCRIPT = /\/@vite\/client|\/_nuxt\/@id\/|\/_nuxt\/@fs\/|\/__nuxt_devtools__\//;

export const nuxtDevBuildLive = defineCheck<PageSnapshot>({
  id: "nuxt-dev-build-live",
  size: "M",
  done: "The live site is a production build: its pages load /_nuxt/ files built by nuxt build, with no dev server client.",
  estimateChanges:
    "Usually a deploy that ran nuxt dev (or a start command that did) is replaced with nuxt build and its output. Allow longer if the host's build settings need changing.",
  area: "Security & email",
  severity: "high",
  title: "This Nuxt site is running its development server",
  what: "A page of this Nuxt site loads Vite's dev server client (/_nuxt/@vite/client) or other dev-only files, or its payload carries the Nuxt DevTools state.",
  why: "A development server is slow, ships source code and debug information, and exposes tools (the DevTools, error overlays with source) that were never meant for visitors.",
  fix: "Deploy the output of nuxt build (or nuxt generate), not the dev server, and check the host's start command. The Nuxt DevTools module only runs under nuxt dev.",
  tech: "Nuxt sites only, read from the page already fetched: a script whose address has /@vite/client, /_nuxt/@id/, /_nuxt/@fs/ or /__nuxt_devtools__/, or a __nuxt_devtools__ useState key in the payload (added by the DevTools server plugin, which exists only in a dev build). The payload is the inline __NUXT_DATA__ script, and the page's own _payload.json when the page points at one. No separate dev-tools address is asked here (see nuxt-devtools-public)",
  async run(page, ctx) {
    if (!isNuxtSite(page) || !isHtmlPage(page)) return [];
    const signs: string[] = [];
    const dev = page.scripts.find((s) => DEV_SCRIPT.test(s));
    if (dev !== undefined) {
      let path = dev;
      try {
        path = new URL(dev).pathname;
      } catch {
        // keep as written
      }
      signs.push(`the page loads ${path.slice(0, 120)}`);
    }
    const read = await readNuxtState(page, ctx);
    if (read.flats.some(hasDevtoolsState)) signs.push("its payload carries the DevTools state");
    if (signs.length === 0) return [];
    return [
      {
        checkId: "nuxt-dev-build-live",
        severity: "high",
        title: this.title,
        evidence: signs.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
