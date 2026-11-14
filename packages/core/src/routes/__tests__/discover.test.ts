import { describe, expect, it } from "vitest";
import { discoverRoutes, findAppDir, readRoutes } from "../discover.js";
import { AUTH_PAGE, PAGE, cleanUpRepos, repo } from "./helpers.js";

cleanUpRepos();

const byPath = async (dir: string) =>
  Object.fromEntries((await discoverRoutes(dir)).map((r) => [r.path, r]));

describe("discoverRoutes: unit", () => {
  it("reads nested folders, a route group, a dynamic segment and a route.ts handler", async () => {
    const dir = repo({
      "app/page.tsx": PAGE,
      "app/about/page.tsx": PAGE,
      "app/(shop)/menu/page.tsx": PAGE,
      "app/(shop)/menu/[slug]/page.tsx": PAGE,
      "app/blog/[...parts]/page.tsx": PAGE,
      "app/docs/[[...parts]]/page.tsx": PAGE,
      "app/api/export/route.ts": "export const GET = () => new Response('x');\n",
      "app/account/orders/history/page.tsx": PAGE,
    });
    const routes = await discoverRoutes(dir);
    expect(routes.map((r) => [r.path, r.file, r.dynamic])).toEqual([
      ["/", "app/page.tsx", false],
      ["/about", "app/about/page.tsx", false],
      ["/account/orders/history", "app/account/orders/history/page.tsx", false],
      ["/api/export", "app/api/export/route.ts", false],
      ["/blog/[...parts]", "app/blog/[...parts]/page.tsx", true],
      ["/docs/[[...parts]]", "app/docs/[[...parts]]/page.tsx", true],
      ["/menu", "app/(shop)/menu/page.tsx", false],
      ["/menu/[slug]", "app/(shop)/menu/[slug]/page.tsx", true],
    ]);
  });

  it("leaves out private folders, parallel-route slots, intercepting routes and what is not a route", async () => {
    const dir = repo({
      "app/page.tsx": PAGE,
      "app/_components/page.tsx": PAGE,
      "app/@modal/login/page.tsx": PAGE,
      "app/(.)photo/page.tsx": PAGE,
      "app/node_modules/x/page.tsx": PAGE,
      "app/loading.tsx": PAGE,
      "app/real/page.test.tsx": PAGE,
    });
    expect((await discoverRoutes(dir)).map((r) => r.path)).toEqual(["/"]);
  });

  it("finds the app folder in src/app, or the folder given when it is called app", async () => {
    const root = repo({ "src/app/page.tsx": PAGE, "src/app/hours/page.tsx": PAGE });
    expect((await discoverRoutes(root)).map((r) => [r.path, r.file])).toEqual([
      ["/", "src/app/page.tsx"],
      ["/hours", "src/app/hours/page.tsx"],
    ]);
    const src = repo({ "src/app/page.tsx": PAGE });
    // The same project, given as ./src: files are relative to the folder given.
    const inner = (await discoverRoutes(`${src}/src`)).map((r) => r.file);
    expect(inner).toEqual(["app/page.tsx"]);
    const app = (await discoverRoutes(`${src}/src/app`)).map((r) => r.file);
    expect(app).toEqual(["page.tsx"]);
    expect(await findAppDir(repo({ "lib/x.ts": "" }))).toBeUndefined();
    expect(await discoverRoutes(repo({ "lib/x.ts": "" }))).toEqual([]);
  });

  it("is the same list, in the same order, on every run", async () => {
    const dir = repo({
      "app/z/page.tsx": PAGE,
      "app/a/page.tsx": PAGE,
      "app/m/route.ts": "export {};\n",
    });
    const first = await discoverRoutes(dir);
    expect(await discoverRoutes(dir)).toEqual(first);
    expect(first.map((r) => r.path)).toEqual(["/a", "/m", "/z"]);
  });
});

describe("expectsSession: unit", () => {
  it("from a middleware matcher that looks like a gate", async () => {
    const dir = repo({
      "middleware.ts":
        'import { NextResponse } from "next/server";\nexport function middleware(req) {\n  if (!req.cookies.get("session")) return NextResponse.redirect(new URL("/login", req.url));\n  return NextResponse.next();\n}\nexport const config = { matcher: ["/account/:path*", "/bookings"] };\n',
      "app/page.tsx": PAGE,
      "app/account/invoices/page.tsx": PAGE,
      "app/account/page.tsx": PAGE,
      "app/bookings/page.tsx": PAGE,
      "app/pricing/page.tsx": PAGE,
    });
    const r = await byPath(dir);
    expect(r["/account/invoices"]).toMatchObject({ expectsSession: true });
    expect(r["/account/invoices"]?.reason).toContain("middleware.ts");
    expect(r["/account/invoices"]?.reason).toContain('"/account/:path*"');
    expect(r["/account"]?.expectsSession).toBe(true);
    expect(r["/bookings"]?.expectsSession).toBe(true);
    expect(r["/pricing"]?.expectsSession).toBe(false);
    expect(r["/"]?.expectsSession).toBe(false);
    expect(r["/pricing"]?.reason).toBeUndefined();
  });

  it("reads the middleware beside src/app, and a proxy file", async () => {
    const dir = repo({
      "src/proxy.ts":
        'export function proxy(req) { return req.cookies.has("session") ? undefined : Response.redirect("/login"); }\nexport const config = { matcher: "/members/:path*" };\n',
      "src/app/members/page.tsx": PAGE,
    });
    expect((await byPath(dir))["/members"]?.expectsSession).toBe(true);
  });

  it("from the page calling a session helper, and from a layout above it", async () => {
    const dir = repo({
      "app/layout.tsx":
        'import { cookies } from "next/headers";\nexport default async function L({ children }) { (await cookies()).get("theme"); return children; }\n',
      "app/page.tsx": PAGE,
      "app/shop/page.tsx": PAGE,
      "app/account/page.tsx": AUTH_PAGE,
      "app/(portal)/layout.tsx":
        'import { getServerSession } from "next-auth";\nexport default async function L({ children }) { await getServerSession(); return children; }\n',
      "app/(portal)/bookings/page.tsx": PAGE,
      "app/(portal)/bookings/new/page.tsx": PAGE,
      "app/(portal)/api/mine/route.ts": "export const GET = () => new Response('x');\n",
      "app/me/page.tsx":
        'import { currentUser } from "@clerk/nextjs/server";\nexport default async function P() { const u = await currentUser(); return u; }\n',
    });
    const r = await byPath(dir);
    expect(r["/account"]).toMatchObject({ expectsSession: true, reason: "the page calls auth()" });
    expect(r["/me"]?.reason).toBe("the page calls currentUser()");
    expect(r["/bookings"]?.reason).toBe(
      "a layout (app/(portal)/layout.tsx) calls getServerSession()",
    );
    expect(r["/bookings/new"]?.expectsSession).toBe(true);
    // A layout wraps pages, not route handlers.
    expect(r["/api/mine"]?.expectsSession).toBe(false);
    // The root layout wraps every page, public ones too: its cookies() call is not a gate.
    expect(r["/shop"]?.expectsSession).toBe(false);
    expect(r["/"]?.expectsSession).toBe(false);
  });

  it("a route handler that calls a session helper expects one", async () => {
    const dir = repo({
      "app/api/me/route.ts":
        'import { auth } from "@/auth";\nexport async function GET() { const s = await auth(); return Response.json({ ok: !!s }); }\n',
    });
    expect((await byPath(dir))["/api/me"]?.reason).toBe("the route handler calls auth()");
  });

  it("is false for a plain marketing page, and a helper's name in a comment, a string or a longer word is not a call", async () => {
    const dir = repo({
      "app/page.tsx":
        '// we used to call auth() here\n/* getServerSession() */\nconst s = "call cookies() later";\nexport default function Home() { const author = authorOf(); return <p>{`currentUser()`}{author}</p>; }\nfunction authorOf() { return "Ana"; }\nfunction auth() { return 1; }\n',
      "app/menu/page.tsx":
        "export default function M() { return <p>Don't call auth() here</p>; }\n",
      "app/hours/page.tsx": "export default function H() { return request.auth(); }\n",
    });
    const r = await byPath(dir);
    expect(r["/"]?.expectsSession).toBe(false);
    expect(r["/menu"]?.expectsSession).toBe(false);
    expect(r["/hours"]?.expectsSession).toBe(false);
  });

  it("combines every reason", async () => {
    const dir = repo({
      "middleware.ts":
        'export function middleware(r) { return r.cookies.get("s") ? undefined : Response.redirect("/login"); }\nexport const config = { matcher: ["/account/:path*"] };\n',
      "app/account/page.tsx": AUTH_PAGE,
    });
    expect((await byPath(dir))["/account"]?.reason).toBe(
      'the page calls auth(); middleware.ts reads a cookie and its matcher "/account/:path*" covers it',
    );
  });
});

describe("expectsSession: a middleware that is not a gate", () => {
  it("one that never touches a session or a sign-in address does not make routes signed-in", async () => {
    const dir = repo({
      "middleware.ts":
        'import { NextResponse } from "next/server";\nexport function middleware(req) { const res = NextResponse.next(); res.headers.set("x-locale", "en"); return res; }\nexport const config = { matcher: ["/:path*"] };\n',
      "app/page.tsx": PAGE,
      "app/pricing/page.tsx": PAGE,
    });
    const found = await readRoutes(dir);
    expect(found.routes.every((r) => !r.expectsSession)).toBe(true);
    expect(found.notes.join(" ")).toContain("never touches a session");
  });

  it("a matcher that covers the home page is too broad to be a list of signed-in routes", async () => {
    const dir = repo({
      "middleware.ts":
        'export function middleware(req) { return req.cookies.get("s") ? undefined : Response.redirect("/login"); }\nexport const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };\n',
      "app/page.tsx": PAGE,
      "app/pricing/page.tsx": PAGE,
    });
    const found = await readRoutes(dir);
    expect(found.routes.every((r) => !r.expectsSession)).toBe(true);
    expect(found.notes.join(" ")).toContain("too broad");
  });

  it("a middleware with no matcher, and one whose matcher is a variable, are noted and read for no route", async () => {
    const gate =
      'export function middleware(req) { return req.cookies.get("s") ? undefined : Response.redirect("/login"); }\n';
    const none = await readRoutes(repo({ "middleware.ts": gate, "app/a/page.tsx": PAGE }));
    expect(none.routes[0]?.expectsSession).toBe(false);
    expect(none.notes.join(" ")).toContain("has no matcher");
    const variable = await readRoutes(
      repo({
        "middleware.ts": `${gate}const PROTECTED = ["/a"];\nexport const config = { matcher: PROTECTED };\n`,
        "app/a/page.tsx": PAGE,
      }),
    );
    expect(variable.routes[0]?.expectsSession).toBe(false);
    expect(variable.notes.join(" ")).toContain("not a list of strings written out in the file");
  });
});
