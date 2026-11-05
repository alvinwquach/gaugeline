/**
 * Re-record cassettes/example-fixture.json against the local "clean" fixture site (not a real
 * provider). Run: GAUGELINE_RECORD=1 pnpm --filter @gaugeline/testkit record:example
 */
import { createFetcher, createNetworkTransport } from "@gaugeline/core";
import { withFixture } from "@gaugeline/fixtures";
import { useCassette } from "../src/cassette.js";

await withFixture("clean", async (site) => {
  const port = new URL(site.origin).port;
  const transport = useCassette("example-fixture", {
    mode: "record",
    transport: createNetworkTransport({ hosts: { "provider.test": `127.0.0.1:${port}` } }),
    now: () => new Date("2026-11-05T00:00:00.000Z"),
  });
  const fetcher = createFetcher({ transport, concurrency: 1 });
  await fetcher.get("http://provider.test/");
  await fetcher.get("http://provider.test/robots.txt");
  await fetcher.get("http://provider.test/menu", { method: "HEAD" });
});
process.stdout.write("Recorded packages/testkit/cassettes/example-fixture.json\n");
