import { load } from "cheerio/slim";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findAiKeys } from "./ai-keys/detectors.js";

/**
 * AI-10. A model provider's key in JavaScript every visitor downloads. The same rule as secret-in-js, for the
 * keys of AI services: a stolen one is spent on the owner's bill, and some providers let it read the owner's
 * stored files and conversations. The check reads what the page already sends (its inline scripts and same-site
 * script files) and asks for nothing else, so it is not a probing check. It reports the provider and the file,
 * never a character of the value.
 *
 * // [docs] uncited: the key shapes (prefix and length of each provider's key) are from memory; the providers' sites were unreachable when this was written. Each shape needs a length floor, and a provider with no prefix is found only when the value's name says the provider.
 */
function inlineScripts(page: PageSnapshot): string[] {
  const $ = load(page.hops.at(-1)?.body ?? "");
  // Every inline script, whatever its type: a JSON data block (__NEXT_DATA__) ships to visitors as well.
  return $("script:not([src])")
    .map((_, el) => $(el).text())
    .get();
}

/** The file as a visitor names it: the path on this site, or the whole address elsewhere. Never the query string, which could carry a key. */
function fileName(url: string, origin: string): string {
  try {
    const u = new URL(url);
    return u.origin === origin ? u.pathname : `${u.origin}${u.pathname}`;
  } catch {
    return "a script file";
  }
}

export const aiKeyInJs = defineCheck<PageSnapshot>({
  id: "ai-key-in-js",
  size: "M",
  done: "The old key is revoked at the provider, a new one lives on the server only, and the site's JavaScript holds no AI key.",
  estimateChanges:
    "The code that called the model from the browser has to move to a server route, and the provider's usage log has to be read for what the key was used for. A key exposed for long means more to read.",
  area: "Security & email",
  severity: "high",
  title: "An AI provider's key is in your site's JavaScript",
  what: "A key for an AI service (OpenAI, Anthropic, Google Gemini, Groq, Hugging Face and others) is in JavaScript the site sends to every visitor. Gaugeline names the provider and the file, never the key.",
  why: "Anyone can copy it from their browser and run models on your account. You pay for what they use, and some providers let a key read the files and conversations stored under your account.",
  fix: "Revoke the key in the provider's dashboard now, make a new one, and keep it on the server: call the model from a server route or a server action, and never put the key in code the browser loads or in a variable the framework exposes to the browser (a NEXT_PUBLIC_ or VITE_ name).",
  tech: "Inline scripts of any type (JSON data blocks included) and up to 15 same-site script files (GET, first 5 MB each, the files secret-in-js reads) matched against the shapes in checks/ai-keys/detectors.ts: a prefixed key (OpenAI sk-proj-, sk-svcacct-, sk-admin- and the older sk- with T3BlbkFJ; Anthropic sk-ant-; Hugging Face hf_; Replicate r8_; Groq gsk_; OpenRouter sk-or-v1-; Perplexity pplx-; xAI xai-; ElevenLabs sk_ and 48 hex) with a length floor and no placeholder or run of one character; a Google key (AIza) only when the Gemini API, its host or its SDK is named within 400 characters, because the same shape is the public browser key of Maps and Firebase; a provider whose keys have no prefix (Cohere, Mistral, Together AI and others) only when the name of the value says the provider and key, token or secret, and the value mixes letters and digits at 3.5 bits per character or more. One finding per provider and file, with a byte offset; no character of the value is kept, so none can be printed. Third-party script files are not read. A key shape is from memory, not from a provider's page (uncited), so a new provider's shape is added by a branch that names its source",
  async run(page, ctx) {
    const origin = new URL(page.finalUrl).origin;
    const sources: { where: string; text: string }[] = inlineScripts(page).map((text, i) => ({
      where: `inline script ${i + 1} on ${fileName(page.finalUrl, origin)}`,
      text,
    }));
    for (const s of (await ctx.scripts?.()) ?? [])
      sources.push({ where: fileName(s.url, origin), text: s.text });
    const out: Finding[] = [];
    for (const { where, text } of sources) {
      const seen = new Set<string>();
      for (const hit of findAiKeys(text)) {
        if (seen.has(hit.provider)) continue;
        seen.add(hit.provider);
        out.push({
          checkId: "ai-key-in-js",
          severity: "high",
          title: this.title,
          evidence: `${hit.label} in ${where} at byte ${hit.offset}`,
          url: page.finalUrl,
        });
      }
    }
    return out;
  },
});
