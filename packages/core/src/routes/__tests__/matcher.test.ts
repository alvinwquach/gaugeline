import { describe, expect, it } from "vitest";
import { gateHint, matcherCovers, matcherToRegExp, readMatcher, samplePath } from "../matcher.js";
import { findSessionHelper, scanSource } from "../scan.js";

describe("readMatcher: unit", () => {
  it("reads a string, an array, objects with a source, and a type annotation", () => {
    expect(readMatcher('export const config = { matcher: "/a/:path*" };')).toEqual({
      kind: "list",
      sources: ["/a/:path*"],
    });
    expect(
      readMatcher("export const config = {\n  // guarded\n  matcher: ['/a', `/b/:id`],\n};"),
    ).toEqual({
      kind: "list",
      sources: ["/a", "/b/:id"],
    });
    expect(
      readMatcher(
        'export const config: MiddlewareConfig = { matcher: [{ source: "/a/:path*", missing: [{ type: "header", key: "x" }] }, "/b"] } as const;',
      ),
    ).toEqual({ kind: "list", sources: ["/a/:path*", "/b"] });
  });

  it("no config, or a config with no matcher, runs on every path", () => {
    expect(readMatcher("export function middleware() {}")).toEqual({ kind: "all" });
    expect(readMatcher("export const config = { runtime: 'nodejs' };")).toEqual({ kind: "all" });
  });

  it("a matcher that is not written out is unreadable", () => {
    expect(readMatcher("export const config = { matcher: PROTECTED };").kind).toBe("unreadable");
    expect(readMatcher("export const config = { matcher: [...A, '/b'] };").kind).toBe("unreadable");
    expect(readMatcher("export const config = { matcher: [`/a/${id}`] };").kind).toBe("unreadable");
    expect(readMatcher("export const config = makeConfig();").kind).toBe("unreadable");
  });

  it("a matcher in a comment is not read", () => {
    expect(
      readMatcher('// export const config = { matcher: ["/a"] };\nexport function m() {}'),
    ).toEqual({
      kind: "all",
    });
  });
});

describe("matcherToRegExp: unit", () => {
  const hits = (source: string, path: string) => matcherToRegExp(source)?.test(path);
  it("reads :name, :name*, :name+, :name? and groups the way Next.js does", () => {
    expect(hits("/account/:path*", "/account")).toBe(true);
    expect(hits("/account/:path*", "/account/invoices/2")).toBe(true);
    expect(hits("/account/:path*", "/accounts")).toBe(false);
    expect(hits("/account/:path+", "/account")).toBe(false);
    expect(hits("/account/:path+", "/account/a")).toBe(true);
    expect(hits("/account/:id", "/account/a")).toBe(true);
    expect(hits("/account/:id", "/account/a/b")).toBe(false);
    expect(hits("/account/:id?", "/account")).toBe(true);
    expect(hits("/dashboard", "/dashboard")).toBe(true);
    expect(hits("/dashboard", "/dashboard/x")).toBe(false);
    expect(hits("/((?!api|_next/static).*)", "/pricing")).toBe(true);
    expect(hits("/((?!api|_next/static).*)", "/api/x")).toBe(false);
    expect(hits("/((?!api|_next/static).*)", "/")).toBe(true);
    expect(hits("/blog/(\\d+)", "/blog/12")).toBe(true);
    expect(hits("/blog/(\\d+)", "/blog/x")).toBe(false);
  });

  it("an expression that is not a regular expression is undefined", () => {
    expect(matcherToRegExp("/a/(unclosed")).toBeUndefined();
    expect(matcherToRegExp("/a/([)")).toBeUndefined();
  });
});

describe("matcherCovers and samplePath: unit", () => {
  it("a dynamic route is tested with a sample address", () => {
    expect(samplePath("/shop/[slug]")).toBe("/shop/sample");
    expect(samplePath("/docs/[...parts]")).toBe("/docs/sample/more");
    expect(samplePath("/docs/[[...parts]]")).toBe("/docs");
    const m = { kind: "list" as const, sources: ["/account/:id"] };
    expect(matcherCovers(m, "/account/[id]")).toEqual({ covered: true, by: "/account/:id" });
    expect(matcherCovers(m, "/account/[id]/edit").covered).toBe(false);
  });
});

describe("gateHint: unit", () => {
  it("names why a middleware looks like a gate", () => {
    expect(gateHint('import { auth } from "x";\nexport default auth((req) => {});\n')).toBe(
      "calls auth()",
    );
    expect(gateHint("export const middleware = clerkMiddleware();")).toBe("uses clerkMiddleware");
    expect(gateHint('const t = req.cookies.get("s");')).toBe("reads a cookie");
    expect(gateHint("return new Response(null, { status: 401 });")).toBe("answers 401 or 403");
    expect(gateHint('return NextResponse.redirect(new URL("/sign-in", req.url));')).toBe(
      "redirects to a sign-in address",
    );
    expect(gateHint('res.headers.set("x-locale", "en");')).toBeUndefined();
  });
});

describe("scanSource and findSessionHelper: unit", () => {
  it("takes out comments and the inside of strings, keeping lines", () => {
    const s = scanSource("a(); // b()\n/* c()\n d() */ e('f()');\n`g()`;");
    expect(s.code).toContain("a();");
    expect(s.code).toContain("e('')");
    expect(s.code).not.toMatch(/[bcdfg]\(\)/);
    expect(s.code.split("\n")).toHaveLength(4);
    expect(s.strings).toEqual(["f()"]);
  });

  it("a quote that never closes ends at the end of its line", () => {
    const s = scanSource("<p>Don't</p>\nconst x = auth();\n");
    expect(findSessionHelper(s.code)).toBe("auth");
  });

  it("finds a generic call and skips a method of another object and a declaration", () => {
    expect(findSessionHelper("const s = await getServerSession<Session>(opts);")).toBe(
      "getServerSession",
    );
    expect(findSessionHelper("supabase.auth(); this.cookies();")).toBeUndefined();
    expect(findSessionHelper("function auth() {}")).toBeUndefined();
    expect(findSessionHelper("export const x = myauth(); authorize();")).toBeUndefined();
    expect(findSessionHelper("x(); cookies()", ["cookies"])).toBe("cookies");
  });
});
