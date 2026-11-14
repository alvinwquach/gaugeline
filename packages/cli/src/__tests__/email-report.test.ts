// check-community: allow-email (invented addresses at reserved example domains, and Resend's onboarding sender, used by the test)
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const KEY = "re_planted_0a1b2c3d4e5f";

function capture(env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** A local server standing in for Resend: answers every POST with `status` and `body`. */
async function fakeResend(status: number, body: unknown) {
  const got: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      got.push({ headers: req.headers, body: data });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/emails`,
    got,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(status: number, body: unknown) {
  const site = await startFixture("clean");
  const api = await fakeResend(status, body);
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-email-"));
  cleanups.push(
    () => site.close(),
    () => api.close(),
    () => rmSync(cwd, { recursive: true, force: true }),
  );
  return { site, api, cwd };
}

describe("email reports: e2e (CLI)", () => {
  it("sends once and says so; without GAUGELINE_EMAIL_FROM it names the shared sender once", async () => {
    const { site, api, cwd } = await setup(200, { id: "4ef9a417" });
    const run = capture({ RESEND_API_KEY: KEY });
    const code = await main(
      [
        site.origin,
        "--allow-private",
        "--no-open",
        "--email",
        "you@shop.example",
        "--notify-on",
        "always",
      ],
      run.io,
      { cwd, emailEndpoint: api.url, version: "0.1.0" },
    );
    expect(code).toBe(0);
    expect(api.got).toHaveLength(1);
    const sent = JSON.parse(api.got[0]?.body ?? "{}") as {
      to: string[];
      from: string;
      subject: string;
    };
    expect(sent.to).toEqual(["you@shop.example"]);
    expect(sent.from).toBe("Gaugeline <onboarding@resend.dev>");
    expect(sent.subject).toBe("127.0.0.1: nothing to report");
    expect(run.err().match(/Resend's shared address/g)).toHaveLength(1);
    expect(run.err()).toContain("Emailed the report.\n");
  });

  it("GAUGELINE_EMAIL and GAUGELINE_EMAIL_FROM: sent from your own domain, no sender note", async () => {
    const { site, api, cwd } = await setup(200, { id: "1" });
    const run = capture({
      RESEND_API_KEY: KEY,
      GAUGELINE_EMAIL: "a@shop.example, b@shop.example,",
      GAUGELINE_EMAIL_FROM: "Reports <reports@shop.example>",
    });
    await main([site.origin, "--allow-private", "--no-open", "--notify-on", "always"], run.io, {
      cwd,
      emailEndpoint: api.url,
    });
    const sent = JSON.parse(api.got[0]?.body ?? "{}") as { to: string[]; from: string };
    expect(sent).toMatchObject({
      to: ["a@shop.example", "b@shop.example"],
      from: "Reports <reports@shop.example>",
    });
    expect(run.err()).not.toContain("shared address");
  });

  it("--email with no RESEND_API_KEY: one clear line, no request, exit code unchanged", async () => {
    const { site, api, cwd } = await setup(200, {});
    const run = capture({});
    const code = await main(
      [
        site.origin,
        "--allow-private",
        "--no-open",
        "--email",
        "you@shop.example",
        "--notify-on",
        "always",
      ],
      run.io,
      { cwd, emailEndpoint: api.url },
    );
    const without = capture({});
    const baseline = await main([site.origin, "--allow-private", "--no-open"], without.io, { cwd });
    expect(code).toBe(baseline);
    expect(api.got).toEqual([]);
    expect(
      run
        .err()
        .split("\n")
        .filter((l) => l.includes("RESEND_API_KEY")),
    ).toEqual([
      "Could not send the email: RESEND_API_KEY is not set: add your Resend API key to the environment to send email.",
    ]);
  });

  it("a planted RESEND_API_KEY never reaches stdout, stderr, the report file or the JSON output", async () => {
    // The stand-in API even echoes the key in its error, as a careless provider might.
    const { site, api, cwd } = await setup(403, {
      statusCode: 403,
      message: `The shop.example domain is not verified (${KEY}).`,
    });
    const env = { RESEND_API_KEY: KEY, GAUGELINE_EMAIL_FROM: "r@shop.example" };
    const terminal = capture(env);
    await main(
      [
        site.origin,
        "--allow-private",
        "--no-open",
        "--email",
        "you@shop.example",
        "--notify-on",
        "always",
        "--verbose",
      ],
      terminal.io,
      { cwd, emailEndpoint: api.url },
    );
    const json = capture(env);
    await main(
      [
        site.origin,
        "--allow-private",
        "--json",
        "--email",
        "you@shop.example",
        "--notify-on",
        "always",
      ],
      json.io,
      { cwd, emailEndpoint: api.url },
    );
    expect(api.got).toHaveLength(2);
    expect(api.got.every((g) => g.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    const report = readFileSync(join(cwd, "gaugeline-report.html"), "utf8");
    for (const text of [terminal.out(), terminal.err(), json.out(), json.err(), report])
      expect(text).not.toContain(KEY);
    expect(terminal.err()).toContain(
      "Could not send the email: 127.0.0.1 answered 403: The shop.example domain is not verified ([redacted]).",
    );
  });
});
