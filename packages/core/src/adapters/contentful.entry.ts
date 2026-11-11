import type { AdapterEntry } from "./entry.js";

/** Planned, no code yet. The branch that builds it replaces this file with a built entry (see entry.ts). */
export const entries: readonly AdapterEntry[] = [
  {
    id: "contentful",
    name: "Contentful",
    status: "planned",
    branch: "C-07",
    docs: {
      key: "set when built",
      reads: "Entries through the Content Delivery API",
    },
  },
];
