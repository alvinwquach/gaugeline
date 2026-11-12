# Hosted app plan (Track 3: G34-G37, X63-X72, X75, X68, F-13, then G39, N16, G40)

Status: plan, 12 Nov 2026. Sources: master spec entries G34-G37 (lines 10235-10435), X63-X75, F-13 (line 600), G39/N16/G40 (lines 11137-11231); "The hosted version" and "What it's built on" landing text as quoted in those entries. Prices: uncited (vendor pricing pages unreachable from this session).

## Principles (owner, 12 Nov)

1. The hosted app calls the same core and the same checks as the CLI (`@gaugeline/core`); it never re-implements a check.
2. Every table has row-level security (RLS). A test lists every table and fails if one has RLS off.
3. Secrets stay server-only (env on the server; never in a client bundle, a log, a finding or a run upload). Site upload tokens are stored as hashes.
4. Probing checks need the site owner's consent, recorded per site: table `site_consents` (append-only like `decisions`: site_id, who, when, wording version). The worker refuses a probing check when no current row exists. The hosted runner never probes unless a consent row exists AND the run asks for it.
5. Checks never run inside a request. Credentialed checks run in the customer's CI/worker; the hosted service only holds public-check capability and findings (spec G35: "we never hold your keys").
6. The hosted service never holds write credentials to a checked system. Approved changes are applied by a job in the CUSTOMER's worker with the customer's own credentials (spec G37). THIS IS A READ-ONLY-RULE QUESTION: see "Owner decisions" 1.

## Where it runs

| Part                                                                                                                                | Choice                                                                                                  | Source   |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------- |
| App + API (Next.js Route Handlers `/api/v1`, Server Actions)                                                                        | `apps/hosted`, Next.js App Router                                                                       | G35      |
| Database, auth, realtime                                                                                                            | Supabase Postgres (Drizzle schema, plain-SQL migrations), Supabase Auth, Realtime on 2 screens          | G34, G37 |
| Schedule                                                                                                                            | pg_cron inserts one job per site at 03:00 site time; a Node worker claims with `FOR UPDATE SKIP LOCKED` | G36      |
| Worker                                                                                                                              | `apps/hosted/worker`, the container image from G30 (Docker) so it runs on any container host            | G36, G30 |
| Email                                                                                                                               | Resend (already used by `--email`, #66)                                                                 | #66      |
| Builders build and test against a plain local/CI Postgres (service container, `auth` schema stub) and create NO account or project. |

## Roles

`owner`, `admin`, `member` (read + approve), `client` (read-only, one site), plus DB roles `app` (RLS), `agent` (INSERT on `drafts` only), `service` (worker). `decisions` is INSERT/SELECT only with a trigger that raises on UPDATE/DELETE for every role.

## Data stored (no page content, no keys)

organisations, members, sites (timezone, probing consent pointer), runs (CLI schema-1 JSON summary), findings (check_id, severity, title, evidence line, url, fingerprint), drafts (kind, payload, finding_ids; status is not a column but the latest decision, view `draft_state`, G34), decisions (append-only), jobs (G36), site_consents (new, append-only), tokens (hash only), notification channels (webhook URL ciphertext, X67), subscriptions (X68, provider ids only).

## Rows: what each delivers, in build order (A = back-end chain, B = product chain)

| Order | Row           | Delivers                                                                                                                | Needs                      | Track                     |
| ----- | ------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------- |
| 1     | G34           | Schema, RLS, append-only decisions, consents table, RLS-on-every-table test                                             | none                       | A                         |
| 2     | G35           | `/api/v1` runs API, per-site token (hash only), idempotency key, `gaugeline --upload`                                   | G34                        | A                         |
| 3     | G36           | `jobs` table, pg_cron fan-out, skip-locked worker, retries, diff by fingerprint, one summary per changed site           | G34, G35                   | A                         |
| 4     | X63           | Sign in, dashboard (sites worst first, what happened last night)                                                        | G34, G35                   | B                         |
| 5     | X64           | Morning email, only when something changed                                                                              | G36, X63                   | B                         |
| 6     | G37           | Drafts inbox, Approve/Edit/Decline, apply job enqueue (the apply job body is an interface here), Realtime on 2 screens  | G34                        | A                         |
| 7     | X66           | Agencies: many sites, client viewers, weekly update                                                                     | X63, G37                   | B                         |
| 8     | X67           | Notifications to Slack, GitHub, Sentry (own channels, ADR-0005 POST)                                                    | G36, X64                   | B                         |
| 9     | X70           | Fix proposal: pull request for what lives in code                                                                       | G37, owner decision 1      | A                         |
| 10    | X71           | Fix proposal: draft in the content system (Sanity)                                                                      | X70, owner decision 1      | A                         |
| 11    | X72           | Fix proposal: one field, old value kept, re-check                                                                       | X70, X71, owner decision 1 | A                         |
| 12    | X69           | Approve in Slack, Discord, Teams (inbound signed webhooks)                                                              | X67, G37                   | B                         |
| 13    | X75           | Drafts in your own Gmail / Outlook mailbox                                                                              | X66, G37, owner decision 1 | B                         |
| 14    | X68           | Billing                                                                                                                 | X63, owner decision 2      | B                         |
| 15    | F-13          | Care-plan receipt ("what we caught")                                                                                    | G34, X64 or X66            | A                         |
| 16-18 | G39, N16, G40 | Decision record for rendered checks; accessibility tools; decision record for listings, creator platforms, self-hosting | none (G39 gates N16)       | whichever builder is free |

## Cost per month

Unmeasured and uncited: supabase.com and vercel.com are not reachable from this session, so I have no sourced prices. Cost drivers, to price once the pages are reachable or the owner pastes the numbers: Supabase plan + compute add-on for the database (size = findings rows, no page content), egress, Auth monthly active users; Next.js host plan (seats); one small always-on container for the worker; Resend emails per month; Stripe fees (X68). Build and test cost today: 0 (local Postgres, no accounts).

## Owner decisions / needs (nothing blocks the other tracks)

1. WRITE PATH (rule 6, ADR policy): X70, X71, X72, X75 and the apply job in G37 write to a checked or user-owned system (a pull request, a CMS draft, one record field, a mailbox draft) after a person approves, using the customer's credentials in the customer's worker. That is a third exception to the read-only rule. I will draft ADR-0009 (proposed) and not build the executors (X70, X71, X72, X75) until the owner approves it. G37 builds the inbox, the decision log and the apply-job ENQUEUE only.
2. Accounts and spend (stop rule; prepare, don't create): Supabase project, Next.js host project, container host for the worker, domain, Resend key, Stripe account (X68), Slack/Discord/Teams apps (X69), GitHub App (X70), Google/Microsoft OAuth apps (X75). Each is listed with exactly what is needed when its row merges.
3. Prices for X68 ("prices agreed with the first teams").
