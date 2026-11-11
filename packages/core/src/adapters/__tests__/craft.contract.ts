import { testKey } from "../../connectors/__tests__/fake.js";
import { createCraftAdapter } from "../craft.js";
import type { ContractEntry } from "./contract.js";
import { CRAFT_ENDPOINT, CRAFT_MARKERS, craftTransport } from "./craft-fixture.js";

/**
 * Fernlight Architects: a two-site Craft CMS install (English studio site, French atelier site) with projects
 * (one disabled draft, one switched off for the French site), journal posts and team members (see
 * craft-fixture.ts). The sections come from the settings, because Craft lists its sections only to a schema
 * that opted in.
 */
const CRAFT_KEY = testKey("craft-adapter");

export const CRAFT_CONTRACT_SETTINGS = {
  id: "craft",
  fingerprint: {
    projects: ["title", "project_Entry.summary"],
    journal: ["title"],
    team: ["title"],
  },
} as const;

export const craftEntry: ContractEntry = {
  id: "craft",
  make: ({ fetcher, sleep }) =>
    createCraftAdapter({
      env: { CRAFT_URL: CRAFT_ENDPOINT, CRAFT_TOKEN: CRAFT_KEY },
      fetcher,
      settings: CRAFT_CONTRACT_SETTINGS,
      sleep,
    }),
  transport: () => craftTransport(undefined, { token: CRAFT_KEY }),
  key: CRAFT_KEY,
  secrets: Object.values(CRAFT_MARKERS),
  expected: {
    types: [
      { name: "journal", count: 2 },
      { name: "projects", count: 3 },
      { name: "team", count: 2 },
    ],
    fields: {
      type: "projects",
      counts: { title: 3, "project_Entry.summary": 1 },
      missing: "project_Entry.subtitle",
    },
    published: {
      options: {
        types: ["projects"],
        fields: { projects: ["title", "project_Entry.summary"] },
      },
      // One entry on two sites is two items: the id carries the site handle.
      ids: ["101.studio", "101.atelier", "102.studio"],
    },
    draftsReachable: true,
  },
  // The key check is the first request and the journal's page the second; the projects' page is the first refused.
  rateLimit: { options: { types: ["journal", "projects"] }, succeedFirst: 2, atLeast: 2 },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [craftEntry];
