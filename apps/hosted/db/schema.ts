/**
 * The hosted tables as Drizzle sees them, for typed queries. The SQL files in db/migrations are the source
 * of truth (tables, constraints, row-level security policies, grants, triggers); this file describes the
 * same tables and columns, and a test fails if the two differ. Policies are not repeated here: they live
 * in 0002_tenancy.sql, reviewed as SQL.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const organisations = pgTable("organisations", {
  orgId: uuid("org_id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: createdAt(),
}).enableRLS();

export const sites = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: createdAt(),
}).enableRLS();

export type MemberRole = "owner" | "admin" | "member" | "client";

export const members = pgTable(
  "members",
  {
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<MemberRole>().notNull(),
    /** Set for a client viewer (their one site), null for everyone else. */
    siteId: uuid("site_id"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("members_user_id_idx").on(t.userId)],
).enableRLS();

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    siteId: uuid("site_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    summary: jsonb("summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("runs_site_started_idx").on(t.siteId, t.startedAt.desc())],
).enableRLS();

export type Severity = "high" | "medium" | "low";

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    siteId: uuid("site_id").notNull(),
    runId: uuid("run_id").notNull(),
    checkId: text("check_id").notNull(),
    severity: text("severity").$type<Severity>().notNull(),
    title: text("title").notNull(),
    /** One evidence line, at most 1000 characters. Never page content. */
    evidence: text("evidence").notNull().default(""),
    url: text("url").notNull(),
    /** core's fingerprint(): 16 hex characters, the join key between runs. */
    fingerprint: text("fingerprint").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("findings_site_fingerprint_idx").on(t.siteId, t.fingerprint),
    index("findings_run_idx").on(t.runId),
  ],
).enableRLS();

/** Append-only: a draft never changes after it is written; an edit is a decision of kind "edited". */
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    siteId: uuid("site_id").notNull(),
    /** pull_request | email | sanity_draft (0004; the shapes are apps/hosted/inbox/kinds.ts). */
    kind: text("kind").$type<"pull_request" | "email" | "sanity_draft">().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    findingIds: uuid("finding_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("drafts_site_idx").on(t.siteId, t.createdAt.desc())],
).enableRLS();

export type Decision = "approved" | "edited" | "declined";

/** Append-only: INSERT and SELECT only; a trigger refuses UPDATE, DELETE and TRUNCATE for every role. */
export const decisions = pgTable(
  "decisions",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id").notNull(),
    draftId: uuid("draft_id").notNull(),
    decision: text("decision").$type<Decision>().notNull(),
    editedPayload: jsonb("edited_payload").$type<Record<string, unknown>>(),
    reason: text("reason"),
    decidedBy: uuid("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    /** SHA-256 of the approved payload's jsonb text, set by a trigger (0004); null for a decline. */
    payloadSha256: text("payload_sha256"),
  },
  (t) => [
    index("decisions_draft_idx").on(t.draftId, t.id.desc()),
    // One person's choice per draft (0004).
    uniqueIndex("decisions_one_choice_per_draft")
      .on(t.draftId)
      .where(sql`decision in ('approved', 'edited', 'declined')`),
  ],
).enableRLS();

/** Append-only like decisions. The latest row per site is the current consent to probing checks. */
export const siteConsents = pgTable(
  "site_consents",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id").notNull(),
    siteId: uuid("site_id").notNull(),
    action: text("action").$type<"granted" | "withdrawn">().notNull(),
    wordingVersion: text("wording_version").notNull(),
    recordedBy: uuid("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("site_consents_site_idx").on(t.siteId, t.id.desc())],
).enableRLS();
