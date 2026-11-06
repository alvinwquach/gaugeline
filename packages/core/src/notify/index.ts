import type { Result } from "../result.js";
import { discordPayload, slackPayload, webhookPayload } from "./payloads.js";
import { parseAddresses, sendEmail } from "./email.js";
import { postJson, type PostResult } from "./post.js";

export type NotifyOn = "any" | "high" | "always";
export const NOTIFY_ON: readonly NotifyOn[] = ["any", "high", "always"];

/** any: something was found. high: something needs fixing first. always: every run. */
export function shouldNotify(result: Result, mode: NotifyOn): boolean {
  if (mode === "always") return true;
  if (mode === "high") return result.findings.some((f) => f.severity === "high");
  return result.findings.length > 0;
}

export interface Channel {
  id: "slack" | "discord" | "webhook";
  /** The environment variable that supplies the address when no flag does. */
  env: string;
  payload(result: Result, reportUrl?: string): unknown;
}

export const CHANNELS: readonly Channel[] = [
  { id: "slack", env: "GAUGELINE_SLACK_WEBHOOK", payload: slackPayload },
  { id: "discord", env: "GAUGELINE_DISCORD_WEBHOOK", payload: discordPayload },
  { id: "webhook", env: "GAUGELINE_WEBHOOK", payload: (r) => webhookPayload(r) },
];

/** The addresses to email the report to, when no --email flag is given. */
export const EMAIL_ENV = "GAUGELINE_EMAIL";
/** The Resend API key: read from the environment only, sent in the Authorization header only. */
export const RESEND_KEY_ENV = "RESEND_API_KEY";
/** The sender, on a domain verified in Resend. Without it, Resend's onboarding sender is used. */
export const EMAIL_FROM_ENV = "GAUGELINE_EMAIL_FROM";

export type ChannelId = Channel["id"] | "email";

export interface Target {
  channel: ChannelId;
  /** A webhook address, or for email the comma-separated list of recipients. */
  url: string;
}

/** Each channel's address: the flag, else its environment variable. A flag always wins. */
export function resolveTargets(
  flags: Partial<Record<ChannelId, string>>,
  env: Record<string, string | undefined>,
): Target[] {
  const hooks: Target[] = CHANNELS.flatMap((c) => {
    const url = flags[c.id] ?? env[c.env];
    return url && url.trim() !== "" ? [{ channel: c.id, url: url.trim() }] : [];
  });
  const to = flags.email ?? env[EMAIL_ENV];
  return to && to.trim() !== "" ? [...hooks, { channel: "email", url: to.trim() }] : hooks;
}

export interface Sent extends PostResult {
  channel: ChannelId;
}

export interface EmailOptions {
  /** RESEND_API_KEY's value. Missing: the email is not sent and nothing is requested. */
  apiKey?: string;
  from?: string;
  endpoint?: string;
  /** The version printed in the report. */
  version?: string;
}

/** Every send at once, each settled on its own: one broken webhook never stops the others. */
export async function notifyAll(
  result: Result,
  targets: readonly Target[],
  opts: { reportUrl?: string; timeoutMs?: number; email?: EmailOptions } = {},
): Promise<Sent[]> {
  const settled = await Promise.allSettled(
    targets.map((t) => {
      if (t.channel === "email") {
        const to = parseAddresses(t.url);
        if (!to.ok) return Promise.resolve<PostResult>({ ok: false, error: to.error });
        const apiKey = opts.email?.apiKey?.trim();
        if (!apiKey)
          return Promise.resolve<PostResult>({
            ok: false,
            error: `${RESEND_KEY_ENV} is not set: add your Resend API key to the environment to send email`,
          });
        return sendEmail(
          result,
          {
            to: to.to,
            apiKey,
            ...(opts.email?.from ? { from: opts.email.from } : {}),
            ...(opts.email?.endpoint ? { endpoint: opts.email.endpoint } : {}),
            ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          },
          {
            ...(opts.reportUrl ? { reportUrl: opts.reportUrl } : {}),
            ...(opts.email?.version ? { version: opts.email.version } : {}),
          },
        );
      }
      const channel = CHANNELS.find((c) => c.id === t.channel);
      if (!channel) return Promise.resolve<PostResult>({ ok: false, error: "unknown channel" });
      return postJson(t.url, channel.payload(result, opts.reportUrl), {
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.reportUrl && t.channel === "webhook"
          ? { headers: { "x-gaugeline-report": opts.reportUrl } }
          : {}),
      });
    }),
  );
  return settled.map((s, i) => ({
    channel: targets[i]?.channel ?? "webhook",
    ...(s.status === "fulfilled" ? s.value : { ok: false, error: "the send failed" }),
  }));
}
