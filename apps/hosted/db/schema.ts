/**
 * The hosted tables as Drizzle sees them, for typed queries. The SQL files in db/migrations are the source
 * of truth (tables, constraints, row-level security policies, grants, triggers); this file describes the
 * same tables and columns, and a test fails if the two differ. Policies are not repeated here: they live
 * in 0002_tenancy.sql, reviewed as SQL.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
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
  /** A paused site gets no nightly job (0004). */
  active: boolean("active").notNull().default(true),
  /** The agency's client this site is grouped under (X66); null when ungrouped. */
  clientId: uuid("client_id"),
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
    /** pull_request | email | sanity_draft (0005; the shapes are apps/hosted/inbox/kinds.ts). */
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
    /** SHA-256 of the approved payload's jsonb text, set by a trigger (0005); null for a decline. */
    payloadSha256: text("payload_sha256"),
  },
  (t) => [
    index("decisions_draft_idx").on(t.draftId, t.id.desc()),
    // One person's choice per draft (0005).
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

/** Server-only: an upload token's hash (never the token) and the 8-character prefix that finds it. */
export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    siteId: uuid("site_id").notNull(),
    prefix: text("prefix").notNull().unique(),
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("tokens_site_idx").on(t.siteId)],
).enableRLS();

/** Server-only: the Idempotency-Keys POST /runs has seen, per site. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    siteId: uuid("site_id").notNull(),
    key: text("key").notNull(),
    orgId: uuid("org_id").notNull(),
    requestHash: text("request_hash").notNull(),
    runId: uuid("run_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.key] }),
    index("idempotency_keys_created_idx").on(t.createdAt),
  ],
).enableRLS();

export type JobStatus = "queued" | "running" | "done" | "failed";

/** Server-only (0004): the nightly queue. A claim is a lease: status "running" and locked_at. */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    siteId: uuid("site_id").notNull(),
    kind: text("kind").$type<"nightly" | "manual">().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    probing: boolean("probing").notNull().default(false),
    /** A nightly job's date in the site's time zone. */
    scheduledFor: date("scheduled_for"),
    runId: uuid("run_id"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_claim_idx").on(t.runAfter, t.id), index("jobs_lease_idx").on(t.lockedAt)],
).enableRLS();

/** What a run opened and closed against the site's previous run, by fingerprint. Only runs that changed. */
export const runChanges = pgTable(
  "run_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    siteId: uuid("site_id").notNull(),
    runId: uuid("run_id").notNull().unique(),
    previousRunId: uuid("previous_run_id"),
    opened: integer("opened").notNull(),
    stillOpen: integer("still_open").notNull(),
    closed: integer("closed").notNull(),
    openedFingerprints: text("opened_fingerprints").array().notNull(),
    closedFingerprints: text("closed_fingerprints").array().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("run_changes_site_idx").on(t.siteId, t.createdAt.desc())],
).enableRLS();

/** An agency's client (X66): one business, which may have several sites. Staff only. */
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  name: text("name").notNull(),
  createdAt: createdAt(),
}).enableRLS();

/** An invitation as data (X66): only the SHA-256 of its token is stored; nothing here sends an email. */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<MemberRole>().notNull(),
    siteId: uuid("site_id"),
    invitedBy: uuid("invited_by").notNull(),
    tokenSha256: text("token_sha256").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [index("invites_org_idx").on(t.orgId, t.createdAt.desc())],
).enableRLS();

/** The weekly update drafted for one client (X66). Append-only; approved in the drafts inbox. */
export const weeklyUpdates = pgTable("weekly_updates", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  clientId: uuid("client_id").notNull(),
  weekStart: date("week_start").notNull(),
  siteIds: uuid("site_ids").array().notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  draftId: uuid("draft_id").notNull().unique(),
  createdAt: createdAt(),
}).enableRLS();

/** A weekly update as sent (X66): one row per update, its text filled from the approval. Append-only. */
export const weeklyUpdateSends = pgTable("weekly_update_sends", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid("org_id").notNull(),
  updateId: uuid("update_id").notNull().unique(),
  decisionId: bigint("decision_id", { mode: "number" }).notNull(),
  clientId: uuid("client_id"),
  siteIds: uuid("site_ids").array(),
  subject: text("subject"),
  body: text("body"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export type EmailFrequency = "every_change" | "fix_first" | "off";

/** Per person, per organisation (0007): the address, whether it is confirmed, and how often to write. */
export const emailPreferences = pgTable(
  "email_preferences",
  {
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    email: text("email"),
    emailConfirmedAt: timestamp("email_confirmed_at", { withTimezone: true }),
    /** Null: the default for the role (every change for owners and admins, off for members). */
    frequency: text("frequency").$type<EmailFrequency>(),
    timezone: text("timezone"),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
).enableRLS();

export type EmailSendStatus = "sending" | "sent" | "failed";

/** Server-only (0007): one morning email per person, organisation and local day. The key is the idempotency key. */
export const emailSends = pgTable(
  "email_sends",
  {
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id").notNull(),
    localDate: date("local_date").notNull(),
    kind: text("kind").$type<"morning">().notNull().default("morning"),
    status: text("status").$type<EmailSendStatus>().notNull().default("sending"),
    attempts: integer("attempts").notNull().default(1),
    coversFrom: timestamp("covers_from", { withTimezone: true }).notNull(),
    coversTo: timestamp("covers_to", { withTimezone: true }).notNull(),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId, t.localDate, t.kind] }),
    index("email_sends_last_idx").on(t.orgId, t.userId, t.coversTo.desc()),
  ],
).enableRLS();

/** An organisation's Slack channel or Sentry project (X67). The address is a Vault secret: name and host only. */
export const notificationChannels = pgTable("notification_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  kind: text("kind").$type<"slack" | "sentry">().notNull(),
  label: text("label").notNull(),
  host: text("host").notNull(),
  secretName: text("secret_name").notNull(),
  status: text("status").$type<"active" | "disabled">().notNull().default("active"),
  failures: integer("failures").notNull().default(0),
  disabledReason: text("disabled_reason").$type<
    "rejected" | "failed-repeatedly" | "address-refused"
  >(),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: createdAt(),
}).enableRLS();

/** Which findings go to a channel, and when. */
export const notificationRules = pgTable("notification_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  siteId: uuid("site_id"),
  minSeverity: text("min_severity").$type<"high" | "medium" | "low">().notNull().default("high"),
  checkIds: text("check_ids").array(),
  onlyChanges: boolean("only_changes").notNull().default(true),
  quietStart: smallint("quiet_start"),
  quietEnd: smallint("quiet_end"),
  createdAt: createdAt(),
}).enableRLS();

/** The outbox and delivery log: a status, a count and a short code. Never an address or a message body. */
export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  kind: text("kind").$type<"run" | "test">().notNull(),
  runId: uuid("run_id"),
  siteId: uuid("site_id"),
  status: text("status").$type<"queued" | "sending" | "sent" | "failed">().notNull(),
  sendAfter: timestamp("send_after", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  httpStatus: integer("http_status"),
  errorCode: text("error_code"),
  findings: integer("findings").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
}).enableRLS();

/** A chat workspace an organisation connected (X69). The signing secret is a Vault secret: its name only. */
export const chatConnections = pgTable("chat_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  provider: text("provider").$type<"slack" | "discord" | "teams">().notNull(),
  label: text("label").notNull(),
  workspaceRef: text("workspace_ref"),
  secretName: text("secret_name").notNull(),
  status: text("status").$type<"active" | "disabled">().notNull().default("active"),
  createdAt: createdAt(),
}).enableRLS();

/** Which member a chat user is, per connection: proposed by an admin, confirmed by the member. */
export const chatIdentities = pgTable(
  "chat_identities",
  {
    orgId: uuid("org_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    chatUserId: text("chat_user_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdAt: createdAt(),
    /** Set by the member themself (signed in); a link counts only once it is. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.chatUserId] }),
    index("chat_identities_user_idx").on(t.orgId, t.userId),
  ],
).enableRLS();

/** A registered agent (AG-02): owner, scopes and the SHA-256 of its token, never the token (0012). */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    /** Null for a token migrated from 0005, or once the owner has left: the shadow inventory flags it. */
    ownerId: uuid("owner_id"),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'`),
    tokenSha256: text("token_sha256").notNull().unique(),
    tokenPrefix: text("token_prefix").unique(),
    /** "migrated_0005" only for tokens moved in from 0005 (no prefix); every later agent is "registered". */
    origin: text("origin").$type<"registered" | "migrated_0005">().notNull().default("registered"),
    status: text("status").$type<"active" | "disabled" | "revoked">().notNull().default("active"),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [index("agents_org_idx").on(t.orgId, t.createdAt.desc())],
).enableRLS();

/** Every status an agent has had, who set it and when (append-only, written by a trigger). */
export const agentEvents = pgTable(
  "agent_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    changedBy: uuid("changed_by"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_events_agent_idx").on(t.agentId, t.id)],
).enableRLS();
