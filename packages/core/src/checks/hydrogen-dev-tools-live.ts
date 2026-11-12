import { devMarkers, isHydrogenSite } from "../hydrogen/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const hydrogenDevToolsLive = defineCheck<PageSnapshot>({
  id: "hydrogen-dev-tools-live",
  size: "S",
  done: "The live address serves the built storefront on Oxygen, not the dev server.",
  estimateChanges:
    "A tunnel or host that runs shopify hydrogen dev as its start command needs a deployment.",
  area: "Security & email",
  severity: "high",
  title: "The live Hydrogen store is a development server",
  what: "This page was served by the Hydrogen dev server: it loads /@vite/client, /@react-refresh, the inject-hmr-runtime module or the Vite preamble.",
  why: "The dev server serves source files, can expose files from the project folder and is slow and unsupervised. It is not meant to face shoppers.",
  fix: "Deploy the storefront to Oxygen (`shopify hydrogen deploy`) and point the domain at the deployment, not at a machine running `shopify hydrogen dev`.",
  tech: "Hydrogen storefronts only (the powered-by: Shopify, Hydrogen header, or React Router's context beside Shopify's CDN; a React Router page with neither is a Remix site and remix-dev-tools-live reports it), read from the page already fetched, no extra request: the HTML or a script address names /@vite/client, /@react-refresh, inject-hmr-runtime, __vite_plugin_react_preamble_installed__ or /node_modules/.vite/. Dev-only paths are not asked for. The dev server is Vite, as run by @shopify/cli-hydrogen 13.0.6",
  async run(page) {
    // Only a page that is positively Hydrogen (its header, or React Router's context beside Shopify's CDN). A React
    // Router 7 page with neither is a Remix site: remix-dev-tools-live reports it, so one dev server is reported once.
    const markers = devMarkers(page);
    if (markers.length === 0 || !isHydrogenSite(page)) return [];
    return [
      {
        checkId: "hydrogen-dev-tools-live",
        severity: "high",
        title: this.title,
        evidence: `the page carries ${markers.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
