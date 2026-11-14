# AI keys in your site's JavaScript

A booking helper, a "ask our menu" box or a product-description button is easy to add to a small business's
site: paste the provider's key into the script and call the model straight from the browser. The key then
ships to every visitor. `ai-key-in-js` finds those keys in the JavaScript the site already sends and tells
you which provider and which file, never the key itself.

It reads what the page loads and asks for nothing else, so it is not a probing check: it needs no consent
flag. Gaugeline never calls a model and never tries the key.

## An example: a yoga studio's booking helper

Larkspur Yoga is an invented studio. Its booking helper calls a model provider from `/assets/helper.js` with
a key in the code, and a leftover Groq token sits in an inline script on the home page.

<!-- fixture: ai-key-in-js -->

```sh title=Terminal
$ npx gaugeline larkspur-yoga.example
```

```text title=Output
✗ An AI provider's key is in your site's JavaScript
    Groq key in inline script 1 on / at byte 55
✗ An AI provider's key is in your site's JavaScript
    OpenAI key in ./helper.js at byte 288
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 2 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. Only the provider and the file are
printed. The offset is a byte position in the file, so you can find it; no part of the key is shown.

## What to do about it

1. Revoke the key in the provider's dashboard now. Treat it as already copied.
2. Read the provider's usage log for the period the key was on the site: it shows what was run on your account.
3. Make a new key and keep it on the server. Move the model call to a server route or a server action, and have
   the browser call that route.
4. In Next.js or Vite, a variable named `NEXT_PUBLIC_...` or `VITE_...` is written into the browser's
   JavaScript at build time. A key in one of those is in the bundle.

## What it looks at

| Where                                           | Read                                                            |
| ----------------------------------------------- | --------------------------------------------------------------- |
| Inline scripts on the page (any type, JSON too) | all of them                                                     |
| Script files on the same site                   | up to 15, the first 5 MB of each, the ones `secret-in-js` reads |
| Script files on other sites                     | never fetched                                                   |

It looks for a key shape for these providers: Anthropic, AssemblyAI, Cohere, Deepgram, DeepSeek, ElevenLabs,
Fireworks AI, Google Gemini, Groq, Hugging Face, Mistral, OpenAI, OpenRouter, Perplexity, Replicate, Stability AI,
Together AI, Voyage AI and xAI.

- A key with a known prefix (for example `sk-proj-`, `sk-ant-`, `hf_`, `gsk_`) counts when it is long enough
  and is not a placeholder such as a run of one letter.
- A Google key (`AIza...`) is also the public browser key of Maps and Firebase, so it counts only when the Gemini
  API, its host or its SDK is named within 400 characters of it.
- A provider whose keys have no prefix (Cohere, Mistral, Together AI and others) counts only when the name of the
  value says the provider and then key, token or secret (`COHERE_API_KEY: "..."`), and the value mixes letters
  and digits like a random key. A reference such as `process.env.OPENAI_API_KEY` is not a value and is never found.

The check says nothing it cannot see. A key that is split in two strings and joined by the code is not found
(Gaugeline reads text; it does not run the page). The key shapes are from memory, not from the providers' own
pages, which could not be reached when the check was written: the check's technical line in the
[checks reference](/docs/checks) says so, and a new provider is added by a branch that names its source.

`secret-in-js` looks for other kinds of key in the same files and leaves a provider's AI key to this check, so
one key is one finding and no part of it is printed.
