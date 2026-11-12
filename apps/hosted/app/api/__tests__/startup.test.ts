/**
 * The API refuses to start on a database login that skips row-level security (the owner, a superuser), and
 * its own code never reaches for a way back to the login role.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionSkipsRls } from "../../../db/audit.js";
import {
  freshDatabase,
  HAS_DATABASE,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "../../../db/__tests__/harness.js";
import { withService } from "../../../lib/api/db.js";
import { APP_URL_ENV, openDatabase } from "../../../lib/api/startup.js";
import { appLogin } from "./app-login.js";

describe.skipIf(!HAS_DATABASE)("start-up: the database login", () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof appLogin>>;
  let ownerUrl: string;
  beforeAll(async () => {
    db = await freshDatabase();
    app = await appLogin(db.sql);
    const dbName = (await db.sql`select current_database() as n`)[0]!.n as string;
    const u = new URL(TEST_DATABASE_URL);
    u.pathname = `/${dbName}`;
    ownerUrl = u.href;
  });
  afterAll(async () => {
    await app?.drop();
    await db?.drop();
  });

  it("a connection as the owner is refused at start-up, and the message points at the migration address", async () => {
    await expect(openDatabase({ [APP_URL_ENV]: ownerUrl })).rejects.toThrow(
      /Refusing to start.*skips row-level security.*GAUGELINE_MIGRATE_URL/s,
    );
  });

  it("the app login starts: it is not the owner, skips nothing, and can work as service_role only", async () => {
    const sql = await openDatabase({ [APP_URL_ENV]: app.url });
    try {
      expect((await sql`select current_user as u`)[0]!.u).toBe(app.role);
      expect(await connectionSkipsRls(sql)).toBe(false);
      // Straight on the login it can read nothing of the tables (no grants of its own)...
      await expect(sql`select count(*) from public.tokens`).rejects.toThrow(/permission denied/);
      // ...and inside the unit of work it is service_role.
      expect(await withService(sql, async (tx) => (await tx`select current_user as u`)[0]!.u)).toBe(
        "service_role",
      );
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("a missing address is a clear error, and the owner's address is not read from the app's variable name by accident", async () => {
    await expect(openDatabase({})).rejects.toThrow(/GAUGELINE_DATABASE_URL is not set/);
    await expect(openDatabase({ GAUGELINE_MIGRATE_URL: ownerUrl })).rejects.toThrow(/not set/);
  });

  it("the app login cannot become the owner or anyone else it is not a member of", async () => {
    const sql = await openDatabase({ [APP_URL_ENV]: app.url });
    try {
      for (const role of ["postgres", "anon"]) {
        await expect(
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
          }),
        ).rejects.toThrow(/permission denied to set role/);
      }
      // Whatever it does inside a transaction, after "reset role" it is the login again, which skips nothing.
      await sql.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        await tx.unsafe("reset role");
        expect(await connectionSkipsRls(tx)).toBe(false);
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});

describe("the API's own code", () => {
  const libDir = fileURLToPath(new URL("../../../lib/api/", import.meta.url));
  const files = readdirSync(libDir).filter((f) => f.endsWith(".ts"));

  it("never issues reset role, set session authorization or a session-wide set role", () => {
    for (const f of files) {
      const text = readFileSync(join(libDir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/reset\s+role/i);
      expect(text, f).not.toMatch(/session\s+authorization/i);
      expect(text, f).not.toMatch(/set\s+(?!local\s)role/i);
    }
  });

  it("only db.ts switches role, and only with `set local role`", () => {
    const using = files.filter((f) =>
      /set\s+local\s+role/i.test(
        readFileSync(join(libDir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
      ),
    );
    expect(using).toEqual(["db.ts"]);
  });

  it("never reads the owner's address: GAUGELINE_MIGRATE_URL belongs to db/migrate.ts alone", () => {
    for (const f of files)
      expect(readFileSync(join(libDir, f), "utf8"), f).not.toMatch(
        /env(\.|\[\s*["'`])GAUGELINE_MIGRATE_URL/,
      );
  });
});
