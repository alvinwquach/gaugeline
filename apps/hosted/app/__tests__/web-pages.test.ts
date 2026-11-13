// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * Sign in, sign out, switch organisation and the page shell, through the real routes against a real
 * Postgres (X63, part 1). Roles: owner, member and client viewer see what the database lets them; the pages
 * also hold back what a client viewer must not be offered, without relying on the policies.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_DATABASE, ORG_A, ORG_B } from "../../db/__tests__/harness.js";
import { signHs256 } from "../../lib/web/auth.js";
import { ROUTES, route } from "../../lib/web/routes.js";
import { fixture, PEOPLE, SECRET, type Fixture } from "./web-helpers.js";

const text = (r: Response) => r.text();

describe.skipIf(!HAS_DATABASE)("sign in and the shell", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(async () => {
    await f?.drop();
  });

  it("an unsigned visitor is sent to sign in, and brought back to where they were going", async () => {
    const b = f.browser();
    const res = await b.get("/");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in");
    const page = await b.get("/sign-in?next=%2F");
    expect(page.status).toBe(200);
    const body = await text(page);
    expect(body).toContain('name="email"');
    expect(body).toContain('name="next" value="/"');
    expect(body).not.toMatch(/type="password"/);
  });

  it("every page carries a policy that allows no script, no framing and only its own styles", async () => {
    const b = f.browser();
    for (const path of ["/sign-in", "/assets/app.css"]) {
      const res = await b.get(path);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).not.toContain("'unsafe-inline'");
      expect(csp, path).not.toMatch(/script-src[^;]*'self'/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toContain("no-store");
    }
    expect(await text(await b.get("/sign-in"))).not.toMatch(/<script/i);
  });

  it("asking for a link answers the same for a known and an unknown address, and sends one only to the known", async () => {
    const b = f.browser();
    const before = f.inbox.length;
    const known = await b.post("/sign-in", { email: PEOPLE.maya.email });
    const unknown = await b.post("/sign-in", { email: "nobody@nowhere.test" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await text(known)).toBe(await text(unknown));
    expect(f.inbox.length - before).toBe(1);
    expect((await b.post("/sign-in", { email: "" })).status).toBe(200);
    expect((await b.post("/sign-in", {})).status).toBe(200);
  });

  it("opening the link does not sign anyone in (a mail scanner may open it); confirming does, once", async () => {
    const b = f.browser();
    await b.post("/sign-in", { email: PEOPLE.maya.email });
    const { token } = f.inbox.at(-1)!;
    const opened = await b.get(`/sign-in/verify?token=${token}`);
    expect(opened.status).toBe(200);
    expect(opened.headers.getSetCookie()).toEqual([]);
    expect(await text(opened)).toContain('method="post"');
    const done = await b.post("/sign-in/verify", { token });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/");
    const cookie = done.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(
      /^gl_session=[\w-]+\.[\w-]+\.[\w-]+; Path=\/; Max-Age=28800; HttpOnly; SameSite=Lax$/,
    );
    const again = await f.browser().post("/sign-in/verify", { token });
    expect(again.status).toBe(400);
    expect(await text(again)).toContain("no longer valid");
  });

  it("an expired link says so and offers a new one", async () => {
    const b = f.browser();
    await b.post("/sign-in", { email: PEOPLE.maya.email });
    const { token } = f.inbox.at(-1)!;
    f.now.t = new Date(f.now.t.getTime() + 16 * 60_000);
    const res = await b.post("/sign-in/verify", { token });
    f.now.t = new Date(f.now.t.getTime() - 16 * 60_000);
    expect(res.status).toBe(400);
    const body = await text(res);
    expect(body).toContain("expired");
    expect(body).toContain('href="/sign-in"');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("after sign-in the owner sees their organisation, their role and the sites it holds; nothing of another", async () => {
    const b = f.browser();
    expect((await b.signIn(PEOPLE.maya.email)).status).toBe(303);
    const home = await text(await b.get("/"));
    expect(home).toContain("Northgate Studio");
    expect(home).toContain("Owner");
    expect(home).toContain(PEOPLE.maya.email);
    expect(home).not.toContain("Brightfield Web");
    expect(home).not.toContain("Maple Street Physio");
  });

  it("a person in two organisations can switch, and the page follows; a stranger's id is ignored", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.both.email);
    const first = await text(await b.get("/"));
    expect(first).toMatch(new RegExp(`<option\\s+value="${ORG_B}"`));
    expect(first).toMatch(/Brightfield Web[\s\S]*Admin/);
    const sw = await b.post("/org", { org: ORG_A });
    expect(sw.status).toBe(303);
    expect(await text(await b.get("/"))).toMatch(/Northgate Studio[\s\S]*Member/);
    // An organisation the person is not in: the choice is refused and the page stays where it was.
    const bad = await b.post("/org", { org: "0c000000-0000-4000-8000-00000000000c" });
    expect(bad.status).toBe(303);
    expect(await text(await b.get("/"))).toMatch(/Northgate Studio[\s\S]*Member/);
    // Someone in one organisation only has nothing to switch.
    const solo = f.browser();
    await solo.signIn(PEOPLE.ben.email);
    expect(await text(await solo.get("/"))).not.toContain("<select");
    const forged = await solo.post("/org", { org: ORG_A });
    expect(forged.headers.getSetCookie().join(";")).not.toContain(ORG_A);
    expect(await text(await solo.get("/"))).not.toContain("Northgate Studio");
  });

  it("a client viewer is offered their one site and nothing to manage", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.manager.email);
    const home = await text(await b.get("/"));
    expect(home).toContain("The Tidewater Bar");
    expect(home).toContain("Client viewer");
    expect(home).not.toContain("Juniper Pop-up Kitchen");
    expect(home).not.toMatch(/Add a site|Invite|Members/);
  });

  it("a forged or tampered cookie is no session; a token for a person who has since lost every membership sees an empty page", async () => {
    const b = f.browser();
    b.cookies.set("gl_session", "x.y.z");
    expect((await b.get("/")).status).toBe(303);
    const jwt = await (async () => {
      const c = f.browser();
      await c.signIn(PEOPLE.dev.email);
      return c.cookies.get("gl_session")!;
    })();
    const [h, p, s] = jwt.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(p!, "base64url").toString()),
        sub: PEOPLE.ben.id,
      }),
    ).toString("base64url");
    b.cookies.set("gl_session", `${h}.${forgedPayload}.${s}`);
    expect((await b.get("/")).status).toBe(303);
    const gone = f.browser();
    await gone.signIn(PEOPLE.dev.email);
    await f.owner`delete from public.members where user_id = ${PEOPLE.dev.id}`;
    const body = await text(await gone.get("/"));
    expect(body).toContain("not a member of any organisation");
    expect(body).not.toContain("Northgate Studio");
    await f.owner`insert into public.members (org_id, user_id, role) values (${ORG_A}, ${PEOPLE.dev.id}, 'member')`;
  });

  it("sign out clears the session; changing state from another origin, or with no origin, is refused", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    expect((await b.post("/org", { org: ORG_A }, { origin: "http://evil.test" })).status).toBe(403);
    expect((await b.post("/sign-out", {}, { origin: null })).status).toBe(403);
    expect(b.cookies.has("gl_session")).toBe(true);
    const out = await b.post("/sign-out", {});
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/sign-in");
    expect(out.headers.getSetCookie().join(";")).toMatch(/gl_session=; .*Max-Age=0/);
    expect((await b.get("/")).status).toBe(303);
  });

  it("sign-out ends the session on the server: the old cookie no longer works", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const old = b.cookies.get("gl_session")!;
    expect((await b.get("/")).status).toBe(200);
    await b.post("/sign-out", {});
    const replay = f.browser();
    replay.cookies.set("gl_session", old);
    expect((await replay.get("/")).status).toBe(303);
    // Signing in again gives a different, working session.
    const again = f.browser();
    await again.signIn(PEOPLE.maya.email);
    expect((await again.get("/")).status).toBe(200);
  });

  it("a token whose sub is in capitals is the same person, not a server error", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const token = signHs256(
      {
        ...f.deps.auth.verify(b.cookies.get("gl_session")!)!,
        sub: PEOPLE.maya.id.toUpperCase(),
        iss: "gaugeline-stand-in",
      },
      SECRET,
    );
    const c = f.browser();
    c.cookies.set("gl_session", token);
    const res = await c.get("/");
    expect(res.status).toBe(200);
    expect(await text(res)).toContain("Northgate Studio");
  });

  it("https responses carry HSTS, http ones do not", async () => {
    const https = await route(new Request("https://app.test/sign-in"), {
      ...f.deps,
      secureCookies: true,
    });
    expect(https.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    const http = await route(new Request("http://app.test/sign-in"), f.deps);
    expect(http.headers.get("strict-transport-security")).toBeNull();
  });

  it("`next` is followed only to a path on this app, and only in the browser that asked", async () => {
    for (const bad of ["//evil.test", "https://evil.test", "/\\evil.test", "javascript:1"]) {
      const b = f.browser();
      await b.post("/sign-in", { email: PEOPLE.maya.email, next: bad });
      const { token } = f.inbox.at(-1)!;
      const res = await b.post("/sign-in/verify", { token, next: bad });
      expect(res.headers.get("location"), bad).toBe("/");
    }
    const b = f.browser();
    await b.post("/sign-in", { email: PEOPLE.maya.email, next: "/sites?x=1" });
    const { token } = f.inbox.at(-1)!;
    // Another browser confirming the link does not inherit the first one's destination.
    expect((await f.browser().post("/sign-in/verify", { token: "x", next: "/sites" })).status).toBe(
      400,
    );
    const res = await b.post("/sign-in/verify", { token });
    expect(res.headers.get("location")).toBe("/sites?x=1");
    expect(b.cookies.has("gl_next")).toBe(false);
  });

  it("no page, for anyone, contains the signing secret, the database address or the session token", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.both.email);
    const session = b.cookies.get("gl_session")!;
    for (const path of ["/", "/sign-in", "/assets/app.css"]) {
      const body = await text(await b.get(path));
      for (const secret of [SECRET, f.appUrl, session, new URL(f.appUrl).password])
        expect(body, path).not.toContain(secret);
    }
  });
});

describe("the route table and the files the host serves", () => {
  const appDir = fileURLToPath(new URL("..", import.meta.url));
  // Route Handlers that are not in the table because they do not use the web app's session or login: the
  // morning email's preference page is opened with a signed token and has its own dependencies (X64).
  const STANDALONE = ["/email/preferences"];
  it("every route has its route.ts, and every route.ts (outside the API) is in the table or named as standalone", () => {
    for (const r of ROUTES) {
      const dir = r.path === "/" ? "" : r.path.slice(1);
      expect(existsSync(join(appDir, dir, "route.ts")), r.path).toBe(true);
    }
    const found: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "__tests__" || e.name === "api") continue;
        if (e.isDirectory()) walk(join(d, e.name), `${rel}/${e.name}`);
        else if (e.name === "route.ts") found.push(rel || "/");
      }
    };
    walk(appDir, "");
    expect(found.sort()).toEqual(
      [...new Set([...ROUTES.map((r) => r.path), ...STANDALONE])].sort(),
    );
    for (const path of STANDALONE) {
      expect(
        ROUTES.some((r) => r.path === path),
        `${path} is in the table and standalone`,
      ).toBe(false);
      expect(readFileSync(join(appDir, path.slice(1), "route.ts"), "utf8"), path).toMatch(
        /export const GET\b/,
      );
    }
    for (const r of ROUTES) {
      const dir = r.path === "/" ? "" : r.path.slice(1);
      const src = readFileSync(join(appDir, dir, "route.ts"), "utf8");
      for (const m of r.methods)
        expect(src, `${r.path} ${m}`).toMatch(new RegExp(`export const ${m}\\b`));
    }
  });
});
