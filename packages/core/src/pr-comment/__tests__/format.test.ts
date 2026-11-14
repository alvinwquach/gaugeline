/**
 * The pull request comment's text (ACTION-COMMENT part 2): what it holds, how page-derived words are made safe,
 * how long it can be, and what "new" means against main's baseline. Pure: the same input gives the same comment.
 */
import { describe, expect, it } from "vitest";
import { buildFindingsBaseline } from "../../config/baseline.js";
import { fingerprint } from "../../fingerprint.js";
import type { Finding, Severity } from "../../model.js";
import {
  MAX_COMMENT_FINDINGS,
  MAX_PR_COMMENT_CHARS,
  buildPrComment,
  capComment,
} from "../format.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const site = "https://brightside-pr-12.example";

function finding(
  id: string,
  severity: Severity,
  title = `Problem ${id}`,
  path = "/",
  evidence = `${id} evidence`,
): Finding {
  return { checkId: id, severity, title, evidence, url: `${site}${path}` };
}

/** Everything of the comment that is not inside a code span: the part page text must never reach. */
const outsideCode = (comment: string) => comment.replace(/`[^`\n]*`/g, "``");

const SAMPLE: Finding[] = [
  finding("menu-link-broken", "high", "The menu link gives a 404", "/menu"),
  finding("title-missing", "medium", "A page has no title", "/about"),
  finding("title-long", "medium", "A title is too long", "/"),
  finding("image-heavy", "low", "An image is very large", "/gallery"),
];

describe("what the comment holds", () => {
  it("counts by level, lists titles with their check ids and a docs link, and the exit state", () => {
    const text = buildPrComment({ findings: SAMPLE, exitCode: 1, couldNotCheck: 0 });
    expect(text).toContain("### Gaugeline: 4 findings");
    expect(text).toContain("| Fix this first | 1 |");
    expect(text).toContain("| Fix soon | 2 |");
    expect(text).toContain("| Worth knowing | 1 |");
    expect(text).toContain(
      "- Fix this first: `The menu link gives a 404` ([menu-link-broken](https://gaugeline.dev/docs/checks#menu-link-broken))",
    );
    expect(text).toContain('Exit code 1: 1 "Fix this first" finding fails this run (--ci).');
  });

  it("is in order: level first, then check id, whatever order the findings arrive in", () => {
    const a = buildPrComment({ findings: SAMPLE, exitCode: 1, couldNotCheck: 0 });
    const b = buildPrComment({ findings: [...SAMPLE].reverse(), exitCode: 1, couldNotCheck: 0 });
    expect(b).toBe(a);
    const order = [...a.matchAll(/^- [^:]+: `([^`]+)`/gm)].map((m) => m[1]);
    expect(order).toEqual([
      "The menu link gives a 404",
      "A title is too long",
      "A page has no title",
      "An image is very large",
    ]);
  });

  it("says no findings, and exit 0, for a clean run", () => {
    const text = buildPrComment({ findings: [], exitCode: 0, couldNotCheck: 0 });
    expect(text).toContain("### Gaugeline: no findings");
    expect(text).toContain("Exit code 0.");
    expect(text).not.toContain("| Level |");
  });

  it("says how many checks could not run", () => {
    expect(buildPrComment({ findings: [], exitCode: 0, couldNotCheck: 2 })).toContain(
      "2 checks could not run.",
    );
    expect(buildPrComment({ findings: [], exitCode: 0, couldNotCheck: 1 })).toContain(
      "1 check could not run.",
    );
  });

  it("holds no address, evidence line or page text but the titles", () => {
    const text = buildPrComment({
      findings: [finding("a-check", "high", "A title", "/private/path", "SECRET-EVIDENCE-LINE")],
      exitCode: 1,
      couldNotCheck: 0,
    });
    expect(text).not.toContain("SECRET-EVIDENCE-LINE");
    expect(text).not.toContain("brightside-pr-12.example");
    expect(text).not.toContain("/private/path");
  });
});

describe("new compared with main's baseline", () => {
  const baseline = buildFindingsBaseline(SAMPLE.slice(0, 2), NOW);

  it("counts the findings the baseline does not know, and says which are new", () => {
    const text = buildPrComment({ findings: SAMPLE, baseline, exitCode: 1, couldNotCheck: 0 });
    expect(text).toContain("**Compared with main:** 2 new, 2 already in main's baseline.");
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    // New first: the two the baseline lacks lead the list, then the known ones, each group by level.
    expect(lines.map((l) => /, new$/.test(l))).toEqual([true, true, false, false]);
  });

  it("counts how many of the new ones are 'Fix this first'", () => {
    const only = [...SAMPLE.slice(1), finding("new-high", "high", "Fresh problem")];
    const text = buildPrComment({ findings: only, baseline, exitCode: 1, couldNotCheck: 0 });
    expect(text).toContain(
      "**Compared with main:** 3 new (1 Fix this first), 1 already in main's baseline.",
    );
  });

  it("says nothing is new when everything is known", () => {
    const text = buildPrComment({
      findings: SAMPLE.slice(0, 2),
      baseline,
      exitCode: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain("**Compared with main:** nothing new, 2 already in main's baseline.");
    expect(text.match(/, new$/gm)).toBeNull();
  });

  it("matches by the one fingerprint the baseline uses: a new preview address or a count is not new", () => {
    const moved: Finding = {
      ...SAMPLE[0]!,
      url: "https://another-preview.example/menu",
      evidence: "menu-link-broken evidence",
    };
    expect(fingerprint(moved)).toBe(fingerprint(SAMPLE[0]!));
    const text = buildPrComment({ findings: [moved], baseline, exitCode: 1, couldNotCheck: 0 });
    expect(text).toContain("nothing new");
  });

  it("with no baseline says so, and never guesses what is new", () => {
    const text = buildPrComment({ findings: SAMPLE, exitCode: 1, couldNotCheck: 0 });
    expect(text).toContain("**Compared with main:** no baseline to compare with.");
    expect(text).not.toMatch(/, new$/m);
    expect(text).not.toMatch(/\d+ new/);
  });

  it("an empty baseline makes every finding new", () => {
    const text = buildPrComment({
      findings: SAMPLE,
      baseline: buildFindingsBaseline([], NOW),
      exitCode: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain(
      "**Compared with main:** 4 new (1 Fix this first), 0 already in main's baseline.",
    );
  });

  it("counts the same finding once, however many pages it is on", () => {
    const twice = [SAMPLE[0]!, { ...SAMPLE[0]! }];
    const text = buildPrComment({
      findings: twice,
      baseline: buildFindingsBaseline([], NOW),
      exitCode: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain("### Gaugeline: 1 finding\n");
    expect(text).toContain("1 new (1 Fix this first)");
  });
});

describe("a long list", () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    finding(`check-${String(i).padStart(3, "0")}`, i % 3 === 0 ? "high" : "low", `Title ${i}`),
  );

  it("lists at most the cap, says how many more, and keeps the counts whole", () => {
    const text = buildPrComment({ findings: many, exitCode: 1, couldNotCheck: 0 });
    expect(MAX_COMMENT_FINDINGS).toBe(10);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(MAX_COMMENT_FINDINGS);
    expect(text).toContain("### Gaugeline: 500 findings");
    expect(text).toContain("| Fix this first | 167 |");
    expect(text).toContain("490 more");
    expect(text).toContain('Exit code 1: 167 "Fix this first" findings fail this run (--ci).');
  });

  it("stays well under GitHub's limit of 65,536 characters, whatever the titles hold", () => {
    const wide = Array.from({ length: 200 }, (_, i) =>
      finding(`check-${i}`, "high", "\u{1F600}́".repeat(5000), `/p${i}`),
    );
    const text = buildPrComment({ findings: wide, exitCode: 1, couldNotCheck: 0 });
    expect(text.length).toBeLessThanOrEqual(MAX_PR_COMMENT_CHARS);
    expect(MAX_PR_COMMENT_CHARS).toBeLessThan(65_536 / 4);
    expect(Buffer.byteLength(text)).toBeLessThan(65_536);
  });

  it("cuts what is still too long at a line, with a plain note, and never leaves a code span open", () => {
    const line = (i: number) =>
      `- Fix soon: \`${"t".repeat(300)}${i}\` ([a-check](https://gaugeline.dev/docs/checks#a-check))`;
    const long = `### Gaugeline\n\n${Array.from({ length: 100 }, (_, i) => line(i)).join("\n")}\n`;
    const cut = capComment(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_PR_COMMENT_CHARS);
    expect(cut.endsWith("(cut to fit)\n")).toBe(true);
    expect(
      cut
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .every((l) => l.endsWith(")")),
    ).toBe(true);
    expect(capComment("short\n")).toBe("short\n");
    expect(capComment("x".repeat(100), 50).length).toBeLessThanOrEqual(50);
  });
});

describe("page-derived text is data, never markup", () => {
  const HOSTILE = [
    "@everyone look at this",
    "@octocat please review",
    "@org/team-name",
    "<script>alert(1)</script>",
    '<img src=x onerror="steal()">',
    "[click here](https://evil.example/phish)",
    "![tracker](https://evil.example/pixel.png)",
    "https://evil.example/autolink and www.evil.example",
    "#1234 closes owner/repo#5 fixes GH-9",
    "```\nfenced\n```\n# heading",
    "a `tick` and ``double`` and ` ",
    "line one\nline two\r\n- list\n> quote\n| a | b |",
    "‮RTL override‬ and zero​width and \u{E0041}tag",
    "\u001b[31mred\u001b[0m terminal escapes",
    "&lt;b&gt; &amp; entities &#64;everyone",
    "\\` backslash then tick \\",
    "Ünïcödé \u{1F9D1}‍\u{1F4BB} ".repeat(60),
  ];

  for (const title of HOSTILE) {
    it(`${JSON.stringify(title.slice(0, 36))} stays inside one code span, and nothing else is page text`, () => {
      const text = buildPrComment({
        findings: [finding("a-check", "high", title)],
        exitCode: 1,
        couldNotCheck: 0,
      });
      const rest = outsideCode(text);
      // Outside code spans there is no mention, no tag, no image, no raw address, no reference.
      expect(rest).not.toMatch(/@\w/);
      expect(rest).not.toMatch(/</);
      expect(rest).not.toContain("![");
      expect(rest).not.toMatch(/evil\.example/);
      expect(rest).not.toMatch(/(^|\s)#\d/);
      // The only link is the check's page on gaugeline.dev.
      expect(rest.match(/\]\(([^)]*)\)/g)).toEqual([
        "](https://gaugeline.dev/docs/checks#a-check)",
      ]);
      // The title is one line in one code span: no newline, no control or bidirectional character.
      const line = text.split("\n").find((l) => l.startsWith("- "))!;
      expect(line).toMatch(/^- Fix this first: `[^`\n]+` \(\[a-check\]/);
      // eslint-disable-next-line no-control-regex -- the point is to find control characters
      expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩\u{E0000}-\u{E007F}]/u);
    });
  }

  it("a hostile check id is not a link and is not trusted", () => {
    const text = buildPrComment({
      findings: [finding("x](https://evil.example) @everyone <b>", "high", "t")],
      exitCode: 1,
      couldNotCheck: 0,
    });
    const rest = outsideCode(text);
    expect(rest).not.toMatch(/evil\.example|@|</);
    expect(rest.match(/\]\(/g)).toBeNull();
  });

  it("a title the checks cut is cut at the title cap, and says so", () => {
    const text = buildPrComment({
      findings: [finding("a-check", "low", "word ".repeat(400))],
      exitCode: 0,
      couldNotCheck: 0,
    });
    const title = /`([^`]+)`/.exec(text.split("\n").find((l) => l.startsWith("- "))!)![1]!;
    expect([...title].length).toBeLessThanOrEqual(120);
    expect(title).toContain("[cut]");
  });

  it("an empty title still reads", () => {
    const text = buildPrComment({
      findings: [finding("a-check", "low", " \n ")],
      exitCode: 0,
      couldNotCheck: 0,
    });
    expect(text).toContain("`(no title)`");
  });

  it("is the same text every time", () => {
    const input = { findings: SAMPLE, exitCode: 1 as const, couldNotCheck: 0 };
    expect(buildPrComment(input)).toBe(buildPrComment(input));
  });
});
