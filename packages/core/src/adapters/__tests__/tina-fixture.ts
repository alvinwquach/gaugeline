/**
 * Rye & Ember Bakery, invented: a neighbourhood bakery whose freelancer built a Next.js site on TinaCMS.
 * The content is Markdown, MDX and JSON in the repository, and `tina/config.ts` says which folders are
 * collections. Nothing here was recorded from a real site. The same files are written to a folder (local
 * reads) and answered as GitHub's git trees and blobs (the contract suite), through git-content-fixture.ts.
 */
export const TINA_MARKERS = {
  newsOne: "Sourdough class sells out again",
  newsTwo: "New Saturday opening hours",
  draft: "Christmas order form, not announced",
  rye: "Dark rye with caraway",
  bun: "Cardamom buns on Fridays",
  hidden: "Retired spelt loaf",
  home: "Fresh bread every morning",
  hours: "Open seven days a week",
} as const;

/** tina/config.ts as a freelancer writes it: three collections, one with a custom address, one matching two files. */
export const TINA_CONFIG = `import { defineConfig } from "tinacms";

// collections: [ not a real list, this is a comment ]
const branch = process.env.GITHUB_BRANCH || process.env.HEAD || "main";

export default defineConfig({
  branch,
  clientId: process.env.NEXT_PUBLIC_TINA_CLIENT_ID,
  token: process.env.TINA_TOKEN,
  build: { outputFolder: "admin", publicFolder: "public" },
  media: { tina: { mediaRoot: "", publicFolder: "public" } },
  schema: {
    collections: [
      {
        name: "post",
        label: "News",
        path: "content/posts",
        format: "mdx",
        ui: {
          router: ({ document }) => \`/news/\${document._sys.filename}\`,
        },
        fields: [
          { type: "string", name: "title", label: "Title", isTitle: true, required: true },
          { type: "string", name: "summary", label: "Summary" },
          { type: "boolean", name: "draft", label: "Draft" },
          { type: "datetime", name: "date", label: "Date" },
          { type: "rich-text", name: "body", label: "Body", isBody: true },
        ],
      },
      {
        name: "bread",
        label: "Bread",
        path: "content/bread",
        format: "md",
        match: { exclude: "retired/**" },
        ui: {
          router: ({ document }) => {
            return \`/bread/\${document.slug}\`;
          },
        },
        fields: [
          { type: "string", name: "title", isTitle: true, required: true },
          { type: "string", name: "slug" },
          { type: "string", name: "notes" },
        ],
      },
      {
        name: "page",
        label: "Pages",
        path: "content/pages",
        format: "json",
        match: { include: "{home,hours}" },
        ui: { router: ({ document }) => \`/\${document._sys.filename}\` },
        fields: [{ type: "string", name: "headline" }],
      },
    ],
  },
});
`;

export const TINA_FILES: Readonly<Record<string, string>> = {
  "tina/config.ts": TINA_CONFIG,
  "tina/tina-lock.json": '{"schema":{},"lookup":{}}',
  "content/posts/sourdough-class.mdx": `---
title: ${TINA_MARKERS.newsOne}
summary: Two spaces left in December.
date: 2026-10-02T08:00:00.000Z
---
import Banner from "../../components/Banner";

<Banner />
`,
  "content/posts/saturday-hours.mdx": `---
title: ${TINA_MARKERS.newsTwo}
date: 2026-11-01T08:00:00.000Z
---
We open at seven.
`,
  "content/posts/christmas-orders.mdx": `---
title: ${TINA_MARKERS.draft}
draft: true
date: 2026-11-10T08:00:00.000Z
---
Not yet.
`,
  "content/posts/readme.md": "---\ntitle: Not an mdx file\n---\n",
  "content/bread/dark-rye.md": `---
title: ${TINA_MARKERS.rye}
slug: rye
notes: Caraway and a long proof.
---
Body.
`,
  "content/bread/cardamom-bun.md": `---
title: ${TINA_MARKERS.bun}
---
Body.
`,
  "content/bread/retired/spelt.md": `---
title: ${TINA_MARKERS.hidden}
---
Body.
`,
  "content/pages/home.json": JSON.stringify({ headline: TINA_MARKERS.home }),
  "content/pages/hours.json": JSON.stringify({ headline: TINA_MARKERS.hours }),
  "content/pages/draft-page.json": JSON.stringify({ headline: "Not matched" }),
  "package.json": '{"name":"rye-and-ember"}',
};

/** "Now" for the tests. */
export const TINA_NOW = new Date("2026-11-11T12:00:00.000Z");
