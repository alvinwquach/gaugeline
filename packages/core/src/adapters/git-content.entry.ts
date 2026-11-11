import type { AdapterEntry } from "./entry.js";

/** Planned, no code yet. The branch that builds it replaces this file with a built entry (see entry.ts). */
export const entries: readonly AdapterEntry[] = [
  {
    id: "git-content",
    name: "Content kept in git",
    status: "planned",
    branch: "C-15",
    docs: {
      key: "none",
      reads: "Markdown, MDX, JSON and YAML content in the repository",
    },
  },
];
