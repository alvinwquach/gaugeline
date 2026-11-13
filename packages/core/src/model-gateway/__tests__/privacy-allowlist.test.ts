/**
 * The privacy gate's design after the third review (AG-23): normalise first, decode second, normalise again,
 * and only then read the text; a title or snippet may hold only plain-word characters, and anything else is
 * withheld whole and not cleaned; the redaction rules are the second layer. Every input the review listed is
 * here, through the whole gate (the value must not go, whichever layer stops it) and through the rules on their
 * own (the allowlist off), so a rule cannot hide behind the allowlist. No network, no key, no clock.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAYLOAD_PARTS,
  DEFAULT_REDACTION_RULES,
  buildModelPayload,
  buildPayloadWith,
  type ModelInput,
} from "../privacy.js";
import { fieldAllowed, hidesEncodedText, normalise } from "../redaction.js";

const LAYER_TWO = { ...DEFAULT_PAYLOAD_PARTS, allowed: () => true };
const finding = (over: Record<string, unknown> = {}) => ({
  id: "f-1",
  severity: "high",
  title: "A finding",
  snippet: "text",
  ...over,
});
const input = (over: Record<string, unknown> = {}): ModelInput =>
  ({ task: { template: "reword-findings" }, findings: [finding()], ...over }) as ModelInput;
const withSnippet = (snippet: string) => input({ findings: [finding({ snippet })] });
const whole = (snippet: string) => {
  const r = buildModelPayload(withSnippet(snippet));
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};
const two = (snippet: string) => {
  const r = buildPayloadWith(withSnippet(snippet), LAYER_TWO);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};
const data = (payload: string) =>
  JSON.parse(payload.split("\n").at(-2)!) as { findings: Record<string, string>[] };

// Key-shaped test values are built from pieces so no key-looking literal sits in the repository.
const AWS_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const AWS_SECRET = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
const CYR_KHA = String.fromCodePoint(0x0445);
const fullwidth = (c: string) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0);
const utf7 = (t: string) =>
  `+${Buffer.from(t, "utf16le").swap16().toString("base64").replace(/=+$/, "")}-`;
const octal = (c: string) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`;

/** [what it is, the text, a value that must not be in what is sent]. */
const DISGUISED: [string, string, string][] = [
  ["a full-width percent sign", `password${fullwidth("%")}3Dhunter2secret`, "hunter2secret"],
  ["a full-width ampersand", `${fullwidth("&")}#65;KIAIOSFODNN7EXAMPLE`, "KIAIOSFODNN7EXAMPLE"],
  [
    "a Cyrillic letter in a hex entity",
    `&#${CYR_KHA}41;KIAIOSFODNN7EXAMPLE`,
    "KIAIOSFODNN7EXAMPLE",
  ],
  ["a combining mark in a percent escape", "password%3́Dhunter2secret", "hunter2secret"],
  ["a combining mark in a numeric entity", "&#6́5;KIAIOSFODNN7EXAMPLE", "KIAIOSFODNN7EXAMPLE"],
  ["a mark that a decode reveals", "&#65;́KIAIOSFODNN7EXAMPLE", "KIAIOSFODNN7EXAMPLE"],
  ["a named styled letter", "&Aopf;KIAIOSFODNN7EXAMPLE", "KIAIOSFODNN7EXAMPLE"],
  ["a named entity with no semicolon", "password&equalshunter2secret", "hunter2secret"],
  [
    "an entity for the ampersand with no semicolon",
    "password&amp#61;hunter2secret",
    "hunter2secret",
  ],
  ["a percent-u escape", "%u0041KIAIOSFODNN7EXAMPLE", "KIAIOSFODNN7EXAMPLE"],
  ["an octal escape", `${octal("A")}KIAIOSFODNN7EXAMPLE`, "KIAIOSFODNN7EXAMPLE"],
  ["a braced unicode escape", "\\u{41}KIAIOSFODNN7EXAMPLE", "KIAIOSFODNN7EXAMPLE"],
  ["a hex escape", "\\x41KIAIOSFODNN7EXAMPLE", "KIAIOSFODNN7EXAMPLE"],
  ["UTF-7", `${utf7("AKIAIOSFODNN7EXAMPLE")} here`, "KIAIOSFODNN7EXAMPLE"],
  [
    "Base64 of an assignment",
    Buffer.from("password=hunter2secret").toString("base64"),
    "cGFzc3dvcmQ9",
  ],
  [
    "hexadecimal of an assignment",
    Buffer.from("password=hunter2secret").toString("hex"),
    "70617373776f7264",
  ],
];

describe("what the review found: disguises are normalised and decoded before anything is read", () => {
  it.each(DISGUISED)("never sends %s, whichever layer stops it", (_, text, value) => {
    expect(whole(text).payload).not.toContain(value);
    expect(JSON.stringify(whole(text).record)).not.toContain(value);
  });

  it.each(DISGUISED.slice(0, 14))("the rules alone find %s", (_, text, value) => {
    const r = two(text);
    expect(r.payload).not.toContain(value);
    expect(
      r.record.redactions.encoding + r.record.redactions["hidden-characters"],
    ).toBeGreaterThanOrEqual(1);
  });

  it("withholds Base64 and hexadecimal that read as text, and leaves a word that only looks like Base64", () => {
    for (const t of [
      Buffer.from("password=hunter2secret").toString("base64"),
      Buffer.from("password=hunter2secret").toString("hex"),
    ]) {
      expect(hidesEncodedText(t)).toBe(true);
      expect(whole(t).record.withheld).toBe(1);
    }
    for (const t of [
      "internationalisation",
      "configuration-for-the-menu-page",
      "a1000000-0000-4000-8000-0000000000a1",
    ])
      expect(hidesEncodedText(t), t).toBe(false);
  });

  it("normalises, decodes, then normalises again: a decode can show a mark the first pass could not", () => {
    const first = normalise("&#65;́KIA");
    expect(first.text).toBe("&#65;KIA"); // the mark follows an ASCII character already
    const r = two("&#65;́KIAIOSFODNN7EXAMPLE");
    expect(r.payload).not.toContain("KIAIOSFODNN7EXAMPLE");
  });

  it("decodes entities with no semicolon the way a browser reads the old ones", () => {
    const encoding = DEFAULT_REDACTION_RULES.find((r) => r.kind === "encoding")!;
    expect(encoding.apply("AT&ampT").text).toBe("AT&T");
    expect(encoding.apply("a&ltb&gtc&quotd").text).toBe('a<b>c"d');
    expect(encoding.apply("a&amp;b").text).toBe("a&b");
    expect(encoding.apply("&Aopf;&afr;&Bscr;").text).toBe("AaB");
  });
});

describe("the allowlist of characters: markup and code are withheld, not cleaned", () => {
  it.each([..."=<>&%\\@{}[]|$~^"])(
    "withholds a snippet with %s in it, and still sends the finding",
    (ch) => {
      const r = whole(`a${ch}b`);
      const f = data(r.payload).findings[0]!;
      expect(f.snippet).toBe("[withheld]");
      expect(f).toMatchObject({ id: "f-1", severity: "high", title: "A finding" });
      expect(r.record.withheld).toBe(1);
    },
  );

  it("sends a snippet of plain words and the marks of ordinary writing, unchanged", () => {
    const plain = "a. b, c; d: e! f? g' h\" (i) j-k_l/m+n*o#p 123";
    const r = whole(plain);
    expect(data(r.payload).findings[0]!.snippet).toBe(plain);
    expect(r.record.withheld).toBe(0);
  });

  it("sends letters of any script, and puts a line break as a space", () => {
    for (const t of [
      "Меню открыто до девяти",
      "菜单已更新",
      "เมนูอัปเดตแล้ว",
      "line one\nline two",
    ])
      expect(whole(t).record.withheld, t).toBe(0);
    expect(data(whole("line one\nline two").payload).findings[0]!.snippet).toBe(
      "line one line two",
    );
  });

  it("withholds a symbol, an emoji and a dash outside the set", () => {
    for (const t of ["menu \u{1f600}", "menu — open", "50€"])
      expect(whole(t).record.withheld, t).toBe(1);
  });

  it("uses the same allowlist for a title", () => {
    const r = buildModelPayload(
      input({ findings: [finding({ title: "Fix <b>this</b> now", snippet: "ok" })] }),
    );
    expect(r.ok && data(r.payload).findings[0]!.title).toBe("[withheld]");
    expect(r.ok && r.record.withheld).toBe(1);
    const t2 = buildModelPayload(input({ findings: [finding({ title: "a=b", snippet: "x=y" })] }));
    expect(t2.ok && t2.record.withheld).toBe(2);
  });

  it("withholds a snippet whole: nothing of it is sent, not a cleaned part", () => {
    const r = whole("Call me at baker@example.test about the menu");
    expect(r.payload).not.toContain("Call me");
    expect(r.payload).not.toContain("menu");
    expect(r.payload).not.toContain("example");
  });

  it("refuses a page rather than withholding it: the page check runs first", () => {
    const r = buildModelPayload(withSnippet("<html><body>x</body></html>"));
    expect(r).toMatchObject({ ok: false, reason: "whole-page" });
  });

  it("is a character check only on what is left after normalising: an entity for a bracket is a bracket", () => {
    expect(fieldAllowed("a &lt; b")).toBe(false);
    expect(fieldAllowed("plain words")).toBe(true);
    expect(whole("a &#60; b").record.withheld).toBe(1);
  });

  it("leaves the redaction rules as the second layer: a phone, a card, an IBAN and a key on plain words still go", () => {
    const key = ["sk", "live", "q".repeat(24)].join("_");
    const text = `Call +44 20 7946 0958, card 4111 1111 1111 1111, key ${key}`;
    const r = whole(text);
    expect(r.payload).not.toContain("7946");
    expect(r.payload).not.toContain("4111");
    expect(r.payload).not.toContain("qqqqqqqq");
    expect(r.record.withheld).toBe(0);
    expect(r.record.redactions).toMatchObject({ phone: 1, card: 1, secret: 1 });
  });
});

describe("more shapes, as rules on their own and through the whole gate", () => {
  const cases: [string, string, string][] = [
    [
      "a PGP private key block",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF9abcdefghijklmnop\n-----END PGP PRIVATE KEY BLOCK-----",
      "lQOYBF9abcdef",
    ],
    ["a PHP array credential", "'password' => 'hunter2secret'", "hunter2secret"],
    ["a PHP config credential", "$cfg['db_password'] = 'hunter2secret';", "hunter2secret"],
    ["an env password line", "DB_PASS=hunter2secret", "hunter2secret"],
    ["an env key line", "MY_SERVICE_KEY=abcdef123456", "abcdef123456"],
    ["an env token line", "API_TOKEN: abcdef123456", "abcdef123456"],
    [
      "a seventh word after a credential name",
      "password: one two three four five six seven eight",
      "eight",
    ],
    [
      "a package index token",
      ["pypi", "AgEIcHlwaS5vcmcCJGFiY2RlZmdoaWprbG1ub3BxcnN0"].join("-"),
      "AgEIcHlwaS5vcmc",
    ],
    ["an access key id behind a prefix", `aws_${AWS_ID}`, "IOSFODNN7EXAMPLE"],
    ["an access key id with a character after it", `${AWS_ID}X`, "IOSFODNN7EXAMPLE"],
    ["a bare secret access key beside a key id", `${AWS_ID} and ${AWS_SECRET}`, "wJalrXUtnFEMI"],
    [
      "a chat webhook address",
      ["https://hooks.slack.com/services", "T0000000", "B0000000", "XXXXXXXXXXXXXXXXXXXXXXXX"].join(
        "/",
      ),
      "XXXXXXXXXXXX",
    ],
    [
      "a team-chat webhook address",
      ["https://discord.com/api/webhooks", "123456789012345678", "abcdefghijklmnopqrstuv"].join(
        "/",
      ),
      "abcdefghijklmnop",
    ],
  ];

  it.each(cases)("redacts %s", (_, text, value) => {
    const r = two(text);
    expect(r.payload).not.toContain(value);
    expect(Object.values(r.record.redactions).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    expect(whole(text).payload).not.toContain(value);
  });

  it("leaves a bare 40-character run alone when there is no access key id near it", () => {
    expect(two(AWS_SECRET).payload).toContain(AWS_SECRET);
  });

  it("has a rule for each of the shapes the review named that the allowlist passes", () => {
    // These pass the allowlist (plain words, digits, `-`, `_`, `/`, `.`, `:`), so only the rules stop them.
    for (const [, text, value] of cases.filter(([n]) => !/PHP|env|seventh|PGP/.test(n))) {
      expect(fieldAllowed(text), text).toBe(true);
      expect(whole(text).payload).not.toContain(value);
    }
  });
});

describe("the four rules whose removal went unnoticed", () => {
  it("redacts a Google key that the core rule does not know (31 characters, not 35)", () => {
    const key = ["AIza", "Sy1b2C3d4E5f6G7h8I9j0K1l2M3n4O5"].join("");
    const r = two(`the script sets ${key} for the map`);
    expect(r.payload).not.toContain("Sy1b2C3d4E5f6");
    expect(r.record.redactions.secret).toBe(1);
  });

  it.each([
    ["a model-hub key", ["hf", "Zx9Cv8Bn7Mq6Wr5Et4Yu3Io2Pa1Sd0Fg9H"].join("_")],
    ["an OAuth access token", ["ya29", "Zx9Cv8Bn7Mq6Wr5Et4Yu3Io2Pa1"].join(".")],
    ["a publishable payment key", ["pk", "live", "Zx9Cv8Bn7Mq6Wr5Et4Yu3Io2Pa"].join("_")],
    ["a prefixed key under 32 characters", ["key", "Zx9Cv8Bn7Mq6Wr5Et4Yu3Io2Pa"].join("-")],
  ])("redacts %s that no core rule knows", (_, key) => {
    const r = two(`it sets ${key} now`);
    expect(r.payload).not.toContain("Zx9Cv8Bn7Mq6");
    expect(r.record.redactions.secret).toBe(1);
  });

  it("finds a page after a Base64 run that is not text: the scan goes on, it does not stop", () => {
    const noise = Buffer.from(Array.from({ length: 24 }, (_, i) => 0xff - i)).toString("base64");
    const page = Buffer.from("<!doctype html><title>x</title>").toString("base64");
    expect(buildModelPayload(withSnippet(`${noise} ${page}`))).toMatchObject({
      ok: false,
      reason: "whole-page",
    });
    expect(buildModelPayload(withSnippet(`${noise} ${noise}`)).ok).toBe(true);
  });

  it("reads an ampersand entity with no semicolon (`&amp`) as the ampersand", () => {
    const r = two("AT&ampT and a&ampb");
    expect(JSON.stringify(data(r.payload).findings[0])).toContain("AT&T and a&b");
    expect(r.record.redactions.encoding).toBeGreaterThanOrEqual(1);
  });
});
