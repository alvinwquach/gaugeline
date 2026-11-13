/**
 * X75, unit: the draft is built by one small pure function (RFC 5322 and RFC 2045, base64url `raw`). The
 * same input is the same bytes, a header cannot be injected through the recipient or the subject, and a
 * message built here reads back as exactly the parts that went in.
 */
import { describe, expect, it } from "vitest";
import { buildMessage, buildRaw, isPlainAddress, MimeError, readRaw } from "../gmail/mime.js";
import { CONTACTS, MAIL } from "./gmail-helpers.js";

const parts = { to: CONTACTS, ...MAIL };

describe("buildMessage: a plain text message", () => {
  it("has exactly four headers, CRLF line ends and a base64 body", () => {
    const text = buildMessage(parts);
    const [head, body] = text.split("\r\n\r\n") as [string, string];
    expect(head.split("\r\n")).toEqual([
      "MIME-Version: 1.0",
      `To: ${CONTACTS.join(", ")}`,
      "Subject: Tidewater Bar: this week on your website",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]);
    expect(body.replace(/\r\n/g, "")).toBe(
      Buffer.from(MAIL.body.replace(/\n/g, "\r\n"), "utf8").toString("base64"),
    );
    expect(text).not.toMatch(/(^|[^\r])\n/);
  });

  it("is deterministic: the same input is the same bytes, with no date or message id", () => {
    expect(buildMessage(parts)).toBe(buildMessage({ ...parts }));
    expect(buildRaw(parts)).toBe(buildRaw({ ...parts }));
    expect(buildMessage(parts)).not.toMatch(/^(Date|Message-ID|From|Cc|Bcc|Reply-To):/im);
  });

  it("wraps the body at 76 characters", () => {
    const text = buildMessage({ ...parts, body: "word ".repeat(400) });
    const lines = text.split("\r\n\r\n")[1]!.split("\r\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(76);
  });

  it("raw is base64url: no plus, slash or padding", () => {
    const raw = buildRaw({ ...parts, body: "\u00FF\u00FE??>>" });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe(
      buildMessage({ ...parts, body: "\u00FF\u00FE??>>" }),
    );
  });

  it("writes a non-ASCII subject as RFC 2047 encoded words of at most 75 characters", () => {
    const subject = "Caf\u00E9 menu: \u2014 la carte des cocktails \u2014 ".repeat(3).trim();
    const text = buildMessage({ ...parts, subject });
    const header = text.split("\r\n\r\n")[0]!.replace(/\r\n /g, "\u0000");
    const value = /Subject: (.*?)\r\nContent-Type/s.exec(header + "\r\nContent-Type")![1]!;
    const words = value.split("\u0000");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
    }
    expect(readRaw(buildRaw({ ...parts, subject })).subject).toBe(subject);
  });

  it("never splits a character across two encoded words", () => {
    const subject = "\u{1F379}".repeat(40);
    expect(readRaw(buildRaw({ ...parts, subject })).subject).toBe(subject);
  });

  it("encodes a subject that would read as an encoded word, or that is long or padded with spaces", () => {
    for (const subject of ["=?UTF-8?B?QQ==?=", "x".repeat(120), " leading", "trailing "]) {
      const head = buildMessage({ ...parts, subject }).split("\r\n\r\n")[0]!;
      expect(head).toMatch(/Subject: =\?UTF-8\?B\?/);
      expect(readRaw(buildRaw({ ...parts, subject })).subject, subject).toBe(subject);
    }
  });

  it("turns every kind of line ending in the body into CRLF, and keeps the words", () => {
    const body = "one\ntwo\r\nthree\rfour";
    const got = readRaw(buildRaw({ ...parts, body })).body;
    expect(got).toBe("one\r\ntwo\r\nthree\r\nfour");
  });

  it("round trips what went in", () => {
    const got = readRaw(buildRaw(parts));
    expect(got).toEqual({
      to: CONTACTS,
      subject: MAIL.subject,
      body: MAIL.body.replace(/\n/g, "\r\n"),
    });
  });
});

describe("header injection is refused, not escaped (X75 edge cases)", () => {
  const injections = [
    ["CR in the subject", "hello\rBcc: spy@evil.example"],
    ["LF in the subject", "hello\nBcc: spy@evil.example"],
    ["CRLF in the subject", "hello\r\nBcc: spy@evil.example"],
    ["NEL in the subject", "hello\u0085Bcc: spy@evil.example"],
    ["a line separator in the subject", "hello\u2028Bcc: spy@evil.example"],
    ["a paragraph separator", "hello\u2029x"],
    ["NUL in the subject", "hello\u0000x"],
    ["a right-to-left override in the subject", "invoice \u202Egnp.exe"],
    ["a right-to-left isolate", "invoice \u2067x"],
    ["a left-to-right mark", "x\u200Ey"],
    ["an empty subject", ""],
  ] as const;
  for (const [name, subject] of injections)
    it(`refuses ${name}`, () => {
      expect(() => buildMessage({ ...parts, subject })).toThrow(MimeError);
      expect(() => buildRaw({ ...parts, subject })).toThrow(MimeError);
    });

  const addresses = [
    ["CRLF in the recipient", "maya@tidewater-bar.example\r\nBcc: spy@evil.example"],
    ["LF in the recipient", "maya@tidewater-bar.example\nBcc: spy@evil.example"],
    ["a display name", "Maya <maya@tidewater-bar.example>"],
    ["an angle bracket", "<maya@tidewater-bar.example>"],
    ["a second address after a comma", "maya@tidewater-bar.example,spy@evil.example"],
    ["a semicolon", "maya@tidewater-bar.example;spy@evil.example"],
    ["a space", "maya @tidewater-bar.example"],
    ["a quoted local part", '"a b"@tidewater-bar.example'],
    ["a parenthesis comment", "maya@tidewater-bar.example(spy@evil.example)"],
    ["no domain dot", "maya@tidewater"],
    ["a non-ASCII address", "m\u00E4ya@tidewater-bar.example"],
    ["a bidi control", "maya@tidewater-bar.example\u202E"],
    ["a trailing dot", "maya@tidewater-bar.example."],
    ["an over-long address", `${"a".repeat(250)}@tidewater-bar.example`],
    ["an empty address", ""],
  ] as const;
  for (const [name, address] of addresses)
    it(`refuses ${name}`, () => {
      expect(isPlainAddress(address)).toBe(false);
      expect(() => buildMessage({ ...parts, to: [address] })).toThrow(MimeError);
    });

  it("accepts the plain addresses a client contact list holds", () => {
    for (const a of ["maya@tidewater-bar.example", "o.brien+news@pop-up.example", "a@b.co"])
      expect(isPlainAddress(a), a).toBe(true);
  });

  it("refuses no recipients, and more than five", () => {
    expect(() => buildMessage({ ...parts, to: [] })).toThrow(MimeError);
    const many = Array.from({ length: 6 }, (_, i) => `c${i}@tidewater-bar.example`);
    expect(() => buildMessage({ ...parts, to: many })).toThrow(MimeError);
  });

  it("refuses a body with a control character other than tab and line breaks", () => {
    for (const body of ["a\u0000b", "a\u001bb", "a\u0085b", "a\u2028b"])
      expect(() => buildMessage({ ...parts, body }), JSON.stringify(body)).toThrow(MimeError);
  });
});

describe("readRaw only reads what buildRaw writes", () => {
  const raw = (text: string) => Buffer.from(text, "utf8").toString("base64url");
  const good = buildMessage(parts);

  it("refuses an extra header (a Bcc, a Cc, a Reply-To, a From, a second To)", () => {
    for (const extra of [
      "Bcc: spy@evil.example",
      "Cc: spy@evil.example",
      "Reply-To: spy@evil.example",
      "From: spy@evil.example",
      "To: spy@evil.example",
    ]) {
      const text = good.replace("MIME-Version: 1.0", `MIME-Version: 1.0\r\n${extra}`);
      expect(() => readRaw(raw(text)), extra).toThrow(MimeError);
    }
  });

  it("refuses a header folded onto the To line", () => {
    const text = good.replace(
      `To: ${CONTACTS.join(", ")}`,
      `To: ${CONTACTS[0]}\r\n  spy@evil.example`,
    );
    expect(() => readRaw(raw(text))).toThrow(MimeError);
  });

  it("refuses text that is not base64url, a message with no body part, and a bare LF", () => {
    expect(() => readRaw("not base64!")).toThrow(MimeError);
    expect(() => readRaw(raw("To: a@b.example"))).toThrow(MimeError);
    expect(() => readRaw(raw(good.replace(/\r\n/g, "\n")))).toThrow(MimeError);
  });

  it("refuses a body that is not valid base64", () => {
    const text = good.replace(/\r\n\r\n[\s\S]*$/, "\r\n\r\n!!!!");
    expect(() => readRaw(raw(text))).toThrow(MimeError);
  });
});
