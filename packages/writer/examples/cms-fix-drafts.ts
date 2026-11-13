/**
 * The runnable example in docs/guides/cms-fix-drafts.md: an approved fix to the opening hours on The
 * Tidewater Bar's page becomes a Sanity draft, against a local stand-in. No account, no token, no network.
 *
 *   pnpm exec tsx packages/writer/examples/cms-fix-drafts.ts
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  applySanityDraft,
  createSanityStandIn,
  valueSha256,
  type Approval,
  type ApplyJob,
  type SanityApplyDeps,
  type TrailEntry,
} from "../src/index.js";

const ORG = "0a000000-0000-4000-8000-00000000000a";
const SITE = "5e000000-0000-4000-8000-0000000000e5";
const TARGET = {
  orgId: ORG,
  siteId: SITE,
  projectId: "tidewtr1",
  dataset: "production",
  apiVersion: "v2025-02-19",
  allowedFields: ["page.hours", "page.phone"],
};

/** The page as it is live in the content system: the hours are wrong. */
const LIVE_PAGE = {
  _id: "contact-page",
  _type: "page",
  _rev: "r1",
  title: "Find The Tidewater Bar",
  hours: "Mon to Sat, 4pm to 11pm",
  phone: "+44 20 7946 0000",
};

/** What the person approved: one field, the new text, and the digest of the text it replaces. */
const payload = {
  documentId: "contact-page",
  documentType: "page",
  set: { hours: "Mon to Sun, 4pm to 11pm" },
  before: { hours: valueSha256(LIVE_PAGE.hours) },
};

const payloadText = JSON.stringify(payload);
const payloadSha256 = createHash("sha256").update(payloadText, "utf8").digest("hex");
const job: ApplyJob = {
  orgId: ORG,
  siteId: SITE,
  draftId: "a1d10000-0000-4000-8000-0000000000a1",
  decisionId: "42",
  kind: "sanity_draft",
  payloadText,
  payloadSha256,
};
const approval: Approval = {
  decisionId: "42",
  draftId: job.draftId,
  orgId: ORG,
  siteId: SITE,
  kind: "sanity_draft",
  decision: "approved",
  payloadSha256,
  decidedAt: new Date("2026-11-12T11:00:00Z"),
  later: [],
};

/** Run the job in the given mode against a stand-in holding `documents`; return the entry and the stand-in. */
async function apply(mode: SanityApplyDeps["mode"], documents: Record<string, unknown>[]) {
  const standIn = createSanityStandIn(TARGET, { documents });
  const trail: TrailEntry[] = [];
  const entry = await applySanityDraft(job, {
    target: TARGET,
    send: standIn.send,
    trail: { record: async (e) => void trail.push(e) },
    approvals: { find: async () => approval },
    mode,
    env: {},
    orgPaused: async () => false,
    now: () => new Date("2026-11-12T12:00:00Z"),
  });
  return { entry, standIn };
}

/** The lines the guide shows. */
export async function run(): Promise<string[]> {
  const out: string[] = [];
  const show = (title: string, value: unknown) =>
    out.push(`${title}\n${JSON.stringify(value, null, 2)}`);

  const dry = await apply("dry-run", [LIVE_PAGE]);
  show("1. Dry run (the default): nothing is sent", dry.entry);
  out.push(`   requests sent: ${dry.standIn.sent.length}`);

  const live = await apply("write", [LIVE_PAGE]);
  show("2. Write: one draft is created", live.entry);
  out.push(`   requests sent: ${live.standIn.sent.map((r) => r.endpoint).join(", ")}`);
  out.push(`   the draft: ${JSON.stringify(live.standIn.docs.get("drafts.contact-page"))}`);
  out.push(`   the live page: ${JSON.stringify(live.standIn.docs.get("contact-page"))}`);

  const replay = await apply("write", [LIVE_PAGE, live.standIn.docs.get("drafts.contact-page")!]);
  show("3. The same approval again: no second write", replay.entry);
  out.push(`   writes sent: ${replay.standIn.writes().length}`);

  const edited = await apply("write", [{ ...LIVE_PAGE, hours: "Tue to Sat, 5pm to midnight" }]);
  show("4. Someone edited the hours meanwhile: refused", edited.entry);
  out.push(`   writes sent: ${edited.standIn.writes().length}`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const line of await run()) console.log(line);
}
