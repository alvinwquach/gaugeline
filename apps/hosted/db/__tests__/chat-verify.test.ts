/**
 * Chat request verification (X69): Slack's signature scheme and the body cap, as plain functions. No database.
 * The signing secret is invented and built at run time, so no key-shaped string sits in the source.
 */
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_BODY,
  MAX_SKEW_SECONDS,
  readCappedBody,
  discordVerifier,
  slackVerifier,
  verifyDiscord,
  verifySlack,
} from "../../chat/verify.js";

const SECRET = ["sig", randomBytes(16).toString("hex")].join("-");
const NOW = new Date("2026-11-13T09:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const BODY = Buffer.from("payload=%7B%22type%22%3A%22block_actions%22%7D", "utf8");

/** The signature Slack would send: v0= and the HMAC-SHA256 of `v0:<timestamp>:<body>` as hex. */
function sign(body: Uint8Array, timestamp: number | string, secret = SECRET): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex");
}
const request = (over: Partial<Parameters<typeof verifySlack>[0]> = {}) => ({
  secret: SECRET,
  rawBody: BODY,
  signature: sign(BODY, nowSeconds),
  timestamp: String(nowSeconds),
  now: NOW,
  ...over,
});

describe("verifySlack", () => {
  it("accepts a request signed the way Slack signs it, and keys it by its signature", () => {
    const v = verifySlack(request());
    expect(v).toEqual({ ok: true, requestKey: sign(BODY, nowSeconds).slice(3) });
  });

  it("refuses a different secret, a different body and a different timestamp", () => {
    expect(verifySlack(request({ secret: SECRET + "x" }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(verifySlack(request({ rawBody: Buffer.from(BODY.toString() + " ") }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    // The same signature with a timestamp one second later is a different message.
    expect(verifySlack(request({ timestamp: String(nowSeconds + 1) }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("checks the raw bytes, not a decoded string (a body that is not valid UTF-8)", () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    expect(verifySlack(request({ rawBody: bytes, signature: sign(bytes, nowSeconds) })).ok).toBe(
      true,
    );
    // The decoded-and-re-encoded bytes are not what was signed.
    const decoded = Buffer.from(bytes.toString("utf8"), "utf8");
    expect(verifySlack(request({ rawBody: decoded, signature: sign(bytes, nowSeconds) })).ok).toBe(
      false,
    );
  });

  it("accepts a timestamp exactly at the window and refuses one second beyond it, past or future", () => {
    for (const ts of [nowSeconds - MAX_SKEW_SECONDS, nowSeconds + MAX_SKEW_SECONDS])
      expect(verifySlack(request({ timestamp: String(ts), signature: sign(BODY, ts) })).ok).toBe(
        true,
      );
    for (const ts of [nowSeconds - MAX_SKEW_SECONDS - 1, nowSeconds + MAX_SKEW_SECONDS + 1])
      expect(verifySlack(request({ timestamp: String(ts), signature: sign(BODY, ts) }))).toEqual({
        ok: false,
        reason: "stale",
      });
  });

  it("refuses missing headers and an empty secret", () => {
    expect(verifySlack(request({ signature: null }))).toEqual({
      ok: false,
      reason: "missing-header",
    });
    expect(verifySlack(request({ timestamp: null }))).toEqual({
      ok: false,
      reason: "missing-header",
    });
    expect(verifySlack(request({ secret: "" }))).toEqual({ ok: false, reason: "missing-header" });
  });

  it("refuses a timestamp that is not whole seconds (JavaScript would read some of these as numbers)", () => {
    for (const ts of [
      "",
      " 1",
      "1e9",
      "0x10",
      "-5",
      "1.5",
      "+1",
      "99999999999999",
      String(nowSeconds) + "\n",
    ])
      expect(verifySlack(request({ timestamp: ts, signature: sign(BODY, ts) }))).toEqual({
        ok: false,
        reason: "bad-timestamp",
      });
  });

  it("refuses a malformed or other-version signature without computing a comparison", () => {
    const good = sign(BODY, nowSeconds);
    for (const sig of [
      good.slice(3), // no version
      "v1=" + good.slice(3),
      good.slice(0, -2), // short
      good + "00", // long
      good.replace(/.$/, "g"), // not hex
      "",
    ])
      expect(verifySlack(request({ signature: sig }))).toEqual({
        ok: false,
        reason: "bad-signature",
      });
  });

  it("slackVerifier reads the two headers", () => {
    const headers = new Headers({
      "x-slack-signature": sign(BODY, nowSeconds),
      "x-slack-request-timestamp": String(nowSeconds),
    });
    expect(slackVerifier({ secret: SECRET, rawBody: BODY, headers, now: NOW }).ok).toBe(true);
    expect(
      slackVerifier({ secret: SECRET, rawBody: BODY, headers: new Headers(), now: NOW }),
    ).toEqual({
      ok: false,
      reason: "missing-header",
    });
  });
});

describe("readCappedBody", () => {
  const post = (body: string | null, headers: Record<string, string> = {}) =>
    new Request("https://hosted.example/chat/slack/x", { method: "POST", body, headers });

  it("reads a body up to the cap, exactly", async () => {
    const text = "a".repeat(MAX_CHAT_BODY);
    expect((await readCappedBody(post(text)))?.length).toBe(MAX_CHAT_BODY);
    expect((await readCappedBody(post(null)))?.length).toBe(0);
  });

  it("refuses a body one byte over the cap, with or without a declared length", async () => {
    const text = "a".repeat(MAX_CHAT_BODY + 1);
    expect(await readCappedBody(post(text))).toBeUndefined();
    expect(
      await readCappedBody(post(text, { "content-length": String(MAX_CHAT_BODY + 1) })),
    ).toBeUndefined();
  });

  it("stops reading a stream that sends more than it said, or never says", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 10 * MAX_CHAT_BODY) controller.close();
      },
    });
    const req = new Request("https://hosted.example/chat/slack/x", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(await readCappedBody(req)).toBeUndefined();
    expect(pulled).toBeLessThan(2 * MAX_CHAT_BODY);
  });

  it("refuses a content-length that is not a plain number", async () => {
    for (const len of ["-1", "1e3", "0x10", "1.5"])
      expect(await readCappedBody(post("x", { "content-length": len }))).toBeUndefined();
  });
});

describe("verifyDiscord", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const KEY = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const OTHER = generateKeyPairSync("ed25519");
  const BODY_D = Buffer.from(JSON.stringify({ type: 3, data: { custom_id: "x" } }), "utf8");
  /** What Discord sends: Ed25519 over the timestamp header followed by the raw body, as 128 hex characters. */
  const signD = (body: Uint8Array, ts: number | string, key = privateKey) =>
    edSign(null, Buffer.concat([Buffer.from(String(ts)), body]), key).toString("hex");
  const reqD = (over: Partial<Parameters<typeof verifyDiscord>[0]> = {}) => ({
    publicKey: KEY,
    rawBody: BODY_D,
    signature: signD(BODY_D, nowSeconds),
    timestamp: String(nowSeconds),
    now: NOW,
    ...over,
  });

  it("accepts a request signed by the application's key, keyed by the hash of what was signed", () => {
    const expected = createHash("sha256")
      .update(Buffer.concat([Buffer.from(String(nowSeconds)), BODY_D]))
      .digest("hex");
    expect(verifyDiscord(reqD())).toEqual({ ok: true, requestKey: expected });
    // Upper-case hex is the same request: the key is not the signature's spelling.
    const shouting = verifyDiscord(reqD({ signature: signD(BODY_D, nowSeconds).toUpperCase() }));
    expect(shouting).toEqual({ ok: true, requestKey: expected });
  });

  it("refuses another key, another body, another timestamp", () => {
    expect(verifyDiscord(reqD({ signature: signD(BODY_D, nowSeconds, OTHER.privateKey) }))).toEqual(
      { ok: false, reason: "bad-signature" },
    );
    expect(verifyDiscord(reqD({ rawBody: Buffer.from(BODY_D.toString() + " ") }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(verifyDiscord(reqD({ timestamp: String(nowSeconds + 1) }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    const otherKey = OTHER.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
    expect(verifyDiscord(reqD({ publicKey: otherKey }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("checks the raw bytes, and the window in both directions", () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    expect(verifyDiscord(reqD({ rawBody: bytes, signature: signD(bytes, nowSeconds) })).ok).toBe(
      true,
    );
    for (const ts of [nowSeconds - MAX_SKEW_SECONDS, nowSeconds + MAX_SKEW_SECONDS])
      expect(verifyDiscord(reqD({ timestamp: String(ts), signature: signD(BODY_D, ts) })).ok).toBe(
        true,
      );
    for (const ts of [nowSeconds - MAX_SKEW_SECONDS - 1, nowSeconds + MAX_SKEW_SECONDS + 1])
      expect(verifyDiscord(reqD({ timestamp: String(ts), signature: signD(BODY_D, ts) }))).toEqual({
        ok: false,
        reason: "stale",
      });
  });

  it("refuses missing headers, a malformed timestamp, signature or key, and never throws on garbage", () => {
    expect(verifyDiscord(reqD({ signature: null }))).toEqual({
      ok: false,
      reason: "missing-header",
    });
    expect(verifyDiscord(reqD({ timestamp: null }))).toEqual({
      ok: false,
      reason: "missing-header",
    });
    expect(verifyDiscord(reqD({ publicKey: "" }))).toEqual({ ok: false, reason: "missing-header" });
    for (const ts of ["", "1e9", "0x10", "-5", "1.5", " 1"])
      expect(verifyDiscord(reqD({ timestamp: ts })), ts).toEqual({
        ok: false,
        reason: "bad-timestamp",
      });
    const good = signD(BODY_D, nowSeconds);
    for (const sig of ["", good.slice(2), good + "00", good.replace(/.$/, "g"), "00".repeat(64)])
      expect(verifyDiscord(reqD({ signature: sig })), sig).toEqual({
        ok: false,
        reason: "bad-signature",
      });
    for (const key of ["zz".repeat(32), KEY.slice(2), KEY + "00", "00".repeat(32)])
      expect(verifyDiscord(reqD({ publicKey: key })).ok, key).toBe(false);
  });

  it("discordVerifier reads the two headers", () => {
    const headers = new Headers({
      "x-signature-ed25519": signD(BODY_D, nowSeconds),
      "x-signature-timestamp": String(nowSeconds),
    });
    expect(discordVerifier({ secret: KEY, rawBody: BODY_D, headers, now: NOW }).ok).toBe(true);
    expect(
      discordVerifier({ secret: KEY, rawBody: BODY_D, headers: new Headers(), now: NOW }),
    ).toEqual({ ok: false, reason: "missing-header" });
  });
});
