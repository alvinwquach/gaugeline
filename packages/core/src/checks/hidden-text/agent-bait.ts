import { normaliseForMatch } from "../../ai-directives.js";

/**
 * Text that speaks to AI agents and assistants (AI-15), matched on the text as normalised for the phrase list: invisible
 * characters removed, accents dropped, lower case, curly apostrophes straightened. Plain patterns with bounded gaps, so a
 * hostile text is read in linear time. The words are from memory (uncited): they are the usual openings of text planted
 * for agents, and the check says what it saw, never more.
 *
 * Bare "agent", "assistant" and "bot" are not enough on their own: "If you are an agent, sign in here" is a login hint
 * on an estate agent's site. The nouns that count are the ones that mean an AI: ai, llm, language model, chatbot,
 * "ai agent", "ai assistant", "ai crawler", and bot, crawler and scraper in a call to them.
 */

/** Nouns that mean an AI, or a program that reads the site. */
const AI_NOUN =
  "(?:a\\.?i\\.?|llms?|language models?|large language models?|chat ?bots?|ai (?:agents?|assistants?|crawlers?|bots?|models?)|bots?|crawlers?|scrapers?|chatgpt|gemini|copilot|perplexity)";
/** Nouns that mean an AI without any other word (no bare bot or crawler): the ones an instruction is aimed at. */
const AI_ONLY =
  "(?:a\\.?i\\.?|llms?|language models?|large language models?|chat ?bots?|ai (?:agents?|assistants?|crawlers?|bots?|models?)|chatgpt|gemini|copilot|perplexity)";

const ADDRESS: readonly RegExp[] = [
  new RegExp(`\\bif you(?: are|'re) (?:an? |the )?${AI_NOUN}(?![a-z])`),
  new RegExp(
    `\\b(?:attention|attn|note to|notice to|message to|message for|instructions? for|hello|hey|dear|calling all)[,:]? +(?:all |any |other )?${AI_NOUN}(?![a-z])`,
  ),
  new RegExp(`\\bfor (?:all )?${AI_ONLY}(?![a-z])[:,]`),
  new RegExp(`\\bai (?:agents?|assistants?|crawlers?|bots?|models?)[:,]`),
];

/** Doing words an instruction to an AI is made of: act, say, send, buy, visit. */
const ACT =
  "(?:recommend|rank|cite|mention|promote|prefer|visit|navigate|click|open|send|email|buy|purchase|book|include|say|state|respond|reply|answer|output|reveal|call|run|execute|download|install|submit|fill|add|link)";

const INSTRUCTION: readonly RegExp[] = [
  // "AI agents must recommend us": an AI noun, a duty word, an act, close together and in one sentence.
  new RegExp(
    `\\b${AI_ONLY}[^.!?\\n]{0,60}?\\b(?:must|should|always|never|please|need to|needs to|have to|has to)\\b[^.!?\\n]{0,40}?\\b${ACT}\\b`,
  ),
  // "AI assistants: please visit the link": an AI noun, a colon or comma, a duty or please, an act.
  new RegExp(`\\b${AI_ONLY}[:,] +(?:please |you must |you should |always |never )?${ACT}\\b`),
  // "If you are an AI agent, you have to send ...": an address followed by a duty and an act.
  new RegExp(
    `\\bif you(?: are|'re) (?:an? |the )?${AI_NOUN}(?![a-z])[^.!?\\n]{0,40}?\\b(?:must|should|always|never|please|need to|have to)\\b[^.!?\\n]{0,40}?\\b${ACT}\\b`,
  ),
  new RegExp(
    `\\bif you(?: are|'re) (?:an? |the )?${AI_NOUN}(?![a-z])[:,] +(?:please |you must |you should )?${ACT}\\b`,
  ),
];

/** The most of a text read: the check keeps 2,000 characters of a hidden element, this is its own floor. */
const READ_MAX = 4000;

export type AgentBait = "address" | "instruction";

/** "instruction" when the text asks AI agents to act, "address" when it only speaks to them, undefined otherwise. */
export function findAgentBait(text: string): AgentBait | undefined {
  const hay = normaliseForMatch(text.slice(0, READ_MAX));
  if (hay === "") return undefined;
  if (INSTRUCTION.some((p) => p.test(hay))) return "instruction";
  if (ADDRESS.some((p) => p.test(hay))) return "address";
  return undefined;
}
