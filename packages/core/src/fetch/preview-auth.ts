import { Buffer } from "node:buffer";
import { ConfigError } from "../errors.js";
import type { Hop } from "../fetcher.js";

/**
 * A protected preview: a secret read once from the environment and sent only to the --base origin.
 * No flag takes a secret, and the value never leaves the request headers: reports show `describe`.
 */
export const PREVIEW_AUTH_ENV = Object.freeze({
  vercel: "GAUGELINE_VERCEL_BYPASS",
  basic: "GAUGELINE_BASIC_AUTH",
  header: "GAUGELINE_PREVIEW_HEADER",
} as const);

export interface PreviewAuth {
  /** The only origin the headers go to. */
  origin: string;
  headers: Record<string, string>;
  /** What a report may show: "Vercel bypass (set)", never the value. */
  describe: string;
  /** Which variables were set, by name. */
  variables: string[];
  /** Set when the base is http on this machine: the secret is sent in clear text. */
  warning?: string;
  /** The values as sent (and the raw ones), so a test or a redactor can look for them. */
  readonly secrets: readonly string[];
}

/** RFC 9110 token characters: what a header name may contain. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the fetcher or the connection owns. */
const RESERVED = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "user-agent",
]);
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

const value = (env: Record<string, string | undefined>, name: string) => {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v;
};

/** Never the value: a malformed variable is named, and its shape described. */
function malformed(name: string, want: string): ConfigError {
  return new ConfigError(`${name} is not in the form ${want}.`, {
    hint: `Set ${name} to ${want}; its value is not shown here.`,
  });
}

/**
 * The headers for a protected preview at `baseOrigin`, from the three variables; undefined when
 * none is set. Two or three set together are all sent. A malformed one is a ConfigError (exit 2).
 */
export function previewAuth(
  env: Record<string, string | undefined>,
  baseOrigin: string,
): PreviewAuth | undefined {
  const headers: Record<string, string> = {};
  const described: string[] = [];
  const variables: string[] = [];
  const secrets: string[] = [];

  const bypass = value(env, PREVIEW_AUTH_ENV.vercel);
  if (bypass !== undefined) {
    // Vercel's Protection Bypass for Automation: the secret in this header.
    headers["x-vercel-protection-bypass"] = bypass.trim();
    described.push("Vercel bypass (set)");
    variables.push(PREVIEW_AUTH_ENV.vercel);
    secrets.push(bypass.trim());
  }

  const basic = value(env, PREVIEW_AUTH_ENV.basic);
  if (basic !== undefined) {
    // RFC 7617: the user-id has no colon, so the first one splits; the password may hold more.
    const at = basic.indexOf(":");
    if (at <= 0) throw malformed(PREVIEW_AUTH_ENV.basic, '"user:password"');
    const encoded = Buffer.from(basic, "utf8").toString("base64");
    headers.authorization = `Basic ${encoded}`;
    described.push("basic auth (set)");
    variables.push(PREVIEW_AUTH_ENV.basic);
    secrets.push(basic, basic.slice(at + 1), encoded);
  }

  const custom = value(env, PREVIEW_AUTH_ENV.header);
  if (custom !== undefined) {
    const at = custom.indexOf(":");
    const name = at > 0 ? custom.slice(0, at).trim() : "";
    const sent = at > 0 ? custom.slice(at + 1).trim() : "";
    if (!TOKEN.test(name) || sent === "") throw malformed(PREVIEW_AUTH_ENV.header, '"Name: value"');
    const key = name.toLowerCase();
    if (RESERVED.has(key))
      throw new ConfigError(
        `${PREVIEW_AUTH_ENV.header} names ${name}, which Gaugeline sets itself.`,
        {
          hint: "Name the header the preview checks, for example X-Preview-Token.",
        },
      );
    if (key === "authorization" && headers.authorization !== undefined)
      throw new ConfigError(
        `${PREVIEW_AUTH_ENV.basic} and ${PREVIEW_AUTH_ENV.header} both set Authorization: set one.`,
      );
    headers[key] = sent;
    described.push(`header ${name} (set)`);
    variables.push(PREVIEW_AUTH_ENV.header);
    secrets.push(sent);
  }

  if (variables.length === 0) return undefined;
  let origin: URL;
  try {
    origin = new URL(baseOrigin);
  } catch {
    throw new ConfigError(`"${baseOrigin}" is not an address.`);
  }
  const auth: PreviewAuth = {
    origin: origin.origin,
    headers,
    describe: described.join(", "),
    variables,
    secrets: Object.freeze(secrets),
  };
  if (origin.protocol === "http:") {
    if (!LOCAL.has(origin.hostname))
      throw new ConfigError(
        `${variables.join(" and ")} would be sent in clear text to ${origin.origin}.`,
        {
          hint: "Use the preview's https address; plain http is allowed only for 127.0.0.1 and localhost.",
        },
      );
    auth.warning = `${auth.describe} is sent in clear text to ${origin.origin} (allowed on this machine only).`;
  }
  return auth;
}

/** The fetcher's per-origin header provider: the headers on the base origin, nothing elsewhere. */
export function authHeaders(auth: PreviewAuth): (url: URL) => Record<string, string> | undefined {
  return (url) => (url.origin === auth.origin ? auth.headers : undefined);
}

/** Flags people try for a secret, and the variable to use instead. */
export const SECRET_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  password: PREVIEW_AUTH_ENV.basic,
  "basic-auth": PREVIEW_AUTH_ENV.basic,
  auth: PREVIEW_AUTH_ENV.basic,
  user: PREVIEW_AUTH_ENV.basic,
  bypass: PREVIEW_AUTH_ENV.vercel,
  "vercel-bypass": PREVIEW_AUTH_ENV.vercel,
  "protection-bypass": PREVIEW_AUTH_ENV.vercel,
  token: PREVIEW_AUTH_ENV.header,
  header: PREVIEW_AUTH_ENV.header,
  "preview-header": PREVIEW_AUTH_ENV.header,
});

/** What stands in front of a page: a password, or a refusal that isn't one. */
export type Protection =
  | { kind: "password"; status: number; platform?: "vercel" | "netlify"; scheme?: string }
  | { kind: "refused"; status: number };

/**
 * A known protection page, whatever its status: Vercel's login (its SSO link) or Netlify's
 * password form. Plain patterns; a page that only mentions the platform is not one.
 */
export function protectionPage(body: string | undefined): "vercel" | "netlify" | undefined {
  if (!body) return undefined;
  if (
    /vercel\.com\/sso-api/i.test(body) ||
    (/vercel/i.test(body) && /authentication required/i.test(body))
  )
    return "vercel";
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(body) && /netlify/i.test(body))
    return "netlify";
  return undefined;
}

/** 401, 403 and a 200 protection page, read from the last hop; undefined when the page is open. */
export function protectionOf(hop: Hop | undefined): Protection | undefined {
  if (!hop) return undefined;
  const platform = protectionPage(hop.body);
  const scheme = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)/.exec(
    hop.headers["www-authenticate"] ?? "",
  )?.[1];
  if (hop.status === 401 || platform !== undefined) {
    return {
      kind: "password",
      status: hop.status,
      ...(platform ? { platform } : {}),
      ...(scheme ? { scheme } : {}),
    };
  }
  if (hop.status === 403)
    return scheme ? { kind: "password", status: 403, scheme } : { kind: "refused", status: 403 };
  return undefined;
}

/** The one message for a preview that can't be read: what stopped it, and which variable to set. */
export function protectionMessage(
  p: Protection,
  origin: string,
  auth?: Pick<PreviewAuth, "describe">,
): ConfigError {
  if (p.kind === "refused")
    return new ConfigError(
      `Could not check: the preview at ${origin} refused the request (${p.status}). It did not ask for a password; it may block automated readers. Nothing in the plan was checked.`,
      {
        hint: "Allow Gaugeline's user agent on the preview, or check a preview that is open to read.",
      },
    );
  const sent = auth ? ` ${auth.describe} was sent and not accepted; check its value.` : "";
  const what = `Could not check: the preview at ${origin} asked for a password`;
  if (p.platform === "vercel")
    return new ConfigError(`${what} (Vercel deployment protection).${sent}`, {
      hint: `Set ${PREVIEW_AUTH_ENV.vercel} to the project's Protection Bypass for Automation secret.`,
    });
  if (p.platform === "netlify")
    return new ConfigError(
      `${what} (Netlify's password form, which Gaugeline will not post).${sent}`,
      {
        hint: `Protect the preview with Netlify basic auth (a Basic-Auth line in _headers) and set ${PREVIEW_AUTH_ENV.basic} to user:password.`,
      },
    );
  if (p.scheme && p.scheme.toLowerCase() === "basic")
    return new ConfigError(`${what} (${p.status}, Basic).${sent}`, {
      hint: `Set ${PREVIEW_AUTH_ENV.basic} to user:password.`,
    });
  if (p.scheme)
    return new ConfigError(`${what} (${p.status}, ${p.scheme}).${sent}`, {
      hint: `Set ${PREVIEW_AUTH_ENV.header} to the header it expects, for example "Authorization: ${p.scheme} ...".`,
    });
  return new ConfigError(`${what} (${p.status}).${sent}`, {
    hint: `Set ${PREVIEW_AUTH_ENV.vercel}, ${PREVIEW_AUTH_ENV.basic} or ${PREVIEW_AUTH_ENV.header}, whichever the preview uses.`,
  });
}
