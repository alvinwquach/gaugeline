import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { buildResult } from "../../result.js";
import { uploadResult, UPLOAD_TOKEN_ENV, UPLOAD_URL_ENV, uploadKey } from "../upload.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const TOKEN = ["glt", "0a1b2c3d", "x".repeat(43)].join("_");
const result = buildResult({
  url: "https://tidewater-bar.test/",
  startedAt: new Date("2026-11-12T03:00:00Z"),
  findings: [
    {
      checkId: "broken-links",
      severity: "high",
      title: "Broken link on the menu page",
      evidence: "/menu links to /drinks-2025 (404)",
      url: "https://tidewater-bar.test/menu",
    },
  ],
  passed: ["noindex"],
  failed: ["broken-links"],
});

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
  key?: string;
  body: string;
}
async function receiver(status: number, answer = "{}") {
  const seen: Seen[] = [];
  const s = await startServer({}, (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        key: req.headers["idempotency-key"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json" }).end(answer);
    });
  });
  servers.push(s);
  return { origin: s.origin, seen };
}

describe("uploadResult", () => {
  it("posts the result to <address>/runs with the token as a Bearer header and an idempotency key", async () => {
    const r = await receiver(201);
    const out = await uploadResult(result, {
      [UPLOAD_TOKEN_ENV]: TOKEN,
      [UPLOAD_URL_ENV]: `${r.origin}/api/v1`,
    });
    expect(out.ok).toBe(true);
    expect(out.line).toBe("Uploaded 1 finding to 127.0.0.1.");
    expect(r.seen).toHaveLength(1);
    const s = r.seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/api/v1/runs");
    expect(s.auth).toBe(`Bearer ${TOKEN}`);
    expect(s.key).toBe(uploadKey(result));
    expect(JSON.parse(s.body)).toEqual(result);
  });

  it("the key is the same for the same result and different for another", () => {
    expect(uploadKey(result)).toBe(uploadKey({ ...result }));
    expect(uploadKey(result)).toMatch(/^gl-[0-9a-f]{32}$/);
    expect(uploadKey({ ...result, url: "https://other.test/" })).not.toBe(uploadKey(result));
  });

  it("says one plain line, with the host and the server's message, when the server refuses; never the token or the address path", async () => {
    const r = await receiver(
      401,
      JSON.stringify({ code: "unauthorized", message: "The token is not valid." }),
    );
    const out = await uploadResult(result, {
      [UPLOAD_TOKEN_ENV]: TOKEN,
      [UPLOAD_URL_ENV]: `${r.origin}/private-path/api/v1`,
    });
    expect(out.ok).toBe(false);
    expect(out.line).toBe("Could not upload: 127.0.0.1 answered 401: The token is not valid.");
    expect(out.line).not.toContain(TOKEN);
    expect(out.line).not.toContain("private-path");
    expect(out.line).not.toContain("\n");
  });

  it("an unreachable server is a line too, not an error", async () => {
    const out = await uploadResult(
      result,
      { [UPLOAD_TOKEN_ENV]: TOKEN, [UPLOAD_URL_ENV]: "http://127.0.0.1:1/api/v1" },
      { timeoutMs: 2000 },
    );
    expect(out.ok).toBe(false);
    expect(out.line).toMatch(/^Could not upload: 127\.0\.0\.1 could not be reached/);
  });

  it("needs a token and an address; says which, and sends nothing", async () => {
    const r = await receiver(201);
    const a = await uploadResult(result, { [UPLOAD_URL_ENV]: `${r.origin}/api/v1` });
    expect(a.line).toBe(`Not uploaded: set ${UPLOAD_TOKEN_ENV} to the site's upload token.`);
    const b = await uploadResult(result, { [UPLOAD_TOKEN_ENV]: TOKEN });
    expect(b.line).toBe(`Not uploaded: set ${UPLOAD_URL_ENV} to the hosted app's API address.`);
    expect(r.seen).toHaveLength(0);
  });

  it("the token only travels over https, or to this machine", async () => {
    const out = await uploadResult(result, {
      [UPLOAD_TOKEN_ENV]: TOKEN,
      [UPLOAD_URL_ENV]: "http://hosted.example/api/v1",
    });
    expect(out.ok).toBe(false);
    expect(out.line).toBe(`Not uploaded: ${UPLOAD_URL_ENV} must be an https address.`);
    const junk = await uploadResult(result, {
      [UPLOAD_TOKEN_ENV]: TOKEN,
      [UPLOAD_URL_ENV]: "not an address",
    });
    expect(junk.line).toBe(`Not uploaded: ${UPLOAD_URL_ENV} must be an https address.`);
  });

  it("refuses to send a result that contains the value of a key in the environment, and names the variable only", async () => {
    const r = await receiver(201);
    const value = ["Zq9", "Lm2", "Xv7", "Kp4"].join("");
    const leaky = buildResult({
      url: "https://tidewater-bar.test/",
      startedAt: new Date(0),
      findings: [
        {
          checkId: "broken-links",
          severity: "low",
          title: "x",
          evidence: `the page printed ${value}`,
          url: "https://tidewater-bar.test/",
        },
      ],
      passed: [],
      failed: [],
    });
    const out = await uploadResult(leaky, {
      [UPLOAD_TOKEN_ENV]: TOKEN,
      [UPLOAD_URL_ENV]: `${r.origin}/api/v1`,
      MY_SERVICE_API_KEY: value,
    });
    expect(out.ok).toBe(false);
    expect(out.line).toBe(
      "Not uploaded: the result contains the value of MY_SERVICE_API_KEY, so nothing was sent.",
    );
    expect(out.line).not.toContain(value);
    expect(r.seen).toHaveLength(0);
  });

  it("never throws, whatever the environment holds", async () => {
    const out = await uploadResult(result, {
      [UPLOAD_TOKEN_ENV]: TOKEN,
      [UPLOAD_URL_ENV]: "https://[bad",
    });
    expect(out.ok).toBe(false);
  });
});
