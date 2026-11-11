import { defineCheck } from "../model.js";
import { devMarkers as qwikDev } from "../qwik/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { devMarkers as solidDev } from "../solidstart/detect.js";
import { frameworkOf } from "./qwik-solid-shared.js";

export const qwikSolidDevServerLive = defineCheck<PageSnapshot>({
  id: "qwik-solid-dev-server-live",
  size: "S",
  done: "The live address serves the built site, not the development server.",
  estimateChanges:
    "A host that runs the dev command as its start command needs the build and start commands set.",
  area: "Security & email",
  severity: "high",
  title: "The live site is a development server",
  what: "This page was served by the Vite development server of a Qwik or SolidStart site: it loads /@vite/client, /@qwik-city-plan or /_build/@fs/ files, or its Qwik container says it was rendered in dev mode.",
  why: "The dev server serves source files, can expose files from the project folder and is slow and unsupervised. It is not meant to face visitors.",
  fix: "Build the site and serve the build's output with the adapter or start command of your host, not the dev command. Check the host's start command.",
  tech: "Read from the page already fetched, no extra request: q:render ending -dev or a q:manifest-hash starting dev on the Qwik container, or a script or the HTML naming /@vite/client, /@qwik-city-plan (Qwik) or /_build/@fs/ (SolidStart). Paths such as /__inspect are not asked for",
  async run(page) {
    const framework = frameworkOf(page);
    if (framework === undefined) return [];
    const markers = framework === "qwik" ? qwikDev(page) : solidDev(page);
    if (markers.length === 0) return [];
    return [
      {
        checkId: "qwik-solid-dev-server-live",
        severity: "high",
        title: this.title,
        evidence: `the page carries ${markers.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
