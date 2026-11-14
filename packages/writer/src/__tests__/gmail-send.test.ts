// check-community: allow-email (invented recipients at reserved .example domains: the draft tests, and the address shapes the builder accepts)
/**
 * X75: the Gmail sender is the writer's second place that opens a connection. It calls the global fetch
 * (so the post-boundary scan sees it), to https://gmail.googleapis.com only, after the registry has
 * accepted the request, with the customer's token in the Authorization header and nowhere else, redirects
 * refused. These tests replace the global with the stand-in. No network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAFTS_PATH, type GmailRequest } from "../gmail/endpoints.js";
import { buildRaw } from "../gmail/mime.js";
import { draftsUrl, gmailSender, MailTokenError } from "../gmail/send.js";
import { CONTACTS, GMAIL_TOKEN, MAIL, standInGmail, tokenSource } from "./gmail-helpers.js";

afterEach(() => vi.unstubAllGlobals());

const req = (to: string[] = CONTACTS): GmailRequest => ({
  endpoint: "createDraft",
  path: DRAFTS_PATH,
  body: { message: { raw: buildRaw({ to, ...MAIL }) } },
});

describe("the sender", () => {
  it("POSTs to gmail.googleapis.com users/me/drafts with the token in the Authorization header only", async () => {
    const gmail = standInGmail();
    gmail.install();
    const res = await gmailSender(tokenSource().source, CONTACTS)(req());
    expect(res.status).toBe(200);
    const [seen] = gmail.requests;
    expect(gmail.requests).toHaveLength(1);
    expect(seen!.method).toBe("POST");
    expect(seen!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    expect(seen!.auth).toBe(`Bearer ${GMAIL_TOKEN}`);
    expect(seen!.url).not.toContain(GMAIL_TOKEN);
    expect(seen!.body).not.toContain(GMAIL_TOKEN);
    expect(gmail.unexpected).toEqual([]);
    expect(gmail.drafts).toHaveLength(1);
  });

  it("sends JSON, refuses redirects and has a timeout", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response("{}", { status: 200 });
    });
    await gmailSender(tokenSource().source, CONTACTS)(req());
    const init = calls[0]!;
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init).sort()).toEqual(["body", "headers", "method", "redirect", "signal"]);
  });

  it("reads the token before each request, so a disconnect takes effect at once", async () => {
    const gmail = standInGmail();
    gmail.install();
    const tok = tokenSource();
    const send = gmailSender(tok.source, CONTACTS);
    await send(req());
    expect(tok.t.reads).toBe(1);
    tok.t.current = null; // the customer disconnected: the stored token is gone
    await expect(send(req())).rejects.toThrow(MailTokenError);
    expect(tok.t.reads).toBe(2);
    expect(gmail.requests).toHaveLength(1);
  });

  it("refuses, with no request, an empty or missing token", async () => {
    const gmail = standInGmail();
    gmail.install();
    for (const t of [null, "", "   "])
      await expect(gmailSender(tokenSource(t).source, CONTACTS)(req())).rejects.toThrow(
        MailTokenError,
      );
    expect(gmail.requests).toEqual([]);
  });

  it("refuses a token with a header-breaking character, with no request", async () => {
    const gmail = standInGmail();
    gmail.install();
    for (const t of [`${GMAIL_TOKEN}\r\nX-Evil: 1`, `${GMAIL_TOKEN}\n`, `a b`])
      await expect(gmailSender(tokenSource(t).source, CONTACTS)(req())).rejects.toThrow(
        MailTokenError,
      );
    expect(gmail.requests).toEqual([]);
  });

  it("the token error and a failed request never carry the token, and a token source that throws is replaced, not wrapped", async () => {
    const gmail = standInGmail();
    gmail.install();
    const boom = gmailSender(async () => {
      throw new Error(`store said ${GMAIL_TOKEN}`);
    }, CONTACTS);
    const err = await boom(req()).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(MailTokenError);
    expect(String(err)).not.toContain(GMAIL_TOKEN);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(GMAIL_TOKEN);
  });

  it("refuses a request outside the registry before it reaches the network", async () => {
    const gmail = standInGmail();
    gmail.install();
    const send = gmailSender(tokenSource().source, CONTACTS);
    for (const bad of [
      { ...req(), path: "/gmail/v1/users/me/drafts/send" },
      { ...req(), endpoint: "sendDraft" },
      req(["spy@evil.example"]),
      { ...req(), body: { message: { raw: req().body!.message.raw, threadId: "t" } } },
    ])
      await expect(send(bad as GmailRequest)).rejects.toThrow();
    expect(gmail.requests).toEqual([]);
  });

  it("does not echo what Gmail answers: a failure carries the status, never the text", async () => {
    const gmail = standInGmail();
    gmail.install();
    gmail.state.status = 400;
    gmail.state.replyBody = { error: { message: "SECRET-DETAIL-FROM-GMAIL", leaked: GMAIL_TOKEN } };
    const res = await gmailSender(tokenSource().source, CONTACTS)(req());
    expect(res).toEqual({ status: 400, json: null });
  });

  it("returns only the draft id from a success, nothing else of the response", async () => {
    const gmail = standInGmail();
    gmail.install();
    const res = await gmailSender(tokenSource().source, CONTACTS)(req());
    expect(res.json).toEqual({ id: "r1000" });
  });

  it("a redirect makes fetch throw; the error does not carry the token", async () => {
    const gmail = standInGmail();
    gmail.install();
    gmail.state.redirect = true;
    const err = await gmailSender(tokenSource().source, CONTACTS)(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain(GMAIL_TOKEN);
  });
});

describe("draftsUrl: the origin pin", () => {
  it("is exactly https://gmail.googleapis.com/gmail/v1/users/me/drafts", () => {
    expect(draftsUrl(DRAFTS_PATH).href).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    );
  });

  it("refuses another host, another scheme and any path the URL parser would rewrite", () => {
    for (const path of [
      "//evil.example/gmail/v1/users/me/drafts",
      "https://evil.example/gmail/v1/users/me/drafts",
      "http://gmail.googleapis.com/gmail/v1/users/me/drafts",
      "\\\\evil.example/x",
      "/gmail/v1/users/me/./drafts",
      "/gmail/v1/users/me/drafts?x=1",
      "/gmail/v1/users/me/drafts\t",
    ])
      expect(() => draftsUrl(path), path).toThrow();
  });
});
