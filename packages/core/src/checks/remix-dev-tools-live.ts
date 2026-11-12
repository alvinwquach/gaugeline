import { defineCheck } from "../model.js";
import { devMarkers } from "../remix/detect.js";
import type { PageSnapshot } from "../snapshot.js";

export const remixDevToolsLive = defineCheck<PageSnapshot>({
  id: "remix-dev-tools-live",
  size: "S",
  done: "The live address serves the built site (react-router-serve or your host's server build), not the dev server.",
  estimateChanges:
    "A host that runs the dev command as its start command needs the build and start commands set.",
  area: "Security & email",
  severity: "high",
  title: "The live Remix site is a development server",
  what: "This page was served by the Remix or React Router dev server: it loads /@vite/client, /@react-refresh, the inject-hmr-runtime module or the live-reload script.",
  why: "The dev server serves source files, can expose files from the project folder and is slow and unsupervised. It is not meant to face visitors.",
  fix: "Build the site (`react-router build` or `remix vite:build`) and serve the build with `react-router-serve` or your host's adapter, not `vite dev`. Check the host's start command.",
  tech: "Read from the page already fetched, no extra request: the HTML or a script address names /@vite/client, /@react-refresh, inject-hmr-runtime (virtual:react-router/ or virtual:remix/), remixLiveReloadConnect, __vite_plugin_react_preamble_installed__ or /node_modules/.vite/. Vite's paths count only on a page that is Remix or React Router by its own context, header or dev module, so another Vite framework's dev server is not named here. Dev-only paths are not asked for. Names read from @react-router/dev 7.18.5 and @remix-run/dev 2.17.5 on npm",
  async run(page) {
    const markers = devMarkers(page);
    if (markers.length === 0) return [];
    return [
      {
        checkId: "remix-dev-tools-live",
        severity: "high",
        title: this.title,
        evidence: `the page carries ${markers.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
