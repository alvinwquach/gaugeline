// check-community: allow-email (invented recipients at reserved .example domains: the draft tests, and the address shapes the builder accepts)
/**
 * Shared stand-ins for the Gmail draft tests: an invented mailbox that implements `users.drafts.create`
 * and nothing else (any other request it sees is recorded as a violation and answered 404), an approvals
 * table and a trail. No network: the sender's global fetch is replaced by the stand-in.
 */
import { vi } from "vitest";
import type { MailDeps } from "../gmail/apply.js";
import { gmailSender } from "../gmail/send.js";
import type { TrailEntry } from "../types.js";
import { approvalFor, NOW, ORG, SITE, job } from "./helpers.js";

export const GMAIL_TOKEN = ["ya29", ".", "invented0access0token0for0tests0only0000"].join("");
export const CONTACTS = ["maya@tidewater-bar.example", "owner@tidewater-bar.example"];
export const MAIL = {
  subject: "Tidewater Bar: this week on your website",
  body: [
    "Hi Maya,",
    "",
    "This week we fixed the broken drinks link on the menu page.",
    "",
    "The finding: https://reports.northgate-studio.example/tidewater-bar/f/3",
    "",
    "Sam",
  ].join("\n"),
};

let counter = 100;
/** An approved email job with its own decision id, so the in-process duplicate guard never links two tests. */
export const mailJob = (payload: unknown = MAIL, over: Parameters<typeof job>[1] = {}) =>
  job(payload, { kind: "email", decisionId: String(++counter), ...over });

export interface StoredDraft {
  id: string;
  to: string[];
  subject: string;
  text: string;
  /** Every header line, unfolded, in order. */
  headers: string[];
}

/** Decode one RFC 2047 "B" encoded-word run, independently of the writer's own code. */
function decodeHeader(value: string): string {
  return value
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=\s?/g, (_, b: string) =>
      Buffer.from(b, "base64").toString("utf8"),
    );
}

/** A stand-in Gmail: only `POST /gmail/v1/users/me/drafts` exists. */
export function standInGmail(token: string = GMAIL_TOKEN) {
  const requests: { method: string; url: string; auth: string | null; body: string }[] = [];
  const drafts: StoredDraft[] = [];
  /** Requests that are not drafts.create (a send, a list, a delete ...). The tests expect none. */
  const unexpected: string[] = [];
  const state = { revoked: false, status: 0, replyBody: undefined as unknown, redirect: false };
  const handler = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(url));
    const method = String(init.method ?? "GET");
    const auth = new Headers(init.headers).get("authorization");
    requests.push({ method, url: u.href, auth, body: String(init.body ?? "") });
    if (state.redirect) throw new TypeError("redirect refused");
    const create =
      method === "POST" &&
      u.origin === "https://gmail.googleapis.com" &&
      u.pathname === "/gmail/v1/users/me/drafts" &&
      u.search === "";
    if (!create) {
      unexpected.push(`${method} ${u.origin}${u.pathname}`);
      return new Response("{}", { status: 404 });
    }
    if (state.status !== 0)
      return new Response(JSON.stringify(state.replyBody ?? { error: { message: "no" } }), {
        status: state.status,
      });
    if (state.revoked || auth !== `Bearer ${token}`)
      return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED" } }), {
        status: 401,
      });
    const raw = (JSON.parse(String(init.body)) as { message: { raw: string } }).message.raw;
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const [head = "", ...rest] = text.split("\r\n\r\n");
    const headers = head.replace(/\r\n[ \t]+/g, " ").split("\r\n");
    const header = (name: string) =>
      headers
        .find((h) => h.toLowerCase().startsWith(`${name.toLowerCase()}:`))
        ?.slice(name.length + 1)
        .trim() ?? "";
    const id = `r${1000 + drafts.length}`;
    drafts.push({
      id,
      headers,
      to: header("To")
        .split(",")
        .map((a) => a.trim()),
      subject: decodeHeader(header("Subject")),
      text: Buffer.from(rest.join("\r\n\r\n").replace(/\s+/g, ""), "base64").toString("utf8"),
    });
    return new Response(
      JSON.stringify({ id, message: { id: `m${id}`, threadId: `t${id}`, labelIds: ["DRAFT"] } }),
      { status: 200 },
    );
  };
  return {
    requests,
    drafts,
    unexpected,
    state,
    handler,
    install: () => vi.stubGlobal("fetch", handler),
  };
}

export type Gmail = ReturnType<typeof standInGmail>;

/** A token source that can be switched off, as a disconnect does. */
export function tokenSource(token: string | null = GMAIL_TOKEN) {
  const t = { current: token as string | null, reads: 0 };
  return {
    t,
    source: async () => {
      t.reads += 1;
      return t.current;
    },
  };
}

/**
 * Deps for one email job over the stand-in: the real sender, the approvals table holding the row that
 * matches `forJob` unless told otherwise, and a trail that records what the writer appends.
 */
export function mailRig(
  over: Partial<MailDeps> = {},
  forJob = mailJob(),
  approval: Parameters<typeof approvalFor>[1] | null = {},
) {
  const gmail = standInGmail();
  gmail.install();
  const log: TrailEntry[] = [];
  const lookups: string[] = [];
  const tok = tokenSource();
  const target = { orgId: ORG, siteId: SITE, contacts: CONTACTS };
  const deps: MailDeps = {
    target,
    createDraft: gmailSender(tok.source, target.contacts),
    trail: { record: async (e) => void log.push(e) },
    approvals: {
      find: async (id) => {
        lookups.push(id);
        return approval === null ? null : approvalFor(forJob, approval);
      },
    },
    mode: "write",
    env: {},
    orgPaused: async () => false,
    now: () => NOW,
    ...over,
  };
  return { deps, gmail, log, lookups, tok, job: forJob };
}
