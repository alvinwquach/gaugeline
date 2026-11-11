import { defineCheck } from "../model.js";
import { devMarkers, isGatsbySite } from "../gatsby/detect.js";
import type { PageSnapshot } from "../snapshot.js";

export const gatsbyDevServerLive = defineCheck<PageSnapshot>({
  id: "gatsby-dev-server-live",
  size: "S",
  done: "The live address serves the built site (public/ from `gatsby build`), not `gatsby develop`.",
  estimateChanges:
    "A host that runs the develop command as its start command needs the build and serve commands set.",
  area: "Security & email",
  severity: "high",
  title: "The live Gatsby site is a development server",
  what: "This page was served by `gatsby develop`: its scripts include /socket.io/socket.io.js, /commons.js or /framework.js, the unhashed files only the development server writes.",
  why: "The development server exposes a GraphQL explorer over all your content, hot-reload endpoints and error overlays with file paths. It is not meant to face visitors.",
  fix: "Build the site (`gatsby build`) and serve the public folder (a static host, or `gatsby serve` for a quick check), not `gatsby develop`. Check the host's start command.",
  tech: "Gatsby sites only, read from the page already fetched, no extra request: a script address ending /socket.io/socket.io.js, /commons.js or /framework.js (a production build names its files with a content hash, as in framework-<hash>.js). Dev-only paths are not asked for",
  async run(page) {
    if (!isGatsbySite(page)) return [];
    const markers = devMarkers(page);
    if (markers.length === 0) return [];
    return [
      {
        checkId: "gatsby-dev-server-live",
        severity: "high",
        title: this.title,
        evidence: `the page carries ${markers.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
