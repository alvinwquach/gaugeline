/**
 * Turn what someone typed or pasted into the address Gaugeline checks.
 *
 * Accepts a bare domain ("example.com") or a full http(s) URL. Leading and
 * trailing whitespace, including a pasted newline, is removed. A bare domain
 * is read as https.
 */
export type AddressResult = { ok: true; url: URL } | { ok: false; reason: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function parseAddress(input: string): AddressResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "The address is empty." };
  const withScheme = SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: `"${trimmed}" is not a web address.` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      reason: `Only http and https addresses can be checked, not ${url.protocol}`,
    };
  }
  if (url.hostname === "" || /\s/.test(trimmed)) {
    return { ok: false, reason: `"${trimmed}" is not a web address.` };
  }
  return { ok: true, url };
}
