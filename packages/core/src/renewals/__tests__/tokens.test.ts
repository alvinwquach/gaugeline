import { describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import {
  GITHUB_TOKEN_VAR,
  VERCEL_TOKEN_VAR,
  parseGithubExpiry,
  parseVercelExpiry,
  readGithubToken,
  readVercelProject,
  readVercelToken,
} from "../tokens.js";
import { fakeKey, recordedTransport } from "./recorded.js";

const GH = fakeKey("github", "_pat_", "TESTONLY", "abc123");
const VC = fakeKey("vercel", "-test-", "token", "xyz789");
const ENV = { [GITHUB_TOKEN_VAR]: GH, [VERCEL_TOKEN_VAR]: VC };

describe("token expiry parsing: unit", () => {
  it("reads GitHub's header with UTC or with an offset", () => {
    expect(parseGithubExpiry("2026-12-03 00:00:00 UTC")).toBe("2026-12-03T00:00:00.000Z");
    expect(parseGithubExpiry("2026-12-03 08:30:00 -0800")).toBe("2026-12-03T16:30:00.000Z");
    expect(parseGithubExpiry("2026-12-03 08:30:00 +0100")).toBe("2026-12-03T07:30:00.000Z");
  });

  it("has no expiry for a header that is absent or not a date", () => {
    expect(parseGithubExpiry(undefined)).toBeUndefined();
    expect(parseGithubExpiry("")).toBeUndefined();
    expect(parseGithubExpiry("never")).toBeUndefined();
  });

  it("reads Vercel's expiresAt in milliseconds (or seconds)", () => {
    expect(parseVercelExpiry(1796256000000)).toBe("2026-12-03T00:00:00.000Z");
    expect(parseVercelExpiry(1796256000)).toBe("2026-12-03T00:00:00.000Z");
    expect(parseVercelExpiry(undefined)).toBeUndefined();
    expect(parseVercelExpiry(null)).toBeUndefined();
    expect(parseVercelExpiry(0)).toBeUndefined();
    expect(parseVercelExpiry("2026-12-03")).toBeUndefined();
  });
});

describe("token reads: integration (recorded responses)", () => {
  it("reads the GitHub token's expiry from the response header, and only asks /rate_limit", async () => {
    const { transport, seen } = recordedTransport({
      "GET https://api.github.com/rate_limit": {
        status: 200,
        headers: { "github-authentication-token-expiration": "2026-12-03 00:00:00 UTC" },
        body: { resources: { core: { limit: 5000, remaining: 4999 } } },
      },
    });
    const read = await readGithubToken(ENV, createFetcher({ transport }));
    expect(read).toEqual({
      provider: "GitHub",
      variable: GITHUB_TOKEN_VAR,
      expiresAt: "2026-12-03T00:00:00.000Z",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${GH}`);
    expect(JSON.stringify(read)).not.toContain(GH);
  });

  it("reports no expiry when GitHub sends no header (a token that does not expire)", async () => {
    const { transport } = recordedTransport({
      "GET https://api.github.com/rate_limit": { status: 200, body: {} },
    });
    const read = await readGithubToken(ENV, createFetcher({ transport }));
    expect(read).toEqual({ provider: "GitHub", variable: GITHUB_TOKEN_VAR });
  });

  it("reads Vercel's token metadata and keeps only the date", async () => {
    const { transport, seen } = recordedTransport({
      "GET https://api.vercel.com/v5/user/tokens/current": {
        status: 200,
        body: {
          token: {
            id: "tok_invented",
            name: "ci-deploy",
            type: "oauth2-token",
            scopes: [{ type: "team", teamId: "team_invented" }],
            expiresAt: 1796256000000,
          },
        },
      },
    });
    const read = await readVercelToken(ENV, createFetcher({ transport }));
    expect(read).toEqual({
      provider: "Vercel",
      variable: VERCEL_TOKEN_VAR,
      expiresAt: "2026-12-03T00:00:00.000Z",
    });
    expect(JSON.stringify(read)).not.toContain("ci-deploy");
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("reads no token that is not set", () => {
    const f = createFetcher({ transport: recordedTransport({}).transport });
    expect(readGithubToken({}, f)).toBeUndefined();
    expect(readVercelToken({ [VERCEL_TOKEN_VAR]: "  " }, f)).toBeUndefined();
  });

  it("says a refused token was refused, without the token in the sentence", async () => {
    const { transport } = recordedTransport({
      "GET https://api.github.com/rate_limit": { status: 401, body: { message: GH } },
    });
    const read = await readGithubToken(ENV, createFetcher({ transport }));
    expect(read?.failed).toMatch(/GitHub could not be read: .*HTTP 401/);
    expect(read?.expiresAt).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain(GH);
  });

  it("reads a project's Node.js version, with the team in the query, and nothing else", async () => {
    const { transport, seen } = recordedTransport({
      "GET https://api.vercel.com/v9/projects/marlowe-bar-site?teamId=team_invented": {
        status: 200,
        body: { name: "marlowe-bar-site", nodeVersion: "18.x", link: { repo: "invented/repo" } },
      },
    });
    const read = await readVercelProject(
      ENV,
      createFetcher({ transport }),
      "marlowe-bar-site",
      "team_invented",
    );
    expect(read).toEqual({ project: "marlowe-bar-site", nodeVersion: "18.x" });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${VC}`);
  });

  it("is a failure, not a guess, when a project has no version or cannot be read", async () => {
    const { transport } = recordedTransport({
      "GET https://api.vercel.com/v9/projects/no-version": { status: 200, body: { name: "x" } },
      "GET https://api.vercel.com/v9/projects/gone": { status: 404, body: {} },
    });
    const f = createFetcher({ transport });
    expect((await readVercelProject(ENV, f, "no-version")).failed).toMatch(/did not report a Node/);
    expect((await readVercelProject(ENV, f, "gone")).failed).toMatch(/HTTP 404/);
  });
});
