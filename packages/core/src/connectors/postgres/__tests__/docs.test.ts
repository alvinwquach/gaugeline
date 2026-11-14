import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../../fetcher.js";
import { DEFAULT_DENIED_FUNCTIONS } from "../classify.js";
import { sourcesConfigSchema } from "../config.js";
import { readDatabases } from "../read.js";
import { startFakePostgres, type FakePostgres } from "./fake-postgres.js";
import { localUrl } from "./helpers.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../../docs/connectors/postgres.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (lang: string, title: string): string | undefined =>
  new RegExp("```" + lang + ' title="?' + title + '"?\\n([\\s\\S]*?)\\n```').exec(page)?.[1];

const servers: FakePostgres[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** A key-shaped anon token built at run time. */
const anonKey = (): string =>
  [{ alg: "HS256" }, { role: "anon" }, "c2ln"]
    .map((p) => (typeof p === "string" ? p : Buffer.from(JSON.stringify(p)).toString("base64url")))
    .join(".");

/** Run the page's own config against a stand-in database that holds the BUCK Tavern's invented rows. */
async function pageRun(): Promise<Awaited<ReturnType<typeof readDatabases>>> {
  const server = await startFakePostgres({
    onQuery: (sql) => {
      if (sql.startsWith("select name from menu_items where is_86"))
        return { columns: [{ name: "name" }], rows: [["Negroni"], ["Paloma"]] };
      if (sql.startsWith("select name, party_size from bookings"))
        return {
          columns: [{ name: "name" }, { name: "party_size", oid: 23 }],
          rows: [
            ["Okafor party", "12"],
            ["Ng birthday", "9"],
          ],
        };
      if (sql.startsWith("select name, price_cents from menu_items"))
        return {
          columns: [{ name: "name" }, { name: "price_cents", oid: 23 }],
          rows: [
            ["Mezcal Mule", "1250"],
            ["Old Fashioned", "1500"],
          ],
        };
      if (sql.startsWith("select current_user"))
        return {
          columns: [{ name: "role" }, { name: "strong", oid: 16 }],
          rows: [["gaugeline_reader", "f"]],
        };
      return undefined;
    },
  });
  servers.push(server);
  const config = sourcesConfigSchema.parse(
    JSON.parse(block("json", "gaugeline.sources.json") ?? "null"),
  );
  return readDatabases(
    {
      config,
      env: {
        BUCK_SUPABASE_DB_URL: localUrl(
          server.port,
          "gaugeline_reader",
          ["bar", "pw", "0123456789"].join("-"),
        ),
        BUCK_SUPABASE_ANON_KEY: anonKey(),
      },
    },
    createFetcher({}),
  );
}

describe("docs/connectors/postgres.md: the BUCK Tavern example", () => {
  it("the config block is a valid gaugeline.sources.json", () => {
    const parsed = sourcesConfigSchema.safeParse(
      JSON.parse(block("json", "gaugeline.sources.json") ?? "null"),
    );
    expect(parsed.success).toBe(true);
  });

  it("the Queries block is what the connector returns for it", async () => {
    const read = await pageRun();
    // Prettier lays JSON out its own way, so the blocks are compared as data.
    expect(JSON.parse(block("json", "Queries") ?? "null")).toEqual(
      JSON.parse(JSON.stringify(read.queries)),
    );
    expect(read.notices).toEqual([]);
  });

  it("the Facts block is the facts the prices query becomes", async () => {
    const read = await pageRun();
    expect(JSON.parse(block("json", "Facts") ?? "null")).toEqual(
      JSON.parse(JSON.stringify(read.facts)),
    );
  });
});

describe("docs/connectors/postgres.md: the safeguards it describes are the ones in the code", () => {
  it("lists every function the classifier refuses by default", () => {
    for (const entry of DEFAULT_DENIED_FUNCTIONS) expect(page, entry).toContain(`\`${entry}\``);
  });

  it("states the row cap, the default timeout and the longest statement the code uses", () => {
    expect(page).toContain("5,000 rows");
    expect(page).toContain("5 seconds");
    expect(page).toContain("20,000 characters");
  });
});
