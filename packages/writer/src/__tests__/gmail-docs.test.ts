/**
 * docs/guides/mailbox-drafts.md shows real output: the two JSON blocks are what the writer produces for the
 * Tidewater Bar's weekly note, a dry run and then a write against the local stand-in mailbox.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEmailDraft } from "../gmail/apply.js";
import { job } from "./helpers.js";
import { MAIL, mailRig } from "./gmail-helpers.js";

afterEach(() => vi.unstubAllGlobals());

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/mailbox-drafts.md", import.meta.url)),
  "utf8",
);
const blocks = [...page.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!));

describe("docs/guides/mailbox-drafts.md", () => {
  const j = job(MAIL, { kind: "email" });

  it("shows the real dry-run entry", async () => {
    const r = mailRig({ mode: "dry-run" }, j);
    expect(blocks[0]).toEqual(await applyEmailDraft(j, r.deps));
  });

  it("shows the real entry for the write, and the draft the stand-in mailbox holds", async () => {
    const r = mailRig({ mode: "write" }, j);
    const entry = await applyEmailDraft(j, r.deps);
    const { to, subject, text } = r.gmail.drafts[0]!;
    expect(blocks[1]).toEqual({
      entry,
      draft: { to, subject, text },
      otherRequests: r.gmail.unexpected,
    });
  });
});
