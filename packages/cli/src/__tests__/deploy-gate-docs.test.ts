import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedOutput, startFixture } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/deploy-gates.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

describe("docs/options.md: gaugeline deploy-gate --help", () => {
  it("shows exactly what the built bin prints, and every flag of the command is in --help and in the table", async () => {
    const r = await runBin(["deploy-gate", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP["deploy-gate"]);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The deploy-gate command"));
    const options = readFileSync(
      fileURLToPath(new URL("../../../../docs/options.md", import.meta.url)),
      "utf8",
    );
    for (const f of flagsFor(FLAGS, "deploy-gate")) {
      expect(HELP["deploy-gate"], `--${f.name} in --help`).toContain(`--${f.name}`);
      expect(options, `--${f.name} in docs/options.md`).toContain(`\`--${f.name}`);
    }
  });
});

describe("docs/guides/deploy-gates.md", () => {
  it("has the freelancer example, every host and the flags that matter", () => {
    expect(page).toMatch(/dentist/i);
    expect(page.match(/^\$ npx gaugeline deploy-gate /gm)?.length).toBeGreaterThanOrEqual(1);
    for (const name of ["VERCEL_ENV", "VERCEL_URL", "CONTEXT", "DEPLOY_PRIME_URL", "CF_PAGES_URL"])
      expect(page, name).toContain(name);
    for (const f of ["--block", "--owner-consent", "--allow-private"]) expect(page).toContain(f);
    expect(page).toMatch(/report only/i);
    expect(page).toMatch(/uncited/);
  });
});

describe("gaugeline deploy-gate: the built CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-gate-e2e-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const preview = (origin: string) => ({
    NETLIFY: "true",
    CONTEXT: "deploy-preview",
    DEPLOY_PRIME_URL: origin,
    // A job that sets CI must not turn blocking on.
    CI: "true",
  });

  it("report only: exit 0 with fix-first findings, and CI=true does not block", async () => {
    const site = await startFixture("deploy-preview-dentist");
    try {
      const r = await runBin(["deploy-gate", "--allow-private"], preview(site.origin), {
        cwd: dir,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/gate: would block \(1 fix-first finding\)/);
    } finally {
      await site.close();
    }
  });
  it("--block exits 1, and GAUGELINE_GATE_BLOCK does the same", async () => {
    const site = await startFixture("deploy-preview-dentist");
    try {
      const flag = await runBin(
        ["deploy-gate", "--allow-private", "--block"],
        preview(site.origin),
        { cwd: dir },
      );
      expect(flag.status).toBe(1);
      expect(flag.stdout).toMatch(/gate: blocked/);
      const env = await runBin(
        ["deploy-gate", "--allow-private"],
        { ...preview(site.origin), GAUGELINE_GATE_BLOCK: "1" },
        { cwd: dir },
      );
      expect(env.status).toBe(1);
    } finally {
      await site.close();
    }
  });
  it("production: exit 2 and nothing was requested", async () => {
    const site = await startFixture("clean");
    try {
      const r = await runBin(
        ["deploy-gate", "--allow-private", "--block"],
        { ...preview(site.origin), CONTEXT: "production" },
        { cwd: dir },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/production/i);
      expect(site.total).toBe(0);
    } finally {
      await site.close();
    }
  });
  it("no address and no variables: exit 2 with a message", async () => {
    const r = await runBin(["deploy-gate"], {}, { cwd: dir });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/No address was given/);
  });
});

describe("gaugeline deploy-gate: a protected Vercel preview", () => {
  it("the bypass secret from the environment opens it and reaches no output", async () => {
    const secret = "gaugeline-fixture-bypass-0001";
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-gate-auth-")));
    const site = await startFixture("preview-vercel");
    try {
      const out: string[] = [];
      const err: string[] = [];
      const run = (env: Record<string, string>) =>
        main(
          ["deploy-gate", site.origin, "--allow-private"],
          {
            stdout: { write: (s: string) => out.push(s) },
            stderr: { write: (s: string) => err.push(s) },
            env: { NO_COLOR: "1", VERCEL_ENV: "preview", VERCEL_URL: "x.vercel.app", ...env },
          },
          { cwd: dir },
        );
      expect(await run({ GAUGELINE_VERCEL_BYPASS: secret })).toBe(0);
      expect(out.join("") + err.join("")).not.toContain(secret);
      expect(out.join("")).toMatch(/gate: /);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    } finally {
      await site.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
