import type { AdapterEntry } from "./entry.js";

/** Planned, no code yet. The branch that builds it replaces this file with a built entry (see entry.ts). */
export const entries: readonly AdapterEntry[] = [
  {
    id: "tina",
    name: "TinaCMS",
    status: "planned",
    branch: "C-03",
    docs: {
      key: "set when built",
      reads: "Content files in git, and TinaCloud when configured",
    },
  },
];
