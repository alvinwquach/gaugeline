/**
 * The Sanity sender: the second and last place the writer opens a connection. It calls the global fetch (so
 * the post-boundary scan sees it); these tests replace the global with a recorder. No network, no account.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SanityTarget } from "../sanity/endpoints.js";
import { sanitySender, sanityUrl } from "../sanity/send.js";

afterEach(() => vi.unstubAllGlobals());

// An invented token, built at run time: a key-shaped literal in the source is refused by push protection.
const TOKEN = ["sk", "invented0sanity0token0for0tests0only0"].join("");
const T: SanityTarget = { projectId: "tidewtr1", dataset: "production", apiVersion: "v2025-02-19" };
const GET = { endpoint: "getDoc", path: "/v2025-02-19/data/doc/production/menu-page" } as const;
const MUTATE = {
  endpoint: "mutate",
  path: "/v2025-02-19/data/mutate/production",
  query: { returnIds: "true" },
  body: {
    mutations: [{ create: { _id: "drafts.menu-page", _type: "page", hours: "Mon to Sun" } }],
  },
} as const;

function stubFetch(status = 200, body: unknown = { documents: [] }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return calls;
}

describe("the sender", () => {
  it("talks to <project>.api.sanity.io over https only, with the token in the Authorization header only", async () => {
    const calls = stubFetch();
    const res = await sanitySender({ ...T, token: TOKEN })(MUTATE);
    expect(res.status).toBe(200);
    const { url, init } = calls[0]!;
    const u = new URL(url);
    expect(u.origin).toBe("https://tidewtr1.api.sanity.io");
    expect(u.pathname).toBe("/v2025-02-19/data/mutate/production");
    expect(u.searchParams.get("returnIds")).toBe("true");
    expect(url).not.toContain(TOKEN);
    expect(String(init.body)).not.toContain(TOKEN);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    // The token is in no other header.
    for (const [name, value] of new Headers(init.headers))
      if (name !== "authorization") expect(value, name).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("sends a read with its registered method and no body", async () => {
    const calls = stubFetch();
    await sanitySender({ ...T, token: TOKEN })(GET);
    const { init } = calls[0]!;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("refuses redirects, so the token cannot follow one to another host", async () => {
    const calls = stubFetch();
    await sanitySender({ ...T, token: TOKEN })(GET);
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("gives up on a request that takes too long", async () => {
    const calls = stubFetch();
    await sanitySender({ ...T, token: TOKEN })(GET);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a request outside the registry before it reaches the network", async () => {
    const calls = stubFetch();
    const send = sanitySender({ ...T, token: TOKEN });
    for (const req of [
      { ...MUTATE, body: { mutations: [{ delete: { id: "drafts.menu-page" } }] } },
      { ...MUTATE, body: { mutations: [{ createOrReplace: { _id: "drafts.x", _type: "page" } }] } },
      {
        ...MUTATE,
        body: { mutations: [{ patch: { id: "drafts.menu-page", set: { hours: "x" } } }] },
      },
      { ...MUTATE, body: { mutations: [{ create: { _id: "menu-page", _type: "page" } }] } },
      { ...GET, path: "/v2025-02-19/data/doc/staging/menu-page" },
      { ...GET, path: "/v2025-02-19/data/doc/production/../query/production" },
    ])
      await expect(send(req as never)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses an empty token and a target that is not plain names, when it is built", () => {
    expect(() => sanitySender({ ...T, token: "" })).toThrow();
    expect(() => sanitySender({ ...T, token: "   " })).toThrow();
    for (const projectId of ["evil.example", "a/b", "a@b", "Tidewtr1", ""])
      expect(() => sanitySender({ ...T, projectId, token: TOKEN }), projectId).toThrow();
    expect(() => sanitySender({ ...T, apiVersion: "2025-02-19", token: TOKEN })).toThrow();
  });

  it("a failed connection throws an error that carries neither the token nor the address", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      throw new Error(
        `connect failed to ${url} with ${new Headers(init.headers).get("authorization")}`,
      );
    });
    const err = await sanitySender({ ...T, token: TOKEN })(GET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).message)).not.toContain("tidewtr1");
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
  });

  it("returns the status and the parsed body; a body that is not JSON or is too large is null", async () => {
    stubFetch(200, { documents: [{ _id: "menu-page" }] });
    expect(await sanitySender({ ...T, token: TOKEN })(GET)).toEqual({
      status: 200,
      json: { documents: [{ _id: "menu-page" }] },
    });
    stubFetch(500, "<html>the token is " + TOKEN + "</html>");
    expect(await sanitySender({ ...T, token: TOKEN })(GET)).toEqual({ status: 500, json: null });
    stubFetch(200, JSON.stringify({ x: "y".repeat(3_000_000) }));
    expect((await sanitySender({ ...T, token: TOKEN })(GET)).json).toBeNull();
  });
});

describe("sanityUrl: what is fetched is exactly what the registry checked", () => {
  it("builds the address for a registered path, with its query", () => {
    expect(sanityUrl(T, "/v2025-02-19/data/doc/production/menu-page").href).toBe(
      "https://tidewtr1.api.sanity.io/v2025-02-19/data/doc/production/menu-page",
    );
    expect(sanityUrl(T, "/v2025-02-19/data/mutate/production", { returnIds: "true" }).search).toBe(
      "?returnIds=true",
    );
  });

  it("refuses an address on another host (the origin pin)", () => {
    for (const path of [
      "//evil.example/v2025-02-19/data/doc/production/x",
      "https://evil.example/x",
      "\\\\evil.example/x",
      "http://tidewtr1.api.sanity.io/x",
    ])
      expect(() => sanityUrl(T, path), path).toThrow(/tidewtr1\.api\.sanity\.io only/);
  });

  it("refuses a path the URL parser would rewrite (dot segments, tabs, backslashes, a query)", () => {
    for (const path of [
      "/v2025-02-19/data/doc/production/../query/production",
      "/v2025-02-19/data/./x",
      "/v2025-02-19/data/%2e%2e/x",
      "/v2025-02-19/data/doc/pro\tduction/x",
      "/v2025-02-19/data\\doc/x",
      "/v2025-02-19/data/doc/production/x?a=1",
      "/v2025-02-19/data/doc/production/x#f",
    ])
      expect(() => sanityUrl(T, path), path).toThrow(/unchanged/);
  });
});
