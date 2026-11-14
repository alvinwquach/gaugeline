import type { IncomingMessage } from "node:http";
import { parseAddress } from "@gaugeline/core";

export const BODY_LIMIT = 4096;
export const URL_LIMIT = 2048;

/** A body that can't be accepted: the status, and one sentence the app can show. */
export class BodyError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

/** The request body, counted while it is read: past BODY_LIMIT bytes it stops reading and throws 413. */
export function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        req.pause();
        reject(new BodyError(413, `The request is larger than ${limit} bytes.`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * POST /api/check's body: Content-Type application/json, exactly { "url": string }, the string at
 * most 2048 characters, a bare domain or http(s), with no username or password.
 */
export function parseCheckBody(contentType: string | undefined, text: string): { url: string } {
  if (!/^application\/json(?:\s*;|$)/i.test((contentType ?? "").trim()))
    throw new BodyError(415, "Send the address as JSON, with Content-Type: application/json.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BodyError(400, "The request isn't valid JSON.");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new BodyError(400, 'Send an object with one key, url: { "url": "yoursite.com" }.');
  const keys = Object.keys(json);
  if (keys.length !== 1 || keys[0] !== "url")
    throw new BodyError(400, 'The only key is url: { "url": "yoursite.com" }.');
  const url = (json as { url: unknown }).url;
  if (typeof url !== "string" || url.trim() === "")
    throw new BodyError(400, "The address must be text, such as yoursite.com.");
  if (url.length > URL_LIMIT)
    throw new BodyError(400, `The address is longer than ${URL_LIMIT} characters.`);
  const a = parseAddress(url);
  if (!a.ok) throw new BodyError(400, a.reason);
  if (a.url.username !== "" || a.url.password !== "")
    throw new BodyError(400, "Leave the username and password out of the address.");
  return { url: a.url.href };
}
