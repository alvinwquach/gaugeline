import {
  MARKER_LABEL,
  findDevMarkers,
  scriptAddressMarkers,
  type DevMarker,
} from "../devtools/markers.js";
import { frameworkCoversDevTools } from "../framework-dev-tools.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

const SHOWN = 6;

function label(m: DevMarker): string {
  return m.detail === undefined ? MARKER_LABEL[m.id] : `${m.detail} (${MARKER_LABEL[m.id]})`;
}

export const devToolsInProduction = defineCheck<PageSnapshot>({
  id: "dev-tools-in-production",
  size: "M",
  done: "No page or file the site serves names a development server, a development build or an address on a developer's own machine.",
  estimateChanges:
    "Usually a deploy of a real production build. An API address that was meant to change per environment needs its environment variable set on the host.",
  area: "Launch day",
  severity: "high",
  title: "Development tools are live on your site",
  what: "A page or script this site serves to everyone carries a sign that it came from a development server or a development build: Vite, webpack, Next.js or React tooling, NODE_ENV set to development, or an address on the visitor's own computer.",
  why: "A development build can expose original code and file paths, accepts hot reload connections, and runs slowly. An address such as 127.0.0.1:3000 in a script means the live site is asking each visitor's own machine for its data, so it breaks for everyone and can leak what the developer was working on.",
  fix: "Deploy a production build (npm run build, then serve its output) and set the API address variable on the host for production. If only a stray address remains, search the code and the host's environment variables for it.",
  tech: "No request of its own: the page's HTML and up to 15 same-site script files already read are searched for /@vite/client, /@react-refresh, /__webpack_hmr, webpack-dev-server/client, webpack-internal://, /_next/static/development/ or a development buildId, the React DevTools development notice, NODE_ENV assigned the value development, and a development build of a library named by a script address (.development.js); a loopback address (localhost, 127.0.0.1, 0.0.0.0 or [::1]) is reported only with a port, as host and port with nothing after them, and never the page's own address; a script cut at the cap is could not check; an Angular, Astro, SvelteKit, Hydrogen, Gatsby, Remix, Qwik, SolidStart or static-generator page on which that framework's own dev-server check reports is left to it; dev-only paths the page does not name are never asked for (that would be a probing check)",
  async run(page, ctx) {
    if (!isHtmlPage(page) || frameworkCoversDevTools(page)) return [];
    const html = page.hops.at(-1)?.body ?? "";
    const own = new URL(page.finalUrl).origin;
    const places: { where: string; markers: DevMarker[] }[] = [
      {
        where: "the page",
        markers: [...findDevMarkers(html, own), ...scriptAddressMarkers(page.scripts)],
      },
    ];
    for (const s of (await ctx.scripts?.()) ?? []) {
      if (s.truncated)
        ctx.couldNotCheck?.(
          s.url,
          "only the start of this file was read, so markers further on are unread",
        );
      places.push({
        where: new URL(s.url).pathname.slice(0, 120),
        markers: findDevMarkers(s.text, own),
      });
    }
    const lines: string[] = [];
    const seen = new Set<string>();
    let serves = false;
    for (const { where, markers } of places)
      for (const m of markers) {
        const line = `${label(m)} in ${where}`;
        if (seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
        serves ||= m.serves;
      }
    if (lines.length === 0) return [];
    const more = lines.length > SHOWN ? ` and ${lines.length - SHOWN} more` : "";
    return [
      {
        checkId: "dev-tools-in-production",
        severity: serves ? ("high" as const) : ("medium" as const),
        title: this.title,
        evidence: `${lines.slice(0, SHOWN).join("; ")}${more}`,
        url: page.finalUrl,
      },
    ];
  },
});
