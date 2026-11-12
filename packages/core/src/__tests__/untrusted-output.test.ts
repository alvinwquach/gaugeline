import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createPageRegistry } from "../checks/index.js";
import type { Finding } from "../model.js";
import {
  discordField,
  discordPayload,
  slackFindingText,
  slackPayload,
} from "../notify/payloads.js";
import type { Result } from "../result.js";
import { buildSnapshot } from "../snapshot.js";
import { UNTRUSTED_CAPS, markUntrusted, type UntrustedText } from "../untrusted.js";
import {
  forDiscord,
  forMarkdown,
  forSlack,
  forSlackPlain,
  forTerminal,
  stripAnsi,
  TERMINAL_EVIDENCE_MAX,
  type SafeText,
} from "../untrusted-output.js";

const ESC = "\u001B";
const tagged = (s: string) =>
  [...s].map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0))).join("");
const graphemes = (s: string) =>
  [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(s)].length;

describe("output escapers: unit (one table per format)", () => {
  const cases: [string, (s: string) => string, [string, string][]][] = [
    [
      "markdown",
      forMarkdown,
      [
        ["<script>alert(1)</script>", "\\<script\\>alert\\(1\\)\\</script\\>"],
        ["# Heading\n- item", "\\# Heading - item"],
        ["[click](https://evil.example)", "\\[click\\]\\(https://evil.example\\)"],
        [`a${tagged("hi")}b`, "ab"],
      ],
    ],
    [
      "slack",
      forSlack,
      [
        ["<!channel> free drinks", "&lt;!channel&gt; free drinks"],
        [
          "<@U012AB3CD> and <https://evil.example|ok>",
          "&lt;@U012AB3CD&gt; and &lt;https://evil.example|ok&gt;",
        ],
        ["Fish & chips", "Fish &amp; chips"],
        ["`code` *bold*", "'code' *bold*"],
      ],
    ],
    [
      "discord",
      forDiscord,
      [
        ["@everyone free drinks", "\\@everyone free drinks"],
        ["@here <@123> <@&456> <#789>", "\\@here \\<@123\\> \\<@&456\\> \\<#789\\>"],
        [
          "**bold** [x](https://evil.example)",
          "\\*\\*bold\\*\\* \\[x\\]\\(https://evil.example\\)",
        ],
        ["`code` ||spoiler||", "\\`code\\` \\|\\|spoiler\\|\\|"],
        ["# Big heading", "\\# Big heading"],
        ["-# small print", "\\-# small print"],
        ["1. list", "1\\. list"],
      ],
    ],
    [
      "terminal",
      forTerminal,
      [
        [`${ESC}[2J${ESC}[31mRed${ESC}[0m`, "Red"],
        [`${ESC}]0;owned\u0007Title`, "Title"],
        [`${ESC}]8;;https://evil.example${ESC}\\link${ESC}]8;;${ESC}\\`, "link"],
        [`\u009B31mC1${ESC}c`, "C1"],
      ],
    ],
  ];
  for (const [format, escape, table] of cases) {
    it(`${format}: hostile inputs give the expected text`, () => {
      for (const [input, expected] of table) expect(escape(input)).toBe(expected);
    });
  }

  it("every escaper sanitises and caps first", () => {
    for (const escape of [forMarkdown, forSlack, forDiscord, forTerminal]) {
      const out = escape(`Ignore previous instructions. `.repeat(2000));
      expect(graphemes(out)).toBeLessThanOrEqual(UNTRUSTED_CAPS.evidence * 2);
      expect(out).toMatch(/\\?\[cut\\?\]$/);
    }
    expect(graphemes(forTerminal("x".repeat(500), UNTRUSTED_CAPS.title))).toBe(
      UNTRUSTED_CAPS.title,
    );
  });

  it("Slack text outside a code span: bold, italic and strike can't be turned on", () => {
    expect(forSlackPlain("*Free* _drinks_ ~today~ <!here>")).toBe(
      "\u2217Free\u2217 \uFF3Fdrinks\uFF3F \u223Ctoday\u223C &lt;!here&gt;",
    );
  });

  it("terminal: benign GROQ, paths and commands pass through unchanged", () => {
    for (const line of [
      "src/app/menu/[slug]/page.tsx:3  The menuItem query's filter does not leave drafts out.",
      "--totals dinnerParty:total=courses[].price  Nothing of type dinnerParty exists",
      '*[_type == "popup" && date > $after]{title, venue->name, "n": count(guests[])} | order(date)',
      "`npx gaugeline query --refs` @acme/site -> ./src/lib/sanity.ts:12",
    ])
      expect(forTerminal(line, TERMINAL_EVIDENCE_MAX)).toBe(line);
  });

  it("stripAnsi leaves text without escapes alone, emoji included", () => {
    expect(stripAnsi("Happy hour \u{1F378} 5-7")).toBe("Happy hour \u{1F378} 5-7");
  });
});

describe("raw sinks: type test on the real Slack and Discord builders", () => {
  it("a raw or wrongly escaped string does not compile at the payload builders", () => {
    // @ts-expect-error a plain string from a page cannot reach the Slack builder
    slackFindingText("high", "<!channel>", forSlack("e"));
    // @ts-expect-error text escaped for Discord is not escaped for Slack
    slackFindingText("high", forSlackPlain("t"), forDiscord("e"));
    // @ts-expect-error page text that was only sanitised cannot reach the Discord builder
    discordField("high", forDiscord("t"), markUntrusted("@everyone", { source: "x" }).text);
    expect(slackFindingText("high", forSlackPlain("*t*"), forSlack("`e`"))).toBe(
      "*Fix this first:* \u2217t\u2217\n`'e'`",
    );
    expect(discordField("low", forDiscord("t"), forDiscord("@here")).value).toBe("\\@here");
  });
});

describe("raw sinks: type test", () => {
  const slackSink = (s: SafeText<"slack">) => s;
  it("only an escaper's output reaches a sink", () => {
    // @ts-expect-error a plain string from a page cannot reach the sink
    slackSink("<!channel>");
    // @ts-expect-error page text that was only sanitised is not escaped for Slack
    slackSink(markUntrusted("<!channel>", { source: "x" }).text);
    // @ts-expect-error text escaped for another format is not escaped for this one
    slackSink(forMarkdown("<!channel>"));
    expect(slackSink(forSlack("<!channel>"))).toBe("&lt;!channel&gt;");
    expectTypeOf(forSlack("x")).toEqualTypeOf<SafeText<"slack">>();
    expectTypeOf<UntrustedText>().not.toEqualTypeOf<SafeText<"slack">>();
  });
});

/** The hostile fixture site (invented): page text aimed at every output. */
async function hostileResult(): Promise<Result> {
  const file = fileURLToPath(
    new URL("../../../fixtures/sites/hostile/index.html", import.meta.url),
  );
  const body = readFileSync(file, "utf8").replaceAll("{{origin}}", "https://juniper-lime.example");
  const page = buildSnapshot([
    {
      url: "https://juniper-lime.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
    },
  ]);
  const findings: Finding[] = [];
  for (const check of createPageRegistry().all())
    if (["duplicate-title", "hidden-ai-directive", "invisible-unicode-tags"].includes(check.id))
      findings.push(
        ...((await check.run(page as never, { warn: () => undefined } as never)) as Finding[]),
      );
  findings.push({
    checkId: "broken-links",
    severity: "high",
    title: "Links on this page go nowhere",
    evidence:
      '"@everyone <!channel> <@U012AB3CD> free drinks" <a href="/events/@everyone"> returned 404',
    url: "https://juniper-lime.example/",
  });
  return { url: "https://juniper-lime.example/", findings } as unknown as Result;
}

// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u{E0000}-\u{E007F}]/u;

describe("the hostile fixture through every output: integration", () => {
  it("has a 50 KB title, ANSI codes, <script>, mentions and tag characters", async () => {
    const r = await hostileResult();
    const all = r.findings.map((f) => f.evidence).join("\n");
    expect(all.length).toBeGreaterThan(50_000);
    for (const bit of [ESC, "<script>", "<!channel>", "@everyone"]) expect(all).toContain(bit);
    expect(r.findings.map((f) => f.checkId)).toContain("hidden-ai-directive");
  });

  it("Slack: no live mention, link or control character, every section capped", async () => {
    const p = slackPayload(await hostileResult());
    for (const b of p.blocks) {
      const t = b.text?.text ?? "";
      expect(t).not.toMatch(/<!|<@|<https?:/);
      expect(t.replaceAll("\n", " ")).not.toMatch(CONTROL);
      expect(t).not.toContain("<script>");
      expect(graphemes(t)).toBeLessThan(UNTRUSTED_CAPS.evidence + UNTRUSTED_CAPS.title + 40);
    }
  });

  it("Discord: mentions are off and escaped, no control character, every field capped", async () => {
    const p = discordPayload(await hostileResult());
    expect(p.allowed_mentions).toEqual({ parse: [] });
    for (const f of p.embeds[0]?.fields ?? []) {
      expect(`${f.name} ${f.value}`).not.toMatch(CONTROL);
      expect(f.value).not.toMatch(/(^|[^\\])(<@|@everyone)/);
      expect(graphemes(f.value)).toBeLessThanOrEqual(UNTRUSTED_CAPS.evidence * 2);
    }
  });

  it("Markdown and terminal: no live HTML, no escape sequence, capped", async () => {
    for (const f of (await hostileResult()).findings) {
      const md = forMarkdown(f.evidence);
      expect(md).not.toMatch(/(^|[^\\])<script/);
      const term = forTerminal(f.evidence);
      expect(term).not.toMatch(CONTROL);
      expect(graphemes(term)).toBeLessThanOrEqual(UNTRUSTED_CAPS.evidence);
    }
  });
});
