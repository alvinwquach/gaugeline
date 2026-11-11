import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { devMarkers } from "../sveltekit/detect.js";

export const sveltekitDevServerLive = defineCheck<PageSnapshot>({
  id: "sveltekit-dev-server-live",
  size: "S",
  done: "The live address serves the built site (adapter output or `vite preview`), not `vite dev`.",
  estimateChanges:
    "A host that runs the dev command as its start command needs the build and start commands set.",
  area: "Security & email",
  severity: "high",
  title: "The live site is a development server",
  what: "This page was served by `vite dev`: its bootstrap script is __sveltekit_dev, or it loads /@vite/client, /.svelte-kit/ or /node_modules/.vite/ files.",
  why: "The dev server serves source files, can expose files from the project folder and is slow and unsupervised. It is not meant to face visitors.",
  fix: "Build the site (`vite build`) and serve the adapter's output (or `vite preview` for a quick check), not `vite dev`. Check the host's start command.",
  tech: "Read from the page already fetched, no extra request: the inline script assigns __sveltekit_dev (the name SvelteKit gives its global only under vite dev), or a script or the HTML names /@vite/client, /.svelte-kit/ or /node_modules/.vite/. Paths such as /__inspect are not asked for",
  async run(page) {
    const markers = devMarkers(page);
    if (markers.length === 0) return [];
    return [
      {
        checkId: "sveltekit-dev-server-live",
        severity: "high",
        title: this.title,
        evidence: `the page carries ${markers.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
