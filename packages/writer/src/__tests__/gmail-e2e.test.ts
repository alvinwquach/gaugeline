/**
 * X75, end to end through the writer's public entry: a job, its approval row, the email writer, the real
 * sender and the stand-in mailbox. The customer's token comes from a store through a token source; a
 * disconnect deletes it and the next draft is refused. Nothing is sent, at any step.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emailDraftWriter,
  gmailSender,
  GMAIL_SCOPE,
  tokenFromStore,
  type EmailDraftWriter,
  type MailDeps,
} from "../index.js";
import { DRAFTS_PATH } from "../gmail/endpoints.js";
import { ORG, SITE, approvalFor, NOW } from "./helpers.js";
import { CONTACTS, GMAIL_TOKEN, MAIL, mailJob, standInGmail } from "./gmail-helpers.js";

afterEach(() => vi.unstubAllGlobals());

/** A store with the shape of the worker's SecretStore (V-01): get and delete by organisation and name. */
function store(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(orgId: string, name: string) {
      return orgId === ORG ? (values.get(name) ?? null) : null;
    },
    async remove(name: string) {
      return values.delete(name);
    },
  };
}

function writerFor(mode: "dry-run" | "write", s: ReturnType<typeof store>) {
  const gmail = standInGmail();
  gmail.install();
  const log: unknown[] = [];
  const job = mailJob();
  const target = { orgId: ORG, siteId: SITE, contacts: CONTACTS };
  const deps: MailDeps = {
    target,
    createDraft: gmailSender(tokenFromStore(s, ORG, "gmail-northgate"), target.contacts),
    trail: { record: async (e) => void log.push(e) },
    approvals: { find: async () => approvalFor(job) },
    mode,
    env: {},
    orgPaused: async () => false,
    now: () => NOW,
  };
  const writer: EmailDraftWriter = emailDraftWriter(deps);
  return { gmail, log, job, writer };
}

describe("an approved update becomes a draft in the person's mailbox, and nothing is sent", () => {
  it("the writer is an EmailDraftWriter for the kind email", () => {
    const { writer } = writerFor("write", store({}));
    expect(writer.kind).toBe("email");
  });

  it("a dry run first (the default), then the real draft, then no second one", async () => {
    const s = store({ "gmail-northgate": GMAIL_TOKEN });
    const dry = writerFor("dry-run", s);
    expect(await dry.writer.apply(dry.job)).toMatchObject({
      outcome: "dry_run",
      planned: [{ endpoint: "createDraft", path: DRAFTS_PATH }],
    });
    expect(dry.gmail.requests).toEqual([]);

    const live = writerFor("write", s);
    const done = await live.writer.apply(live.job);
    expect(done).toMatchObject({ outcome: "applied", ref: "r1000" });
    expect(live.gmail.drafts).toHaveLength(1);
    expect(live.gmail.drafts[0]).toMatchObject({ to: CONTACTS, subject: MAIL.subject });
    expect(live.gmail.unexpected).toEqual([]);

    expect(await live.writer.apply(live.job)).toMatchObject({
      outcome: "refused",
      reason: "duplicate",
    });
    expect(live.gmail.drafts).toHaveLength(1);
  });

  it("disconnecting removes the token: the next draft is refused and nothing reaches Gmail", async () => {
    const s = store({ "gmail-northgate": GMAIL_TOKEN });
    const w = writerFor("write", s);
    await s.remove("gmail-northgate");
    expect(await w.writer.apply(w.job)).toMatchObject({
      outcome: "refused",
      reason: "disconnected",
    });
    expect(w.gmail.requests).toEqual([]);
    expect(JSON.stringify(w.log)).not.toContain(GMAIL_TOKEN);
  });

  it("a token stored for another organisation is not this organisation's", async () => {
    const s = store({ "gmail-northgate": GMAIL_TOKEN });
    const gmail = standInGmail();
    gmail.install();
    const get = tokenFromStore(s, "0b000000-0000-4000-8000-00000000000b", "gmail-northgate");
    expect(await get()).toBeNull();
  });

  it("the scope to grant is the one that can only create drafts", () => {
    expect(GMAIL_SCOPE).toBe("https://www.googleapis.com/auth/gmail.drafts.create");
  });
});
