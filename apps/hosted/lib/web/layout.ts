/** The page shell: header with the organisation switch and sign-out, the main area, and the answers every route gives. */
import { markup, type SafeHtml } from "./html.js";
import { ROLE_LABEL, type Membership } from "./memberships.js";

export interface Shell {
  email: string;
  memberships: Membership[];
  current: Membership;
  /** Which page the header marks as current. */
  active?: "sites" | "last-night" | "agents" | "clients";
}

/** No script anywhere, no framing, styles only from this app's own stylesheet, forms only to this app. */
const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "cache-control": "no-store",
    ...extra,
  };
}

export function respondHtml(
  status: number,
  title: string,
  content: SafeHtml,
  shell?: Shell,
  cookies: string[] = [],
): Response {
  const body = markup`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} - Gaugeline</title>
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body>
        <a class="skip" href="#main">Skip to the content</a>
        ${shell ? header(shell) : markup`<header class="bar"><span class="brand">Gaugeline</span></header>`}
        <main id="main">${content}</main>
      </body>
    </html>`;
  const headers = new Headers(securityHeaders({ "content-type": "text/html; charset=utf-8" }));
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(body.toString(), { status, headers });
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers(securityHeaders({ location }));
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/** Browsers that have seen an https answer keep to https for a year. Added on https responses only. */
export function withHsts(response: Response, request: Request, secure: boolean): Response {
  if (secure || new URL(request.url).protocol === "https:")
    response.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return response;
}

export function respondText(status: number, body: string, type: string): Response {
  return new Response(body, { status, headers: securityHeaders({ "content-type": type }) });
}

function header(shell: Shell): SafeHtml {
  const { current, memberships } = shell;
  return markup`<header class="bar">
    <a class="brand" href="/">Gaugeline</a>
    <nav aria-label="Main">
      <a href="/"${shell.active === "last-night" || shell.active === "agents" || shell.active === "clients" ? "" : markup` aria-current="page"`}>Sites</a>
      <a href="/last-night"${shell.active === "last-night" ? markup` aria-current="page"` : ""}>Last night</a>
      ${
        current.role !== "client"
          ? markup`<a href="/clients"${shell.active === "clients" ? markup` aria-current="page"` : ""}>Clients</a>`
          : ""
      }
      ${
        current.role === "owner" || current.role === "admin"
          ? markup`<a href="/agents"${shell.active === "agents" ? markup` aria-current="page"` : ""}>Agents</a>`
          : ""
      }
    </nav>
    <div class="who">
      ${
        memberships.length > 1
          ? markup`<form method="post" action="/org" class="switch">
              <label for="org">Organisation</label>
              <select id="org" name="org">
                ${memberships.map(
                  (m) =>
                    markup`<option
                      value="${m.orgId}"
                      ${m.orgId === current.orgId ? markup` selected` : ""}
                    >
                      ${m.orgName}
                    </option>`,
                )}
              </select>
              <button type="submit">Switch</button>
            </form>`
          : markup`<span class="org">${current.orgName}</span>`
      }
      <span class="muted">${shell.email} (${ROLE_LABEL[current.role]})</span>
      <form method="post" action="/sign-out"><button type="submit">Sign out</button></form>
    </div>
  </header>`;
}

export const STYLES = `/* Classes only: the Content-Security-Policy allows no inline style. Same tokens as the local app. */
:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
  --bg: #ffffff; --panel: #f6f7f9; --text: #101828; --muted: #475467; --line: #d0d5dd;
  --accent: #1d4ed8; --high: #b42318; --medium: #93370d; --low: #475467; --focus: #1d4ed8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1419; --panel: #182029; --text: #f2f4f7; --muted: #b6bfcb; --line: #3b4654;
    --accent: #84adff; --high: #ffa198; --medium: #fdb022; --low: #b6bfcb; --focus: #84adff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.5; }
main { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.125rem; margin: 2rem 0 0.5rem; }
p { margin: 0.25rem 0 0.75rem; }
a { color: var(--accent); }
.muted { color: var(--muted); }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 0.5rem; top: 0.5rem; background: var(--bg); padding: 0.25rem 0.5rem; }
.bar { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; align-items: center; padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); background: var(--panel); }
.brand { font-weight: 700; text-decoration: none; color: var(--text); }
.bar nav { display: flex; gap: 1rem; }
.who { margin-left: auto; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; }
.who form, .switch { display: flex; gap: 0.5rem; align-items: center; margin: 0; }
button, select, input { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 0.375rem; padding: 0.375rem 0.75rem; }
button { cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.stack { display: grid; gap: 0.75rem; max-width: 26rem; }
.stack label { font-weight: 600; }
.notice { border: 1px solid var(--line); background: var(--panel); border-radius: 0.5rem; padding: 0.75rem 1rem; }
.update { white-space: pre-wrap; font: inherit; border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.75rem 1rem; max-width: 70ch; }
.sites { width: 100%; border-collapse: collapse; }
.sites caption { text-align: left; font-weight: 600; padding-bottom: 0.5rem; }
.sites th, .sites td { text-align: left; vertical-align: top; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--line); }
.sites thead th { font-size: 0.875rem; color: var(--muted); }
.sites .num { text-align: right; font-variant-numeric: tabular-nums; }
.sites tbody th { font-weight: 600; }
.trend { font-weight: 600; }
.blank, .silent { color: var(--muted); }
.trend-worse { color: var(--high); }
.trend-better { color: var(--accent); }
.trend-still, .trend-first, .trend-unchecked { color: var(--muted); }
`;
