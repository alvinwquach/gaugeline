import type { AdapterEntry } from "./entry.js";

/** Planned, no code yet. The branch that builds it replaces this file with a built entry (see entry.ts). */
export const entries: readonly AdapterEntry[] = [
  {
    id: "strapi",
    name: "Strapi",
    status: "planned",
    branch: "C-02",
    docs: {
      key: "set when built",
      reads: "Entries through the REST or GraphQL API",
    },
  },
];
