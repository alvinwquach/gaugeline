/**
 * The sender: the one place the writer opens a connection. It calls the global fetch (so the
 * post-boundary scan sees it); these tests replace the global with a recorder. No network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, githubSender } from "../github/send.js";
import { DRAFT, TOKEN } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 201, body: unknown = { html_url: "u" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

describe("the sender", () => {
  it("puts the token in the Authorization header only, and talks to api.github.com only", async () => {
    const calls = stubFetch();
    const res = await githubSender(TOKEN)({
      endpoint: "createPull",
      path: "/repos/northgate-studio/tidewater-bar/pulls",
      body: { title: "t", head: `gaugeline/${DRAFT}`, base: "main", body: "b", draft: true },
    });
    expect(res.status).toBe(201);
    const { url, init } = calls[0]!;
    expect(new URL(url).host).toBe("api.github.com");
    expect(url).not.toContain(TOKEN);
    expect(String(init.body)).not.toContain(TOKEN);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init.method).toBe("POST");
  });

  it("refuses redirects, so the token cannot follow one to another host", async () => {
    const calls = stubFetch(200, []);
    await githubSender(TOKEN)({ endpoint: "getRef", path: "/repos/a/b/git/ref/heads/main" });
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("sends a read with its registered method and no body", async () => {
    const calls = stubFetch(200, []);
    await githubSender(TOKEN)({
      endpoint: "listPulls",
      path: "/repos/a/b/pulls",
      query: { head: "a:gaugeline/x", state: "all" },
    });
    const { url, init } = calls[0]!;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(new URL(url).searchParams.get("state")).toBe("all");
  });

  it("refuses a request outside the registry before it reaches the network", async () => {
    const calls = stubFetch();
    await expect(
      githubSender(TOKEN)({
        endpoint: "createRef",
        path: "/repos/a/b/git/refs",
        body: { ref: "refs/heads/main", sha: "b" },
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses a path that climbs out of the repository: no request, no token sent", async () => {
    const calls = stubFetch();
    await expect(
      githubSender(TOKEN)({
        endpoint: "getRef",
        path: "/repos/acme/site/git/ref/heads/../../../../../user",
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses an empty token", () => {
    expect(() => githubSender("")).toThrow();
    expect(() => githubSender("   ")).toThrow();
  });
});

describe("apiUrl: what is fetched is exactly what the registry checked", () => {
  it("builds the address for a plain registered path, with its query", () => {
    const u = apiUrl("/repos/a/b/contents/app/x%40y.ts", { ref: "main" });
    expect(u.href).toBe("https://api.github.com/repos/a/b/contents/app/x%40y.ts?ref=main");
  });

  it("refuses an address on another host (the origin pin)", () => {
    for (const path of [
      "//evil.example/repos/a/b/pulls",
      "https://evil.example/repos/a/b/pulls",
      "\\\\evil.example/x",
    ])
      expect(() => apiUrl(path), path).toThrow(/api\.github\.com only/);
  });

  it("refuses a path the URL parser would rewrite (dot segments, tabs, backslashes)", () => {
    for (const path of [
      "/repos/a/b/git/ref/heads/../../../../../user",
      "/repos/a/b/./pulls",
      "/repos/a/b/%2e%2e/pulls",
      "/repos/a/b/pu\tlls",
      "/repos/a/b\\pulls",
      "/repos/a/b/pulls?x=1",
      "/repos/a/b/pulls#frag",
    ])
      expect(() => apiUrl(path), path).toThrow(/unchanged/);
  });
});
