import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resultSchema } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";

/**
 * gaugeline emails <folder>: Marlowe Street Pop-Up's invented export (packages/fixtures/emails-marlowe),
 * read as text. The settings files sit in the working folder, as they do for the page check.
 */
const MARLOWE = fileURLToPath(new URL("../../../fixtures/emails-marlowe/", import.meta.url));
const CEDAR = fileURLToPath(new URL("../../../fixtures/emails-cedar/", import.meta.url));

const servers: FixtureServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** A transport that fails the test if anything asks the network. */
const refuses = {
  send: () => {
    throw new Error("a request was made");
  },
};

async function emails(argv: string[], cwd: string, fetcher: object = { transport: refuses }) {
  const run = capture();
  const code = await main(["emails", ...argv], run.io, {
    cwd,
    now: () => new Date("2026-11-11T09:00:00.000Z"),
    fetcher,
  } as never);
  return { code, out: run.out(), err: run.err() };
}

describe("gaugeline emails: end to end", () => {
  it("prints each finding, the file and the line, and exits 0 without --ci", async () => {
    const r = await emails(["./emails"], MARLOWE);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe("");
    const lines = r.out.split("\n");
    expect(lines[0]).toBe(
      "Read 6 emails in emails, 2 with a text version. Nothing was rendered, run or sent.",
    );
    expect(lines[1]).toBe(
      "No request was made. Add --base https://your-site.example to check the links and images on your site.",
    );
    expect(r.out).toContain("\u2717 A link in an email only works on the developer's computer");
    expect(r.out).toContain("emails/booking-request.html:14 1 relative link");
    expect(r.out).toContain(
      "emails/order-confirmation.html:26 1 placeholder left in: line 26 {{order_id}}",
    );
    expect(r.out).toContain('emails/receipt.html:13 Venmo "@marlowe-old"');
    expect(r.out).toContain("? broken-links could not be checked: no --base");
    expect(r.out).toMatch(/9 to look at, 3 to fix first\.\n$/);
  });

  it("with --ci a fix-first finding is exit 1, and a clean folder is exit 0", async () => {
    expect((await emails(["./emails", "--ci"], MARLOWE)).code).toBe(EXIT.findings);
    const clean = mkdtempSync(join(tmpdir(), "gaugeline-emails-cli-"));
    dirs.push(clean);
    mkdirSync(join(realpathSync(clean), "mail"));
    writeFileSync(join(realpathSync(clean), "mail", "ok.html"), "<p>Thanks, Dana.</p>");
    const r = await emails(["mail", "--ci"], realpathSync(clean));
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Nothing to look at.");
  });

  it("--json prints the schema 2 result and nothing else, every finding with a source", async () => {
    const r = await emails(["./emails", "--json"], MARLOWE);
    const result = resultSchema.parse(JSON.parse(r.out));
    expect(result.schema).toBe(2);
    expect(result.url).toBe("emails");
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) expect(f.source?.file.startsWith("emails/")).toBe(true);
    expect(r.err).toBe("");
  });

  it("reads one .html file, naming it the way it was typed", async () => {
    const r = await emails(["emails/receipt.html"], MARLOWE);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Read 1 email in emails,");
    expect(r.out).toContain("emails/receipt.html:13");
  });

  it("a bilingual folder reports the languages and the pair that disagrees", async () => {
    const r = await emails(["emails"], CEDAR);
    expect(r.out).toContain("Read 3 emails in emails (en, es), 0 with a text version.");
    expect(r.out).toContain("A language version of this page is missing");
    expect(r.out).toContain("emails/reminder.en.html");
    expect(r.out).toContain("Prices differ between language versions");
  });

  it("with --base the site's links are asked for with HEAD or GET, nothing is sent", async () => {
    const server = await startServer({
      "/orders/1": (_q, res) => void res.writeHead(404).end("no"),
    });
    servers.push(server);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-emails-cli-")));
    dirs.push(dir);
    writeFileSync(join(dir, "a.html"), `<a href="${server.origin}/orders/1">view</a>`);
    const r = await emails([".", "--base", server.origin, "--allow-private", "--ci"], dir, {});
    expect(r.code).toBe(EXIT.findings);
    expect(r.out).toContain(`Asked ${server.origin} for the links and images`);
    expect(r.out).toContain("a.html:1");
    expect(r.out).toContain("returned 404");
    expect(server.log.map((q) => q.method).every((m) => m === "HEAD" || m === "GET")).toBe(true);
  });

  it("a folder that is not there, one with no .html and a bad settings file are exit 2", async () => {
    const missing = await emails(["nowhere"], MARLOWE);
    expect(missing.code).toBe(EXIT.couldNotRun);
    expect(missing.err).toContain("The folder nowhere does not exist.");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-emails-cli-")));
    dirs.push(dir);
    writeFileSync(join(dir, "gaugeline.emails.json"), '{"textVersion": "yes"}');
    writeFileSync(join(dir, "a.html"), "<p>x</p>");
    const bad = await emails(["."], dir);
    expect(bad.code).toBe(EXIT.couldNotRun);
    expect(bad.err).toContain("gaugeline.emails.json: textVersion");
  });
});

describe("gaugeline emails: the command line", () => {
  it("needs one folder, and checks --base", () => {
    expect(parseCliArgs(["emails"]).kind).toBe("error");
    expect(parseCliArgs(["emails", "a", "b"]).kind).toBe("error");
    expect(parseCliArgs(["emails", "./emails", "--base", "not a url"]).kind).toBe("error");
    expect(
      parseCliArgs(["emails", "./emails", "--base", "shop.example", "--ci", "--json"]),
    ).toMatchObject({
      kind: "emails",
      dir: "./emails",
      base: "https://shop.example/",
      ci: true,
      json: true,
    });
  });

  it("is in --help with its flags, and only the flags it takes", () => {
    expect(HELP.emails).toContain("gaugeline emails <folder>");
    for (const flag of ["base", "allow-private", "json", "ci"])
      expect(FLAGS.find((f) => f.name === flag)?.commands).toContain("emails");
    expect(parseCliArgs(["emails", "./emails", "--since", "7d"]).kind).toBe("error");
  });
});
