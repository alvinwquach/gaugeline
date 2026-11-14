// check-community: allow-email (invented addresses at reserved example domains, in the stand-ins for the providers' answers)
import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { readGoogleAdmins } from "../google.js";
import { readSanity } from "../sanity.js";
import { readVercel } from "../vercel.js";
import {
  CLIENT,
  ENV,
  FREELANCER,
  GOOGLE_TOKEN,
  SANITY_TOKEN,
  TEAMMATE,
  VERCEL_TOKEN,
  world,
} from "./world.js";

const fetcherFor = (over: Parameters<typeof world>[0] = {}) => {
  const { transport, seen } = world(over);
  return { fetcher: createFetcher({ transport }), seen };
};

describe("readVercel", () => {
  const args = { env: ENV, project: "marlowe-bar-site", teamId: "team_harbour01" };

  it("reads the team that owns the project and its members with their roles", async () => {
    const { fetcher } = fetcherFor();
    const read = await readVercel({ ...args, fetcher });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.subject).toBe("marlowe-bar-site");
    expect(read.account).toEqual({ kind: "team", name: "Harbour Studio" });
    expect(read.members.map((m) => [m.email, m.role, m.rawRole, m.pending === true])).toEqual([
      [FREELANCER, "owner", "OWNER", false],
      [TEAMMATE, "member", "MEMBER", false],
      [CLIENT, "member", "MEMBER", true],
    ]);
  });

  it("a personal account has one owner: the token's own user", async () => {
    const { fetcher } = fetcherFor();
    const read = await readVercel({ env: ENV, fetcher, project: "juniper-site" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.account.kind).toBe("personal");
    expect(read.members).toHaveLength(1);
    expect(read.members[0]).toMatchObject({ role: "owner", rawRole: "owner" });
  });

  it("says so when the token belongs to someone other than the account that owns the project", async () => {
    const { fetcher } = fetcherFor({
      "GET https://api.vercel.com/v2/user": {
        status: 200,
        body: { user: { id: "uid_someone_else", email: "x@y.example" } },
      },
    });
    const read = await readVercel({ env: ENV, fetcher, project: "juniper-site" });
    expect(read).toMatchObject({ ok: false });
    if (!read.ok) expect(read.reason).toMatch(/another account/);
  });

  it("is could-not-check, with the variable named, when there is no token", async () => {
    const { fetcher, seen } = fetcherFor();
    const read = await readVercel({ ...args, env: {}, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("GAUGELINE_VERCEL_TOKEN");
    expect(seen).toHaveLength(0);
  });

  it("is could-not-check, with the file named, when no project is named", async () => {
    const { fetcher, seen } = fetcherFor();
    const read = await readVercel({ env: ENV, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("gaugeline.handoff.json");
    expect(seen).toHaveLength(0);
  });

  it("a token that may not list members gives could-not-check for Vercel, in plain words, and never the token", async () => {
    const { fetcher } = fetcherFor({
      "GET https://api.vercel.com/v3/teams/team_harbour01/members?limit=100": {
        status: 403,
        body: { error: { message: `forbidden ${VERCEL_TOKEN}` } },
      },
    });
    const read = await readVercel({ ...args, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toMatch(/Vercel/);
      expect(read.reason).toMatch(/403/);
      expect(read.reason).toMatch(/members/);
      expect(read.reason).not.toContain(VERCEL_TOKEN);
    }
  });

  it("a rate limit says when to try again", async () => {
    const { fetcher } = fetcherFor({
      "GET https://api.vercel.com/v9/projects/marlowe-bar-site?teamId=team_harbour01": {
        status: 429,
        headers: { "retry-after": "120" },
      },
    });
    const read = await readVercel({ ...args, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/in 120 seconds/);
  });

  it("a team with more members than one page is could-not-check, not a partial list", async () => {
    const { fetcher } = fetcherFor({
      "GET https://api.vercel.com/v3/teams/team_harbour01/members?limit=100": {
        status: 200,
        body: {
          members: [{ uid: "u1", email: FREELANCER, role: "OWNER" }],
          pagination: { next: 1731315600000 },
        },
      },
    });
    const read = await readVercel({ ...args, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/more than 100/);
  });

  it("only asks with GET, and sends the token only to Vercel, in a header", async () => {
    const { fetcher, seen } = fetcherFor();
    await readVercel({ ...args, fetcher });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(new URL(s.url).hostname).toBe("api.vercel.com");
      expect(s.url).not.toContain(VERCEL_TOKEN);
      expect(s.headers.authorization).toBe(`Bearer ${VERCEL_TOKEN}`);
    }
  });

  it("a member with an unknown role is kept, as unknown", async () => {
    const { fetcher } = fetcherFor({
      "GET https://api.vercel.com/v3/teams/team_harbour01/members?limit=100": {
        status: 200,
        body: {
          members: [{ uid: "u1", email: FREELANCER, role: "TEAPOT" }],
          pagination: { next: null },
        },
      },
    });
    const read = await readVercel({ ...args, fetcher });
    expect(read.ok && read.members[0]).toMatchObject({ role: "unknown", rawRole: "TEAPOT" });
  });
});

describe("readSanity", () => {
  it("reads the project's members and their addresses, and marks a token as not a person", async () => {
    const { fetcher, seen } = fetcherFor();
    const read = await readSanity({ env: ENV, fetcher });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.subject).toBe("Marlowe Bar");
    expect(read.members.map((m) => [m.email ?? m.id, m.role, m.token === true])).toEqual([
      ["dev.harbour@mail.example", "admin", false],
      [CLIENT, "member", false],
      ["su_bot", "viewer", true],
    ]);
    expect(
      seen.every((s) => s.method === "GET" && new URL(s.url).hostname === "api.sanity.io"),
    ).toBe(true);
    expect(seen.every((s) => s.headers.authorization === `Bearer ${SANITY_TOKEN}`)).toBe(true);
  });

  it("keeps the members, without addresses, when Sanity will not give the addresses", async () => {
    const { fetcher } = fetcherFor({
      "GET https://api.sanity.io/v2021-06-07/projects/abc123xy/users/su_dev,su_rosa": {
        status: 403,
      },
    });
    const read = await readSanity({ env: ENV, fetcher });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.members.every((m) => m.email === undefined)).toBe(true);
    expect(read.notes.join(" ")).toMatch(/address/);
  });

  it("a token without permission is could-not-check for Sanity only", async () => {
    const { fetcher } = fetcherFor({
      "GET https://api.sanity.io/v2021-06-07/projects/abc123xy": { status: 401 },
    });
    const read = await readSanity({ env: ENV, fetcher });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toMatch(/Sanity/);
      expect(read.reason).toMatch(/401/);
      expect(read.reason).not.toContain(SANITY_TOKEN);
    }
  });

  it("needs a project and a token, and says which is missing", async () => {
    const { fetcher } = fetcherFor();
    const noToken = await readSanity({ env: { SANITY_PROJECT_ID: "abc123xy" }, fetcher });
    expect(!noToken.ok && noToken.reason).toContain("SANITY_TOKEN");
    const noProject = await readSanity({ env: { SANITY_TOKEN }, fetcher });
    expect(!noProject.ok && noProject.reason).toContain("SANITY_PROJECT_ID");
  });

  it("takes the project from the config over the environment, and refuses an id that is not one", async () => {
    const { fetcher, seen } = fetcherFor();
    await readSanity({ env: ENV, fetcher, projectId: "abc123xy" });
    expect(seen[0]?.url).toContain("/projects/abc123xy");
    const bad = await readSanity({ env: ENV, fetcher, projectId: "../x" });
    expect(bad.ok).toBe(false);
  });
});

describe("readGoogleAdmins", () => {
  it("reads who administers the location, with the owner marked", async () => {
    const { fetcher, seen } = fetcherFor();
    const read = await readGoogleAdmins({ env: ENV, fetcher, location: "locations/1234567890" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.subject).toBe("locations/1234567890");
    expect(read.members.map((m) => [m.email, m.role, m.rawRole])).toEqual([
      [CLIENT, "owner", "PRIMARY_OWNER"],
      [FREELANCER, "member", "MANAGER"],
    ]);
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${GOOGLE_TOKEN}`);
  });

  it("a pending invitation is not yet a member", async () => {
    const { fetcher } = fetcherFor({
      "GET https://mybusinessaccountmanagement.googleapis.com/v1/locations/1234567890/admins": {
        status: 200,
        body: { admins: [{ admin: CLIENT, role: "OWNER", pendingInvitation: true }] },
      },
    });
    const read = await readGoogleAdmins({ env: ENV, fetcher, location: "locations/1234567890" });
    expect(read.ok && read.members[0]?.pending).toBe(true);
  });

  it("needs the token and the location from the listings settings", async () => {
    const { fetcher, seen } = fetcherFor();
    const noToken = await readGoogleAdmins({ env: {}, fetcher, location: "locations/1234567890" });
    expect(!noToken.ok && noToken.reason).toContain("GOOGLE_BUSINESS_PROFILE_TOKEN");
    const noLocation = await readGoogleAdmins({ env: ENV, fetcher });
    expect(!noLocation.ok && noLocation.reason).toContain("gaugeline.listings.json");
    expect(seen).toHaveLength(0);
  });

  it("a refusal is could-not-check for Google only", async () => {
    const { fetcher } = fetcherFor({
      "GET https://mybusinessaccountmanagement.googleapis.com/v1/locations/1234567890/admins": {
        status: 403,
      },
    });
    const read = await readGoogleAdmins({ env: ENV, fetcher, location: "locations/1234567890" });
    expect(!read.ok && read.reason).toMatch(/Google/);
  });
});
