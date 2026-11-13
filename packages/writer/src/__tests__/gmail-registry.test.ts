// check-community: allow-email (invented recipients at reserved .example domains: the draft tests, and the address shapes the builder accepts)
/**
 * X75: the Gmail registry knows one request, `users.drafts.create`, and nothing that sends. The scope the
 * customer grants is the one that can only create drafts. A request that is not that request, to anyone but
 * the customer's configured contacts, with anything extra in it, is refused before it reaches the network.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkGmailRequest,
  DRAFTS_PATH,
  GMAIL_ENDPOINTS,
  GMAIL_SCOPE,
  type GmailRequest,
} from "../gmail/endpoints.js";
import { buildRaw, buildMessage } from "../gmail/mime.js";
import { RegistryError } from "../github/endpoints.js";
import { CONTACTS, MAIL } from "./gmail-helpers.js";

const raw = buildRaw({ to: CONTACTS, ...MAIL });
const valid: GmailRequest = {
  endpoint: "createDraft",
  path: DRAFTS_PATH,
  body: { message: { raw } },
};
const refused = (req: unknown, contacts: readonly string[] = CONTACTS) =>
  expect(() => checkGmailRequest(req as GmailRequest, contacts)).toThrow(RegistryError);

describe("the registry has one request and no way to send", () => {
  it("holds createDraft only: POST /gmail/v1/users/me/drafts", () => {
    expect(Object.keys(GMAIL_ENDPOINTS)).toEqual(["createDraft"]);
    expect(GMAIL_ENDPOINTS.createDraft.method).toBe("POST");
    expect(DRAFTS_PATH).toBe("/gmail/v1/users/me/drafts");
  });

  it("contains no endpoint, path or name that sends, updates, deletes or reads", () => {
    const text = JSON.stringify(GMAIL_ENDPOINTS);
    expect(text).not.toMatch(/send|update|delete|trash|list|get|modify|insert|import/i);
    for (const e of Object.values(GMAIL_ENDPOINTS)) expect(e.method).toBe("POST");
  });

  it("is frozen all the way down", () => {
    expect(Object.isFrozen(GMAIL_ENDPOINTS)).toBe(true);
    expect(Object.isFrozen(GMAIL_ENDPOINTS.createDraft)).toBe(true);
    expect(() => {
      (GMAIL_ENDPOINTS as Record<string, unknown>).sendDraft = {};
    }).toThrow();
  });

  it("asks for the one scope that can create a draft and cannot send", () => {
    expect(GMAIL_SCOPE).toBe("https://www.googleapis.com/auth/gmail.drafts.create");
  });

  it("no source file in the mail code names a send, a wider scope or another Google host", () => {
    const dir = join(fileURLToPath(new URL("../gmail/", import.meta.url)));
    const files = readdirSync(dir).filter((n) => n.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const re of [
        /drafts\/send|messages\/send|sendMail|gmail\.send|\.send\s*\(/i,
        /auth\/gmail\.(compose|modify|readonly|metadata|labels|settings)|mail\.google\.com/i,
        /googleapis\.com\/(?!auth\/gmail\.drafts\.create|gmail\/v1\/users\/me\/drafts)/i,
      ])
        expect(text, `${f} ${re}`).not.toMatch(re);
    }
  });
});

describe("checkGmailRequest refuses everything but one draft to the configured contacts", () => {
  it("accepts the valid request and returns the parts it will create", () => {
    const parts = checkGmailRequest(valid, CONTACTS);
    expect(parts.to).toEqual(CONTACTS);
    expect(parts.subject).toBe(MAIL.subject);
  });

  it("refuses an endpoint that is not registered (send, update, delete, list ...)", () => {
    for (const endpoint of [
      "sendDraft",
      "sendMessage",
      "send",
      "updateDraft",
      "deleteDraft",
      "list",
      "__proto__",
      "constructor",
    ])
      refused({ ...valid, endpoint });
  });

  it("refuses every path but users/me/drafts", () => {
    for (const path of [
      "/gmail/v1/users/me/drafts/send",
      "/gmail/v1/users/me/messages/send",
      "/gmail/v1/users/me/messages",
      "/gmail/v1/users/me/drafts/r123",
      "/gmail/v1/users/someone@else.example/drafts",
      "/gmail/v1/users/me/drafts/",
      "/gmail/v1/users/me/drafts?x=1",
      "/gmail/v1/users/me/drafts#x",
      "/gmail/v1/users/me/../me/drafts",
      "/gmail/v1/users/me/%2e%2e/drafts",
      "/upload/gmail/v1/users/me/drafts",
      "//evil.example/gmail/v1/users/me/drafts",
      "https://evil.example/gmail/v1/users/me/drafts",
      "/gmail/v1/USERS/me/drafts",
      "",
    ])
      refused({ ...valid, path });
  });

  it("refuses a body with anything but message.raw (a thread, labels, an id)", () => {
    refused({ ...valid, body: { message: { raw, threadId: "t1" } } });
    refused({ ...valid, body: { message: { raw, labelIds: ["SENT"] } } });
    refused({ ...valid, body: { id: "r1", message: { raw } } });
    refused({ ...valid, body: { message: { raw }, send: true } });
    refused({ ...valid, body: { message: {} } });
    refused({ ...valid, body: {} });
    refused({ ...valid, body: undefined });
    refused({ ...valid, body: { message: { raw: "" } } });
    refused({ ...valid, body: { message: { raw: 5 } } });
    refused({ ...valid, body: { message: { raw: `${raw}=` } } });
    refused({ ...valid, body: { message: { raw: "A".repeat(120_000) } } });
    refused({ ...valid, query: { alt: "json" } });
  });

  it("refuses a recipient the customer did not configure (the allowlist)", () => {
    const stranger = buildRaw({ to: ["spy@evil.example"], ...MAIL });
    refused({ ...valid, body: { message: { raw: stranger } } });
    const mixed = buildRaw({ to: [CONTACTS[0]!, "spy@evil.example"], ...MAIL });
    refused({ ...valid, body: { message: { raw: mixed } } });
    refused(valid, []);
    refused(valid, ["someone-else@tidewater-bar.example"]);
  });

  it("compares addresses without regard to letter case, and only as whole addresses", () => {
    const upper = buildRaw({ to: [CONTACTS[0]!.toUpperCase()], ...MAIL });
    expect(() =>
      checkGmailRequest({ ...valid, body: { message: { raw: upper } } }, CONTACTS),
    ).not.toThrow();
    const suffix = buildRaw({ to: [`x${CONTACTS[0]}`], ...MAIL });
    refused({ ...valid, body: { message: { raw: suffix } } });
    const prefix = buildRaw({ to: [`${CONTACTS[0]}.evil.example`], ...MAIL });
    refused({ ...valid, body: { message: { raw: prefix } } });
  });

  it("refuses a message with a Bcc, a Cc or a second To hidden in the raw text", () => {
    const text = buildMessage({ to: CONTACTS, ...MAIL });
    for (const extra of ["Bcc: spy@evil.example", "Cc: spy@evil.example", "To: spy@evil.example"]) {
      const bad = Buffer.from(
        text.replace("MIME-Version: 1.0", `MIME-Version: 1.0\r\n${extra}`),
      ).toString("base64url");
      refused({ ...valid, body: { message: { raw: bad } } });
    }
  });

  it("refuses a request that is not an object, or whose path is not text", () => {
    refused(null);
    refused("createDraft");
    refused({ ...valid, path: 5 });
  });
});
