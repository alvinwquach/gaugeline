import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { loadSinceContext } from "../../scripts/lib/check-since.js";
import { NAV, UNLISTED } from "../nav.js";

const pages = [...NAV.flatMap((g) => g.pages), ...UNLISTED];
// "Since vX" on the checks reference: released checks from docs/check-since.lock.json, every other
// check shows the next version (from the pending changesets). Read at build time, never committed.
const since = loadSinceContext(fileURLToPath(new URL("../../", import.meta.url)));

export default defineConfig({
  title: "Gaugeline docs",
  description: "Check a website the way search engines and visitors see it.",
  // Feed readers and browsers find the changelog feed from any page (docs/public/changelog.atom).
  head: [
    [
      "link",
      {
        rel: "alternate",
        type: "application/atom+xml",
        title: "Gaugeline changelog",
        href: "/changelog.atom",
      },
    ],
  ],
  vite: { define: { __CHECK_SINCE__: JSON.stringify({ lock: since.lock, next: since.next }) } },
  cleanUrls: true,
  // Source files sit in docs/; every page is served under /docs/<slug>, the addresses people already link to.
  rewrites: Object.fromEntries(pages.map((p) => [`${p.slug}.md`, `docs/${p.slug}.md`])),
  // Decision records are repository documents, read on GitHub, not site pages.
  srcExclude: ["**/__tests__/**", "**/README.md", "adr/**"],
  themeConfig: {
    sidebar: NAV.map((g) => ({
      text: g.soon ? `${g.group} (soon)` : g.group,
      items: g.pages.map((p) => ({
        text: p.soon ? `${p.title} (soon)` : p.title,
        link: `/docs/${p.slug}`,
      })),
    })),
    search: { provider: "local" },
  },
});
