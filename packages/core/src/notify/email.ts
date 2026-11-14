// check-community: allow-email (Resend's documented onboarding sender, and the shape of an address in a comment)
import { createPageRegistry } from "../checks/index.js";
import { BUDGET_KINDS, type BudgetSummary } from "../limits.js";
import { SEVERITIES, SEVERITY_LABEL, SEVERITY_ORDER, type CheckRegistry } from "../model.js";
import { renderReport } from "../report/html.js";
import type { Result } from "../result.js";
import type { RunResult } from "../run.js";
import { postJson, type PostResult } from "./post.js";

/**
 * The email channel: the full report as the body, sent with one POST to Resend's API. The key
 * goes in the Authorization header only and is scrubbed from anything that could be printed.
 */
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
/** Resend's shared test sender, used when GAUGELINE_EMAIL_FROM is not set. */
export const ONBOARDING_FROM = "Gaugeline <onboarding@resend.dev>";
/** Resend's limit on one email, attachments included (40 MB). */
export const EMAIL_MAX_BYTES = 40 * 1024 * 1024;
/** Findings kept when a report would pass the limit: the most urgent. Proposed. */
export const EMAIL_CUT_FINDINGS = 50;

/** name@domain.tld, with nothing that could split or extend a header. Deliberately plain. */
const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/;

/** One address or a comma-separated list. Empty entries (a trailing comma) are dropped. */
export function parseAddresses(
  list: string,
): { ok: true; to: string[] } | { ok: false; error: string } {
  const to = list
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");
  if (to.length === 0) return { ok: false, error: "no email address was given" };
  const bad = to.find((a) => !ADDRESS.test(a));
  if (bad !== undefined) return { ok: false, error: `"${bad}" is not an email address` };
  return { ok: true, to };
}

/** Control characters and line breaks out: a subject is one header line. */
function oneLine(s: string): string {
  return [...s]
    .map((c) => {
      const code = c.charCodeAt(0);
      return code < 32 || code === 127 ? " " : c;
    })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return oneLine(url);
  }
}

/** "shop.example: 2 to fix first, 3 to look at", "shop.example: 3 to look at", or nothing to report. */
export function emailSubject(result: Pick<Result, "url" | "findings">): string {
  const host = oneLine(hostOf(result.url));
  const total = result.findings.length;
  if (total === 0) return `${host}: nothing to report`;
  const high = result.findings.filter((f) => f.severity === "high").length;
  return high > 0
    ? `${host}: ${high} to fix first, ${total} to look at`
    : `${host}: ${total} to look at`;
}

/** The --json result back into the shape the report renders. */
function asRun(result: Result, findings: Result["findings"]): RunResult {
  return {
    findings,
    passed: result.passed,
    failed: result.failed.map((id) => ({ id, error: "" })),
    warnings: [],
    couldNotCheck: result.couldNotCheck,
    sampled: result.sampled,
  };
}

function asSummary(sampled: Result["sampled"]): BudgetSummary {
  const out = {} as BudgetSummary;
  for (const kind of BUDGET_KINDS) {
    const s = sampled[kind];
    out[kind] = { limit: s?.limit ?? 0, sampled: s?.taken ?? 0, found: s?.seen ?? 0 };
  }
  return out;
}

function plainText(
  result: Result,
  findings: Result["findings"],
  note: string | undefined,
  reportUrl: string | undefined,
): string {
  const lines = [`Gaugeline checked ${result.url}`, ""];
  if (note) lines.push(note, "");
  if (result.findings.length === 0) lines.push("Nothing to fix. Every check that ran passed.", "");
  for (const s of SEVERITIES) {
    const list = findings.filter((f) => f.severity === s);
    if (list.length === 0) continue;
    lines.push(`${SEVERITY_LABEL[s]} (${list.length})`);
    for (const f of list)
      lines.push(`- ${f.title}`, `  ${f.evidence}`, `  ${f.checkId} · ${f.url}`);
    lines.push("");
  }
  if (result.couldNotCheck.length > 0) {
    lines.push("Could not check");
    for (const c of result.couldNotCheck) lines.push(`- ${c.id}: ${c.reason} (${c.url})`);
    lines.push("");
  }
  if (reportUrl) lines.push(`Full report: ${reportUrl}`, "");
  return lines.join("\n");
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * The subject, the full report as a mail-safe HTML body (inline styles, no style element, no
 * scripts, no remote images) and a plain-text version. Over the size limit, the findings are cut
 * to the most urgent 50 and both versions say so.
 */
export function buildEmail(
  result: Result,
  opts: {
    reportUrl?: string;
    registry?: CheckRegistry;
    maxBytes?: number;
    version?: string;
    startedAt?: Date;
  } = {},
): BuiltEmail {
  const registry = opts.registry ?? createPageRegistry();
  const maxBytes = opts.maxBytes ?? EMAIL_MAX_BYTES;
  const startedAt = opts.startedAt ?? new Date(result.startedAt);
  const version = opts.version ?? "";
  const render = (findings: Result["findings"], note?: string): BuiltEmail => {
    const link = opts.reportUrl ? `Full report: ${opts.reportUrl}` : undefined;
    const notes = [note, link].filter((n): n is string => n !== undefined).join(" · ");
    return {
      subject: emailSubject(result),
      html: renderReport({
        result: asRun(result, findings),
        url: result.url,
        startedAt,
        registry,
        sampled: asSummary(result.sampled),
        version,
        mail: true,
        ...(notes ? { note: notes } : {}),
      }),
      text: plainText(result, findings, note, opts.reportUrl),
    };
  };
  const full = render(result.findings);
  const size = Buffer.byteLength(full.html) + Buffer.byteLength(full.text);
  if (size <= maxBytes || result.findings.length <= EMAIL_CUT_FINDINGS) return full;
  const urgent = [...result.findings]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, EMAIL_CUT_FINDINGS);
  return render(
    urgent,
    `This email shows the ${EMAIL_CUT_FINDINGS} most urgent of ${result.findings.length} findings: the whole report was too large to send. The report file and --json have them all.`,
  );
}

export interface EmailSettings {
  to: readonly string[];
  apiKey: string;
  /** "Name <address>" or an address on a domain verified in Resend. */
  from?: string;
  /** Tests point this at a local server; the default is Resend's API. */
  endpoint?: string;
  timeoutMs?: number;
  /** Hosted sends: refuse a name that resolves to a loopback, private, link-local or metadata address. */
  publicOnly?: boolean;
  /** Sent as the `Idempotency-Key` header: a retry of the same key is not sent twice (Resend's SDK names it so). */
  idempotencyKey?: string;
}

/** The key, wherever a message might carry it, replaced. */
function scrub(text: string | undefined, key: string): string | undefined {
  return text === undefined || key === "" ? text : text.split(key).join("[redacted]");
}

/** One POST to Resend with a prepared message. The result's error never contains the key. */
export async function postEmail(settings: EmailSettings, mail: BuiltEmail): Promise<PostResult> {
  const sent = await postJson(
    settings.endpoint ?? RESEND_EMAILS_URL,
    {
      from: settings.from ?? ONBOARDING_FROM,
      to: [...settings.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    },
    {
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        ...(settings.idempotencyKey ? { "idempotency-key": settings.idempotencyKey } : {}),
      },
      readError: true,
      ...(settings.publicOnly ? { publicOnly: true } : {}),
      ...(settings.timeoutMs ? { timeoutMs: settings.timeoutMs } : {}),
    },
  );
  const error = scrub(sent.error, settings.apiKey);
  return {
    ok: sent.ok,
    ...(sent.status ? { status: sent.status } : {}),
    ...(error ? { error } : {}),
  };
}

/** The run's report, built and sent with one POST to Resend. */
export function sendEmail(
  result: Result,
  settings: EmailSettings,
  opts: { reportUrl?: string; registry?: CheckRegistry; maxBytes?: number; version?: string } = {},
): Promise<PostResult> {
  return postEmail(settings, buildEmail(result, opts));
}
