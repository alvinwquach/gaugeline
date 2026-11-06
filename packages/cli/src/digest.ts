import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ConfigError,
  EMAIL_FROM_ENV,
  ONBOARDING_FROM,
  RESEND_KEY_ENV,
  buildDigest,
  digestHtml,
  digestMarkdown,
  digestVerdict,
  parseAddresses,
  parseResult,
  postEmail,
  postJson,
  resolveTargets,
  type Digest,
  type Result,
} from "@gaugeline/core";

export const DIGEST_MD = "gaugeline-digest.md";
export const DIGEST_HTML = "gaugeline-digest.html";

/** Every *.json file in the folder that is a saved run, in name order. Anything else stops it. */
export function readRuns(dir: string): Result[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new ConfigError(`${dir} is not a folder of saved runs.`, {
      hint: "Save each run with gaugeline <address> --json > runs/<date>.json, then pass --runs runs.",
    });
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0)
    throw new ConfigError(`${dir} has no saved runs (*.json).`, {
      hint: "Save each run with gaugeline <address> --json > runs/<date>.json.",
    });
  return files.map((f) => {
    try {
      return parseResult(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      throw new ConfigError(`${join(dir, f)} is not a saved Gaugeline run (--json output).`, {
        hint: "Keep only runs saved with --json in the folder.",
      });
    }
  });
}

/** A zone Intl knows ("America/Los_Angeles"), or a ConfigError. */
export function checkTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    throw new ConfigError(`--time-zone: "${zone}" is not a time zone.`, {
      hint: "Use an IANA name such as America/Los_Angeles or Europe/London.",
    });
  }
}

export interface DigestIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: Record<string, string | undefined>;
}

/**
 * Read the runs, write the Markdown and HTML, print the Markdown, and send it only where sending
 * is configured (email through Resend, or a webhook). A failed send never fails the command.
 */
export async function runDigest(
  opts: {
    runs: string;
    timeZone?: string;
    notify: { email?: string; webhook?: string };
    quiet: boolean;
    cwd: string;
    emailEndpoint?: string;
  },
  io: DigestIo,
): Promise<Digest> {
  const results = readRuns(resolve(opts.cwd, opts.runs));
  let digest: Digest;
  try {
    digest = buildDigest(results, {
      ...(opts.timeZone ? { timeZone: checkTimeZone(opts.timeZone) } : {}),
    });
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError((err as Error).message, { hint: "Keep one site's runs in the folder." });
  }
  const md = digestMarkdown(digest);
  const html = digestHtml(digest);
  writeFileSync(join(opts.cwd, DIGEST_MD), md);
  writeFileSync(join(opts.cwd, DIGEST_HTML), html);
  io.stdout.write(md);
  if (!opts.quiet) io.stderr.write(`Digest written to ./${DIGEST_MD} and ./${DIGEST_HTML}\n`);

  // Only email and the webhook carry a digest; nothing is sent unless one is configured.
  const targets = resolveTargets(opts.notify, io.env).filter(
    (t) => t.channel === "email" || t.channel === "webhook",
  );
  const host = new URL(digest.site).hostname;
  for (const t of targets) {
    if (t.channel === "webhook") {
      const r = await postJson(t.url, {
        kind: "gaugeline-digest",
        verdict: digestVerdict(digest),
        digest,
      });
      io.stderr.write(
        r.ok
          ? "Sent the digest to the webhook.\n"
          : `Could not send the digest to the webhook: ${r.error ?? "it failed"}.\n`,
      );
      continue;
    }
    const to = parseAddresses(t.url);
    const apiKey = io.env[RESEND_KEY_ENV]?.trim();
    if (!to.ok) {
      io.stderr.write(`Could not email the digest: ${to.error}.\n`);
      continue;
    }
    if (!apiKey) {
      io.stderr.write(
        `Could not email the digest: ${RESEND_KEY_ENV} is not set: add your Resend API key to the environment to send email.\n`,
      );
      continue;
    }
    const from = io.env[EMAIL_FROM_ENV]?.trim();
    if (!from)
      io.stderr.write(
        `Email is sent from Resend's shared address (${ONBOARDING_FROM}). Set ${EMAIL_FROM_ENV} to send from your own domain.\n`,
      );
    const r = await postEmail(
      {
        to: to.to,
        apiKey,
        ...(from ? { from } : {}),
        ...(opts.emailEndpoint ? { endpoint: opts.emailEndpoint } : {}),
      },
      { subject: `${host}: ${digestVerdict(digest)}`, html, text: md },
    );
    io.stderr.write(
      r.ok ? "Emailed the digest.\n" : `Could not email the digest: ${r.error ?? "it failed"}.\n`,
    );
  }
  return digest;
}
