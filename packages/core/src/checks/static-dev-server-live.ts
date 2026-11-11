import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { devMarkers } from "../static-generators/detect.js";
import { isHtmlPage } from "./page.js";

export const staticDevServerLive = defineCheck<PageSnapshot>({
  id: "static-dev-server-live",
  size: "S",
  done: "The live address serves the built files, not the generator's development server.",
  estimateChanges: "A host that runs a start command needs it changed to serve the build folder.",
  area: "Launch day",
  severity: "high",
  title: "The live site is a development server",
  what: "This page loads a live-reload or development script of a static site generator (Hugo, Jekyll, Eleventy, Docusaurus or VitePress).",
  why: "A development server shows drafts and future posts, rebuilds on every request and was never meant for visitors: it is slow, and it keeps a connection open for every one of them.",
  fix: "Build the site (hugo, jekyll build, eleventy, docusaurus build, vitepress build) and serve the output folder from a static host.",
  tech: "The page's own script addresses only: /livereload.js (Hugo and Jekyll servers: uncited), /.11ty/reload-client.js (eleventy-dev-server 2.1.2), /@vite/client beside a vitepress script (VitePress dev), or a Docusaurus generator tag with no version (the development template, @docusaurus/core 3.10.2). Names of the markers only",
  run(page) {
    if (!isHtmlPage(page)) return [];
    const found = devMarkers(page);
    if (found.length === 0) return [];
    return [
      {
        checkId: "static-dev-server-live",
        severity: "high",
        title: this.title,
        evidence: `the page loads ${found.join(", ")}`.replace(
          /^the page loads a /,
          "the page has a ",
        ),
        url: page.finalUrl,
      },
    ];
  },
});
