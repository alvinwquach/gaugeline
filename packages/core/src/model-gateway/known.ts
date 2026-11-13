/**
 * What the gateway knows by name (AG-20). A config is a file a person wrote, and anything in it that is printed
 * back could be a key pasted in the wrong place. So the root rule is: a provider, a model id or a variable name from
 * a config is shown only if it is on a closed list kept here, and anything else is shown as its length and its first
 * three characters at most. A new provider, model or key variable is added by a change to this file and its test, the
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

/** The model ids shown in full, per provider, as exact shapes. Any other id is shown masked. */
const KNOWN_MODEL_IDS: Readonly<Record<string, RegExp>> = Object.freeze({
  example: /^example-(small|large)(-\d{4}-\d{2}-\d{2})?$/,
  recorded: /^recorded-(small|large)$/,
});

export const isKnownProvider = (provider: string): boolean => KNOWN_PROVIDERS.includes(provider);
export const isKnownKeyEnv = (name: string): boolean => KNOWN_KEY_ENVS.includes(name);
export const isKnownModelId = (provider: string, id: string): boolean =>
  KNOWN_MODEL_IDS[provider]?.test(id) === true;

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

/** A config string that is not on a known list, as something safe to print: its first three characters and its length. */
export const masked = (what: string, value: string): string =>
  `${value.slice(0, 3)}... (a ${what} of ${value.length} characters, not on the known list)`;

/** A provider as it may be printed: itself if known, else masked. */
export const shownProvider = (provider: string): string =>
  isKnownProvider(provider) ? provider : masked("provider name", provider);
/** A model id as it may be printed: itself if known for the provider, else masked. */
export const shownModelId = (provider: string, id: string): string =>
  isKnownModelId(provider, id) ? id : masked("model id", id);
