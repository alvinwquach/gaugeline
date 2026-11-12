/**
 * The page a morning email's link opens (/email/preferences), as functions from a Request to a Response.
 *
 *   GET  ?t=<token>                         shows the person's current setting; changes nothing
 *   POST t=<token>&frequency=<choice>       sets it (every_change, fix_first, off)
 *   POST ?t=<token>  List-Unsubscribe=One-Click    sets it to off (RFC 8058)
 *
 * The token is the credential and names one person in one organisation (lib/email/token.ts). It does not
 * sign anyone in: no cookie is set, no session read, and the only thing it can touch is that person's
 * `frequency`. A GET never changes anything, because mail scanners and previews open links. The page loads
 * no script, style or image from elsewhere and is not cached, framed, or sent as a referrer (the address
 * has the token in it).
 */
import { escapeHtml, sanitise } from "@gaugeline/core";
import { type Sql, withService } from "../api/db.js";
import { verifyToken } from "./token.js";

export interface PreferenceDeps {
  sql: Sql;
  tokenSecret: string;
  now?: () => Date;
}

const CHOICES = [
  ["every_change", "Every change", "Any night a site has something new or fixed."],
  ["fix_first", "Fix first only", "Only when something new needs fixing first."],
  ["off", "No email", "Stop the morning email."],
] as const;
type Choice = (typeof CHOICES)[number][0];
const isChoice = (v: unknown): v is Choice => CHOICES.some(([c]) => c === v);
const MAX_BODY = 4096;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // Nothing loads from anywhere; the form posts back to this page only.
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function page(status: number, title: string, body: string): Response {
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.5rem 1rem;margin:.25rem 0;display:block;width:100%;text-align:left}</style>
</head><body><h1>${e(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const invalid = () =>
  page(
    400,
    "This link does not work",
    "<p>It may have expired (links last 90 days) or been copied wrongly. Open a recent morning email and use the link at the bottom, or change the setting from the dashboard.</p>",
  );

async function readCapped(req: Request): Promise<string | undefined> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function who(deps: PreferenceDeps, token: string | null) {
  const check = verifyToken(deps.tokenSecret, token ?? "", (deps.now ?? (() => new Date()))());
  return check.ok ? check : undefined;
}

export async function getPreferences(req: Request, deps: PreferenceDeps): Promise<Response> {
  const token = new URL(req.url).searchParams.get("t");
  const person = who(deps, token);
  if (!person || !token) return invalid();
  const rows = await withService(
    deps.sql,
    (tx) => tx`select o.name, p.frequency, m.role
      from public.email_preferences p
      join public.members m on m.org_id = p.org_id and m.user_id = p.user_id
      join public.organisations o on o.org_id = p.org_id
      where p.org_id = ${person.orgId} and p.user_id = ${person.userId}`,
  );
  const row = rows[0];
  if (!row) return notFound();
  const current: Choice =
    (row.frequency as Choice | null) ?? (row.role === "member" ? "off" : "every_change");
  const e = escapeHtml;
  const org = e(sanitise(String(row.name), 80).text);
  const buttons = CHOICES.map(
    ([value, label, help]) =>
      `<button type="submit" name="frequency" value="${value}">${e(label)}${value === current ? " (now)" : ""}<br><small>${e(help)}</small></button>`,
  ).join("");
  return page(
    200,
    "Your morning email",
    `<p>How often should Gaugeline email you about ${org}'s sites? It only writes on mornings when something changed.</p>
<form method="post" action="/email/preferences"><input type="hidden" name="t" value="${e(token)}">${buttons}</form>`,
  );
}

const notFound = () =>
  page(404, "Not found", "<p>There is no email setting for this link any more.</p>");

export async function postPreferences(req: Request, deps: PreferenceDeps): Promise<Response> {
  const text = await readCapped(req);
  if (text === undefined) return invalid();
  const body = new URLSearchParams(text);
  const token = body.get("t") ?? new URL(req.url).searchParams.get("t");
  const person = who(deps, token);
  // One-click unsubscribe from a mail program sends this exact field and nothing else.
  const choice = body.get("List-Unsubscribe") === "One-Click" ? "off" : body.get("frequency");
  if (!person || !isChoice(choice)) return invalid();
  const changed = await withService(
    deps.sql,
    (tx) => tx`update public.email_preferences set frequency = ${choice}
      where org_id = ${person.orgId} and user_id = ${person.userId} returning 1`,
  );
  if (changed.length === 0) return notFound();
  const label = CHOICES.find(([c]) => c === choice)![1];
  return page(
    200,
    "Saved",
    `<p>Your morning email is now: <strong>${escapeHtml(label)}</strong>.</p>`,
  );
}
