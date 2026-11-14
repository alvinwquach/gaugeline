import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
  connectorGet,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { escapeInvisible } from "../checks/hidden-text/escape.js";

/** One provider's reads: its name for messages, the variables that hold its key, and the key as a header value. */
export interface ProviderAccess {
  provider: string;
  env: Env;
  /** The variables to blank from every message. */
  secretVars: readonly string[];
  fetcher: Fetcher;
  /** "Bearer <key>": sent to the first address's origin only, never in an address. */
  authorization: string;
}

export type JsonRead = { ok: true; body: unknown } | { ok: false; reason: string };
export type TextRead = { ok: true; body: string } | { ok: false; reason: string };

/** Text from a provider, made safe to print in a report: invisible characters written out, cut at `max`. */
export const clip = (text: string, max = 120): string => escapeInvisible(text, max);

/**
 * One GET through the fetcher, as text, or the plain reason it could not be had. A refusal (401, 403)
 * says the token may not read this, a 429 says when to try again, any other status names itself, and
 * nothing from an answer's body is ever put in a message. Every message is redacted.
 */
export async function getProviderText(
  access: ProviderAccess,
  url: string,
  what: string,
): Promise<TextRead> {
  const redact = createRedactor(access.env, access.secretVars);
  const fail = (reason: string): TextRead => ({ ok: false, reason: redact(reason) });
  try {
    const hop = await connectorGet(access.fetcher, url, { authorization: access.authorization });
    if (hop.truncated)
      return fail(`${access.provider}'s answer about ${what} is larger than Gaugeline reads`);
    return { ok: true, body: hop.body ?? "" };
  } catch (err) {
    if (err instanceof ConnectorRefusedError)
      return fail(
        `${access.provider} refused the token (HTTP ${err.status}) when asked for ${what}. A token that cannot read ${what} gives Gaugeline nothing to report, so check it yourself or use a token that can`,
      );
    if (err instanceof ConnectorRateLimitedError)
      return fail(
        `${access.provider} asked Gaugeline to slow down (HTTP 429) when asked for ${what}. ${err.retry ? `Try again ${err.retry}.` : "It did not say when to try again."}`,
      );
    if (err instanceof ConnectorStatusError)
      return fail(`${access.provider} answered HTTP ${err.status} when asked for ${what}`);
    return fail(
      `${access.provider} could not be read (${what}): ${err instanceof Error ? err.message : "the read failed"}`,
    );
  }
}

/** The same read, parsed as JSON. */
export async function getProviderJson(
  access: ProviderAccess,
  url: string,
  what: string,
): Promise<JsonRead> {
  const text = await getProviderText(access, url, what);
  if (!text.ok) return text;
  try {
    return { ok: true, body: JSON.parse(text.body) as unknown };
  } catch {
    const redact = createRedactor(access.env, access.secretVars);
    return {
      ok: false,
      reason: redact(
        `${access.provider} answered with something that is not JSON when asked for ${what}`,
      ),
    };
  }
}
