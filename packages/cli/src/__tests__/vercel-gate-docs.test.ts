import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${p}`, import.meta.url)), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const page = read("docs/guides/vercel-gate.md");
const template = read("examples/workflows/vercel-gate.yml");

describe("docs/guides/vercel-gate.md", () => {
  it("has a freelancer example with a runnable command and says what is not built", () => {
    expect(page).toMatch(/pop-up/i);
    expect(
      page.match(/^\$ npx gaugeline deploy-gate .* --block$/gm)?.length,
    ).toBeGreaterThanOrEqual(1);
    expect(page).toMatch(/Deferred to v1\.1/);
    expect(page).toMatch(/Checks API/);
    expect(page).toMatch(/writes nothing/i);
    expect(page).toMatch(/uncited/);
    expect(page).toMatch(/only on (sites|previews) you own or have permission to test/i);
  });

  it("shows the template file as it is, so the page and the file cannot drift", () => {
    expect(page).toContain(template.trimEnd());
  });

  it("is linked from the nav and from the deploy gates guide", () => {
    expect(read("docs/nav.ts")).toContain('"guides/vercel-gate"');
    expect(read("docs/guides/deploy-gates.md")).toContain("vercel-gate");
  });
});

describe("the Vercel gate, with the built CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-vgate-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("a preview that still carries a noindex: exit 1, and only GET and HEAD were sent", async () => {
    const site = await startFixture("vercel-noindex-preview");
    try {
      const r = await runBin(
        ["deploy-gate", site.origin, "--allow-private", "--block"],
        { VERCEL_ENV: "preview", CI: "true" },
        { cwd: dir },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/gate: blocked \(1 fix-first finding\)/);
      expect(r.stdout).toMatch(/noindex/i);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("--format sarif keeps the exit code and writes a SARIF log with the noindex result", async () => {
    const site = await startFixture("vercel-noindex-preview");
    try {
      const r = await runBin(
        ["deploy-gate", site.origin, "--allow-private", "--block", "--format", "sarif"],
        { VERCEL_ENV: "preview" },
        { cwd: dir },
      );
      expect(r.status).toBe(1);
      const log = JSON.parse(r.stdout) as { version: string; runs: { results: unknown[] }[] };
      expect(log.version).toBe("2.1.0");
      expect(JSON.stringify(log.runs[0]?.results)).toMatch(/noindex/i);
    } finally {
      await site.close();
    }
  });

  it("a clean preview: exit 0 with --block", async () => {
    const site = await startFixture("clean");
    try {
      const r = await runBin(
        ["deploy-gate", site.origin, "--allow-private", "--block"],
        { VERCEL_ENV: "preview" },
        { cwd: dir },
      );
      expect(r.status).toBe(0);
    } finally {
      await site.close();
    }
  });

  it("a preview that does not answer is exit 2, never a pass", async () => {
    const site = await startFixture("clean");
    const origin = site.origin;
    await site.close();
    const r = await runBin(
      ["deploy-gate", origin, "--allow-private", "--block"],
      { VERCEL_ENV: "preview" },
      { cwd: dir },
    );
    expect(r.status).toBe(2);
  });

  it("the production deployment is refused before any request, even with an address typed", async () => {
    const site = await startFixture("vercel-noindex-preview");
    try {
      const r = await runBin(
        ["deploy-gate", site.origin, "--allow-private", "--block"],
        { VERCEL_ENV: "production" },
        { cwd: dir },
      );
      expect(r.status).toBe(2);
      expect(site.total).toBe(0);
    } finally {
      await site.close();
    }
  });
});
