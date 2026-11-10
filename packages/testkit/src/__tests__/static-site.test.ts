import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../fixtures/src/index.js";
import { staticSite } from "../static-site.js";

const body = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};
const req = { method: "GET", headers: {}, timeoutMs: 1000 } as const;
const elsewhere = () => Promise.reject(new Error("elsewhere"));

describe("staticSite", () => {
  const site = staticSite("bucktavern.example", `${SITES_DIR}listings-bar`, elsewhere);

  it("serves / as index.html and a path with no extension as .html", async () => {
    const home = await site(new URL("https://bucktavern.example/"), req);
    expect(home.status).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
    expect(await body(home.body)).toContain("The BUCK Tavern");
  });

  it("a missing file is a 404, and a path that climbs out of the folder is never served", async () => {
    expect((await site(new URL("https://bucktavern.example/nope"), req)).status).toBe(404);
    const up = await site(new URL("https://bucktavern.example/..%2Fclean%2Findex.html"), req);
    expect(up.status).toBe(404);
  });

  it("another host goes to the other transport", async () => {
    await expect(site(new URL("https://elsewhere.example/"), req)).rejects.toThrow("elsewhere");
  });
});
