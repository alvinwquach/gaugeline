/**
 * Make packages/app-server/demo/results.json: the example runs `gaugeline open --demo` starts with.
 *
 * Three of the invented fixture sites (a pottery studio, a wine bar and a tavern) are served on
 * 127.0.0.1 and checked by the app's own runner, with a fixed clock and a stand-in for the one
 * outside host the wine bar names. Every address is then rewritten to a reserved .example name, the
 * response times are replaced with fixed invented ones, and the file is written the way Prettier
 * would. Nothing leaves this computer.
 *
 *   pnpm demo:build           write the file
 *
 * Run it again, and commit the result, whenever a check's wording changes or the result schema
 * moves on. A test (report-demo.test.ts) fails when the checked-in file no longer validates against
 * the schema, and says to run this. The file is not compared with a fresh build in CI: the wording
 * of a JSON parser's error differs between Node versions.
 */
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
  createNetworkTransport,
  RESULT_SCHEMA_VERSION,
  type Transport,
  type TransportResponse,
} from "@gaugeline/core";
import {
  createRunner,
  createStore,
  DEMO_FILE_VERSION,
  parseDemo,
  type Run,
} from "../packages/app-server/src/index.ts";
import { PLANTED, startFixture } from "../packages/fixtures/src/index.ts";

const FILE = fileURLToPath(new URL("../packages/app-server/demo/results.json", import.meta.url));

/** The runs, oldest first (the last one is the one the app opens). */
const SITES = [
  { fixture: "venue", host: "tavern.example", at: "2026-11-05T20:00:00Z" },
  { fixture: "leaks-access", host: "wine-bar.example", at: "2026-11-05T20:05:00Z" },
  { fixture: "pages-search", host: "shop.example", at: "2026-11-05T20:10:00Z" },
] as const;

/** What the wine bar's Sanity project answers: the dataset is readable by anyone. Invented. */
const SANITY = {
  count: 142,
  types: ["event", "menu", "page", "post", "venue", "wineList"],
};

const json = (status: number, body: unknown): TransportResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: Readable.from([Buffer.from(JSON.stringify(body))]),
});

async function one(site: (typeof SITES)[number]): Promise<unknown> {
  const fixture = await startFixture(site.fixture);
  try {
    const local = createNetworkTransport({ hosts: fixture.hosts, allowPrivate: true });
    const transport: Transport = (url, req) =>
      url.hostname.endsWith(".api.sanity.io")
        ? Promise.resolve(json(200, { result: SANITY }))
        : local(url, req);
    const store = createStore();
    const runner = createRunner(store, { fetcher: { transport }, now: () => new Date(site.at) });
    const { run, finished } = runner.start(fixture.origin);
    await finished;
    return rewrite(run, fixture.origin, site.host);
  } finally {
    await fixture.close();
  }
}

/** The run as the demo file holds it, with the local address replaced everywhere it appears. */
function rewrite(run: Run, origin: string, host: string): unknown {
  if (run.state !== "done" || !run.result || !run.checked || !run.report)
    throw new Error(`${origin} did not finish: ${run.reason ?? run.state}`);
  const checked = {
    ...run.checked,
    // Response times are the one thing that differs from run to run: replaced with invented ones.
    ...(run.checked.requests
      ? { requests: run.checked.requests.map((r, i) => ({ ...r, ms: 18 + ((i * 29) % 83) })) }
      : {}),
  };
  const text = JSON.stringify({
    startedAt: run.startedAt,
    result: run.result,
    checked,
    reportFailed: run.report.result.failed.map((f) => f.id),
  });
  const out = text.replaceAll(origin, `https://${host}`);
  return JSON.parse(out) as unknown;
}

/** The ways a local address or a planted key could still be in the file. Any is a bug here. */
function assertClean(text: string): void {
  for (const bad of ["127.0.0.1", "localhost", ...Object.values(PLANTED)])
    if (text.includes(bad)) throw new Error("the demo file still holds a local address or a key");
}

async function buildDemoText(): Promise<string> {
  const runs: unknown[] = [];
  for (const site of SITES) runs.push(await one(site));
  const text = JSON.stringify({
    demo: DEMO_FILE_VERSION,
    resultSchema: RESULT_SCHEMA_VERSION,
    runs,
  });
  assertClean(text);
  const config = (await resolveConfig(FILE)) ?? {};
  const pretty = await format(text, { ...config, parser: "json" });
  parseDemo(pretty);
  return pretty;
}

const text = await buildDemoText();
writeFileSync(FILE, text);
process.stdout.write(`demo:build: wrote ${FILE} (${Buffer.byteLength(text)} bytes)\n`);
