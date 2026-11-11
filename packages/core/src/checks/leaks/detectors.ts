/**
 * Detectors for private keys in shipped JavaScript. Each is one entry with its own tests: a
 * pattern, and an optional verify step that turns down look-alikes. A match is redacted here,
 * before any Finding is built, so no output path can ever carry the raw value.
 */
export interface Detector {
  id: string;
  /** How the key is named in evidence. */
  label: string;
  /** Global. The secret is capture group "secret". */
  pattern: RegExp;
  verify?(secret: string, match: RegExpExecArray): boolean;
  /**
   * True when a finding for this kind shows no character of the value at all, not the usual first 6 and
   * last 2: only the kind and the place.
   */
  hideValue?: boolean;
}

/** Shannon entropy in bits per character. Random base64 is about 5-6; hex at most 4; words about 3. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Below this, a value is a word, a hex digest or an identifier, not a random key. Hex content
 * hashes (md5, sha1, sha256) top out at 4 bits per character, so they stay under it.
 */
export const ENTROPY_MIN = 4.2;

/** Base64 magic numbers of image files: an inlined icon is not a key. */
const IMAGE_BASE64 = /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|PHN2Zy|Qk[0-9A-Z])/;
/** A value that names a file ("app.3f2a9c.js") is a build hash, not a key. */
const FILE_NAME = /\.(?:js|mjs|cjs|css|map|json|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|html?)$/i;

/** The Contentful Preview API's host, and how far from a token it must be to count as the token's host. */
const PREVIEW_HOST = /preview\.contentful\.com/i;
const PREVIEW_WINDOW = 300;

/** A Contentful token (delivery or preview) is 43 characters of base64url. */
const CONTENTFUL_TOKEN_LENGTH = 43;
/** Words that tie a value to Contentful's client: the SDK's name, its host, or its constructor. */
const CONTENTFUL_CONTEXT = /contentful|createClient/i;

/**
 * The part of the text a value belongs to: the object literal it sits in (after the last "{" before it,
 * up to the first "}" after it), or, with `wide`, the 300 characters on each side.
 */
function scopeOf(m: RegExpExecArray, wide: boolean): string {
  const start = m.index;
  const end = start + m[0].length;
  const before = m.input.slice(Math.max(0, start - PREVIEW_WINDOW), start);
  const after = m.input.slice(end, end + PREVIEW_WINDOW);
  return wide
    ? `${before} ${after}`
    : `${before.slice(before.lastIndexOf("{") + 1)} ${after.split("}")[0] ?? ""}`;
}

/**
 * A Contentful delivery token: 43 characters in a place that names Contentful or createClient, and not
 * the Preview API (the preview host in the same object or address, or "preview" in its name). Delivery
 * tokens read published content and are meant to be in the page's JavaScript, so they are not leaks.
 */
function isContentfulDeliveryToken(secret: string, m: RegExpExecArray): boolean {
  if (secret.length !== CONTENTFUL_TOKEN_LENGTH) return false;
  if (!CONTENTFUL_CONTEXT.test(scopeOf(m, true))) return false;
  const name = m.groups?.name ?? "";
  return !(/preview/i.test(name) || PREVIEW_HOST.test(scopeOf(m, false)));
}

/**
 * The text of the object literal a value sits in and no nested one: after the last "{" before it, up to the
 * next "{" or "}" after it. A nested `live_preview:{...}` after a delivery token is another object.
 */
function ownObject(m: RegExpExecArray): string {
  const start = m.index;
  const before = m.input.slice(Math.max(0, start - PREVIEW_WINDOW), start);
  const after = m.input.slice(start + m[0].length, start + m[0].length + PREVIEW_WINDOW);
  return `${before.slice(before.lastIndexOf("{") + 1)} ${after.split(/[{}]/)[0] ?? ""}`;
}

/** The Contentstack Live Preview host (rest-preview.contentstack.com and its regional spellings). */
const CONTENTSTACK_PREVIEW_HOST = /preview\.contentstack\.(?:com|io)/i;

export const DETECTORS: readonly Detector[] = Object.freeze([
  {
    id: "stripe-secret",
    label: "Stripe secret key",
    // Secret (sk_) and restricted (rk_) live keys. Publishable keys (pk_) are meant to be public.
    pattern: /(?<![A-Za-z0-9_])(?<secret>(?:sk|rk)_live_[A-Za-z0-9]{20,})(?![A-Za-z0-9])/g,
  },
  {
    id: "sanity-token",
    label: "Sanity API token",
    // "sk" and a long token, with no underscore: unlike Stripe's sk_live_.
    pattern: /(?<![A-Za-z0-9_])(?<secret>sk[A-Za-z0-9]{60,})(?![A-Za-z0-9])/g,
    // Real tokens mix upper case, lower case and digits; a run of one letter does not.
    verify: (s) => /[A-Z]/.test(s) && /[a-z]/.test(s.slice(2)) && /\d/.test(s),
  },
  {
    id: "contentful-preview-token",
    label: "Contentful preview token",
    // A finding says the kind and the place only: no prefix, no suffix, no hash.
    hideValue: true,
    // Contentful tokens are 43 characters of base64url with no prefix, so the shape alone proves nothing
    // (a delivery token is public by design). A match is a 43-character value assigned to a name that
    // contains "token" or "key", either as name = "value" / name: "value", or as ?access_token=value.
    // verify() then insists on the Preview API: the name says "preview" in a file that names Contentful,
    // or the preview host is within a few hundred characters (the contentful SDK itself contains that
    // host, which is why mere presence in a file is not enough).
    pattern:
      /(?:(?<![A-Za-z0-9_$])(?<name>[A-Za-z0-9_$]{0,40}(?:token|key)[A-Za-z0-9_$]{0,40})["']?\s*[:=]\s*["'`]|[?&]access_token=)(?<secret>[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/gi,
    verify: (s, m) => {
      if (entropy(s) < ENTROPY_MIN) return false;
      const start = m.index;
      const name = m.groups?.name ?? "";
      if (name === "") {
        // ?access_token=...: the preview host just before it, in the same address.
        if (PREVIEW_HOST.test(m.input.slice(Math.max(0, start - PREVIEW_WINDOW), start)))
          return true;
      } else {
        // name: "value": the preview host in the same object literal (after the last "{" before the
        // token, up to the first "}" after it), so a delivery token next to a preview client is not one.
        if (PREVIEW_HOST.test(scopeOf(m, false))) return true;
      }
      return /preview/i.test(name) && /contentful/i.test(m.input);
    },
  },
  {
    id: "contentstack-preview-token",
    label: "Contentstack preview token",
    // A finding says the kind and the place only: no prefix, no suffix, no hash.
    hideValue: true,
    // A Contentstack token is "cs" and hex (uncited: the shape is from memory, so the name or the host must
    // agree too). A delivery token is public by design and is never a match: a match needs the name to say
    // "preview" in a file that names Contentstack, or the Live Preview host in the same object literal.
    pattern:
      /(?<![A-Za-z0-9_$])(?<name>[A-Za-z0-9_$]{0,40}(?:token|key)[A-Za-z0-9_$]{0,40})["']?\s*[:=]\s*["'`](?<secret>cs[0-9a-f]{20,60})(?![A-Za-z0-9_-])/gi,
    verify: (_s, m) =>
      CONTENTSTACK_PREVIEW_HOST.test(ownObject(m)) ||
      (/preview/i.test(m.groups?.name ?? "") && /contentstack/i.test(m.input)),
  },
  {
    id: "secret-assignment",
    label: "Secret value",
    // name = "value" or name: "value", where the name contains SECRET, TOKEN or KEY. The name is capped
    // at 40 characters each side of that word: an open-ended name made a hostile file scan in quadratic time.
    pattern:
      /(?<![A-Za-z0-9_$])(?<name>[A-Za-z0-9_$]{0,40}(?:secret|token|key)[A-Za-z0-9_$]{0,40})["']?\s*[:=]\s*(?<q>["'`])(?<secret>[A-Za-z0-9+/_=.-]{20,200})\k<q>/gi,
    verify: (s, m) => {
      const name = m.groups?.name ?? "";
      if (/public|publishable/i.test(name)) return false;
      if (/^pk_(?:live|test)_/.test(s)) return false;
      if (FILE_NAME.test(s) || IMAGE_BASE64.test(s)) return false;
      // A Contentful delivery token is public by design; the preview token is the contentful detector's.
      if (isContentfulDeliveryToken(s, m)) return false;
      return entropy(s) >= ENTROPY_MIN;
    },
  },
] satisfies Detector[]);

/** Characters of a secret kept at each end: never more than 8 of the original reach any output. */
const KEEP = { start: 6, end: 2 } as const;

/** Below this length, the first 6 and last 2 would be most of the value. */
const SHORT_SECRET = 12;

/** "sk_liv…Z9": the first 6 and last 2 characters. A short value keeps 2 at the start only. */
export function redact(secret: string): string {
  if (secret.length < SHORT_SECRET) return `${secret.slice(0, 2)}…`;
  return `${secret.slice(0, KEEP.start)}…${secret.slice(-KEEP.end)}`;
}

export interface Leak {
  detector: string;
  label: string;
  /** Redacted. The raw value is never stored. Empty for a kind that shows no character of the value. */
  redacted: string;
  /** Byte offset of the secret in the file, as sent. */
  offset: number;
}

/** Every leak in a file's text, redacted, first occurrence of each value only. */
export function findLeaks(text: string): Leak[] {
  const out: Leak[] = [];
  const seen = new Set<string>();
  for (const d of DETECTORS) {
    for (const m of text.matchAll(new RegExp(d.pattern.source, d.pattern.flags))) {
      const secret = m.groups?.secret;
      if (!secret || (d.verify && !d.verify(secret, m))) continue;
      if (seen.has(secret)) continue;
      seen.add(secret);
      const at = (m.index ?? 0) + m[0].indexOf(secret);
      out.push({
        detector: d.id,
        label: d.label,
        redacted: d.hideValue ? "" : redact(secret),
        offset: Buffer.byteLength(text.slice(0, at)),
      });
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}
