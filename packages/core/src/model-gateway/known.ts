/**
 * What the gateway knows by name (AG-20). A config is a file a person wrote, and anything in it that is printed
 * back could be a key pasted in the wrong place. So the root rule is: a provider, a model id or a variable name from
 * a config is shown only if it is on a closed list kept here, and anything else is shown as one fixed text, with no
 * character of it and no length. A new provider, model or key variable is added by a change to this file and its test, the
 * way a provider host is added to the sending module.
 */

/** The providers the adapter registry supports: the example provider and the recorded fake. */
export const KNOWN_PROVIDERS: readonly string[] = Object.freeze(["example", "recorded"]);

/**
 * The variables a model key may be kept in. Any other name is refused, without being shown: a deny list could
 * never be complete (a file could name GH_API_KEY, TWILIO_API_KEY, any service's key), and an allowlist is.
 * Custom names are not supported: to use another provider's variable, add it here.
 */
export const KNOWN_KEY_ENVS: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "COHERE_API_KEY",
  "DEEPSEEK_API_KEY",
  "EXAMPLE_API_KEY",
  "GAUGELINE_MODEL_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
]);

/** Whether `yyyy-mm-dd` is a real calendar date (not 9384-71-62, not 2026-02-30). */
function isCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    y >= 2020 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/** The model ids shown in full, per provider, as exact shapes. Any other id is not shown at all. */
const KNOWN_MODEL_IDS: Readonly<Record<string, (id: string) => boolean>> = Object.freeze({
  example: (id) => {
    const m = /^example-(small|large)(?:-(\d{4}-\d{2}-\d{2}))?$/.exec(id);
    return m !== null && (m[2] === undefined || isCalendarDate(m[2]));
  },
  recorded: (id) => /^recorded-(small|large)$/.test(id),
});

export const isKnownProvider = (provider: string): boolean => KNOWN_PROVIDERS.includes(provider);
export const isKnownKeyEnv = (name: string): boolean => KNOWN_KEY_ENVS.includes(name);
export const isKnownModelId = (provider: string, id: string): boolean =>
  KNOWN_MODEL_IDS[provider]?.(id) === true;

/**
 * A name made of words and short version numbers, which is what a provider or model name is, and nothing a key
 * can be. Split on `-`, `.` and `:`, every part is letters (up to 16), a whole number (up to 8 digits), a word with a
 * short version (`llama3`, `gpt4o`), or a size (`8b`, `70b`); at most ten parts and 48 characters. A key's parts are
 * mixed letters and digits of any length, a UUID's are eight, four and twelve characters long, so none of those fit.
 */
const PART = [/^[a-z]{1,16}$/, /^\d{1,8}$/, /^[a-z]{1,10}\d{1,2}[a-z]?$/, /^\d{1,3}[a-z]{1,2}$/];
export function isNameShaped(value: string): boolean {
  if (value.length === 0 || value.length > 48 || !/^[a-z0-9][a-z0-9._:-]*$/.test(value))
    return false;
  const parts = value.split(/[-.:]/);
  return parts.length <= 10 && parts.every((p) => PART.some((re) => re.test(p)));
}

/**
 * What a config string that is not on a known list is printed as. Not its first characters and not its length:
 * any character of a free-form string can be key material, so none is ever shown.
 */
export const NOT_ON_LIST = "[not on the known list]";

/** A provider as it may be printed: itself if known, else the fixed text. */
export const shownProvider = (provider: string): string =>
  isKnownProvider(provider) ? provider : NOT_ON_LIST;
/** A model id as it may be printed: itself if known for the provider, else the fixed text. */
export const shownModelId = (provider: string, id: string): string =>
  isKnownModelId(provider, id) ? id : NOT_ON_LIST;
/** Whether an id is a known model id for any known provider. */
export const isKnownAnyModel = (id: string): boolean =>
  KNOWN_PROVIDERS.some((p) => isKnownModelId(p, id));
/** A model id when the provider is not at hand: itself if it is known for any known provider, else the fixed text. */
export const shownAnyModelId = (id: string): string =>
  KNOWN_PROVIDERS.some((p) => isKnownModelId(p, id)) ? id : NOT_ON_LIST;

/** Mistakes people make in a settings file, by their canonical spelling: a key, a host, a mode. */
const KNOWN_MISTAKES: readonly string[] = Object.freeze([
  "apiKey",
  "api_key",
  "key",
  "token",
  "secret",
  "password",
  "authorization",
  "bearer",
  "host",
  "baseUrl",
  "url",
  "endpoint",
  "proxy",
  "allowPrivate",
  "mode",
  "managed",
  "vault",
  "metered",
  "metering",
]);

/** The edit distance between two short words (insert, delete, change one letter). */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length]!;
}

/**
 * What a setting name is, if it is a name this file recognises: `mistake` for a recognised mistake (a key, a host, a
 * mode), `real` for a real setting or a near miss of one (two edits, any case), with the CANONICAL spelling. The
 * user's own spelling is never returned and so never printed: a person may have pasted a key as a name, and
 * "within two edits" would let two characters of it through. Nothing recognised: undefined.
 */
export function recognisedSetting(
  k: string,
  settings: readonly string[],
): { name: string; kind: "mistake" | "real" } | undefined {
  if (k.length > 24 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) return undefined;
  const lower = k.toLowerCase();
  const mistake = KNOWN_MISTAKES.find((m) => m.toLowerCase() === lower);
  if (mistake !== undefined) return { name: mistake, kind: "mistake" };
  let best: { name: string; d: number } | undefined;
  for (const s of settings) {
    const d = distance(lower, s.toLowerCase());
    if (d <= 2 && (best === undefined || d < best.d)) best = { name: s, d };
  }
  return best === undefined ? undefined : { name: best.name, kind: "real" };
}

/**
 * A path segment for a message: exactly one of the file's real settings, or a known model id (a price is keyed by
 * one), else "an entry". Never a near miss, and never the person's own spelling.
 */
export const shownPathSegment = (k: string, settings: readonly string[]): string =>
  settings.includes(k) || isKnownAnyModel(k) ? k : "an entry";

/** A path segment or setting name for a message: the canonical name of a recognised setting, else "a setting". */
export const shownSettingName = (k: string, settings: readonly string[]): string =>
  recognisedSetting(k, settings)?.name ?? "a setting";
