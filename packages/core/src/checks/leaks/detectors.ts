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
    // Contentful tokens are 43 characters of base64url with no prefix, so the shape alone proves nothing
    // (a delivery token is public by design). A match is a 43-character value assigned to a name that
    // contains "token" or "key", either as name = "value" / name: "value", or as ?access_token=value.
    // verify() then insists on the Preview API: the name says "preview" in a file that names Contentful,
    // or the preview host is within a few hundred characters (the contentful SDK itself contains that
    // host, which is why mere presence in a file is not enough).
    pattern:
      /(?:(?<![A-Za-z0-9_$])(?<name>[A-Za-z0-9_$]*(?:token|key)[A-Za-z0-9_$]*)["']?\s*[:=]\s*["'`]|[?&]access_token=)(?<secret>[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/gi,
    verify: (s, m) => {
      if (entropy(s) < ENTROPY_MIN) return false;
      const start = m.index;
      const end = start + m[0].length;
      const name = m.groups?.name ?? "";
      if (name === "") {
        // ?access_token=...: the preview host just before it, in the same address.
        if (PREVIEW_HOST.test(m.input.slice(Math.max(0, start - PREVIEW_WINDOW), start)))
          return true;
      } else {
        // name: "value": the preview host in the same object literal (after the last "{" before the
        // token, up to the first "}" after it), so a delivery token next to a preview client is not one.
        const before = m.input.slice(Math.max(0, start - PREVIEW_WINDOW), start);
        const after = m.input.slice(end, end + PREVIEW_WINDOW);
        const scope = `${before.slice(before.lastIndexOf("{") + 1)} ${after.split("}")[0] ?? ""}`;
        if (PREVIEW_HOST.test(scope)) return true;
      }
      return /preview/i.test(name) && /contentful/i.test(m.input);
    },
  },
  {
    id: "secret-assignment",
    label: "Secret value",
    // name = "value" or name: "value", where the name contains SECRET, TOKEN or KEY.
    pattern:
      /(?<![A-Za-z0-9_$])(?<name>[A-Za-z0-9_$]*(?:secret|token|key)[A-Za-z0-9_$]*)["']?\s*[:=]\s*(?<q>["'`])(?<secret>[A-Za-z0-9+/_=.-]{20,200})\k<q>/gi,
    verify: (s, m) => {
      const name = m.groups?.name ?? "";
      if (/public|publishable/i.test(name)) return false;
      if (/^pk_(?:live|test)_/.test(s)) return false;
      if (FILE_NAME.test(s) || IMAGE_BASE64.test(s)) return false;
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
  /** Redacted. The raw value is never stored. */
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
        redacted: redact(secret),
        offset: Buffer.byteLength(text.slice(0, at)),
      });
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}
