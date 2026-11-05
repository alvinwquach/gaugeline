import { defineConfig } from "vitepress";
import { NAV, UNLISTED } from "../nav.js";

const pages = [...NAV.flatMap((g) => g.pages), ...UNLISTED];

export default defineConfig({
  title: "Gaugeline docs",
  description: "Check a website the way search engines and visitors see it.",
  cleanUrls: true,
  // Source files sit in docs/; every page is served under /docs/<slug>, the addresses people already link to.
  rewrites: Object.fromEntries(pages.map((p) => [`${p.slug}.md`, `docs/${p.slug}.md`])),
  srcExclude: ["**/__tests__/**", "**/README.md"],
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
