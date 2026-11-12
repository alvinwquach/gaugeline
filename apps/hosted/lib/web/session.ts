/** The session cookie and the same-origin rule for anything that changes state. */

const SESSION = "gl_session";
const ORG = "gl_org";

/** `__Host-` on https: the browser then refuses the cookie unless it is Secure, Path=/ and has no Domain. */
export const sessionCookieName = (secure: boolean): string =>
  secure ? `__Host-${SESSION}` : SESSION;
export const orgCookieName = (secure: boolean): string => (secure ? `__Host-${ORG}` : ORG);

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export const sessionCookie = (token: string, maxAge: number, secure: boolean): string =>
  cookie(sessionCookieName(secure), token, maxAge, secure);
export const orgCookie = (orgId: string, secure: boolean): string =>
  cookie(orgCookieName(secure), orgId, 90 * 86400, secure);
/** Where to go after the link is confirmed: kept in this browser, so the link itself carries nothing but its token. */
export const nextCookieName = (secure: boolean): string => (secure ? `__Host-gl_next` : "gl_next");
export const nextCookie = (path: string, secure: boolean): string =>
  cookie(nextCookieName(secure), encodeURIComponent(path), 900, secure);
export const clearCookie = (name: string, secure: boolean): string => cookie(name, "", 0, secure);

/** One cookie's value from a Cookie header, or undefined (also for a value that is not valid encoding). */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * A request that changes state must come from this app's own pages: its Origin (or, failing that, its
 * Referer) names this origin. SameSite=Lax already keeps the cookie off cross-site POSTs; this is the
 * second wall. A request with neither header is refused: a browser form always sends one.
 */
export function sameOrigin(request: Request): boolean {
  const own = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === own;
  const referer = request.headers.get("referer");
  if (referer === null) return false;
  try {
    return new URL(referer).origin === own;
  } catch {
    return false;
  }
}
