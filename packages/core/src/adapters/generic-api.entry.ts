import type { AdapterEntry } from "./entry.js";

/** Planned, no code yet. The branch that builds it replaces this file with a built entry (see entry.ts). */
export const entries: readonly AdapterEntry[] = [
  {
    id: "generic-api",
    name: "Any headless CMS with a read API",
    status: "planned",
    branch: "C-14",
    docs: {
      key: "set by the recipe",
      reads:
        "A small mapping in settings, with recipes for Storyblok, Payload, Ghost, Drupal and others",
    },
  },
];
