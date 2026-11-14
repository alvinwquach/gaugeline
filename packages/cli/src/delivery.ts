import {
  ConfigError,
  SUPABASE_ACCESS_TOKEN,
  runSupabasePlatform,
  createFetcher,
  formatAge,
  freezeEnv,
  RESEND_API_KEY,
  runDelivery,
  runWebhooks,
  STRIPE_API_KEY,
  STRIPE_EVENT_RETENTION_DAYS,
  type FetcherOptions,
  type Outcome,
  type Result,
} from "@gaugeline/core";
import { formatTerminal } from "./reporter.js";
import { PLATFORMS_CONFIG_FILE, readPlatformsConfig } from "./schema-config.js";

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env?: Record<string, string | undefined>;
}

interface Deps {
  now: Date;
  fetcher?: FetcherOptions;
  color?: boolean;
  /** Tests: do not wait out a Retry-After. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests: how many days Resend is taken to keep. */
  retentionDays?: number;
  /** Where gaugeline.platforms.json is looked for. */
  cwd?: string;
}

/** The findings, as the page check prints them, and the high ones counted for --ci. */
function describe(result: Result, color: boolean): { text: string; outcome: Outcome } {
  const { findings, passed, couldNotCheck } = result;
  return {
    text: formatTerminal({
      result: { findings, passed, failed: [], warnings: [], couldNotCheck, sampled: {} },
      color,
    }),
    outcome: {
      kind: "ran",
      highFindings: findings.filter((f) => f.severity === "high").length,
      drift: false,
    },
  };
}

const plural = (n: number, word: string): string => `${n} ${word}`;

/**
 * gaugeline delivery --paid --sent: counts and UTC days, nothing else. The lines are the window,
 * the totals ("12 paid, 9 sent"), one line for each day with any, and then what the checks found.
 * --json prints the schema 2 result and nothing else (the counts are in `sampled` and in the
 * finding). Notices (a page cap, a window cut short, a key worth swapping) go to stderr.
 */
export async function runDeliveryCommand(
  args: {
    paid: boolean;
    sent: boolean;
    since?: string;
    allowSecretKey: boolean;
    json: boolean;
    quiet: boolean;
  },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  const run = await runDelivery({
    paid: args.paid,
    sent: args.sent,
    ...(args.since !== undefined ? { since: args.since } : {}),
    env: freezeEnv(io.env ?? {}, [STRIPE_API_KEY, RESEND_API_KEY]),
    fetcher: createFetcher(deps.fetcher),
    now: deps.now,
    allowSecretKey: args.allowSecretKey,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.retentionDays ? { retentionDays: deps.retentionDays } : {}),
  });
  if (!args.quiet) for (const n of run.notices) io.stderr.write(`${n}\n`);
  const { text, outcome } = describe(run.result, deps.color ?? false);
  if (args.json) {
    io.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`);
    return outcome;
  }
  const totals = [
    ...(run.paid !== undefined ? [`${run.paid} paid`] : []),
    ...(run.sent !== undefined ? [`${run.sent} sent`] : []),
  ].join(", ");
  io.stdout.write(
    `${args.paid && args.sent ? "Paid orders and sent emails" : args.paid ? "Paid orders" : "Sent emails"}, ${run.window.label} (${run.comparedFrom} to ${run.comparedTo} UTC)\n${totals}\n`,
  );
  // One side alone is a count and nothing was compared, so there are no days and no findings to print.
  if (!run.reconciled) return outcome;
  if (run.reconciled.byDay.length > 0) {
    io.stdout.write("\n");
    for (const d of run.reconciled.byDay)
      io.stdout.write(`${d.day}  ${d.paid} paid, ${d.sent} sent\n`);
  }
  io.stdout.write(`\n${text}`);
  return outcome;
}

/** gaugeline platform --webhooks: one line for each endpoint (a host, its state, a count and an age), then the findings. */
export async function runPlatformCommand(
  args: { webhooks: boolean; allowSecretKey: boolean; json: boolean; quiet: boolean },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  if (!args.webhooks) return runPlatformReads(args, io, deps);
  const run = await runWebhooks({
    env: freezeEnv(io.env ?? {}, [STRIPE_API_KEY]),
    fetcher: createFetcher(deps.fetcher),
    now: deps.now,
    allowSecretKey: args.allowSecretKey,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  if (!args.quiet) for (const n of run.notices) io.stderr.write(`${n}\n`);
  const { text, outcome } = describe(run.result, deps.color ?? false);
  if (args.json) {
    io.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`);
    return outcome;
  }
  const enabled = run.endpoints.filter((e) => e.enabled).length;
  io.stdout.write(
    `Stripe webhook endpoints: ${run.endpoints.length} (${enabled} enabled, ${run.endpoints.length - enabled} disabled)\n` +
      `Events read: ${run.eventsFrom} to ${deps.now.toISOString().slice(0, 10)} UTC (Stripe keeps events for ${STRIPE_EVENT_RETENTION_DAYS} days)\n`,
  );
  if (run.endpoints.length > 0) io.stdout.write("\n");
  const width = Math.max(0, ...run.endpoints.map((e) => e.host.length));
  for (const e of run.endpoints) {
    const state = !e.enabled
      ? "disabled"
      : e.undelivered > 0 && e.oldestAgeSeconds !== null
        ? `enabled, ${plural(e.undelivered, e.undelivered === 1 ? "event" : "events")} not delivered, the oldest ${formatAge(e.oldestAgeSeconds)} old`
        : "enabled, nothing waiting";
    io.stdout.write(`${e.host.padEnd(width)}  ${state}\n`);
  }
  io.stdout.write(`\n${text}`);
  return outcome;
}

/**
 * gaugeline platform (no flag): the platforms in gaugeline.platforms.json, read through their own
 * MCP servers in read-only mode (ADR-0008). Supabase is the one so far. One line says what was read
 * and how many requests it took, then the findings; a read that stopped says why, in Gaugeline's words.
 */
async function runPlatformReads(
  args: { json: boolean; quiet: boolean },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  const config = readPlatformsConfig(deps.cwd ?? process.cwd());
  if (config === undefined)
    throw new ConfigError(
      `gaugeline platform needs --webhooks, or a ${PLATFORMS_CONFIG_FILE} naming the platforms to read.`,
      { hint: "The steps are in docs/delivery (Stripe) and docs/sources/supabase-mcp (Supabase)." },
    );
  const env = freezeEnv(io.env ?? {}, [SUPABASE_ACCESS_TOKEN]);
  if (env[SUPABASE_ACCESS_TOKEN] === undefined || env[SUPABASE_ACCESS_TOKEN] === "")
    throw new ConfigError(`Set ${SUPABASE_ACCESS_TOKEN} to read the Supabase project.`, {
      hint: "Keys are read from the environment only and never printed. The steps are in docs/sources/supabase-mcp.",
    });
  const { read, result } = await runSupabasePlatform({
    fetcher: createFetcher(deps.fetcher),
    env,
    projectRef: config.supabase.projectRef,
    now: deps.now,
  });
  const { text, outcome } = describe(result, deps.color ?? false);
  if (args.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return outcome;
  }
  io.stdout.write(
    `Supabase project ${read.projectRef}, read-only through Supabase's MCP server (${plural(read.calls, read.calls === 1 ? "request" : "requests")})\n`,
  );
  if (read.status === "read") {
    const parts = [
      read.tables === undefined
        ? "tables not read"
        : `${plural(read.tables.length, read.tables.length === 1 ? "table" : "tables")} in public`,
      read.advisors === undefined
        ? "security advisor not read"
        : `${plural(read.advisors.length, read.advisors.length === 1 ? "security lint" : "security lints")}`,
      read.migrations === undefined
        ? "migrations not read"
        : `${plural(read.migrations.count, read.migrations.count === 1 ? "migration" : "migrations")}${read.migrations.latest ? `, the newest ${read.migrations.latest}` : ""}`,
    ];
    io.stdout.write(`Read: ${parts.join("; ")}\n`);
  } else io.stdout.write(`Supabase could not be read: ${read.reason ?? "no reason recorded"}.\n`);
  io.stdout.write(`\n${text}`);
  return outcome;
}
