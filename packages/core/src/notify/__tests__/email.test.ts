// check-community: allow-email (invented addresses at reserved example domains, and Resend's onboarding sender, used by the test)
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import type { Finding } from "../../model.js";
import { buildResult, type Result } from "../../result.js";
import {
  EMAIL_CUT_FINDINGS,
  ONBOARDING_FROM,
  buildEmail,
  emailSubject,
  parseAddresses,
  sendEmail,
} from "../email.js";
import { notifyAll, resolveTargets } from "../index.js";

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const KEY = "re_planted_9f8e7d6c5b4a";

const f = (severity: Finding["severity"], i = 0, extra: Partial<Finding> = {}): Finding => ({
  checkId: "canonical-elsewhere",
  severity,
  title: `Finding ${i}`,
  evidence: `evidence ${i}`,
  url: "https://shop.example/",
  ...extra,
});
const run = (findings: Finding[]): Result =>
  buildResult({
    url: "https://shop.example/tools?x=1",
    startedAt: new Date("2026-11-06T12:00:00Z"),
    findings,
    passed: ["noindex", "viewport"],
    failed: [],
    couldNotCheck: [
      {
        id: "sitemap-dead",
        reason: "refused automated readers (403)",
        url: "https://shop.example/a",
      },
    ],
  });
const mixed = run([f("high", 0), f("high", 1), f("medium", 2), f("low", 3)]);
const clean = run([]);
const opts = { version: "0.1.0" };

/** A stand-in for Resend's API: records each request and answers with `status` and `body`. */
function resend(
  status: number,
  body: unknown,
  got: { headers: IncomingMessage["headers"]; body: string }[],
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      got.push({ headers: req.headers, body: data });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  };
}

describe("email: unit", () => {
  it("buildEmail for a mixed result (snapshot)", () => {
    const mail = buildEmail(mixed, { ...opts, reportUrl: "https://reports.example/r/1" });
    expect(mail.subject).toBe("shop.example: 2 to fix first, 4 to look at");
    expect(mail.text).toMatchSnapshot("text");
    expect(mail.html).toMatchSnapshot("html");
  });

  it("buildEmail for a clean result (snapshot)", () => {
    const mail = buildEmail(clean, opts);
    expect(mail.subject).toBe("shop.example: nothing to report");
    expect(mail.text).toContain("Nothing to fix. Every check that ran passed.");
    expect(mail.html).toMatchSnapshot("html");
  });

  it("the html has no script, no style element, no stylesheet, no details and no remote image", () => {
    for (const r of [mixed, clean]) {
      const { html } = buildEmail(r, opts);
      expect(html).not.toMatch(/<script|<style|<link|<details|<summary|<img|url\(/i);
      expect(html).not.toMatch(/\ssrc=/i);
    }
    // Every style attribute is well formed: no double quote inside one.
    for (const m of buildEmail(mixed, opts).html.matchAll(/style="([^"]*)"/g))
      expect(m[1]).not.toContain("<");
    expect(buildEmail(mixed, opts).html).toContain("'Segoe UI'");
    // Every finding still reads the same: inline styles carry the look.
    expect(buildEmail(mixed, opts).html).toContain('style="border-left:4px solid');
  });

  it("subject lines: high and medium, medium only, clean", () => {
    expect(emailSubject(run([f("high"), f("medium", 1)]))).toBe(
      "shop.example: 1 to fix first, 2 to look at",
    );
    expect(emailSubject(run([f("medium"), f("medium", 1), f("low", 2)]))).toBe(
      "shop.example: 3 to look at",
    );
    expect(emailSubject(clean)).toBe("shop.example: nothing to report");
  });

  it("address lists: one, three, a trailing comma, an invalid entry", () => {
    expect(parseAddresses("you@shop.example")).toEqual({ ok: true, to: ["you@shop.example"] });
    expect(parseAddresses(" a@x.example, b@y.example ,c@z.example")).toEqual({
      ok: true,
      to: ["a@x.example", "b@y.example", "c@z.example"],
    });
    expect(parseAddresses("a@x.example,")).toEqual({ ok: true, to: ["a@x.example"] });
    expect(parseAddresses("a@x.example, not-an-address")).toEqual({
      ok: false,
      error: '"not-an-address" is not an email address',
    });
    expect(parseAddresses("a@x.example\r\nBcc: z@evil.example").ok).toBe(false);
    expect(parseAddresses(" , ")).toEqual({ ok: false, error: "no email address was given" });
  });

  it("--email and GAUGELINE_EMAIL resolve to one email target; the flag wins", () => {
    expect(resolveTargets({}, { GAUGELINE_EMAIL: "a@x.example" })).toEqual([
      { channel: "email", url: "a@x.example" },
    ]);
    expect(resolveTargets({ email: "b@y.example" }, { GAUGELINE_EMAIL: "a@x.example" })).toEqual([
      { channel: "email", url: "b@y.example" },
    ]);
  });
});

describe("email: integration (a local server standing in for the Resend API)", () => {
  it("a successful send posts once with from, to, subject, html and text, the key in Authorization only", async () => {
    const got: { headers: IncomingMessage["headers"]; body: string }[] = [];
    const api = await startServer({}, resend(200, { id: "4ef9a417" }, got));
    servers.push(api);
    const sent = await sendEmail(
      mixed,
      {
        to: ["you@shop.example", "ops@shop.example"],
        apiKey: KEY,
        endpoint: `${api.origin}/emails`,
      },
      opts,
    );
    expect(sent).toEqual({ ok: true, status: 200 });
    expect(api.log.map((l) => [l.method, l.path])).toEqual([["POST", "/emails"]]);
    const body = JSON.parse(got[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(body.from).toBe(ONBOARDING_FROM);
    expect(body.to).toEqual(["you@shop.example", "ops@shop.example"]);
    expect(body.subject).toBe("shop.example: 2 to fix first, 4 to look at");
    expect(got[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(got[0]?.body).not.toContain(KEY);
  });

  it("the API answers 401: email reports failed, the webhook still delivers", async () => {
    const got: { headers: IncomingMessage["headers"]; body: string }[] = [];
    const api = await startServer(
      {},
      resend(
        401,
        { statusCode: 401, message: "API key is invalid", name: "validation_error" },
        got,
      ),
    );
    const hook = await startServer({}, resend(200, {}, []));
    servers.push(api, hook);
    const results = await notifyAll(
      mixed,
      [
        { channel: "email", url: "you@shop.example" },
        { channel: "webhook", url: `${hook.origin}/hook` },
      ],
      { email: { apiKey: KEY, endpoint: `${api.origin}/emails`, version: "0.1.0" } },
    );
    expect(results).toEqual([
      {
        channel: "email",
        ok: false,
        status: 401,
        error: "127.0.0.1 answered 401: API key is invalid",
      },
      { channel: "webhook", ok: true, status: 200 },
    ]);
  });
});

describe("email: edge cases", () => {
  it("no RESEND_API_KEY: one clear error naming the variable, and no request", async () => {
    const api = await startServer({}, resend(200, {}, []));
    servers.push(api);
    const [r] = await notifyAll(mixed, [{ channel: "email", url: "you@shop.example" }], {
      email: { endpoint: `${api.origin}/emails` },
    });
    expect(r?.error).toBe(
      "RESEND_API_KEY is not set: add your Resend API key to the environment to send email",
    );
    expect(api.log).toEqual([]);
  });

  it("an invalid address is rejected before any request", async () => {
    const api = await startServer({}, resend(200, {}, []));
    servers.push(api);
    const [r] = await notifyAll(mixed, [{ channel: "email", url: "you@shop.example, nope" }], {
      email: { apiKey: KEY, endpoint: `${api.origin}/emails` },
    });
    expect(r).toEqual({ channel: "email", ok: false, error: '"nope" is not an email address' });
    expect(api.log).toEqual([]);
  });

  it("a report over the size limit: the most urgent 50 findings, with a line saying so", () => {
    const many = run(Array.from({ length: 80 }, (_, i) => f(i >= 70 ? "high" : "low", i)));
    const mail = buildEmail(many, { ...opts, maxBytes: 20_000 });
    const shown = (mail.html.match(/<article/g) ?? []).length;
    expect(shown).toBe(EMAIL_CUT_FINDINGS);
    // The ten high findings are the ones kept first.
    expect(mail.html).toContain("Finding 79");
    expect(mail.text).toContain(
      "This email shows the 50 most urgent of 80 findings: the whole report was too large to send.",
    );
    expect(mail.html).toContain("This email shows the 50 most urgent of 80 findings");
    expect(buildEmail(many, opts).html.match(/<article/g)?.length).toBe(80);
  });

  it("a page title containing HTML is escaped in the body and kept out of the subject", () => {
    const evil = run([
      f("high", 0, {
        title: 'Title <script>alert("x")</script>',
        evidence: "<title><img src=x onerror=alert(1)></title>",
      }),
    ]);
    const mail = buildEmail(evil, opts);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("Title &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(mail.subject).toBe("shop.example: 1 to fix first, 1 to look at");
    expect(mail.subject).not.toMatch(/[<>\r\n]/);
  });

  it("a sender on a domain Resend hasn't verified: the API's error is shown, without the key", async () => {
    const api = await startServer(
      {},
      resend(
        403,
        {
          statusCode: 403,
          message: `The shop.example domain is not verified. Please, add and verify your domain. (key ${KEY})`,
          name: "validation_error",
        },
        [],
      ),
    );
    servers.push(api);
    const sent = await sendEmail(
      mixed,
      {
        to: ["you@shop.example"],
        apiKey: KEY,
        from: "Reports <reports@shop.example>",
        endpoint: `${api.origin}/emails`,
      },
      opts,
    );
    expect(sent.ok).toBe(false);
    expect(sent.error).toBe(
      "127.0.0.1 answered 403: The shop.example domain is not verified. Please, add and verify your domain. (key [redacted])",
    );
    expect(JSON.stringify(sent)).not.toContain(KEY);
  });
});
