// check-community: allow-email (invented addresses at reserved example domains, for the members fixture)
import { testKey } from "../../connectors/__tests__/fake.js";
import { createWordPressAdapter } from "../wordpress.js";
import type { ContractEntry } from "./contract.js";
import { CONTENT_MARKERS as WP_MARKERS, wordpressTransport } from "./wordpress-fixture.js";

/** The Copper Lantern's WordPress: a dedicated user whose application password reads drafts and users. */
const WP_KEY = testKey("wordpress-adapter");
export const WP_USER = "gaugeline-reader";
export const WP_ENV = {
  WORDPRESS_URL: "https://copper-lantern.example",
  WORDPRESS_USER: WP_USER,
  WORDPRESS_APP_PASSWORD: WP_KEY,
};
const wpTransport = () =>
  wordpressTransport(undefined, { app: { user: WP_USER, password: WP_KEY } });

export const wordpressEntry: ContractEntry = {
  id: "wordpress",
  make: ({ fetcher, sleep }) => createWordPressAdapter({ env: WP_ENV, fetcher, sleep }),
  transport: wpTransport,
  key: WP_KEY,
  keyHeader: { value: `Basic ${Buffer.from(`${WP_USER}:${WP_KEY}`).toString("base64")}` },
  secrets: Object.values(WP_MARKERS),
  expected: {
    types: [
      { name: "event", count: 2 },
      { name: "page", count: 3 },
      { name: "post", count: 3 },
    ],
    fields: {
      type: "post",
      counts: { title: 3, excerpt: 2, slug: 3 },
      missing: "subtitle",
    },
    published: {
      options: { types: ["post"], fields: { post: ["title", "excerpt"] } },
      ids: ["11", "12", "13"],
    },
    draftsReachable: true,
  },
  // The first request lists the types and the second reads the pages; the posts are the third.
  rateLimit: { options: { types: ["page", "post"] }, succeedFirst: 2, atLeast: 3 },
  members: {
    transport: wpTransport,
    expected: [
      { emailMasked: "r***@copper-lantern.example", role: "admin" },
      { emailMasked: "d***@freelancer.example", role: "member" },
      { emailMasked: "(address not shown by WordPress)", role: "viewer" },
    ],
    addresses: ["Rosa.Ferrer", "rosa.ferrer", "dev@freelancer"],
  },
};

/** The contract suite's entries for this adapter (collected by pnpm gen:adapters). */
export const contractEntries: readonly ContractEntry[] = [wordpressEntry];
