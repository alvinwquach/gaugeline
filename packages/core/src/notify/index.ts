import type { Result } from "../result.js";
import { discordPayload, slackPayload, webhookPayload } from "./payloads.js";
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

export interface Target {
  channel: Channel["id"];
  url: string;
}

/** Each channel's address: the flag, else its environment variable. A flag always wins. */
export function resolveTargets(
  flags: Partial<Record<Channel["id"], string>>,
  env: Record<string, string | undefined>,
): Target[] {
  return CHANNELS.flatMap((c) => {
    const url = flags[c.id] ?? env[c.env];
    return url && url.trim() !== "" ? [{ channel: c.id, url: url.trim() }] : [];
  });
}

export interface Sent extends PostResult {
  channel: Channel["id"];
}

/** Every send at once, each settled on its own: one broken webhook never stops the others. */
export async function notifyAll(
  result: Result,
  targets: readonly Target[],
  opts: { reportUrl?: string; timeoutMs?: number } = {},
): Promise<Sent[]> {
  const settled = await Promise.allSettled(
    targets.map((t) => {
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
