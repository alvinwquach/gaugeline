/** The token source the worker uses by default: a named environment variable, read at each request. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAFTS_PATH } from "../gmail/endpoints.js";
import { buildRaw } from "../gmail/mime.js";
import { GMAIL_TOKEN_ENV, gmailSender, MailTokenError, tokenFromEnv } from "../gmail/send.js";
import { CONTACTS, GMAIL_TOKEN, MAIL, standInGmail } from "./gmail-helpers.js";

afterEach(() => vi.unstubAllGlobals());

const req = () => ({
  endpoint: "createDraft" as const,
  path: DRAFTS_PATH,
  body: { message: { raw: buildRaw({ to: CONTACTS, ...MAIL }) } },
});

describe("tokenFromEnv", () => {
  it("has a default name, separate from every read-only key", () => {
    expect(GMAIL_TOKEN_ENV).toBe("GAUGELINE_GMAIL_ACCESS_TOKEN");
    expect(GMAIL_TOKEN_ENV).not.toMatch(/READ|ONLY/i);
  });

  it("reads the variable at each request, not once at start", async () => {
    const env: Record<string, string | undefined> = { [GMAIL_TOKEN_ENV]: GMAIL_TOKEN };
    const get = tokenFromEnv(GMAIL_TOKEN_ENV, env);
    expect(await get()).toBe(GMAIL_TOKEN);
    env[GMAIL_TOKEN_ENV] = undefined;
    expect(await get()).toBeNull();
    env[GMAIL_TOKEN_ENV] = `${GMAIL_TOKEN}2`;
    expect(await get()).toBe(`${GMAIL_TOKEN}2`);
  });

  it("is null when the variable is missing or empty", async () => {
    expect(await tokenFromEnv(GMAIL_TOKEN_ENV, {})()).toBeNull();
    expect(await tokenFromEnv(GMAIL_TOKEN_ENV, { [GMAIL_TOKEN_ENV]: "" })()).toBeNull();
  });

  it("a missing or malformed token makes the sender fail with the fixed error and no request, and the value is never in it", async () => {
    const gmail = standInGmail();
    gmail.install();
    for (const value of [
      undefined,
      "",
      "   ",
      `${GMAIL_TOKEN}\r\nX: 1`,
      `two words`,
      "x".repeat(5000),
    ]) {
      const send = gmailSender(
        tokenFromEnv(GMAIL_TOKEN_ENV, { [GMAIL_TOKEN_ENV]: value }),
        CONTACTS,
      );
      const err = await send(req()).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(MailTokenError);
      expect(String(err)).not.toContain(GMAIL_TOKEN);
      expect((err as Error).message).toBe("the mailbox is not connected: no usable access token");
    }
    expect(gmail.requests).toEqual([]);
  });

  it("sends a good token in the Authorization header only", async () => {
    const gmail = standInGmail();
    gmail.install();
    const send = gmailSender(
      tokenFromEnv(GMAIL_TOKEN_ENV, { [GMAIL_TOKEN_ENV]: GMAIL_TOKEN }),
      CONTACTS,
    );
    expect((await send(req())).status).toBe(200);
    expect(gmail.requests[0]!.auth).toBe(`Bearer ${GMAIL_TOKEN}`);
  });

  it("refuses a variable name that is not an environment variable name", () => {
    for (const name of ["", "lower", "A B", "A=B", "A\nB", "__proto__x", "1A"])
      expect(() => tokenFromEnv(name, {}), name).toThrow(/environment variable/);
  });

  it("defaults to the process environment", async () => {
    vi.stubEnv(GMAIL_TOKEN_ENV, GMAIL_TOKEN);
    expect(await tokenFromEnv()()).toBe(GMAIL_TOKEN);
  });
});
