import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CheckRegistry,
  createPageRegistry,
  defineCheck,
  resultSchema,
  type PageSnapshot,
} from "@gaugeline/core";
import {
  html,
  redirect,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";
import { isCiEnv, main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
const cleanPage =
  (path: string, extraHead = "") =>
  (origin: string) =>
    `<html><head><title>Fixture Cafe</title><meta name="viewport" content="width=device-width"><meta property="og:image" content="${origin}/og.png"><link rel="canonical" href="${origin}${path}">${extraHead}</head><body><main><h1>Fixture Cafe</h1><p>${words}</p></main></body></html>`;

let site: FixtureServer;
beforeAll(async () => {
  const routes: Parameters<typeof startServer>[0] = {
    "/": (_q, res) =>
      void res.writeHead(200, { "content-type": "text/html" }).end(cleanPage("/")(site.origin)),
    // The "high finding" page has a wrong canonical; everything else about it is clean.
    "/sitemap.xml": (_q, res) =>
      void res
        .writeHead(200, { "content-type": "application/xml" })
        .end(`<urlset><url><loc>${site.origin}/</loc></url></urlset>`),
    "/wrong-canonical": (_q, res) =>
      void res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          cleanPage("/wrong-canonical")(site.origin).replace(
            /href="[^"]*\/wrong-canonical"/,
            'href="https://other.example/"',
          ),
        ),
    "/hop1": redirect(301, "/hop2"),
    "/hop2": redirect(301, "/"),
    "/plain": html("<p>x</p>"),
    "/og.png": (_q, res) => void res.writeHead(200, { "content-type": "image/png" }).end(""),
  };
  site = await startServer(routes);
});
afterAll(() => site.close());

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../core/schema/result.v2.json", import.meta.url)),
    "utf8",
  ),
) as object;
function validator() {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("cli: e2e (built bin against the fixture server)", () => {
  it("clean fixture: exit 0, stdout contains a tick line", async () => {
    const r = await runBin([`${site.origin}/`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^✓ canonical-elsewhere$/m);
    expect(r.stdout).toContain("Nothing to look at.");
  });

  it("high finding without --ci: exit 0", async () => {
    const r = await runBin([`${site.origin}/wrong-canonical`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✗ This page tells Google to show a different page");
  });

  it("high finding with --ci: exit 1", async () => {
    expect((await runBin([`${site.origin}/wrong-canonical`, "--ci"])).status).toBe(1);
  });

  it("CI=true in the environment behaves like --ci", async () => {
    expect((await runBin([`${site.origin}/wrong-canonical`], { CI: "true" })).status).toBe(1);
  });

  it("unreachable host: exit 2 and a one-line reason on stderr", async () => {
    const closed = await startServer({});
    const origin = closed.origin;
    await closed.close();
    const r = await runBin([origin]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("refused the connection.");
  });

  it("--json output parses and matches the zod schema and result.v2.json; stdout has no other bytes", async () => {
    const r = await runBin([`${site.origin}/wrong-canonical`, "--json"]);
    expect(r.status).toBe(0);
    const parsed: unknown = JSON.parse(r.stdout);
    expect(resultSchema.safeParse(parsed).success).toBe(true);
    const validate = validator();
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true);
    expect(r.stdout.trim().startsWith("{")).toBe(true);
    expect(r.stdout.trim().endsWith("}")).toBe(true);
    expect((parsed as { findings: { checkId: string }[] }).findings.map((f) => f.checkId)).toEqual([
      "canonical-elsewhere",
    ]);
  });

  it("--json with zero findings validates against result.v2.json (deferred from G02a)", async () => {
    const r = await runBin([`${site.origin}/`, "--json"]);
    const parsed = JSON.parse(r.stdout) as { findings: unknown[] };
    expect(parsed.findings).toEqual([]);
    expect(validator()(parsed)).toBe(true);
  });

  it("--json where one check failed to execute validates and failed is non-empty (deferred from G02a)", async () => {
    const registry = new CheckRegistry();
    for (const c of createPageRegistry().all()) registry.register(c);
    registry.register(
      defineCheck<PageSnapshot>({
        id: "always-throws",
        area: "Visitors",
        severity: "low",
        title: "t",
        what: "w",
        why: "y",
        fix: "f",
        tech: "t",
        size: "S",
        done: "Done.",
        estimateChanges: "Nothing.",
        run: () => {
          throw new Error("boom");
        },
      }),
    );
    const out: string[] = [];
    const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => true } };
    expect(await main([`${site.origin}/`, "--json", "--allow-private"], io, { registry })).toBe(0);
    const parsed = JSON.parse(out.join("")) as { failed: string[] };
    // Without --dns the mail record checks are listed as not run, never hidden.
    expect(parsed.failed).toEqual([
      "always-throws",
      "email-spf-missing",
      "email-spf-multiple",
      "email-dmarc-missing",
      "email-dmarc-none",
    ]);
    expect(validator()(parsed)).toBe(true);
  });

  it("--no-open is accepted", async () => {
    expect((await runBin([`${site.origin}/`, "--no-open"])).status).toBe(0);
  });
});

describe("cli: edge cases", () => {
  it("only medium findings with --ci: exit 0 (full check set, in process)", async () => {
    const out: string[] = [];
    const io = { stdout: { write: (x: string) => out.push(x) }, stderr: { write: () => true } };
    const code = await main([`${site.origin}/hop1`, "--ci", "--allow-private"], io, {
      registry: createPageRegistry(),
    });
    expect(out.join("")).toContain("! Your address takes several jumps to load");
    expect(out.join("")).not.toContain("\u2717");
    expect(code).toBe(0);
  });

  it("output piped to a file has no ANSI codes", async () => {
    const r = await runBin([`${site.origin}/wrong-canonical`]);
    expect(r.stdout).not.toContain("\u001b[");
    expect(r.stderr).not.toContain("\u001b[");
  });

  it("NO_COLOR wins over FORCE_COLOR; FORCE_COLOR adds colour to a pipe", async () => {
    expect(
      (await runBin([`${site.origin}/wrong-canonical`], { FORCE_COLOR: "1" })).stdout,
    ).toContain("\u001b[");
    expect(
      (await runBin([`${site.origin}/wrong-canonical`], { FORCE_COLOR: "1", NO_COLOR: "1" }))
        .stdout,
    ).not.toContain("\u001b[");
  });

  it("CI=false and CI=0 are not CI", () => {
    expect(isCiEnv({ CI: "false" })).toBe(false);
    expect(isCiEnv({ CI: "0" })).toBe(false);
    expect(isCiEnv({ CI: "" })).toBe(false);
    expect(isCiEnv({ CI: "1" })).toBe(true);
    expect(isCiEnv({})).toBe(false);
  });
});

describe("cli: blocked addresses", () => {
  it("a private address without --allow-private exits 2 with a one-line reason, never a crash", async () => {
    const r = await runBin([`http://[::ffff:127.0.0.1]:${site.port}/`]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("points at a loopback address");
    expect(r.stderr).toContain(
      "Try: To check a site on your own computer or network, add --allow-private.",
    );
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe("cli: install paths", () => {
  it("the bundled bin runs from a folder whose path has spaces", async () => {
    const { copyFileSync, mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { bin } = await import("./helpers/bin.js");
    const root = mkdtempSync(join(tmpdir(), "gaugeline e2e "));
    try {
      const dir = join(root, "node modules", "gaugeline with space", "dist");
      mkdirSync(dir, { recursive: true });
      copyFileSync(bin, join(dir, "index.js"));
      // As installed: the package's own package.json says the bundle is an ES module.
      copyFileSync(join(bin, "..", "..", "package.json"), join(dir, "..", "package.json"));
      const r = await promisify(execFile)(
        process.execPath,
        [join(dir, "index.js"), `${site.origin}/`, "--allow-private"],
        {
          encoding: "utf8",
          env: { ...process.env, CI: "" },
        },
      );
      expect(r.stdout).toContain("Nothing to look at.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
