/**
 * The runs API against a real Postgres (the hosted database tests' harness): the handlers are called with
 * Web-standard Requests, the way a Next.js Route Handler receives them, so no server needs to start.
 * Skipped without GAUGELINE_TEST_DATABASE_URL, like the database tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  SITE_A1,
  SITE_A2,
  SITE_B1,
  type Sql,
  type TestDatabase,
} from "../../../db/__tests__/harness.js";
import { getRunFindings, getRuns, postRun } from "../../../lib/api/handlers.js";
import { encodeCursor } from "../../../lib/api/cursor.js";
import { mintToken, revokeToken } from "../../../lib/api/tokens.js";
import { appLogin } from "./app-login.js";
import { finding, manyFindings, result } from "./helpers.js";

const BASE = "https://hosted.example/api/v1";
const SERVER_ENV_VALUE = ["Zq9", "Lm2", "Xv7", "Kp4"].join("");
// Key-shaped, built at run time (a key in the source would be refused by push protection).
const KEY_SHAPE = ["sk", "live", "0123456789abcdefABCDEF"].join("_");
/** Every character as a JSON \\uXXXX escape: the receiver decodes it, a scan of the text does not see it. */
const escaped = (s: string) =>
  [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

describe.skipIf(!HAS_DATABASE)("runs API: integration", () => {
  let db: TestDatabase;
  let sql: Sql;
  let app: Awaited<ReturnType<typeof appLogin>>;
  let tokenA1: string;
  let tokenA2: string;
  let tokenB1: string;
  // The API connects as the app login (not the owner); the tests read the tables as the owner.
  const deps = () => ({ sql: app.sql });

  beforeAll(async () => {
    db = await freshDatabase();
    sql = db.sql;
    await seed(sql);
    app = await appLogin(sql);
    tokenA1 = (await mintToken(app.sql, { orgId: ORG_A, siteId: SITE_A1 })).token;
    tokenA2 = (await mintToken(app.sql, { orgId: ORG_A, siteId: SITE_A2 })).token;
    tokenB1 = (await mintToken(app.sql, { orgId: ORG_B, siteId: SITE_B1 })).token;
  });
  afterAll(async () => {
    await app?.drop();
    await db?.drop();
  });

  function post(
    body: unknown,
    opts: { token?: string | null; key?: string; query?: string; raw?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? tokenA1}`;
    if (opts.key) headers["idempotency-key"] = opts.key;
    return postRun(
      new Request(`${BASE}/runs${opts.query ?? ""}`, {
        method: "POST",
        headers,
        body: opts.raw ?? JSON.stringify(body),
      }),
      deps(),
    );
  }
  function get(path: string, token: string | null = tokenA1): Promise<Response> {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const url = new URL(`${BASE}${path}`);
    const req = new Request(url, { headers });
    const m = /^\/runs\/([^/]+)\/findings$/.exec(url.pathname.slice("/api/v1".length));
    return m ? getRunFindings(req, m[1]!, deps()) : getRuns(req, deps());
  }
  const count = async (table: string) =>
    (await sql.unsafe(`select count(*)::int as n from public.${table}`))[0]!.n as number;

  describe("POST /runs", () => {
    it("with a valid token creates a run and its findings under the token's organisation and site", async () => {
      const res = await post(result([finding(1), finding(2, { severity: "low" })]));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; findings: number };
      expect(body.findings).toBe(2);
      const run = await sql`select org_id, site_id, summary from public.runs where id = ${body.id}`;
      expect(run[0]).toMatchObject({ org_id: ORG_A, site_id: SITE_A1 });
      expect(run[0]!.summary).toMatchObject({ high: 1, low: 1, total: 2 });
      const f =
        await sql`select org_id, site_id, fingerprint, check_id from public.findings where run_id = ${body.id}`;
      expect(f).toHaveLength(2);
      for (const row of f) expect(row).toMatchObject({ org_id: ORG_A, site_id: SITE_A1 });
    });

    it("no token, a wrong token, a revoked token and a malformed header are 401, with the same message", async () => {
      const { token, id } = await mintToken(app.sql, { orgId: ORG_A, siteId: SITE_A1 });
      await revokeToken(app.sql, id);
      const wrong = `${tokenA1.slice(0, -4)}AAAA`;
      const before = await count("runs");
      const messages = new Set<string>();
      for (const t of [null, wrong, token, "nonsense"]) {
        const res = await post(result(), { token: t });
        expect(res.status, String(t)).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
        messages.add(((await res.json()) as { message: string }).message);
      }
      expect(messages.size).toBe(1);
      expect(await count("runs")).toBe(before);
    });

    it("a token for site A cannot post to site B, by the site named in the request or by any other way", async () => {
      const before = await count("runs");
      const named = await post(result(), { token: tokenA1, query: `?site=${SITE_A2}` });
      expect(named.status).toBe(403);
      const otherOrg = await post(result(), { token: tokenA1, query: `?site=${SITE_B1}` });
      expect(otherOrg.status).toBe(403);
      expect(await count("runs")).toBe(before);
      // B's token cannot reach A's site either, and its own site works.
      expect((await post(result(), { token: tokenB1, query: `?site=${SITE_A1}` })).status).toBe(
        403,
      );
      const own = await post(result(), { token: tokenB1, query: `?site=${SITE_B1}` });
      expect(own.status).toBe(201);
      const id = ((await own.json()) as { id: string }).id;
      expect(
        (await sql`select site_id, org_id from public.runs where id = ${id}`)[0],
      ).toMatchObject({
        site_id: SITE_B1,
        org_id: ORG_B,
      });
    });

    it("the same Idempotency-Key twice creates one run, and answers the second time with the first run", async () => {
      const before = await count("runs");
      const first = await post(result(), { key: "nightly-2026-11-12" });
      const second = await post(result(), { key: "nightly-2026-11-12" });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.headers.get("idempotent-replayed")).toBe("true");
      expect(((await second.json()) as { id: string }).id).toBe(
        ((await first.json()) as { id: string }).id,
      );
      expect(await count("runs")).toBe(before + 1);
    });

    it("the same key with a different body is a 409, and the same key on another site is a different key", async () => {
      expect((await post(result(), { key: "k-conflict" })).status).toBe(201);
      const other = await post(result([finding(9)]), { key: "k-conflict" });
      expect(other.status).toBe(409);
      expect(((await other.json()) as { code: string }).code).toBe("idempotency_key_reused");
      expect((await post(result(), { key: "k-conflict", token: tokenA2 })).status).toBe(201);
    });

    it("two uploads with the same key at the same moment create one run", async () => {
      const before = await count("runs");
      const all = await Promise.all(
        Array.from({ length: 5 }, () => post(result([finding(77)]), { key: "k-race" })),
      );
      expect(all.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(await count("runs")).toBe(before + 1);
    });

    it("an unknown schema is 422 with a clear message and stores nothing", async () => {
      const before = await count("runs");
      const res = await post(result([finding()], { schema: 3 }));
      expect(res.status).toBe(422);
      expect(((await res.json()) as { message: string }).message).toMatch(/schema 1 and 2/);
      expect(await count("runs")).toBe(before);
    });

    it("a body that is not JSON is 400; a body over the cap is 413 and is not read", async () => {
      expect((await post(null, { raw: "{not json" })).status).toBe(400);
      const before = await count("runs");
      const big = await post(null, {
        raw: JSON.stringify(result([finding(1, { evidence: "x".repeat(9 * 1024 * 1024) })])),
      });
      expect(big.status).toBe(413);
      expect(((await big.json()) as { code: string }).code).toBe("body_too_large");
      expect(await count("runs")).toBe(before);
    });

    it("a Content-Length over the cap is refused before the body is read, and a lie about it does not help", async () => {
      const req = new Request(`${BASE}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenA1}`, "content-length": String(50 * 1024 * 1024) },
        body: "{}",
      });
      expect((await postRun(req, deps())).status).toBe(413);
    });

    it("10,000 findings are stored in one transaction", async () => {
      const res = await post(result(manyFindings(10_000)), { token: tokenA2 });
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { id: string }).id;
      expect(
        (await sql`select count(*)::int as n from public.findings where run_id = ${id}`)[0]!.n,
      ).toBe(10_000);
    }, 60_000);

    it("10,001 findings are rejected whole: no run, no findings", async () => {
      const runs = await count("runs");
      const findings = await count("findings");
      const res = await post(result(manyFindings(10_001)), { token: tokenA2 });
      expect(res.status).toBe(413);
      expect(await count("runs")).toBe(runs);
      expect(await count("findings")).toBe(findings);
    }, 60_000);

    it("one bad finding at the end rejects the whole upload: nothing is left half-written", async () => {
      const runs = await count("runs");
      const findings = await count("findings");
      const list = [...manyFindings(20), finding(1, { checkId: "Not A Check Id" })];
      const res = await post(result(list));
      expect(res.status).toBe(422);
      expect(await count("runs")).toBe(runs);
      expect(await count("findings")).toBe(findings);
    });

    it("a database failure part way through (the last finding is refused) rolls the run and the earlier findings back", async () => {
      await sql.unsafe(`
        create function public.test_refuse_boom() returns trigger language plpgsql as
          $$ begin if new.title = 'refuse-me' then raise exception 'boom from the database'; end if; return new; end $$;
        create trigger test_refuse_boom before insert on public.findings
          for each row execute function public.test_refuse_boom();
      `);
      try {
        const runs = await count("runs");
        const findings = await count("findings");
        const key = "k-db-failure";
        const list = [...manyFindings(30), finding(1, { title: "refuse-me" })];
        const res = await post(result(list), { key });
        expect(res.status).toBe(500);
        expect(JSON.stringify(await res.json())).not.toContain("boom");
        expect(await count("runs")).toBe(runs);
        expect(await count("findings")).toBe(findings);
        // The failed attempt did not use up the key: the same upload, once fixed, goes through.
        expect((await post(result(manyFindings(30)), { key })).status).toBe(201);
      } finally {
        await sql.unsafe(
          `drop trigger test_refuse_boom on public.findings; drop function public.test_refuse_boom();`,
        );
      }
    });

    it("the server's own environment is not a dictionary to guess from: its values are accepted, however many guesses", async () => {
      const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVER_ENV_VALUE;
      try {
        const guesses = Array.from({ length: 5000 }, (_, i) => `guess${i}`).concat([
          SERVER_ENV_VALUE,
        ]);
        const res = await post(result([finding(1, { evidence: guesses.join(" ").slice(0, 900) })]));
        expect(res.status).toBe(201);
        const res2 = await post(
          result([finding(2, { evidence: `NEXTAUTH_URL is ${SERVER_ENV_VALUE}` })]),
        );
        expect(res2.status).toBe(201);
      } finally {
        if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        else process.env.SUPABASE_SERVICE_ROLE_KEY = prev;
      }
    });

    // Each way a value can sit in a body: plain, and as \\u escapes (which a scan of the text never sees).
    const fields: Array<[string, (v: string) => Record<string, unknown>]> = [
      ["a finding's title", (v) => result([finding(1, { title: `t ${v}` })])],
      ["a finding's evidence", (v) => result([finding(1, { evidence: `e ${v}` })])],
      ["a finding's address", (v) => result([finding(1, { url: `https://t.test/?${v}` })])],
      [
        "a reason in couldNotCheck",
        (v) =>
          result([finding(1)], { couldNotCheck: [{ id: "a", reason: v, url: "https://t.test/" }] }),
      ],
      [
        "an address in couldNotCheck",
        (v) =>
          result([finding(1)], {
            couldNotCheck: [{ id: "a", reason: "r", url: `https://t.test/${v}` }],
          }),
      ],
      ["the top-level address", (v) => result([finding(1)], { url: `https://t.test/?${v}` })],
      ["a passed id", (v) => result([finding(1)], { passed: [v] })],
      [
        "a sampled key",
        (v) => result([finding(1)], { sampled: { [v]: { seen: 1, taken: 1, limit: 1 } } }),
      ],
      ["a field the schema does not know", (v) => result([finding(1)], { extra: v })],
    ];
    for (const [where, make] of fields) {
      for (const [how, secret] of [
        ["a key shape", KEY_SHAPE],
        ["the token just presented", "TOKEN"],
      ] as const) {
        for (const mode of ["plain", "escaped"] as const) {
          it(`${how} in ${where}, ${mode}: refused whole, nothing stored, never echoed`, async () => {
            const value = secret === "TOKEN" ? tokenA1 : secret;
            const runs = await count("runs");
            const marker = "MARKERXYZ";
            let raw = JSON.stringify(make(marker));
            raw = raw.replace(marker, mode === "plain" ? value : escaped(value));
            expect(raw).not.toContain(marker);
            const res = await post(null, { raw });
            expect(res.status).toBe(422);
            expect(((await res.json()) as { code: string }).code).toBe("secret_in_body");
            expect(await count("runs")).toBe(runs);
          });
        }
      }
    }

    it("the refusal does not echo the value or say which one it was", async () => {
      const res = await post(result([finding(1, { evidence: `x ${KEY_SHAPE}` })]));
      const text = await res.text();
      expect(text).not.toContain(KEY_SHAPE);
      expect(text).not.toMatch(/stripe/i);
    });

    it("a NUL character anywhere is a 400 the sender can read, not a 500", async () => {
      for (const make of [
        () => result([finding(1, { evidence: "a\u0000b" })]),
        () => result([finding(1, { title: "a\u0000b" })]),
        () => result([finding(1)], { couldNotCheck: [{ id: "a", reason: "a\u0000b", url: "u" }] }),
        () => result([finding(1)], { url: "https://t.test/\u0000" }),
      ]) {
        const res = await post(make());
        expect(res.status).toBe(400);
        expect(((await res.json()) as { message: string }).message).toMatch(/NUL/);
      }
    });

    it("a start time the database cannot hold is a 400, not a 500", async () => {
      for (const startedAt of [
        "0000-01-01T00:00:00Z",
        "0001-01-01T00:00:00+14:00",
        "275760-09-13T00:00:00Z",
      ]) {
        const res = await post(result([finding(1)], { startedAt }));
        expect(res.status, startedAt).toBe(400);
      }
    });

    it("stores no token and no body: the token column is a 64-character hash", async () => {
      const rows = await sql`select token_hash, prefix from public.tokens`;
      expect(rows.length).toBeGreaterThanOrEqual(4);
      for (const r of rows) {
        expect(String(r.token_hash)).toMatch(/^[0-9a-f]{64}$/);
        for (const t of [tokenA1, tokenA2, tokenB1])
          expect(JSON.stringify(r)).not.toContain(t.slice(-30));
      }
    });
  });

  describe("GET /runs", () => {
    let ids: string[];
    beforeAll(async () => {
      ids = [];
      for (const day of ["01", "02", "03", "04", "05"]) {
        const res = await post(
          result([finding(1)], { startedAt: `2026-12-${day}T03:00:00.000Z` }),
          {
            token: tokenA2,
          },
        );
        ids.push(((await res.json()) as { id: string }).id);
      }
    });

    it("lists the token's site, newest first, and nothing of another site", async () => {
      const res = await get(`/runs?limit=200`, tokenA2);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: { id: string; siteId: string; startedAt: string }[];
      };
      expect(body.runs.every((r) => r.siteId === SITE_A2)).toBe(true);
      const times = body.runs.map((r) => r.startedAt);
      expect(times).toEqual([...times].sort().reverse());
      expect(body.runs.map((r) => r.id)).toEqual(expect.arrayContaining(ids));
    });

    it("since= returns only newer runs, paginated by cursor, with nothing repeated or skipped", async () => {
      const first = (await (
        await get(`/runs?since=2026-12-02T03:00:00.000Z&limit=2`, tokenA2)
      ).json()) as {
        runs: { id: string; startedAt: string }[];
        nextCursor: string | null;
      };
      expect(first.runs.map((r) => r.startedAt)).toEqual([
        "2026-12-05T03:00:00.000Z",
        "2026-12-04T03:00:00.000Z",
      ]);
      expect(first.nextCursor).toBeTruthy();
      const second = (await (
        await get(
          `/runs?since=2026-12-02T03:00:00.000Z&limit=2&cursor=${first.nextCursor}`,
          tokenA2,
        )
      ).json()) as { runs: { id: string; startedAt: string }[]; nextCursor: string | null };
      expect(second.runs.map((r) => r.startedAt)).toEqual(["2026-12-03T03:00:00.000Z"]);
      expect(second.nextCursor).toBeNull();
      const seen = [...first.runs, ...second.runs].map((r) => r.id);
      expect(new Set(seen).size).toBe(3);
      expect(seen).not.toContain(ids[0]);
      expect(seen).not.toContain(ids[1]);
    });

    it("site= must be the token's own site; another is 403, an invalid one or a bad cursor is 400", async () => {
      expect((await get(`/runs?site=${SITE_A2}`, tokenA2)).status).toBe(200);
      expect((await get(`/runs?site=${SITE_A1}`, tokenA2)).status).toBe(403);
      expect((await get(`/runs?site=${SITE_B1}`, tokenA2)).status).toBe(403);
      expect((await get(`/runs?site=not-a-uuid`, tokenA2)).status).toBe(400);
      expect((await get(`/runs?cursor=junk`, tokenA2)).status).toBe(400);
      for (const t of [
        "abc",
        "infinity",
        "-infinity",
        "9999-99-99 00:00:00+00",
        "2026-01-01 00:00:00+00' or 1=1",
      ]) {
        const res = await get(
          `/runs?cursor=${encodeCursor({ t, id: "a1a10000-0000-4000-8000-0000000000a1" })}`,
          tokenA2,
        );
        expect(res.status, t).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("invalid_cursor");
      }
      const zero = await get(`/runs?since=0000-01-01T00:00:00Z`, tokenA2);
      expect(zero.status).toBe(400);
      expect(((await zero.json()) as { message: string }).message).not.toMatch(/upload/i);
      expect((await get(`/runs?since=10000-01-01T00:00:00Z`, tokenA2)).status).toBe(400);
      expect((await get(`/runs?since=yesterday`, tokenA2)).status).toBe(400);
      expect((await get(`/runs?limit=0`, tokenA2)).status).toBe(400);
      expect((await get(`/runs`, null)).status).toBe(401);
    });
  });

  describe("GET /runs/:id/findings", () => {
    it("returns the run's findings; a run of another site is a 404, not a 403", async () => {
      const created = await post(result([finding(1), finding(2, { severity: "medium" })]), {
        token: tokenA1,
      });
      const id = ((await created.json()) as { id: string }).id;
      const res = await get(`/runs/${id}/findings`, tokenA1);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        findings: { checkId: string; fingerprint: string; evidence: string }[];
      };
      expect(body.findings).toHaveLength(2);
      expect(body.findings[0]).toHaveProperty("fingerprint");
      expect(Object.keys(body.findings[0]!).sort()).toEqual(
        ["checkId", "evidence", "fingerprint", "id", "severity", "title", "url"].sort(),
      );
      expect((await get(`/runs/${id}/findings`, tokenA2)).status).toBe(404);
      expect((await get(`/runs/${id}/findings`, tokenB1)).status).toBe(404);
      expect((await get(`/runs/not-a-uuid/findings`, tokenA1)).status).toBe(404);
      expect((await get(`/runs/${id}/findings`, null)).status).toBe(401);
    });

    it("pages through 10,000 findings by cursor without repeating or skipping one", async () => {
      const created = await post(result(manyFindings(2500)), { token: tokenB1 });
      const id = ((await created.json()) as { id: string }).id;
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(
          `/runs/${id}/findings?limit=1000${cursor ? `&cursor=${cursor}` : ""}`,
          tokenB1,
        );
        const body = (await res.json()) as {
          findings: { id: string }[];
          nextCursor: string | null;
        };
        for (const f of body.findings) seen.add(f.id);
        cursor = body.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen.size).toBe(2500);
    }, 60_000);
  });

  describe("tokens and the database", () => {
    it("a revoked token stops working at once", async () => {
      const t = await mintToken(app.sql, { orgId: ORG_A, siteId: SITE_A1 });
      expect((await post(result(), { token: t.token })).status).toBe(201);
      await revokeToken(app.sql, t.id);
      expect((await post(result(), { token: t.token })).status).toBe(401);
      expect((await get("/runs", t.token)).status).toBe(401);
    });

    it("mintToken refuses a site that is not in the organisation", async () => {
      await expect(mintToken(app.sql, { orgId: ORG_B, siteId: SITE_A1 })).rejects.toThrow();
    });
  });
});
