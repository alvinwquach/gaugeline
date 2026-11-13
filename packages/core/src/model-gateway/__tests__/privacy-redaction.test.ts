/**
 * The privacy gate's redaction, round three (AG-23 review): provider keys, values hidden behind entities,
 * percent escapes and JSON escapes, whole values and not their first word, more page shapes, every Base64 run,
 * and the guards whose removal used to go unnoticed (ids counted in the total, each look-alike letter, the page
 * check on the raw text). Where a fix cannot be made reliably the gate refuses. No network, no key, no clock.
 */
import { describe, expect, it } from "vitest";
import { LOOKALIKES } from "../redaction.js";
import {
  DEFAULT_PAYLOAD_PARTS,
  DEFAULT_REDACTION_RULES,
  MODEL_INPUT_LIMITS,
  buildModelPayload,
  buildPayloadWith,
  type ModelInput,
} from "../privacy.js";

const UUID = "a1000000-0000-4000-8000-0000000000a1";
const finding = (over: Record<string, unknown> = {}) => ({
  id: "f-1",
  title: "A finding",
  snippet: "text",
  ...over,
});
const input = (over: Record<string, unknown> = {}): ModelInput =>
  ({ task: { template: "reword-findings" }, findings: [finding()], ...over }) as ModelInput;
const withSnippet = (snippet: string) => input({ findings: [finding({ snippet })] });
/** The redaction rules on their own, with the character allowlist off: the second layer. */
const LAYER_TWO = { ...DEFAULT_PAYLOAD_PARTS, allowed: () => true };
function sent(i: unknown) {
  const r = buildPayloadWith(i, LAYER_TWO);
  if (!r.ok) throw new Error(`refused: ${r.reason} at ${r.path}`);
  return r;
}
const refusal = (i: unknown) => {
  const r = buildModelPayload(i);
  if (r.ok) throw new Error("the gate was expected to refuse");
  return r;
};
/** What a page text became on its way out: the snippet as the model would read it. */
const out = (snippet: string) =>
  (
    JSON.parse(sent(withSnippet(snippet)).payload.split("\n").at(-2)!) as {
      findings: { snippet: string }[];
    }
  ).findings[0]!.snippet;
const b64 = (t: string) => Buffer.from(t).toString("base64");

// Key-shaped test values are built from pieces so no key-looking literal sits in the repository.
const PROVIDER_KEYS: [string, string, string][] = [
  [
    "a project key",
    ["sk", "proj", "Ab3dEf6hJk9mNp2qRs5tUv8wXy1zBc4dFg7h"].join("-"),
    "Ab3dEf6hJk9m",
  ],
  [
    "an assistant-provider key",
    ["sk", "ant", "api03", "Zx9Cv8Bn7Mq6Wr5Et4Yu3Io2Pa1Sd0Fg9Hj8Kl7"].join("-"),
    "Zx9Cv8Bn7Mq6",
  ],
  ["a plain provider key", ["sk", "Zx9Cv8Bn7Mq6Wr5Et4Yu3Io2Pa1Sd0Fg"].join("-"), "Zx9Cv8Bn7Mq6"],
  [
    "a router key",
    ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-"),
    "0123456789abcdef0123",
  ],
  ["a Google key", ["AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"].join(""), "A1b2C3d4E5f6"],
  ["a chat token", ["xoxb", "1234567890", "abcdefghijkl"].join("-"), "1234567890"],
  [
    "a source host token",
    ["gh", "p_", "x9Y8z7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2"].join(""),
    "x9Y8z7W6v5U4",
  ],
  [
    "a source host fine-grained token",
    ["github", "pat", "11ABCDEFG0abcdefghij1234567890"].join("_"),
    "11ABCDEFG0abcdefghij",
  ],
  [
    "a source host group token",
    ["glpat", "abcdefghijklmnopqrst"].join("-"),
    "abcdefghijklmnopqrst",
  ],
  [
    "a package token",
    ["npm", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join(""),
    "a1B2c3D4e5F6",
  ],
  [
    "a mail key",
    ["SG", "abcdefghijklmnopqrstuv", "wxyz0123456789ABCDEFGH"].join("."),
    "abcdefghijklmnopqrstuv",
  ],
  ["a prefixed key", ["key", "0123456789abcdef0123456789abcdef"].join("-"), "0123456789abcdef0123"],
  ["a cloud access key", ["AKIA", "IOSFODNN7EXAMPLE"].join(""), "IOSFODNN7EXAMPLE"],
];

describe("model-provider and service keys", () => {
  it.each(PROVIDER_KEYS)("redacts %s, and counts it as a secret", (_, key, middle) => {
    const r = sent(withSnippet(`the script sets ${key} for the call`));
    expect(r.payload).not.toContain(middle);
    expect(r.payload).not.toContain(key);
    expect(r.record.redactions.secret).toBeGreaterThanOrEqual(1);
  });

  it("leaves ordinary hyphenated words alone", () => {
    expect(out("a task-list and a disk-image and key-value pairs")).toBe(
      "a task-list and a disk-image and key-value pairs",
    );
  });
});

describe("values hidden behind an encoding are decoded first, and the decoded text is what is sent", () => {
  const cases: [string, string, string][] = [
    ["an entity for a letter of a key", "&#65;KIAIOSFODNN7EXAMPLE", "IOSFODNN7EXAMPLE"],
    ["an entity for the equals sign", "password&#61;hunter2secret", "hunter2secret"],
    ["an entity with no semicolon", "password&#61hunter2secret", "hunter2secret"],
    ["a hex entity", "password&#x3D;hunter2secret", "hunter2secret"],
    ["a named entity", "password&equals;hunter2secret", "hunter2secret"],
    ["an entity for the at sign", "jane&#64;example.com", "jane"],
    ["a percent escape for the equals sign", "password%3Dhunter2secret", "hunter2secret"],
    ["a percent escape for the at sign", "jane%40example.com", "jane"],
    ["a token with a percent-escaped equals sign", "see /a?token%3Dabcdef123456789", "abcdef"],
    ["two layers of percent escapes", "password%253Dhunter2secret", "hunter2secret"],
    ["three layers of percent escapes", "password%25253Dhunter2secret", "hunter2secret"],
    ["an entity of an entity", "password&amp;#61;hunter2secret", "hunter2secret"],
    ["an entity split by a zero-width space", "&#6\u200b5;KIAIOSFODNN7EXAMPLE", "IOSFODNN7EXAMPLE"],
    ["JSON-escaped quotes", '\\"apiKey\\":\\"abcd1234efgh5678ijkl\\"', "abcd1234efgh5678ijkl"],
    ["a JSON unicode escape", "password\\u003dhunter2secret", "hunter2secret"],
    ["a JSON hex escape", "password\\x3dhunter2secret", "hunter2secret"],
    [
      "a percent-escaped zero-width space inside a key",
      "sk_live_qqqqqqqq%E2%80%8Bqqqqqqqq%E2%80%8Bqqqqqqqq",
      "qqqqqqqq",
    ],
  ];
  it.each(cases)("redacts %s", (_, text, value) => {
    const result = sent(withSnippet(text));
    expect(result.payload).not.toContain(value);
    expect(result.record.redactions.encoding).toBeGreaterThanOrEqual(1);
  });

  it("sends the decoded form, never the original, when decoding changed the text", () => {
    expect(out("50%25 off, AT&amp;T, a&#32;b")).toBe("50% off, AT&T, a b");
    expect(sent(withSnippet("plain text")).record.redactions.encoding).toBe(0);
  });

  it("refuses text still encoded after three layers, instead of trying to clean it", () => {
    const layered = (n: number) => {
      let t = "%3D";
      for (let i = 1; i < n; i++) t = t.replaceAll("%", "%25");
      return `password${t}hunter2secret`;
    };
    expect(out(layered(3))).not.toContain("hunter2secret");
    expect(refusal(withSnippet(layered(4)))).toMatchObject({
      reason: "bad-field",
      path: "findings.0.snippet",
    });
  });

  it("leaves a word that only looks like an entity or an escape as it is", () => {
    expect(out("R&D, Q&A, 100%, 5%of, a&b, \\d+ and \\w")).toBe(
      "R&D, Q&A, 100%, 5%of, a&b, \\d+ and \\w",
    );
  });
});

describe("the whole value goes, not its first word", () => {
  it.each([
    [
      "a phrase",
      "password = correct horse battery staple",
      ["horse", "battery", "staple", "correct"],
    ],
    ["a phrase after a colon", "secret: one two three four five six", ["one", "two", "six"]],
    ["a quoted value", 'password: "correct horse battery staple"', ["horse", "staple"]],
    ["a JSON value", '{"private_key_id": "a1b2c3d4e5f6a7b8c9d0e1f2"}', ["a1b2c3d4"]],
    ["a private key", '{"private_key": "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"}', ["MIIEvQ"]],
    ["a client secret", "client_secret=abc123def456ghi789 and more", ["abc123"]],
    ["an access key", 'accessKey = "AbCdEf123456"', ["AbCdEf"]],
    ["a secret key", "secret_key: s3cr3tvalue", ["s3cr3tvalue"]],
    ["an auth value", "auth=Zm9vOmJhcg==", ["Zm9vOmJhcg"]],
    ["an authorization header with a scheme", "Authorization: Bearer abc.def.ghi-jkl", ["abc.def"]],
    ["a password in a query", "go to /login?passwd=hunter2hunter2&next=/", ["hunter2"]],
    ["a pwd field", "pwd=hunter2hunter2", ["hunter2"]],
    ["a token field", 'token: "abcdef123456"', ["abcdef"]],
  ])("removes %s", (_, text, gone) => {
    const o = out(text);
    for (const g of gone) expect(o, o).not.toContain(g);
  });

  it("removes the value of an input field named like a credential, in either attribute order", () => {
    for (const html of [
      '<input value="hunter2long" name="password">',
      '<input name="password" value="hunter2long">',
      "<input type=password value=hunter2long>",
      "<input id=\"api_key\" value='hunter2long'>",
      '<textarea name="token" value="hunter2long">',
    ]) {
      const r = sent(
        withSnippet(
          html.replace(/^<input type=password/, '<input name=pass type=text name="password"'),
        ),
      );
      expect(r.payload, html).not.toContain("hunter2long");
      expect(r.record.redactions["credential-field"], html).toBeGreaterThanOrEqual(1);
    }
    expect(out('<input name="email" value="hunter2long">')).toContain("hunter2long");
  });

  it("stops at the end of the value: what follows a delimiter stays", () => {
    // A credential's value goes to the end of the line, and what follows it on the line goes with it.
    expect(out("token=abc123def456&page=2")).toBe("token=[redacted]");
    expect(out('{"token": "abc123def456", "page": 2}')).toBe('{"token": [redacted], "page": 2}');
  });
});

describe("page shapes that used to pass", () => {
  it.each([
    "<object data=x>",
    "<embed src=x>",
    "<frameset cols=1>",
    "<frame src=x>",
    '<meta http-equiv="refresh" content="0;url=x">',
    "<base href=x>",
    '<link rel="stylesheet" href=x>',
    "<form action=x>",
    '<input type="password">',
    "<img src=x onerror=alert(1)>",
    '<div onclick="x">',
    "<body onload=x>",
    "<APPLET code=x>",
  ])("refuses %s as a whole page", (snippet) => {
    expect(refusal(withSnippet(snippet)).reason).toBe("whole-page");
  });

  it("still lets one quoted image or link through", () => {
    expect(sent(withSnippet('<img src="/menu.png" alt="">')).ok).toBe(true);
    expect(sent(withSnippet('<a href="/menu">Menu</a>')).ok).toBe(true);
  });

  it("reads every Base64 run, not the first twenty: a page after many decoys is found", () => {
    const decoy = "QUJDREVGR0hJSktMTU5PUFFS";
    const decoys = Array.from({ length: 30 }, () => decoy).join(" ");
    expect(decoys.length).toBeLessThan(MODEL_INPUT_LIMITS.maxFieldRawChars - 100);
    const r = refusal(withSnippet(`${decoys} ${b64("<!doctype html><title>x</title>")}`));
    expect(r.reason).toBe("whole-page");
  });

  it("refuses Base64 that decodes to text with a tag in it, even a tag that is not a page element", () => {
    expect(refusal(withSnippet(b64("<b>hello there friend of the bakery</b>"))).reason).toBe(
      "whole-page",
    );
    expect(
      refusal(withSnippet(Buffer.from("<p>hello there friend of the bakery").toString("base64url")))
        .reason,
    ).toBe("whole-page");
  });

  it("does not take a long word, an id or ordinary Base64 text for a page", () => {
    expect(sent(withSnippet("internationalisation-configuration-for-the-menu-page")).ok).toBe(true);
    expect(sent(withSnippet(b64("the bakery opens at seven and closes at ten"))).ok).toBe(true);
    expect(sent(withSnippet(`${UUID}${UUID}`)).ok).toBe(true);
  });

  it("refuses a page that only the raw text shows: a value the redaction removed hid its tag", () => {
    const i = withSnippet('token="<html>secret value"');
    expect(refusal(i).reason).toBe("whole-page");
    // With the check on the raw text left out of the gate, the processed text is clean and goes out.
    const off = buildPayloadWith(i, {
      ...DEFAULT_PAYLOAD_PARTS,
      pageCheck: (t) =>
        DEFAULT_PAYLOAD_PARTS.pageCheck(t === 'token="<html>secret value"' ? "" : t),
    });
    expect(off.ok).toBe(true);
  });
});

describe("ids and look-alike letters: the guards that mutants used to survive", () => {
  it("counts extra ids toward the total, and allows only ten", () => {
    // 10 x (3 + 120 + 200) = 3,230 characters; ten UUIDs make 3,590, over the 3,500 total.
    const findings = Array.from({ length: 10 }, (_, k) => ({
      id: `f-${k}`,
      title: "t".repeat(120),
      snippet: "a".repeat(200),
    }));
    expect(sent(input({ findings })).ok).toBe(true);
    expect(sent(input({ findings, ids: Array.from({ length: 5 }, () => UUID) })).ok).toBe(true);
    expect(refusal(input({ findings, ids: Array.from({ length: 10 }, () => UUID) }))).toMatchObject(
      {
        reason: "too-large",
        path: "findings",
      },
    );
    expect(refusal(input({ ids: Array.from({ length: 11 }, () => UUID) })).reason).toBe(
      "too-many-findings",
    );
    expect(MODEL_INPUT_LIMITS.maxIds).toBe(10);
  });

  it("reads each look-alike letter in the table as its Latin letter inside a word", () => {
    for (const [char, latin] of LOOKALIKES) expect(out(`x${char}y`), char).toBe(`x${latin}y`);
  });

  it.each([
    ["password", "рassword"], // Cyrillic er for p
    ["password", "pаssword"], // Cyrillic a
    ["secret", "sеcret"], // Cyrillic e
    ["secret", "ѕecret"], // Cyrillic dze for s
    ["secret", "seсret"], // Cyrillic es for c
    ["token", "tоken"], // Cyrillic o
    ["token", "toкen"], // Cyrillic ka for k
    ["api_key", "аpi_key"],
    ["authorization", "authоrization"],
  ])("finds a credential name written as `%s` with a look-alike letter: %s", (_, written) => {
    const o = out(`${written}=hunter2hunter2`);
    expect(o).not.toContain("hunter2");
  });

  it("every look-alike used in a credential name is in the table", () => {
    const used = ["р", "а", "е", "ѕ", "с", "о", "к"].map((c) => c.codePointAt(0));
    const known = new Set([...LOOKALIKES.keys()].map((c) => c.codePointAt(0)));
    for (const cp of used) expect(known.has(cp), `U+${cp!.toString(16)}`).toBe(true);
  });

  it("rebuilds with a rule removed, and the encoding rule is the one that finds an entity", () => {
    const i = withSnippet("&#65;KIAIOSFODNN7EXAMPLE");
    const without = buildPayloadWith(i, {
      ...LAYER_TWO,
      redactions: DEFAULT_REDACTION_RULES.filter((r) => r.kind !== "encoding"),
    });
    expect(without.ok && without.payload).toContain("&#65;KIAIOSF");
    expect(sent(i).payload).not.toContain("KIAIOSFODNN7EXAMPLE");
  });
});
