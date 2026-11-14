import { entropy } from "../leaks/detectors.js";

/**
 * Detectors for an AI provider's key in shipped JavaScript (AI-10). A hit is the provider, a label and a byte
 * offset: no character of the value leaves this file, so no output path can carry one.
 *
 * Every key shape here is from memory, not from a vendor page (the vendors' sites were unreachable when this was
 * written): uncited. A shape is only trusted with a length floor and a check that the value is not a placeholder;
 * a provider whose keys have no prefix is only found when the name of the value says the provider.
 */
export interface AiKeyHit {
  provider: string;
  label: string;
  /** Byte offset of the value in the text, as sent. */
  offset: number;
}

interface Shape {
  provider: string;
  /** Global. The value is the capture group "secret". */
  pattern: RegExp;
  /** An extra reason to turn a match down, given the match and the whole text. */
  verify?(secret: string, m: RegExpExecArray): boolean;
}

/** Below this many bits per character a value is a word or a run of one letter, not a random key. */
const NAMED_ENTROPY_MIN = 3.5;
/** A prefixed key is turned down when it has fewer different characters than this. */
const MIN_DISTINCT = 8;
/** At most this many hits are kept from one file: a hostile file cannot make the offsets cost much. */
const MAX_HITS = 50;
/** How far from a Google key the Gemini API must be named for it to count as a Gemini key. */
const GEMINI_WINDOW = 400;

const PLACEHOLDER =
  /^(?:your|example|placeholder|sample|test|demo|changeme|insert|replace)|x{6,}|\.{3}|<|\$\{/i;

/**
 * A Google API key (AIza and 35 characters) is also the public browser key of Maps and Firebase, so the shape
 * alone proves nothing: it is a Gemini key only when the Gemini API, its host or its SDK is named near it.
 */
const GEMINI_CONTEXT =
  /generativelanguage\.googleapis\.com|GoogleGenerativeAI|@google\/(?:generative-ai|genai)|GoogleGenAI|gemini-\d|gemini[_-]?api[_-]?key/i;

const prefixed = (secretSource: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_-])(?<secret>${secretSource})(?![A-Za-z0-9_-])`, "g");

const SHAPES: readonly Shape[] = Object.freeze([
  { provider: "OpenAI", pattern: prefixed("sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,200}") },
  { provider: "OpenAI", pattern: prefixed("sk-[A-Za-z0-9]{20,100}T3BlbkFJ[A-Za-z0-9]{20,100}") },
  { provider: "Anthropic", pattern: prefixed("sk-ant-(?:api|admin)\\d{2}-[A-Za-z0-9_-]{40,200}") },
  {
    provider: "Google Gemini",
    pattern: prefixed("AIza[0-9A-Za-z_-]{35}"),
    verify: (_s, m) => {
      const at = m.index ?? 0;
      const near = m.input.slice(Math.max(0, at - GEMINI_WINDOW), at + m[0].length + GEMINI_WINDOW);
      return GEMINI_CONTEXT.test(near);
    },
  },
  { provider: "Hugging Face", pattern: prefixed("hf_[A-Za-z0-9]{34,100}") },
  { provider: "Replicate", pattern: prefixed("r8_[A-Za-z0-9]{37,100}") },
  { provider: "Groq", pattern: prefixed("gsk_[A-Za-z0-9]{40,100}") },
  { provider: "OpenRouter", pattern: prefixed("sk-or-v1-[a-f0-9]{64}") },
  { provider: "Perplexity", pattern: prefixed("pplx-[A-Za-z0-9]{40,100}") },
  { provider: "xAI", pattern: prefixed("xai-[A-Za-z0-9]{70,200}") },
  { provider: "ElevenLabs", pattern: prefixed("sk_[a-f0-9]{48}") },
]);

/** The words in a value's name that say which provider it belongs to, as written in lower case. */
const NAMED: readonly [word: string, provider: string][] = [
  ["assemblyai", "AssemblyAI"],
  ["anthropic", "Anthropic"],
  ["cohere", "Cohere"],
  ["deepgram", "Deepgram"],
  ["deepseek", "DeepSeek"],
  ["elevenlabs", "ElevenLabs"],
  ["fireworks", "Fireworks AI"],
  ["gemini", "Google Gemini"],
  ["groq", "Groq"],
  ["huggingface", "Hugging Face"],
  ["hugging_face", "Hugging Face"],
  ["mistral", "Mistral"],
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
  ["perplexity", "Perplexity"],
  ["replicate", "Replicate"],
  ["stability", "Stability AI"],
  ["together", "Together AI"],
  ["voyage", "Voyage AI"],
  ["xai", "xAI"],
];

/**
 * name = "value" or name: "value", where the name has a provider word and then key, token or secret. The name
 * is capped on each side of those words, so a hostile file is scanned in linear time.
 */
const NAMED_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_$])(?<name>[A-Za-z0-9_$]{0,40}(?<word>${NAMED.map(([w]) => w).join("|")})[A-Za-z0-9_$]{0,24}(?:key|token|secret)[A-Za-z0-9_$]{0,16})["']?\\s*[:=]\\s*(?<q>["'\`])(?<secret>[A-Za-z0-9._+/=-]{20,200})\\k<q>`,
  "gi",
);

/** Every provider Gaugeline looks for, once each, by name. */
export const AI_KEY_PROVIDERS: readonly { provider: string }[] = Object.freeze(
  [...new Set([...SHAPES.map((s) => s.provider), ...NAMED.map(([, p]) => p)])]
    .sort()
    .map((provider) => ({ provider })),
);

const distinct = (s: string): number => new Set(s).size;

function plausible(secret: string, named: boolean): boolean {
  if (PLACEHOLDER.test(secret)) return false;
  if (distinct(secret) < MIN_DISTINCT) return false;
  if (!named) return true;
  return /\d/.test(secret) && /[A-Za-z]/.test(secret) && entropy(secret) >= NAMED_ENTROPY_MIN;
}

/** The provider keys in a file's text, in the order they sit, the first of each value only. No value is kept. */
export function findAiKeys(text: string): AiKeyHit[] {
  const found: { provider: string; at: number }[] = [];
  const seen = new Set<string>();
  const take = (provider: string, secret: string, m: RegExpExecArray): void => {
    if (seen.has(secret) || found.length >= MAX_HITS) return;
    seen.add(secret);
    found.push({ provider, at: (m.index ?? 0) + m[0].indexOf(secret) });
  };
  for (const shape of SHAPES) {
    for (const m of text.matchAll(new RegExp(shape.pattern.source, shape.pattern.flags))) {
      const secret = m.groups?.secret;
      if (!secret || !plausible(secret, false)) continue;
      if (shape.verify && !shape.verify(secret, m)) continue;
      take(shape.provider, secret, m);
    }
  }
  for (const m of text.matchAll(NAMED_PATTERN)) {
    const secret = m.groups?.secret;
    const word = m.groups?.word?.toLowerCase();
    const provider = NAMED.find(([w]) => w === word)?.[1];
    if (!secret || !provider || !plausible(secret, true)) continue;
    take(provider, secret, m);
  }
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => ({
      provider: f.provider,
      label: `${f.provider} key`,
      offset: Buffer.byteLength(text.slice(0, f.at)),
    }));
}
