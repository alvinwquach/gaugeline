import { describe, expect, it } from "vitest";
import { aiKeyInJs } from "../ai-key-in-js.js";
import { AI_KEY_PROVIDERS, findAiKeys } from "../ai-keys/detectors.js";
import { createPageRegistry } from "../index.js";
import type { CheckContext } from "../../model.js";
import { buildSnapshot } from "../../snapshot.js";
import type { ScriptRead } from "../../scripts.js";

/**
 * ai-key-in-js (AI-10): an AI provider's key in JavaScript the site sends to every visitor. Every value here is
 * invented and built at run time: a key-shaped string in source is refused by push protection. The check reports
 * the provider and the file, never any character of the value.
 */
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** n characters of a fixed pseudo-random sequence: the same seed gives the same value on every run. */
const rnd = (seed: number, n: number, alphabet = BASE62) => {
  let x = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[Math.floor(x / 65536) % alphabet.length];
  }
  return out;
};
const mix = (seed: string, n: number) =>
  rnd(
    [...seed].reduce((a, c) => a * 31 + c.charCodeAt(0), 7),
    n,
  );
const hex = (n: number) => rnd(4242, n, "0123456789abcdef");
const K = {
  openaiProject: ["sk", "proj", mix("Ab3dEf9Gh", 56)].join("-"),
  openaiLegacy: ["sk", mix("Kp4", 22) + "T3BlbkFJ" + mix("Zw8", 22)].join("-"),
  anthropic: ["sk", "ant", "api03", mix("Qr7sT2", 60)].join("-"),
  google: "AIza" + mix("Sy7Bd2", 35),
  hf: "hf_" + mix("Vn5Cp", 36),
  replicate: "r8_" + mix("Lm4Xa", 37),
  groq: "gsk_" + mix("Jt6Wq", 52),
  openrouter: ["sk", "or", "v1", hex(64)].join("-"),
  perplexity: "pplx-" + mix("Nd3Uo", 48),
  xai: "xai-" + mix("Rb9Ey", 80),
  elevenlabs: "sk_" + hex(48),
};
const PROVIDER_OF: Record<keyof typeof K, string> = {
  openaiProject: "OpenAI",
  openaiLegacy: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  hf: "Hugging Face",
  replicate: "Replicate",
  groq: "Groq",
  openrouter: "OpenRouter",
  perplexity: "Perplexity",
  xai: "xAI",
  elevenlabs: "ElevenLabs",
};
const providers = (text: string) => findAiKeys(text).map((h) => h.provider);

const page = (body = "<html><head><title>Cafe</title></head><body>x</body></html>") =>
  buildSnapshot([
    {
      url: "https://larkspur-yoga.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
    },
  ]);
const script = (url: string, text: string): ScriptRead => ({
  url,
  status: 200,
  text,
  truncated: false,
});
const ctxWith = (scripts: ScriptRead[]): CheckContext => ({
  warn: () => undefined,
  scripts: async () => scripts,
});

describe("ai-key-in-js: unit, the key shapes", () => {
  it("finds each provider's key and names the provider", () => {
    for (const [name, key] of Object.entries(K)) {
      const context = name === "google" ? "// gemini-2.0 " : "";
      const hit = findAiKeys(`${context}const client = new Client({ credentials: "${key}" });`);
      expect(
        hit.map((h) => h.provider),
        name,
      ).toEqual([PROVIDER_OF[name as keyof typeof K]]);
    }
  });

  it("a hit carries the provider, a label and an offset, and no part of the value", () => {
    const text = `var a = 1;\nvar token = "${K.anthropic}";`;
    const hits = findAiKeys(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.offset).toBe(text.indexOf(K.anthropic));
    expect(Object.keys(hits[0] ?? {}).sort()).toEqual(["label", "offset", "provider"]);
    expect(JSON.stringify(hits)).not.toContain(K.anthropic.slice(0, 12));
    expect(JSON.stringify(hits)).not.toContain(K.anthropic.slice(-8));
  });

  it("finds a key named for its provider even when the value has no prefix", () => {
    const v = mix("Cd4Ef6Gh", 40);
    expect(providers(`const COHERE_API_KEY = "${v}";`)).toEqual(["Cohere"]);
    expect(providers(`{ mistralApiKey: '${v}' }`)).toEqual(["Mistral"]);
    expect(providers(`window.__env = { TOGETHER_API_KEY: "${v}" }`)).toEqual(["Together AI"]);
    expect(providers(`const openai_api_key = "${hex(40)}";`)).toEqual(["OpenAI"]);
  });

  it("a Gemini key is a Google key named near the Gemini API: the same shape alone is a public browser key", () => {
    const maps = `new google.maps.Map(el,{key:"${K.google}"})`;
    expect(providers(maps)).toEqual([]);
    const gemini = `fetch("https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${K.google}")`;
    expect(providers(gemini)).toEqual(["Google Gemini"]);
    const sdk = `import {GoogleGenerativeAI} from "@google/generative-ai"; new GoogleGenerativeAI("${K.google}")`;
    expect(providers(sdk)).toEqual(["Google Gemini"]);
  });

  it("lists every provider it looks for, once, sorted by name", () => {
    const names = AI_KEY_PROVIDERS.map((p) => p.provider);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  it("is the same answer every time for the same text", () => {
    const text = `a="${K.groq}";b="${K.hf}";`;
    expect(findAiKeys(text)).toEqual(findAiKeys(text));
    expect(findAiKeys(text)).toEqual(
      findAiKeys(text)
        .slice()
        .sort((a, b) => a.offset - b.offset),
    );
  });
});

describe("ai-key-in-js: unit, look-alikes are not reported", () => {
  it("a short prefix, a placeholder, an environment reference, a doc string and a file name are not keys", () => {
    for (const miss of [
      `const k = "sk-";`,
      `const k = "sk-proj-";`,
      `const k = "sk-ant-api03-YOUR_KEY_HERE";`,
      `const OPENAI_API_KEY = "your-openai-api-key-here";`,
      `const OPENAI_API_KEY = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";`,
      `const OPENAI_API_KEY = process.env.OPENAI_API_KEY;`,
      `const OPENAI_API_KEY = "";`,
      `headers: { Authorization: "Bearer " + token }`,
      `// keys start with sk-proj- or sk-ant-api03-`,
      `const k = "hf_";`,
      `import "./openai-key.js";`,
      `const COHERE_API_KEY = "${"a".repeat(40)}";`,
      `const TOKEN = "${mix("Cd4Ef6Gh", 40)}";`,
    ])
      expect(providers(miss), miss).toEqual([]);
  });

  it("a Stripe key and a Sanity token are not an AI key (secret-in-js reports them)", () => {
    const stripe = ["sk", "live", mix("Gh4Jk", 28)].join("_");
    expect(providers(`const s = "${stripe}";`)).toEqual([]);
  });

  it("a hostile file is read in linear time", () => {
    const hostile = "sk-proj-".repeat(40000) + "_".repeat(200000) + "openai_api_key=".repeat(20000);
    const start = Date.now();
    findAiKeys(hostile);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("ai-key-in-js: integration, the check over a page and its script files", () => {
  it("is registered, high, and reads files only (no probing)", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("ai-key-in-js");
    expect(aiKeyInJs.severity).toBe("high");
    expect(aiKeyInJs.tech).not.toMatch(/^probing check/);
  });

  it("reports the provider and the file for a key in a same-site script file, and never the value", async () => {
    const found = await aiKeyInJs.run(
      page(),
      ctxWith([
        script("https://larkspur-yoga.example/assets/chat.js", `var k="${K.openaiProject}";`),
        script("https://larkspur-yoga.example/assets/clean.js", `var a=1;`),
      ]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.checkId).toBe("ai-key-in-js");
    expect(found[0]?.severity).toBe("high");
    expect(found[0]?.evidence).toBe("OpenAI key in /assets/chat.js at byte 7");
    expect(JSON.stringify(found)).not.toContain(K.openaiProject.slice(0, 10));
    expect(JSON.stringify(found)).not.toContain(K.openaiProject.slice(-6));
  });

  it("reads inline scripts, including a JSON data block such as __NEXT_DATA__", async () => {
    const body = `<html><head><title>Studio</title></head><body>
      <script>window.cfg={ai:"${K.groq}"}</script>
      <script id="__NEXT_DATA__" type="application/json">{"props":{"OPENAI_API_KEY":"${K.openaiProject}"}}</script>
    </body></html>`;
    const found = await aiKeyInJs.run(page(body), ctxWith([]));
    expect(found.map((f) => f.evidence.split(" key in ")[0])).toEqual(["Groq", "OpenAI"]);
    expect(found[0]?.evidence).toContain("inline script 1 on /");
    expect(found[1]?.evidence).toContain("inline script 2 on /");
  });

  it("one finding per provider and file, however many times the key is repeated or how many keys it holds", async () => {
    const twice = `a="${K.groq}";b="${K.groq}";c="${mix("Pq8Rs", 52).replace(/^/, "gsk_")}";`;
    const found = await aiKeyInJs.run(
      page(),
      ctxWith([script("https://larkspur-yoga.example/a.js", twice)]),
    );
    expect(found).toHaveLength(1);
  });

  it("two providers in one file are two findings; the same provider in two files is two", async () => {
    const found = await aiKeyInJs.run(
      page(),
      ctxWith([
        script("https://larkspur-yoga.example/a.js", `a="${K.groq}";b="${K.hf}"`),
        script("https://larkspur-yoga.example/b.js", `a="${K.groq}"`),
      ]),
    );
    expect(found.map((f) => f.evidence.replace(/ at byte \d+/, ""))).toEqual([
      "Groq key in /a.js",
      "Hugging Face key in /a.js",
      "Groq key in /b.js",
    ]);
  });

  it("finds nothing on a clean page, with no scripts, a failed script read, or an empty file", async () => {
    expect(await aiKeyInJs.run(page(), ctxWith([]))).toEqual([]);
    expect(await aiKeyInJs.run(page(), { warn: () => undefined })).toEqual([]);
    expect(
      await aiKeyInJs.run(
        page(),
        ctxWith([
          { url: "https://larkspur-yoga.example/x.js", status: null, text: "", truncated: false },
          script("https://larkspur-yoga.example/y.js", ""),
        ]),
      ),
    ).toEqual([]);
  });

  it("is the same findings for the same page every time", async () => {
    const ctx = ctxWith([script("https://larkspur-yoga.example/a.js", `a="${K.xai}"`)]);
    expect(await aiKeyInJs.run(page(), ctx)).toEqual(await aiKeyInJs.run(page(), ctx));
  });
});

describe("ai-key-in-js: edge cases", () => {
  it("a key split across a string concatenation is not joined (Gaugeline reads text, it does not run code)", async () => {
    const half = K.groq.length / 2;
    const text = `var k="${K.groq.slice(0, half)}"+"${K.groq.slice(half)}";`;
    expect(providers(text)).toEqual([]);
  });

  it("a key inside a minified one-line bundle and after multi-byte text keeps a byte offset", () => {
    const text = `/* café */var a=1;var k="${K.hf}";`;
    const [hit] = findAiKeys(text);
    expect(hit?.offset).toBe(Buffer.byteLength(text.slice(0, text.indexOf(K.hf))));
  });

  it("an inline script that is a template or a type the browser does not run is still read for key shapes", async () => {
    const body = `<html><body><script type="text/template">${K.anthropic}</script></body></html>`;
    const found = await aiKeyInJs.run(page(body), ctxWith([]));
    expect(found).toHaveLength(1);
  });
});

describe("ai-key-in-js: with secret-in-js", () => {
  it("secret-in-js leaves a provider's AI key to this check, so no part of it is printed twice", async () => {
    const { secretInJs } = await import("../secret-in-js.js");
    const text = `var OPENAI_API_KEY="${K.openaiProject}";var s="${["sk", "live", rnd(9, 28)].join("_")}";`;
    const ctx = ctxWith([script("https://larkspur-yoga.example/a.js", text)]);
    const generic = await secretInJs.run(page(), ctx);
    expect(generic.map((f) => f.evidence)).toEqual([
      expect.stringMatching(/^Stripe secret key sk_liv…\S\S in \/a\.js at byte \d+$/),
    ]);
    const ours = await aiKeyInJs.run(page(), ctx);
    expect(ours.map((f) => f.evidence)).toEqual([expect.stringMatching(/^OpenAI key in \/a\.js/)]);
  });
});
