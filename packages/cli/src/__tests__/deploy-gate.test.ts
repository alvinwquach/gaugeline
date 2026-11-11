import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { resolveDeployGate } from "../deploy-gate.js";
import { main } from "../main.js";

type Env = Record<string, string | undefined>;
const resolveOk = (env: Env, typed?: string, allowPrivate = false) => {
  const r = resolveDeployGate(env, typed, { allowPrivate });
  if (!r.ok) throw new Error(`expected a resolution, got: ${r.message}`);
  return r;
};
const resolveBad = (env: Env, typed?: string, allowPrivate = false) => {
  const r = resolveDeployGate(env, typed, { allowPrivate });
  if (r.ok) throw new Error(`expected a refusal, got ${r.address}`);
  return r;
};

describe("deploy-gate: the address from each host's variables", () => {
  it("Vercel: VERCEL_URL has no scheme, https is added", () => {
    const r = resolveOk({
      VERCEL_ENV: "preview",
      VERCEL_URL: "brightside-abc123-studio.vercel.app",
    });
    expect(r).toMatchObject({
      host: "vercel",
      source: "environment",
      address: "https://brightside-abc123-studio.vercel.app/",
    });
  });
  it("Netlify: DEPLOY_PRIME_URL on a deploy preview and on a branch deploy", () => {
    for (const context of ["deploy-preview", "branch-deploy"]) {
      const r = resolveOk({
        NETLIFY: "true",
        CONTEXT: context,
        DEPLOY_PRIME_URL: "https://deploy-preview-7--brightside.netlify.app",
      });
      expect(r).toMatchObject({
        host: "netlify",
        address: "https://deploy-preview-7--brightside.netlify.app/",
      });
    }
  });
  it("Netlify: DEPLOY_URL is used when DEPLOY_PRIME_URL is missing", () => {
    const r = resolveOk({
      CONTEXT: "deploy-preview",
      DEPLOY_URL: "https://64f0--brightside.netlify.app",
    });
    expect(r.address).toBe("https://64f0--brightside.netlify.app/");
  });
  it("Cloudflare Pages: CF_PAGES_URL on a branch that is not the production branch", () => {
    const r = resolveOk({
      CF_PAGES: "1",
      CF_PAGES_BRANCH: "new-prices",
      CF_PAGES_URL: "https://1a2b3c4d.brightside.pages.dev",
    });
    expect(r).toMatchObject({
      host: "cloudflare-pages",
      address: "https://1a2b3c4d.brightside.pages.dev/",
    });
  });
  it("an address typed on the command line wins over the variables, and the host is still named", () => {
    const r = resolveOk(
      { VERCEL_ENV: "preview", VERCEL_URL: "from-env.vercel.app" },
      "https://typed.example/",
    );
    expect(r).toMatchObject({
      source: "argument",
      host: "vercel",
      address: "https://typed.example/",
    });
  });
  it("an address typed with no scheme is checked as https", () => {
    expect(resolveOk({}, "preview.brightside.example")).toMatchObject({
      source: "argument",
      address: "https://preview.brightside.example/",
    });
  });
});

describe("deploy-gate: production is refused", () => {
  const cases: [string, Env][] = [
    ["Vercel", { VERCEL_ENV: "production", VERCEL_URL: "brightside.vercel.app" }],
    [
      "Netlify",
      {
        NETLIFY: "true",
        CONTEXT: "production",
        DEPLOY_PRIME_URL: "https://brightside.netlify.app",
      },
    ],
    [
      "Cloudflare Pages (main)",
      { CF_PAGES: "1", CF_PAGES_BRANCH: "main", CF_PAGES_URL: "https://x.brightside.pages.dev" },
    ],
    [
      "Cloudflare Pages (master)",
      { CF_PAGES: "1", CF_PAGES_BRANCH: "master", CF_PAGES_URL: "https://x.brightside.pages.dev" },
    ],
  ];
  for (const [name, env] of cases) {
    it(`${name}: no address, exit 2 with a plain message`, () => {
      const r = resolveBad(env);
      expect(r.message).toMatch(/production/i);
      expect(r.message).toMatch(/preview/i);
    });
    it(`${name}: a typed address does not get round it`, () => {
      expect(resolveBad(env, "https://typed.example/").message).toMatch(/production/i);
    });
  }
  it("a context that is not a preview (Vercel development, Netlify dev) is refused too", () => {
    expect(resolveBad({ VERCEL_ENV: "development", VERCEL_URL: "x.vercel.app" }).message).toMatch(
      /development/,
    );
    expect(
      resolveBad({ CONTEXT: "dev", DEPLOY_PRIME_URL: "https://x.netlify.app" }).message,
    ).toMatch(/dev/);
  });
});

describe("deploy-gate: edge cases", () => {
  it("no address and no host variables: says what to do", () => {
    const r = resolveBad({});
    expect(r.message).toMatch(/no address/i);
    expect(r.hint).toMatch(/VERCEL_URL|DEPLOY_PRIME_URL|CF_PAGES_URL/);
  });
  it("more than one host's variables and no address: refuses to guess", () => {
    const r = resolveBad({
      VERCEL_ENV: "preview",
      VERCEL_URL: "a.vercel.app",
      NETLIFY: "true",
      CONTEXT: "deploy-preview",
      DEPLOY_PRIME_URL: "https://b.netlify.app",
    });
    expect(r.message).toMatch(/more than one/i);
    expect(r.message).toMatch(/Vercel/);
    expect(r.message).toMatch(/Netlify/);
  });
  it("more than one host with an address typed: production on either still refuses", () => {
    const r = resolveBad(
      { VERCEL_ENV: "preview", VERCEL_URL: "a.vercel.app", NETLIFY: "true", CONTEXT: "production" },
      "https://typed.example/",
    );
    expect(r.message).toMatch(/production/i);
  });
  it("the variable is missing or empty: names the variable", () => {
    expect(resolveBad({ VERCEL_ENV: "preview" }).message).toMatch(/VERCEL_URL/);
    expect(resolveBad({ VERCEL_ENV: "preview", VERCEL_URL: "  " }).message).toMatch(/VERCEL_URL/);
    expect(resolveBad({ CONTEXT: "deploy-preview" }).message).toMatch(/DEPLOY_PRIME_URL/);
    expect(resolveBad({ CF_PAGES: "1", CF_PAGES_BRANCH: "x" }).message).toMatch(/CF_PAGES_URL/);
  });
  it("a value with a user name or password is refused, and the message never repeats it", () => {
    const secret = ["hunter", "2"].join("");
    const r = resolveBad({
      CONTEXT: "deploy-preview",
      DEPLOY_PRIME_URL: `https://deploy:${secret}@brightside.netlify.app`,
    });
    expect(r.message).toMatch(/DEPLOY_PRIME_URL/);
    expect(JSON.stringify(r)).not.toContain(secret);
  });
  it("malformed values are refused by variable name: a path, a query, plain http, a space, junk", () => {
    const bad = [
      "https://x.netlify.app/some/path",
      "https://x.netlify.app/?token=abc",
      "https://x.netlify.app/#frag",
      "http://x.netlify.app",
      "https://x .netlify.app",
      "not a url",
      "ftp://x.netlify.app",
    ];
    for (const value of bad) {
      const r = resolveBad({ CONTEXT: "deploy-preview", DEPLOY_PRIME_URL: value });
      expect(r.message).toMatch(/DEPLOY_PRIME_URL/);
      expect(r.message).not.toContain(value);
    }
  });
  it("http is accepted only with --allow-private (a local fixture)", () => {
    const env = { CONTEXT: "deploy-preview", DEPLOY_PRIME_URL: "http://127.0.0.1:8123" };
    expect(resolveBad(env).message).toMatch(/https/);
    expect(resolveOk(env, undefined, true).address).toBe("http://127.0.0.1:8123/");
  });
  it("a typed address with a user name is refused", () => {
    expect(
      resolveBad({}, ["https://me:pw", "x.example/"].join(String.fromCharCode(64))).message,
    ).toMatch(/user name|password/i);
  });
});

describe("deploy-gate: the command line", () => {
  it("is report only: --block turns blocking on, and CI alone does not", () => {
    const env = { VERCEL_ENV: "preview", VERCEL_URL: "a.vercel.app", CI: "true" };
    const off = parseCliArgs(["deploy-gate"], env);
    expect(off).toMatchObject({ kind: "run", command: "deploy-gate", ci: false, noOpen: true });
    const on = parseCliArgs(["deploy-gate", "--block"], env);
    expect(on).toMatchObject({ kind: "run", ci: true });
  });
  it("GAUGELINE_GATE_BLOCK turns blocking on", () => {
    const on = parseCliArgs(["deploy-gate", "https://a.example"], { GAUGELINE_GATE_BLOCK: "1" });
    expect(on).toMatchObject({ kind: "run", ci: true });
  });
  it("--ci is refused with a pointer to --block", () => {
    const r = parseCliArgs(["deploy-gate", "https://a.example", "--ci"], {});
    expect(r).toMatchObject({ kind: "error" });
    expect(JSON.stringify(r)).toMatch(/--block/);
  });
  it("more than one address is an error", () => {
    expect(parseCliArgs(["deploy-gate", "a.example", "b.example"], {}).kind).toBe("error");
  });
  it("a refusal from the resolver is an error (exit 2), not a run", () => {
    expect(parseCliArgs(["deploy-gate"], {}).kind).toBe("error");
  });
});

describe("deploy-gate: a preview served locally", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-gate-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function gate(fixture: string, argv: string[], envFor: (origin: string) => Env) {
    const site = await startFixture(fixture);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        ["deploy-gate", ...argv],
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: (s: string) => err.push(s) },
          env: { NO_COLOR: "1", ...envFor(site.origin) },
        },
        { cwd: dir },
      );
      return {
        code,
        out: out.join(""),
        err: err.join(""),
        site,
        methods: [...site.methods.keys()],
      };
    } finally {
      await site.close();
    }
  }
  const netlify = (origin: string): Env => ({
    NETLIFY: "true",
    CONTEXT: "deploy-preview",
    DEPLOY_PRIME_URL: origin,
  });

  it("report only: findings, a would-block verdict, and exit 0", async () => {
    const r = await gate("deploy-preview-dentist", ["--allow-private"], netlify);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/gate: would block \(1 fix-first finding\)/);
    expect(r.out).toMatch(/Links on this page go nowhere/);
    expect(r.out).toMatch(/no <link rel="canonical">/);
    expect(r.methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
  });
  it("--block: the same run exits 1", async () => {
    const r = await gate("deploy-preview-dentist", ["--allow-private", "--block"], netlify);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/gate: blocked \(1 fix-first finding\)/);
  });
  it("a clean preview: gate clear, exit 0 with or without --block", async () => {
    for (const extra of [[], ["--block"]]) {
      const r = await gate("clean", ["--allow-private", ...extra], netlify);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/gate: clear/);
    }
  });
  it("an address typed on the command line is the one checked", async () => {
    const site = await startFixture("clean");
    try {
      const out: string[] = [];
      const code = await main(
        ["deploy-gate", site.origin, "--allow-private"],
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: () => true },
          env: { NO_COLOR: "1" },
        },
        { cwd: dir },
      );
      expect(code).toBe(0);
      expect(out.join("")).toMatch(/gate: clear/);
      expect(site.total).toBeGreaterThan(0);
    } finally {
      await site.close();
    }
  });
  it("--json keeps stdout to the JSON and puts the verdict on stderr", async () => {
    const r = await gate("deploy-preview-dentist", ["--allow-private", "--json"], netlify);
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.err).toMatch(/gate: would block/);
  });
  it("the private-address refusal still applies without --allow-private: exit 2", async () => {
    const r = await gate("clean", [], netlify);
    expect(r.code).toBe(2);
  });
  it("production is refused before any request", async () => {
    const r = await gate("clean", ["--allow-private"], (origin) => ({
      ...netlify(origin),
      CONTEXT: "production",
    }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/production/i);
    expect(r.site.total).toBe(0);
  });
  it("no address and no variables: exit 2, no request, a clear message", async () => {
    const r = await gate("clean", ["--allow-private"], () => ({}));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no address/i);
    expect(r.site.total).toBe(0);
  });
  it("probing checks stay off unless --owner-consent is passed", async () => {
    const r = await gate("clean", ["--allow-private"], netlify);
    expect(r.err).not.toMatch(/Probing checks are on/);
    const on = await gate("clean", ["--allow-private", "--owner-consent"], netlify);
    expect(on.err).toMatch(/Probing checks are on/);
  });
  it("names the host and the address, and never a variable's value other than the address", async () => {
    const r = await gate("clean", ["--allow-private"], (origin) => ({
      ...netlify(origin),
      DEPLOY_TOKEN: ["tok", "en-value"].join(""),
    }));
    expect(r.out + r.err).toMatch(/Netlify/);
    expect(r.out + r.err).not.toContain("token-value");
  });
});
