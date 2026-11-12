/**
 * End to end: the real CLI uploads a run to the real handlers over HTTP, which store it in a real Postgres.
 * The CLI's own tests (packages/cli) use a stand-in receiver; this one proves the two halves agree.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../../../../packages/cli/src/main.js";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  seed,
  SITE_A1,
  SITE_A2,
  type TestDatabase,
} from "../../../db/__tests__/harness.js";
import { getRunFindings, getRuns, postRun, type ApiDeps } from "../../../lib/api/handlers.js";
import { appLogin } from "./app-login.js";
import { mintToken } from "../../../lib/api/tokens.js";

describe.skipIf(!HAS_DATABASE)("gaugeline --upload to the runs API: e2e", () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof appLogin>>;
  let server: Server;
  let address: string;
  let token: string;
  let tokenOther: string;
  const secret = ["sk", "live", "0123456789abcdefABCDEF"].join("_");

  beforeAll(async () => {
    db = await freshDatabase();
    await seed(db.sql);
    app = await appLogin(db.sql);
    token = (await mintToken(app.sql, { orgId: ORG_A, siteId: SITE_A1 })).token;
    tokenOther = (await mintToken(app.sql, { orgId: ORG_A, siteId: SITE_A2 })).token;
    const deps: ApiDeps = { sql: app.sql };
    // A Node server that hands each request to the handlers as a Web Request, as Next.js does.
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const init: RequestInit = {
          method: req.method ?? "GET",
          headers: req.headers as Record<string, string>,
          ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        };
        const request = new Request(url, init);
        const m = /^\/api\/v1\/runs\/([^/]+)\/findings$/.exec(url.pathname);
        const done =
          url.pathname === "/api/v1/runs"
            ? req.method === "POST"
              ? postRun(request, deps)
              : getRuns(request, deps)
            : m
              ? getRunFindings(request, m[1]!, deps)
              : Promise.resolve(new Response("{}", { status: 404 }));
        void done.then(async (r) => {
          res.writeHead(r.status, Object.fromEntries(r.headers));
          res.end(Buffer.from(await r.arrayBuffer()));
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await app?.drop();
    await db?.drop();
  });

  async function cli(env: Record<string, string>, flags: string[] = []) {
    const site = await startFixture("quick-start");
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-upload-e2e-"));
    const err: string[] = [];
    try {
      const code = await main(
        [site.origin, "--allow-private", "--no-open", "--upload", ...flags],
        {
          stdout: { write: () => undefined },
          stderr: { write: (s: string) => err.push(s) },
          env: { NO_COLOR: "1", GAUGELINE_UPLOAD_URL: address, ...env },
        },
        { cwd },
      );
      return { code, err: err.join(""), origin: site.origin };
    } finally {
      await site.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
  const asToken = (t: string, path: string) =>
    fetch(`${address}${path}`, { headers: { authorization: `Bearer ${t}` } });

  it("a run uploaded from the CLI can be read back, with the findings the CLI printed", async () => {
    const r = await cli({ GAUGELINE_TOKEN: token });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/Uploaded 1 finding to 127\.0\.0\.1\.\n/);
    const list = (await (await asToken(token, "/runs")).json()) as {
      runs: { id: string; summary: { url: string; total: number } }[];
    };
    const mine = list.runs.find((x) => x.summary.url?.startsWith(r.origin));
    expect(mine?.summary.total).toBe(1);
    const found = (await (await asToken(token, `/runs/${mine!.id}/findings`)).json()) as {
      findings: { checkId: string; severity: string }[];
    };
    expect(found.findings).toHaveLength(1);
    expect(found.findings[0]!.severity).toBe("high");
    // Another site's token sees none of it.
    const other = (await (await asToken(tokenOther, "/runs")).json()) as { runs: unknown[] };
    expect(other.runs).toHaveLength(0);
    expect((await asToken(tokenOther, `/runs/${mine!.id}/findings`)).status).toBe(404);
  }, 30_000);

  it("a wrong token: one plain line, the exit code the check would have had, nothing stored", async () => {
    const before = (await db.sql`select count(*)::int as n from public.runs`)[0]!.n as number;
    const r = await cli({ GAUGELINE_TOKEN: `${token.slice(0, -4)}AAAA` }, ["--ci"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "Could not upload: 127.0.0.1 answered 401: Send the site's upload token",
    );
    expect((await db.sql`select count(*)::int as n from public.runs`)[0]!.n).toBe(before);
  }, 30_000);

  it("a result with a key's value in it is stopped by the CLI, and by the server, which refuses a key shape if one gets there anyway", async () => {
    const before = (await db.sql`select count(*)::int as n from public.runs`)[0]!.n as number;
    const r = await cli({ GAUGELINE_TOKEN: token, MY_SERVICE_API_KEY: "http://127.0.0.1:" });
    expect(r.err).toContain("the result contains the value of MY_SERVICE_API_KEY");
    // The same body sent by hand, with a key shape in it: refused whole.
    const res = await fetch(`${address}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema: 2,
        url: "https://tidewater-bar.test/",
        startedAt: "2026-11-12T03:00:00.000Z",
        findings: [
          {
            checkId: "broken-links",
            severity: "low",
            title: "x",
            evidence: `printed ${secret}`,
            url: "https://tidewater-bar.test/",
          },
        ],
        passed: [],
        failed: [],
        couldNotCheck: [],
        sampled: {},
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain(secret);
    expect((await db.sql`select count(*)::int as n from public.runs`)[0]!.n).toBe(before);
  }, 30_000);
});
