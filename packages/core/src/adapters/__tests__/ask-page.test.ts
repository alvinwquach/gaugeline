import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { askPage } from "../webflow-read.js";

const reply = (status: number, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "text/html", ...headers },
    body: Readable.from([Buffer.from("<html></html>")]),
  });

/** /old redirects to /new (and /slash to /slash/); /new and /slash/ answer 200, anything else 404. */
const transport: Transport = (url) => {
  if (url.pathname === "/old") return reply(301, { location: "/new" });
  if (url.pathname === "/slash") return reply(301, { location: "/slash/" });
  if (url.pathname === "/new" || url.pathname === "/slash/" || url.pathname === "/same")
    return reply(200);
  return reply(404);
};
const fetcher = () => createFetcher({ transport, timeoutMs: 5000 });
const at = (path: string) => `https://askpage.example${path}`;

describe("askPage", () => {
  it("by default a page reached through a redirect is a page (Webflow and Craft rely on this)", async () => {
    expect(await askPage(fetcher(), at("/old"))).toEqual({ kind: "page", status: 200 });
  });

  it("with sameAddress a redirect to another path is not a page", async () => {
    expect(await askPage(fetcher(), at("/old"), { sameAddress: true })).toEqual({
      kind: "unread",
      reason: "the address redirects to /new",
    });
  });

  it("with sameAddress a trailing-slash redirect is still the page, and a direct answer is unchanged", async () => {
    expect(await askPage(fetcher(), at("/slash"), { sameAddress: true })).toEqual({
      kind: "page",
      status: 200,
    });
    expect(await askPage(fetcher(), at("/same"), { sameAddress: true })).toEqual({
      kind: "page",
      status: 200,
    });
    expect(await askPage(fetcher(), at("/gone"), { sameAddress: true })).toEqual({
      kind: "missing",
      status: 404,
    });
  });
});
