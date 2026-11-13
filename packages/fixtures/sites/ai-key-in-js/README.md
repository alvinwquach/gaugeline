# ai-key-in-js

An invented yoga studio (Larkspur Yoga) with a booking helper chat, for `ai-key-in-js` (AI-10). Nothing here is a
real business or key.

- `/assets/helper.js` calls a model provider from the browser with a key in its code: an OpenAI key. The key is a
  `{{planted:...}}` placeholder the fixture server fills in at serve time (`PLANTED` in
  packages/fixtures/src/server.ts), so no key-shaped string is in the repository.
- `/` has an inline script with a Groq key, planted the same way.
- The finding names the provider and the file, never the value.

The passing copy is `ai-key-in-js-clean`: the same helper calls the studio's own `/api/helper` route and holds no key.
