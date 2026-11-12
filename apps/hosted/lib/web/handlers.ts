/**
 * The pages and actions of part 1: sign in by email link, sign out, switch organisation, and the home page.
 * Each takes a Request and the app's dependencies and returns a Response, so the same code runs behind a
 * Next.js Route Handler and behind the test server. Nothing here runs a check or writes to a checked site.
 */
import { SESSION_TTL_S, type Claims } from "./auth.js";
import { asUser, type Tx } from "./db.js";
import type { WebDeps } from "./deps.js";
import { markup } from "./html.js";
import { redirect, respondHtml, respondText, STYLES, type Shell } from "./layout.js";
import { listMemberships, listSites, pickOrg, ROLE_LABEL, type Membership } from "./memberships.js";
import {
  clearCookie,
  nextCookie,
  nextCookieName,
  orgCookie,
  orgCookieName,
  readCookie,
  sameOrigin,
  sessionCookie,
  sessionCookieName,
} from "./session.js";

/** Only a path on this app: starts with one slash, and the next character is not a slash or backslash. */
export function safeNext(value: string | null | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/";
}

async function form(request: Request): Promise<URLSearchParams> {
  try {
    return new URLSearchParams(await request.text());
  } catch {
    return new URLSearchParams();
  }
}

const refused = (): Response =>
  respondHtml(
    403,
    "Not allowed",
    markup`<h1>Not allowed</h1>
      <p>That request did not come from this site.</p>`,
  );

export const stylesheet = (): Response => respondText(200, STYLES, "text/css; charset=utf-8");

// ---- sign in -------------------------------------------------------------------------------------------

function signInForm(next: string, error = ""): Response {
  return respondHtml(
    error ? 400 : 200,
    "Sign in",
    markup`<h1>Sign in</h1>
      ${error ? markup`<p class="notice" role="alert">${error}</p>` : ""}
      <p>Enter your email address and we will send you a link. There is no password.</p>
      <form method="post" action="/sign-in" class="stack">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
        <input type="hidden" name="next" value="${next}" />
        <button type="submit" class="primary">Send me a link</button>
      </form>`,
  );
}

export const signInPage = (request: Request): Response =>
  signInForm(safeNext(new URL(request.url).searchParams.get("next")));

export async function postSignIn(request: Request, deps: WebDeps): Promise<Response> {
  if (!sameOrigin(request)) return refused();
  const body = await form(request);
  const email = (body.get("email") ?? "").trim();
  if (email !== "" && email.length <= 254) await deps.auth.requestLink(email);
  const next = safeNext(body.get("next"));
  // The same answer for an address with an account and one without.
  return respondHtml(
    200,
    "Check your email",
    markup`<h1>Check your email</h1>
      <p>
        If that address has an account, a sign-in link is on its way. It works once and expires in
        15 minutes.
      </p>
      <p><a href="/sign-in">Use a different address</a></p>`,
    undefined,
    next === "/" ? [] : [nextCookie(next, deps.secureCookies)],
  );
}

/** A mail scanner may open the link, so opening it only shows a button; the button's POST signs in. */
export function verifyPage(request: Request): Response {
  const params = new URL(request.url).searchParams;
  return respondHtml(
    200,
    "Finish signing in",
    markup`<h1>Finish signing in</h1>
      <form method="post" action="/sign-in/verify" class="stack">
        <input type="hidden" name="token" value="${params.get("token") ?? ""}" />
        <button type="submit" class="primary">Sign in</button>
      </form>`,
  );
}

export async function postVerify(request: Request, deps: WebDeps): Promise<Response> {
  if (!sameOrigin(request)) return refused();
  const body = await form(request);
  const result = await deps.auth.exchangeLink(body.get("token") ?? "");
  if (!result.ok) {
    return respondHtml(
      400,
      "Link not valid",
      markup`<h1>That link is ${result.reason === "expired" ? "expired" : "no longer valid"}</h1>
        <p>
          ${result.reason === "expired" ? "Sign-in links expire after 15 minutes." : "A sign-in link works once."}
          <a href="/sign-in">Get a new link</a>.
        </p>`,
    );
  }
  const next = safeNext(
    readCookie(request.headers.get("cookie"), nextCookieName(deps.secureCookies)),
  );
  return redirect(next, [
    sessionCookie(
      result.accessToken,
      Math.min(result.expiresIn, SESSION_TTL_S),
      deps.secureCookies,
    ),
    clearCookie(nextCookieName(deps.secureCookies), deps.secureCookies),
  ]);
}

export async function postSignOut(request: Request, deps: WebDeps): Promise<Response> {
  if (!sameOrigin(request)) return refused();
  return redirect("/sign-in", [
    clearCookie(sessionCookieName(deps.secureCookies), deps.secureCookies),
    clearCookie(orgCookieName(deps.secureCookies), deps.secureCookies),
  ]);
}

// ---- signed-in pages -----------------------------------------------------------------------------------

export interface Signed {
  claims: Claims;
  tx: Tx;
  shell: Shell | null;
  memberships: Membership[];
}

/**
 * Runs `fn` as the signed-in person, or sends the visitor to sign in. `shell` is null when the person is in
 * no organisation. The cookie's organisation is only a preference: it is honoured when the database says the
 * person is a member, and ignored otherwise.
 */
export async function signedIn(
  request: Request,
  deps: WebDeps,
  fn: (s: Signed) => Promise<Response>,
): Promise<Response> {
  const token = readCookie(request.headers.get("cookie"), sessionCookieName(deps.secureCookies));
  const claims = token ? deps.auth.verify(token) : null;
  if (!claims) {
    const url = new URL(request.url);
    const next =
      request.method === "GET" && url.pathname !== "/"
        ? `?next=${encodeURIComponent(url.pathname + url.search)}`
        : "";
    return redirect(`/sign-in${next}`);
  }
  return asUser(deps.sql, claims, async (tx) => {
    const memberships = await listMemberships(tx, claims.sub);
    const chosen = readCookie(request.headers.get("cookie"), orgCookieName(deps.secureCookies));
    const current = pickOrg(memberships, chosen);
    const shell = current ? { email: claims.email ?? "", memberships, current } : null;
    return fn({ claims, tx, shell, memberships });
  });
}

export function home(request: Request, deps: WebDeps): Promise<Response> {
  return signedIn(request, deps, async ({ tx, shell }) => {
    if (!shell)
      return respondHtml(
        200,
        "No organisation",
        markup`<h1>Welcome</h1>
          <p class="notice">
            You are not a member of any organisation yet. Ask the person who invited you to add you.
          </p>
          <form method="post" action="/sign-out"><button type="submit">Sign out</button></form>`,
      );
    const { current } = shell;
    const sites = await listSites(tx, current);
    return respondHtml(
      200,
      "Sites",
      markup`<h1>${current.orgName}</h1>
        <p class="muted">You are signed in as ${ROLE_LABEL[current.role]}.</p>
        <h2>Sites</h2>
        ${
          sites.length === 0
            ? markup`<p class="notice">No sites yet.</p>`
            : markup`<ul>
                ${sites.map((s) => markup`<li>${s.name}</li>`)}
              </ul>`
        }`,
      shell,
    );
  });
}

export async function postOrg(request: Request, deps: WebDeps): Promise<Response> {
  if (!sameOrigin(request)) return refused();
  const wanted = (await form(request)).get("org") ?? "";
  return signedIn(request, deps, async ({ memberships }) =>
    redirect(
      "/",
      memberships.some((m) => m.orgId === wanted) ? [orgCookie(wanted, deps.secureCookies)] : [],
    ),
  );
}
