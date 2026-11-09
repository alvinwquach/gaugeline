import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SAVED_PAGE_BYTES,
  REQUESTS_FILE_SCHEMA_VERSION,
  requestsFileSchema,
  type RequestsFile,
} from "@gaugeline/core";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import { parseCliArgs } from "../args.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const servers: FixtureServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gaugeline-save-requests-"));
  dirs.push(d);
  return d;
};

// Put together at run time, so no key-shaped string is in the repository.
const IN_BODY = ["sk", "live", "SaveRequestsBodyNotAKey00"].join("_");
const IN_BLOCK = ["sk", "live", "SaveRequestsBlockNotAKey0"].join("_");
const IN_HEADER = ["ghp", "SaveRequestsHeaderNotAToken0000000000"].join("_");
const IN_QUERY = "hunter2querysecretvalue";
const IN_REDIRECT = "hunter2redirectsecretvalue";
const SECRETS = [IN_BODY, IN_BLOCK, IN_HEADER, IN_QUERY, IN_REDIRECT];

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        `../../../core/schema/requests.v${REQUESTS_FILE_SCHEMA_VERSION}.json`,
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as object;
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

const NOW = new Date("2026-11-09T20:00:00Z");

/** A small invented site with a planted secret in a link's query string, the body, a data block, a header and a redirect. */
async function site(extraHead = "") {
  const server = await startServer(
    {
      "/": (_req: IncomingMessage, res: ServerResponse) => {
        res
          .writeHead(200, { "content-type": "text/html", "x-debug-token": IN_HEADER })
          .end(
            `<html><head><title>Fernkiln Studio</title><link rel="canonical" href="/">${extraHead}<script type="application/ld+json">${JSON.stringify({ "@type": "Organization", name: "Fernkiln", note: IN_BLOCK })}</script></head><body><main><h1>Fernkiln Studio</h1><p>Hand thrown bowls. Our test key is ${IN_BODY} for the demo shop.</p><a href="/next?token=${IN_QUERY}&page=2">Next</a> <a href="/old">Old page</a></main></body></html>`,
          );
      },
      "/old": (_req: IncomingMessage, res: ServerResponse) => {
        res
          .writeHead(301, {
            location: `/landing?api_key=${IN_REDIRECT}`,
            "x-debug-token": IN_HEADER,
          })
          .end();
      },
    },
    (_req, res) => {
      res
        .writeHead(200, { "content-type": "text/html", "x-debug-token": IN_HEADER })
        .end("<html><head><title>Inner</title></head><body><p>Inner page.</p></body></html>");
    },
  );
  servers.push(server);
  return server;
}

async function run(argv: string[], cwd: string, deps: { now?: () => Date } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
      now: () => NOW,
    },
    { cwd, ...deps },
  );
  return { code, out: out.join(""), err: err.join("") };
}
const check = (origin: string, cwd: string, flags: string[]) =>
  run([origin, "--no-open", "--allow-private", ...flags], cwd);
const saved = (path: string) => JSON.parse(readFileSync(path, "utf8")) as RequestsFile;

describe("--save-requests: off by default", () => {
  it("without the flag nothing is written: the folder holds the report and nothing else", async () => {
    const server = await site();
    const cwd = tmp();
    const r = await check(server.origin, cwd, []);
    expect(r.code).toBe(0);
    expect(readdirSync(cwd)).toEqual(["gaugeline-report.html"]);
    expect(r.err).not.toContain("equest log");
  });

  it("with --json and no flag the folder stays empty", async () => {
    const server = await site();
    const cwd = tmp();
    await check(server.origin, cwd, ["--json"]);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("the built bin writes nothing either, in the folder it runs from", async () => {
    const server = await site();
    const cwd = tmp();
    const r = await runBin([server.origin, "--no-open", "--json"], {}, { cwd });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe("--save-requests <file>: the file", () => {
  it("writes a file that matches its schema (zod and the published JSON Schema), and says where on stderr", async () => {
    const server = await site();
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    const r = await check(server.origin, cwd, ["--save-requests", path]);
    expect(r.code).toBe(0);
    const file = saved(path);
    expect(requestsFileSchema.safeParse(file).success).toBe(true);
    expect(validateSchema(file), ajv.errorsText(validateSchema.errors)).toBe(true);
    expect(file.schemaVersion).toBe(1);
    expect(file.startedAt).toBe(NOW.toISOString());
    expect(file.url).toBe(`${server.origin}/`);
    expect(file.page).toMatchObject({
      url: `${server.origin}/`,
      title: "Fernkiln Studio",
      canonical: `${server.origin}/`,
    });
    expect(file.page.firstWords).toContain("Hand thrown bowls");
    expect(file.page.blocks).toHaveLength(1);
    const kinds = new Set(file.requests.map((q) => q.kind));
    expect(kinds).toContain("page");
    expect(kinds).toContain("link");
    expect(file.requests.find((q) => q.kind === "page")).toMatchObject({
      url: `${server.origin}/`,
      method: "GET",
      status: 200,
    });
    expect(file.truncation.truncated).toBe(false);
    expect(r.err).toContain(`Request log written to ${path}`);
    expect(r.err).toMatch(/page content.*(not|n't) commit/i);
    // The file sits where it was asked to; the report is the only other file.
    expect(readdirSync(cwd).sort()).toEqual(["gaugeline-report.html", "requests.json"]);
  });

  it("a relative path is taken from the folder the check runs in", async () => {
    const server = await site();
    const cwd = tmp();
    mkdirSync(join(cwd, "out"));
    const r = await check(server.origin, cwd, ["--save-requests", join("out", "r.json")]);
    expect(r.code).toBe(0);
    expect(requestsFileSchema.safeParse(saved(resolve(cwd, "out", "r.json"))).success).toBe(true);
  });

  it("an existing file is replaced, not appended to", async () => {
    const server = await site();
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    writeFileSync(path, "x".repeat(100_000));
    const r = await check(server.origin, cwd, ["--save-requests", path]);
    expect(r.code).toBe(0);
    expect(requestsFileSchema.safeParse(saved(path)).success).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "a new file is readable by its owner only (0600)",
    async () => {
      const server = await site();
      const cwd = tmp();
      const path = join(cwd, "requests.json");
      await check(server.origin, cwd, ["--save-requests", path]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("works with launch, and with --json (the file is separate from stdout)", async () => {
    const server = await site();
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    const r = await run(
      ["launch", server.origin, "--no-open", "--allow-private", "--json", "--save-requests", path],
      cwd,
    );
    expect(r.code).toBe(0);
    expect(requestsFileSchema.safeParse(saved(path)).success).toBe(true);
    expect(JSON.parse(r.out)).toMatchObject({ schema: 2 });
  });

  it("--quiet leaves the confirmation off stderr but still writes the file", async () => {
    const server = await site();
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    const r = await check(server.origin, cwd, ["--quiet", "--save-requests", path]);
    expect(r.err).not.toContain("Request log written");
    expect(existsSync(path)).toBe(true);
  });
});

describe("--save-requests: the result is untouched", () => {
  it("--json prints the same bytes with and without the flag, and the schema number stays 2", async () => {
    const server = await site();
    const cwd = tmp();
    const without = await check(server.origin, cwd, ["--json"]);
    const withFlag = await check(server.origin, cwd, [
      "--json",
      "--save-requests",
      join(cwd, "requests.json"),
    ]);
    expect(withFlag.code).toBe(without.code);
    expect(withFlag.out).toBe(without.out);
    expect(Buffer.from(withFlag.out).equals(Buffer.from(without.out))).toBe(true);
    expect(JSON.parse(withFlag.out)).toMatchObject({ schema: 2 });
    expect(withFlag.out).not.toContain("requests");
  });

  it("the terminal summary is the same too, and the exit code does not change (--ci)", async () => {
    const server = await site('<meta name="robots" content="noindex">');
    const cwd = tmp();
    const without = await check(server.origin, cwd, ["--ci"]);
    const withFlag = await check(server.origin, cwd, [
      "--ci",
      "--save-requests",
      join(cwd, "requests.json"),
    ]);
    expect(withFlag.code).toBe(without.code);
    expect(withFlag.out).toBe(without.out);
  });
});

describe("--save-requests: redaction", () => {
  it("none of a planted key, a query-string secret, a block secret, a header secret or a redirect secret reaches the file", async () => {
    const server = await site();
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    const r = await check(server.origin, cwd, ["--save-requests", path]);
    expect(r.code).toBe(0);
    const text = readFileSync(path, "utf8");
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    // The planted things were really read: the link and the redirect are in the log, with the secret removed.
    const file = saved(path);
    expect(file.requests.map((q) => q.url)).toContain(
      `${server.origin}/next?token=[redacted]&page=2`,
    );
    const hop = file.requests.find((q) => q.status === 301);
    expect(hop?.location).toBe(`${server.origin}/landing?api_key=[redacted]`);
    expect(file.page.firstWords).toContain("Hand thrown bowls");
    expect(file.page.firstWords).toContain("sk_live_[redacted]");
    expect(JSON.stringify(file.page.blocks)).toContain("sk_live_[redacted]");
    // The file holds no headers at all.
    expect(text).not.toMatch(/x-debug-token/i);
  });

  it("the address the check was started with is redacted in the file", async () => {
    const server = await site();
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    await check(`${server.origin}/?key=${IN_QUERY}`, cwd, ["--save-requests", path]);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(IN_QUERY);
    expect(text).toContain("key=[redacted]");
  });
});

describe("--save-requests: the size cap", () => {
  it("a page with more structured data than the cap is cut, and the file says so", async () => {
    const block = (i: number) =>
      `<script type="application/ld+json">${JSON.stringify({ "@type": "Thing", name: `${i}`.repeat(45_000) })}</script>`;
    const server = await startServer({
      "/": (_req, res) => {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            `<html><head><title>Cairn</title>${Array.from({ length: 8 }, (_, i) => block(i)).join("")}</head><body><p>Stacked stones.</p></body></html>`,
          );
      },
    });
    servers.push(server);
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    const r = await check(server.origin, cwd, ["--save-requests", path]);
    expect(r.code).toBe(0);
    const file = saved(path);
    expect(requestsFileSchema.safeParse(file).success).toBe(true);
    expect(validateSchema(file), ajv.errorsText(validateSchema.errors)).toBe(true);
    expect(file.truncation.truncated).toBe(true);
    expect(file.truncation.maxPageBytes).toBe(MAX_SAVED_PAGE_BYTES);
    expect(file.truncation.notes.length).toBeGreaterThan(0);
    expect(file.page.truncated).toContain("blocks");
    expect(file.page.blocks.some((b) => !b.ok && b.truncated === true)).toBe(true);
    expect(file.page.blocks.length + file.page.blocksOmitted).toBe(8);
    const pageBytes = file.page.blocks.reduce(
      (n, b) => n + Buffer.byteLength(b.ok ? JSON.stringify(b.value) : b.raw + b.error),
      0,
    );
    expect(pageBytes).toBeLessThanOrEqual(MAX_SAVED_PAGE_BYTES);
  });
});

describe("--save-requests: when the file cannot be written", () => {
  it("a folder is refused before anything is requested: exit 2 and one sentence", async () => {
    const server = await site();
    const cwd = tmp();
    const r = await check(server.origin, cwd, ["--save-requests", cwd]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`--save-requests: ${cwd} is a folder, not a file.`);
    expect(r.err).toContain("Try: Give a file name, such as requests.json.");
    expect(r.out).toBe("");
    expect(server.log).toHaveLength(0);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("a folder that does not exist is refused before anything is requested", async () => {
    const server = await site();
    const cwd = tmp();
    const path = join(cwd, "missing", "requests.json");
    const r = await check(server.origin, cwd, ["--save-requests", path]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`--save-requests: ${path} cannot be written (ENOENT).`);
    expect(r.out).toBe("");
    expect(server.log).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a file that cannot be replaced is refused before anything is requested",
    async () => {
      const server = await site();
      const cwd = tmp();
      const path = join(cwd, "requests.json");
      writeFileSync(path, "keep");
      chmodSync(path, 0o400);
      const r = await check(server.origin, cwd, ["--save-requests", path]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("cannot be written");
      expect(server.log).toHaveLength(0);
      expect(readFileSync(path, "utf8")).toBe("keep");
    },
  );

  it("a check that could not run leaves no empty file behind", async () => {
    const gone = await site();
    const origin = gone.origin;
    await gone.close();
    servers.splice(servers.indexOf(gone), 1);
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    const r = await check(origin, cwd, ["--save-requests", path]);
    expect(r.code).toBe(2);
    expect(existsSync(path)).toBe(false);
  });

  it("a file that already existed is left as it was when the check could not run", async () => {
    const gone = await site();
    const origin = gone.origin;
    await gone.close();
    servers.splice(servers.indexOf(gone), 1);
    const cwd = tmp();
    const path = join(cwd, "requests.json");
    writeFileSync(path, "earlier run");
    const r = await check(origin, cwd, ["--save-requests", path]);
    expect(r.code).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("earlier run");
  });

  it("an empty file name is refused", () => {
    const parsed = parseCliArgs(["example.com", "--save-requests", ""]);
    expect(parsed).toMatchObject({
      kind: "error",
      message: "--save-requests needs a file name.",
    });
  });
});

describe("--save-requests: which commands accept it", () => {
  it("the page check and launch accept it and carry the path", () => {
    expect(parseCliArgs(["example.com", "--save-requests", "r.json"])).toMatchObject({
      kind: "run",
      saveRequests: "r.json",
    });
    expect(parseCliArgs(["launch", "example.com", "--save-requests", "r.json"])).toMatchObject({
      kind: "run",
      command: "launch",
      saveRequests: "r.json",
    });
    expect(parseCliArgs(["example.com"])).not.toHaveProperty("saveRequests");
  });

  it.each([
    ["plan", ["plan", "sitemap.csv", "--save-requests", "r.json"]],
    ["open", ["open", "--save-requests", "r.json"]],
    ["view", ["view", "run.json", "--save-requests", "r.json"]],
    ["digest", ["digest", "--runs", "runs", "--save-requests", "r.json"]],
    ["run", ["run", "--all", "--save-requests", "r.json"]],
  ])("gaugeline %s refuses it with one usage sentence (exit 2)", async (command, argv) => {
    const cwd = tmp();
    const r = await run(argv, cwd);
    expect(r.code).toBe(2);
    expect(r.err.split("\n")[0]).toBe(
      `--save-requests only works with the page check (gaugeline <address>) and gaugeline launch, not with gaugeline ${command}.`,
    );
    expect(r.err).toContain(
      "Try: Run it on one address: gaugeline example.com --save-requests requests.json.",
    );
    expect(r.out).toBe("");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("an unknown flag still gets the usual message", () => {
    expect(parseCliArgs(["plan", "x.csv", "--save-request", "r.json"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Unknown option --save-request."),
    });
  });
});
