// check-community: allow-email (invented addresses on the reserved .test domain, for a local stand-in)
/**
 * Unit, integration and end-to-end, no database: the waiting-drafts digest inside the morning email, the
 * placeholder sender domain that refuses to send, and the Resend sender against a local stand-in server.
 * No key is real (the one used is assembled from pieces and means nothing) and no request leaves the machine.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApprovalsDigest, postEmail } from "@gaugeline/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDigestExample } from "./example-digest.js";
import { buildMorningEmail, waitingFor } from "../email/morning.js";
import {
  DEFAULT_MAIL_FROM,
  mailFrom,
  MAIL_DOMAIN_PLACEHOLDER,
  morningFromEnv,
  resendSender,
  SENDER_NOT_CONFIGURED,
  sendMorningEmails,
} from "../email/send.js";

const KEY = ["re", "_test_", "0123456789abcdef"].join("");
const NOW = new Date("2026-11-14T07:10:00Z");
const APP = "https://app.example.test";
const DASH = "https://dashboard.example.test/";
const LINK = "https://dashboard.example.test/email/preferences?t=abc";
const SECRET = "t9Gk2Vq7ZxMw4BnR8cLd1HsYfJ3aEuP5oIe0";
const SITE = "a1000000-0000-4000-8000-0000000000a1";
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

function draft(n: number, hoursAgo: number, title = `Draft ${n}`) {
  return {
    id: `a1d20000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    siteId: SITE,
    kind: "email",
    title,
    createdAt: iso(hoursAgo),
    expiresAt: iso(hoursAgo - 72),
  };
}
const digestOf = (drafts: unknown[]) => buildApprovalsDigest(drafts, NOW, { appUrl: APP });
const waitingMail = (
  drafts: unknown[],
  changes: Parameters<typeof buildMorningEmail>[0]["changes"] = [],
) =>
  buildMorningEmail({
    orgName: "Northgate Studio",
    changes,
    dashboardUrl: DASH,
    preferencesUrl: LINK,
    waiting: waitingFor("every_change", digestOf(drafts)),
  });

describe("the waiting drafts in the morning email (unit)", () => {
  it("a digest alone is an email: counts, titles and ids, and the preference link", () => {
    const m = waitingMail([draft(1, 70, "Your menu link is fixed"), draft(2, 1)])!;
    expect(m.subject).toBe("2 drafts waiting for your approval");
    expect(m.text).toContain(
      "2 drafts wait for approval: 1 older than 24 hours, 1 expire within 24 hours.",
    );
    expect(m.text).toContain("Your menu link is fixed");
    expect(m.text).toContain(`${APP}/inbox/a1d20000-0000-4000-8000-000000000001`);
    expect(m.text).toContain(LINK);
    expect(m.html).toContain(`href="${LINK}"`);
    expect(m.text).toContain("Nothing here approves anything");
  });

  it("nothing changed and nothing waits: no email", () => {
    expect(waitingMail([])).toBeNull();
    expect(waitingFor("every_change", digestOf([]))).toBeNull();
    // A draft already past its 72 hours cannot be approved: it does not wake anyone.
    expect(waitingFor("every_change", digestOf([draft(1, 80)]))).toBeNull();
  });

  it("changes and waiting drafts are one email, the subject is still about the changes", () => {
    const m = waitingMail(
      [draft(1, 30)],
      [
        {
          siteId: SITE,
          siteName: "The Tidewater Bar",
          opened: 1,
          openedHigh: 1,
          closed: 0,
          topTitle: "Broken link",
        },
      ],
    )!;
    expect(m.subject).toBe("New: Broken link (The Tidewater Bar)");
    expect(m.text).toContain("The Tidewater Bar: 1 new problem");
    expect(m.text).toContain("1 draft waits for approval");
  });

  it("fix-first people hear only about drafts that are old or about to expire", () => {
    expect(waitingFor("fix_first", digestOf([draft(1, 2)]))).toBeNull();
    expect(waitingFor("fix_first", digestOf([draft(1, 30)]))).not.toBeNull();
    expect(waitingFor("off", digestOf([draft(1, 30)]))).toBeNull();
  });

  it("a huge digest is capped: five are listed, the rest are counted, and the size stays small", () => {
    const many = Array.from({ length: 600 }, (_, i) => draft(i + 1, 30 + (i % 30)));
    const m = waitingMail(many)!;
    expect(m.text).toContain("and 595 more in the inbox");
    expect((m.text.match(/\/inbox\/a1d2/g) ?? []).length).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength(m.html) + Buffer.byteLength(m.text)).toBeLessThan(10_000);
  });

  it("a draft title is data: cleaned, escaped, never a link or a header", () => {
    const m = waitingMail([
      draft(1, 30, "Menu\r\nBcc: attacker@evil.test <script>alert(1)</script> ‮exe.txt"),
    ])!;
    expect(m.html).not.toMatch(/<script/i);
    expect(m.text).not.toMatch(/‮|^Bcc:/m);
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});

describe("the sender address and its placeholder domain (unit)", () => {
  it("the default is a reserved fake domain that nothing can be delivered from", () => {
    expect(MAIL_DOMAIN_PLACEHOLDER).toBe("mail.gaugeline.invalid");
    expect(DEFAULT_MAIL_FROM).toBe("Gaugeline <morning@mail.gaugeline.invalid>");
    expect(mailFrom({})).toEqual({ from: DEFAULT_MAIL_FROM, configured: false });
  });
  it("any .invalid domain, Resend's shared test domain or a malformed address is not configured", () => {
    for (const from of [
      "Gaugeline <a@mail.gaugeline.invalid>",
      "a@anything.invalid",
      "Gaugeline <onboarding@resend.dev>",
      "not an address",
      "",
      "a@mail.gaugeline.invalid.", // a trailing dot is the same name
      "a@mail.gaugeline.invalid\u200b", // a zero-width space
      "a@MAIL.Gaugeline.INVALID",
      "a@sub.mail.gaugeline.invalid",
      "a@resend.dev.",
      "a@x.resend.dev",
      "a@mail.gaugeline.\u0456nvalid", // Cyrillic i in "invalid"
      "a@m\u0430il.studio.test", // Cyrillic a: a look-alike domain is not an address on a verified one
      "Gaugeline\r\nBcc: x@mail.studio.test <a@mail.studio.test>",
      "Gaugeline\u202e <a@mail.studio.test>",
      "a@mail..studio.test",
      "a@-mail.studio.test",
      "a@mail.studio.test\u0007",
    ])
      expect(mailFrom({ GAUGELINE_EMAIL_FROM: from }).configured, from).toBe(false);
  });
  it("an ordinary subdomain or an uppercase address on a real domain is configured", () => {
    for (const from of [
      "Gaugeline <a@Mail.Studio.test>",
      "a@studio.test.",
      "Studio Mail <a@resend.studio.test>",
    ])
      expect(mailFrom({ GAUGELINE_EMAIL_FROM: from }).configured, from).toBe(true);
  });
  it("one swapped value is all it takes", () => {
    expect(mailFrom({ GAUGELINE_EMAIL_FROM: "Gaugeline <morning@mail.studio.test>" })).toEqual({
      from: "Gaugeline <morning@mail.studio.test>",
      configured: true,
    });
  });
});

/** A local stand-in for Resend: records each request and answers as told. */
async function standIn(
  answer: () => { status: number; body: string; headers?: Record<string, string> },
) {
  const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] =
    [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const a = answer();
      res.writeHead(a.status, { "content-type": "application/json", ...a.headers }).end(a.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/emails`;
  /** The real notifier, pointed at the stand-in: tests only, the worker never builds one of these. */
  const post: typeof postEmail = (settings, m) =>
    postEmail({ ...settings, endpoint, publicOnly: false }, m);
  return { seen, endpoint, post, close: () => new Promise((r) => server.close(r)) };
}
const mail = { subject: "S", html: "<p>h</p>", text: "t" };
const realFrom = "Gaugeline <morning@mail.studio.test>";
const env = (over: Record<string, string> = {}) => ({
  RESEND_API_KEY: KEY,
  GAUGELINE_EMAIL_FROM: realFrom,
  ...over,
});

describe("the Resend sender against a local stand-in (end to end)", () => {
  let close: (() => Promise<unknown>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    vi.restoreAllMocks();
  });

  it("one POST: the path, the method, the key in Authorization only, the body, and the id answered", async () => {
    const s = await standIn(() => ({ status: 200, body: '{"id":"re_msg_0001"}' }));
    close = s.close;
    const send = resendSender(env(), s.post)!;
    expect(
      await send({ to: "owner@mail.example.test", mail, idempotencyKey: "morning/o/u/2026-11-14" }),
    ).toEqual({ ok: true, status: 200 });
    expect(s.seen).toHaveLength(1);
    const r = s.seen[0]!;
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/emails");
    expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["idempotency-key"]).toBe("morning/o/u/2026-11-14");
    expect(r.body).not.toContain(KEY);
    expect(JSON.parse(r.body)).toEqual({
      from: realFrom,
      to: ["owner@mail.example.test"],
      subject: "S",
      html: "<p>h</p>",
      text: "t",
    });
  });

  it("the placeholder domain: nothing is sent, the result says so, the key is nowhere in it", async () => {
    const s = await standIn(() => ({ status: 200, body: "{}" }));
    close = s.close;
    const send = resendSender(env({ GAUGELINE_EMAIL_FROM: DEFAULT_MAIL_FROM }), s.post)!;
    const res = await send({ to: "owner@mail.example.test", mail });
    expect(res).toEqual({ ok: false, error: SENDER_NOT_CONFIGURED });
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(s.seen).toEqual([]);
    // Unset is the same as the placeholder.
    const unset = resendSender({ RESEND_API_KEY: KEY }, s.post)!;
    expect(await unset({ to: "owner@mail.example.test", mail })).toEqual({
      ok: false,
      error: SENDER_NOT_CONFIGURED,
    });
    expect(s.seen).toEqual([]);
  });

  it("production settings: publicOnly, no endpoint override, the idempotency key passed on", async () => {
    const calls: Parameters<typeof postEmail>[0][] = [];
    const spy: typeof postEmail = async (settings) => {
      calls.push(settings);
      return { ok: true, status: 200 };
    };
    await resendSender(env(), spy)!({ to: "owner@mail.example.test", mail, idempotencyKey: "k" });
    expect(calls).toEqual([
      {
        to: ["owner@mail.example.test"],
        apiKey: KEY,
        from: realFrom,
        publicOnly: true,
        idempotencyKey: "k",
      },
    ]);
    expect("endpoint" in calls[0]!).toBe(false);
  });

  it("no key: no sender, and the step is off", () => {
    expect(resendSender({ GAUGELINE_EMAIL_FROM: realFrom })).toBeNull();
    expect(resendSender({ RESEND_API_KEY: "  " })).toBeNull();
    expect(morningFromEnv({} as never, {})).toBeNull();
  });

  it("429 and 503 come back with their status (the worker's retry rules read it); the key is scrubbed from the words", async () => {
    const s = await standIn(() => ({
      status: 429,
      body: `{"message":"slow down, key ${KEY} is limited"}`,
    }));
    close = s.close;
    const send = resendSender(env(), s.post)!;
    const res = await send({ to: "owner@mail.example.test", mail });
    expect(res).toMatchObject({ ok: false, status: 429 });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("a redirect is not followed", async () => {
    const s = await standIn(() => ({
      status: 302,
      body: "",
      headers: { location: "http://127.0.0.1:1/elsewhere" },
    }));
    close = s.close;
    const send = resendSender(env(), s.post)!;
    expect(await send({ to: "owner@mail.example.test", mail })).toMatchObject({
      ok: false,
      status: 302,
    });
    expect(s.seen).toHaveLength(1);
  });

  it("an unreachable host is an error without the key or the address", async () => {
    const send = resendSender(env(), (settings, m) =>
      postEmail({ ...settings, endpoint: "http://127.0.0.1:1/emails", publicOnly: false }, m),
    )!;
    const res = await send({ to: "owner@mail.example.test", mail });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });
});

describe("what the worker selects (integration, no database)", () => {
  const good = { ...env(), GAUGELINE_DASHBOARD_URL: DASH, GAUGELINE_EMAIL_TOKEN_SECRET: SECRET };
  it("a key and a real domain: sending is on", () => {
    expect(morningFromEnv({} as never, good)).toMatchObject({ dashboardUrl: DASH });
    expect(morningFromEnv({} as never, good)?.refusal).toBeUndefined();
  });
  it("a key and the placeholder: the step is built but refuses, with a fixed reason", () => {
    const d = morningFromEnv({} as never, { ...good, GAUGELINE_EMAIL_FROM: DEFAULT_MAIL_FROM });
    expect(d?.refusal).toBe(SENDER_NOT_CONFIGURED);
    expect(JSON.stringify(d?.refusal)).not.toContain(KEY);
  });
  it("a refusing pass touches nothing: no query, no send", async () => {
    const sql = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the database was touched");
        },
      },
    ) as never;
    const send = vi.fn();
    const report = await sendMorningEmails(
      { sql, send, dashboardUrl: DASH, tokenSecret: SECRET, refusal: SENDER_NOT_CONFIGURED },
      NOW,
    );
    expect(report).toEqual({ sent: 0, failed: 0, refused: SENDER_NOT_CONFIGURED });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the docs page", () => {
  it("shows the real output of the example, and the example never touches a real address", async () => {
    const page = readFileSync(
      fileURLToPath(new URL("../../../../docs/hosted/morning-email.md", import.meta.url)),
      "utf8",
    );
    const out = await runDigestExample();
    expect(page).toContain(out);
    expect(out).not.toMatch(/api\.resend\.com/);
  });
});
