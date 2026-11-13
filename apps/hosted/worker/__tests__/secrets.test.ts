/**
 * The worker's SecretStore (V-01): the same contract for the in-memory store (unit) and the Vault store
 * (integration, against the Vault stand-in), plus what never leaks: no value in list, errors or logs.
 */
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  type TestDatabase,
} from "../../db/__tests__/harness.js";
import {
  memorySecretStore,
  SecretError,
  type SecretStore,
  secretStoreFrom,
  vaultSecretStore,
} from "../secrets.js";

// Invented values (rule 12), built at run time so no key-shaped string sits in the source.
const HOOK = ["https://hooks.slack.test/services", "T0NORTHGATE", "B0JUNIPER", "marker-hook"].join(
  "/",
);
const SIG = ["sig", "juniper", "marker-sig"].join("-");

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    expect(e).toBeInstanceOf(SecretError);
    const text = `${inspect(e, { depth: 5, showHidden: true })} ${JSON.stringify(e)}`;
    expect(text).not.toMatch(/marker-/);
    return (e as SecretError).code;
  }
}

function contract(name: string, make: () => SecretStore, ready: () => boolean = () => true) {
  describe.skipIf(!ready())(`${name}: the SecretStore contract`, () => {
    it("puts, gets, rotates and deletes per organisation", async () => {
      const s = make();
      expect(await s.put(ORG_A, "slack-juniper", "webhook_url", HOOK)).toBe("created");
      expect(await s.get(ORG_A, "slack-juniper")).toBe(HOOK);
      expect(await s.get(ORG_B, "slack-juniper")).toBeNull();
      expect(await s.put(ORG_A, "slack-juniper", "webhook_url", `${HOOK}-2`)).toBe("rotated");
      expect(await s.get(ORG_A, "slack-juniper")).toBe(`${HOOK}-2`);
      expect(await s.delete(ORG_A, "slack-juniper")).toBe(true);
      expect(await s.delete(ORG_A, "slack-juniper")).toBe(false);
      expect(await s.get(ORG_A, "slack-juniper")).toBeNull();
    });

    it("a get for a missing name is a clean not-found (null)", async () => {
      expect(await make().get(ORG_A, "never-set")).toBeNull();
    });

    it("list returns names, kinds and dates for one organisation, never a value", async () => {
      const s = make();
      await s.put(ORG_A, "discord-juniper", "signing_secret", SIG);
      await s.put(ORG_B, "teams-maple", "signing_secret", "sig-maple-marker-b");
      const list = await s.list(ORG_A);
      expect(list.map((m) => [m.name, m.kind])).toEqual([["discord-juniper", "signing_secret"]]);
      expect(Object.keys(list[0]!).sort()).toEqual(["createdAt", "kind", "name", "rotatedAt"]);
      expect(JSON.stringify(list)).not.toMatch(/marker-/);
      await s.delete(ORG_A, "discord-juniper");
      await s.delete(ORG_B, "teams-maple");
    });

    it("refuses bad names, kinds and values with a code, never echoing the value", async () => {
      const s = make();
      expect(await codeOf(s.put(ORG_A, "Bad Name", "webhook_url", "marker-1"))).toBe(
        "invalid-name",
      );
      expect(await codeOf(s.put(ORG_A, "x".repeat(64), "webhook_url", "marker-2"))).toBe(
        "invalid-name",
      );
      expect(await codeOf(s.put(ORG_A, "ok", "password" as never, "marker-3"))).toBe(
        "invalid-kind",
      );
      expect(await codeOf(s.put(ORG_A, "ok", "webhook_url", ""))).toBe("invalid-value");
      expect(await codeOf(s.put(ORG_A, "ok", "webhook_url", `marker-4${"é".repeat(2048)}`))).toBe(
        "invalid-value",
      );
      expect(await codeOf(s.put("not-a-uuid", "ok", "webhook_url", "marker-5"))).toBe(
        "invalid-org",
      );
      expect(await codeOf(s.get(ORG_A, "../etc"))).toBe("invalid-name");
      await s.put(ORG_A, "kind-fixed", "webhook_url", "https://hooks.slack.test/k");
      expect(await codeOf(s.put(ORG_A, "kind-fixed", "signing_secret", "marker-6"))).toBe(
        "kind-mismatch",
      );
      await s.delete(ORG_A, "kind-fixed");
    });
  });
}

contract("memory", () => memorySecretStore());

describe.skipIf(!HAS_DATABASE)("vault store", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await freshDatabase();
    await seed(db.sql);
  });
  afterAll(async () => {
    await db?.drop();
  });

  contract("vault", () => vaultSecretStore(db.sql));

  it("a database failure becomes a SecretError without the value or the query's parameters", async () => {
    const s = vaultSecretStore(db.sql);
    // An organisation that does not exist: the database refuses, and the error must not carry the value.
    expect(
      await codeOf(s.put("0c000000-0000-4000-8000-00000000000c", "ok", "webhook_url", "marker-db")),
    ).toBe("invalid-org");
  });

  it("records each put and delete in the audit log", async () => {
    const s = vaultSecretStore(db.sql);
    await s.put(ORG_A, "role-check", "webhook_url", "https://hooks.slack.test/r");
    const ev =
      await db.sql`select count(*)::int as n from private.secret_events where name = 'role-check'`;
    expect(ev[0]!.n).toBe(1);
    await s.delete(ORG_A, "role-check");
    const after =
      await db.sql`select action from private.secret_events where name = 'role-check' order by id`;
    expect(after.map((r) => r.action)).toEqual(["created", "deleted"]);
  });
});

describe("secretStoreFrom (configuration)", () => {
  it("picks memory only outside production, and refuses an unknown or missing store", () => {
    expect(secretStoreFrom({ GAUGELINE_SECRET_STORE: "memory", NODE_ENV: "test" })).toBeDefined();
    expect(() =>
      secretStoreFrom({ GAUGELINE_SECRET_STORE: "memory", NODE_ENV: "production" }),
    ).toThrow(/memory/);
    expect(() => secretStoreFrom({ GAUGELINE_SECRET_STORE: "file" })).toThrow(
      /GAUGELINE_SECRET_STORE/,
    );
    expect(() => secretStoreFrom({})).toThrow(/GAUGELINE_SECRET_STORE/);
    expect(() => secretStoreFrom({ GAUGELINE_SECRET_STORE: "vault" })).toThrow(/database/);
  });
});
