/**
 * The pull request comment's text (ACTION-COMMENT part 2): what it holds, how page-derived words are made safe,
 * how long it can be, and what "new" means against main's baseline. Pure: the same input gives the same comment.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFindingsBaseline } from "../../config/baseline.js";
import { CHECKS_DOCS_BASE, checkDocsUrl } from "../../docs-url.js";
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

/* eslint-disable no-control-regex -- the point is to find control characters */
const UNSAFE_CHARACTERS =
  /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069\u{E0000}-\u{E007F}]/u;
/* eslint-enable no-control-regex */

const SAMPLE: Finding[] = [
  finding("menu-link-broken", "high", "The menu link gives a 404", "/menu"),
  finding("title-missing", "medium", "A page has no title", "/about"),
  finding("title-long", "medium", "A title is too long", "/"),
  finding("image-heavy", "low", "An image is very large", "/gallery"),
];

describe("what the comment holds", () => {
  it("counts by level, lists titles with their check ids and a docs link, and the exit state", () => {
    const text = buildPrComment({ findings: SAMPLE, exitCode: 1, failing: 1, couldNotCheck: 0 });
    expect(text).toContain("### Gaugeline: 4 findings");
    expect(text).toContain("| Fix this first | 1 |");
    expect(text).toContain("| Fix soon | 2 |");
    expect(text).toContain("| Worth knowing | 1 |");
    expect(text).toContain("- Fix this first: `The menu link gives a 404` (`menu-link-broken`)");
    expect(text).toContain("CLI exit code 1: 1 finding fails this run (--ci).");
  });

  it("is in order: level first, then check id, whatever order the findings arrive in", () => {
    const a = buildPrComment({ findings: SAMPLE, exitCode: 1, failing: 1, couldNotCheck: 0 });
    const b = buildPrComment({
      findings: [...SAMPLE].reverse(),
      exitCode: 1,
      failing: 1,
      couldNotCheck: 0,
    });
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
    const text = buildPrComment({ findings: [], exitCode: 0, failing: 0, couldNotCheck: 0 });
    expect(text).toContain("### Gaugeline: no findings");
    expect(text).toContain("CLI exit code 0.");
    expect(text).not.toContain("| Level |");
  });

  it("says how many checks could not run", () => {
    expect(buildPrComment({ findings: [], exitCode: 0, failing: 0, couldNotCheck: 2 })).toContain(
      "2 checks could not run.",
    );
    expect(buildPrComment({ findings: [], exitCode: 0, failing: 0, couldNotCheck: 1 })).toContain(
      "1 check could not run.",
    );
  });

  it("holds no address, evidence line or page text but the titles", () => {
    const text = buildPrComment({
      findings: [finding("a-check", "high", "A title", "/private/path", "SECRET-EVIDENCE-LINE")],
      exitCode: 1,
      failing: 1,
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
    const text = buildPrComment({
      findings: SAMPLE,
      baseline,
      exitCode: 1,
      failing: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain(
      "**Compared with the baseline file:** 2 new, 2 already in the baseline file.",
    );
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    // New first: the two the baseline lacks lead the list, then the known ones, each group by level.
    expect(lines.map((l) => /, new$/.test(l))).toEqual([true, true, false, false]);
  });

  it("counts how many of the new ones are 'Fix this first'", () => {
    const only = [...SAMPLE.slice(1), finding("new-high", "high", "Fresh problem")];
    const text = buildPrComment({
      findings: only,
      baseline,
      exitCode: 1,
      failing: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain(
      "**Compared with the baseline file:** 3 new (1 Fix this first), 1 already in the baseline file.",
    );
  });

  it("says nothing is new when everything is known", () => {
    const text = buildPrComment({
      findings: SAMPLE.slice(0, 2),
      baseline,
      exitCode: 1,
      failing: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain(
      "**Compared with the baseline file:** nothing new, 2 already in the baseline file.",
    );
    expect(text.match(/, new$/gm)).toBeNull();
  });

  it("matches by the one fingerprint the baseline uses: a new preview address or a count is not new", () => {
    const moved: Finding = {
      ...SAMPLE[0]!,
      url: "https://another-preview.example/menu",
      evidence: "menu-link-broken evidence",
    };
    expect(fingerprint(moved)).toBe(fingerprint(SAMPLE[0]!));
    const text = buildPrComment({
      findings: [moved],
      baseline,
      exitCode: 1,
      failing: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain("nothing new");
  });

  it("with no baseline says so, and never guesses what is new", () => {
    const text = buildPrComment({ findings: SAMPLE, exitCode: 1, failing: 1, couldNotCheck: 0 });
    expect(text).toContain(
      "**Compared with the baseline file:** no baseline file to compare with.",
    );
    expect(text).not.toMatch(/, new$/m);
    expect(text).not.toMatch(/\d+ new/);
  });

  it("an empty baseline makes every finding new", () => {
    const text = buildPrComment({
      findings: SAMPLE,
      baseline: buildFindingsBaseline([], NOW),
      exitCode: 1,
      failing: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain(
      "**Compared with the baseline file:** 4 new (1 Fix this first), 0 already in the baseline file.",
    );
  });

  it("counts the same finding once, however many pages it is on", () => {
    const twice = [SAMPLE[0]!, { ...SAMPLE[0]! }];
    const text = buildPrComment({
      findings: twice,
      baseline: buildFindingsBaseline([], NOW),
      exitCode: 1,
      failing: 1,
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
    const text = buildPrComment({ findings: many, exitCode: 1, failing: 3, couldNotCheck: 0 });
    expect(MAX_COMMENT_FINDINGS).toBe(10);
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(MAX_COMMENT_FINDINGS);
    expect(text).toContain("### Gaugeline: 500 findings");
    expect(text).toContain("| Fix this first | 167 |");
    expect(text).toContain("490 more");
    expect(text).toContain("CLI exit code 1: 3 findings fail this run (--ci).");
  });

  it("stays well under GitHub's limit of 65,536 characters, whatever the titles hold", () => {
    const wide = Array.from({ length: 200 }, (_, i) =>
      finding(`check-${i}`, "high", "\u{1F600}́".repeat(5000), `/p${i}`),
    );
    const text = buildPrComment({ findings: wide, exitCode: 1, failing: 1, couldNotCheck: 0 });
    expect(text.length).toBeLessThanOrEqual(MAX_PR_COMMENT_CHARS);
    expect(MAX_PR_COMMENT_CHARS).toBeLessThan(65_536 / 4);
    expect(Buffer.byteLength(text)).toBeLessThan(65_536);
  });

  it("cuts what is still too long at a line, with a plain note, and never leaves a code span open", () => {
    const line = (i: number) => `- Fix soon: \`${"t".repeat(300)}${i}\` (\`a-check\`)`;
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

  const IDS = [
    { id: "a-check", link: undefined },
    { id: "cms-token-in-client-code", link: checkDocsUrl("cms-token-in-client-code") },
  ];
  for (const { id, link } of IDS)
    for (const title of HOSTILE) {
      it(`${id}: ${JSON.stringify(title.slice(0, 36))} stays inside one code span, and nothing else is page text`, () => {
        const text = buildPrComment({
          findings: [finding(id, "high", title)],
          exitCode: 1,
          failing: 1,
          couldNotCheck: 0,
        });
        const rest = outsideCode(text);
        // Outside code spans there is no mention, no tag, no image, no raw address, no reference.
        expect(rest).not.toMatch(/@\w/);
        expect(rest).not.toMatch(/</);
        expect(rest).not.toContain("![");
        expect(rest).not.toMatch(/evil\.example/);
        expect(rest).not.toMatch(/(^|\s)#\d/);
        // The only link, if the check has a page in the repository, is that page, built from the one constant.
        expect(rest.match(/\]\(([^)]*)\)/g)).toEqual(link ? [`](${link})`] : null);
        // The title is one line in one code span: no newline, no control or bidirectional character.
        const line = text.split("\n").find((l) => l.startsWith("- "))!;
        expect(line).toMatch(
          link
            ? /^- Fix this first: `[^`\n]+` \(\[cms-token-in-client-code\]/
            : /^- Fix this first: `[^`\n]+` \(`a-check`\)$/,
        );
        expect(text).not.toMatch(UNSAFE_CHARACTERS);
      });
    }

  it("a hostile check id is not a link and is not trusted", () => {
    const text = buildPrComment({
      findings: [finding("x](https://evil.example) @everyone <b>", "high", "t")],
      exitCode: 1,
      failing: 1,
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
      failing: 0,
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
      failing: 0,
      couldNotCheck: 0,
    });
    expect(text).toContain("`(no title)`");
  });

  it("is the same text every time", () => {
    const input = { findings: SAMPLE, exitCode: 1 as const, failing: 1, couldNotCheck: 0 };
    expect(buildPrComment(input)).toBe(buildPrComment(input));
  });
});

describe("the links name no domain but github.com, from the one constant, and only to pages that exist", () => {
  const here = fileURLToPath(new URL("..", import.meta.url));
  const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
  const withPages: Finding[] = [
    finding(
      "cms-token-in-client-code",
      "high",
      "A content-system token is in code sent to the browser",
    ),
    finding("webhook-url-hardcoded", "high", "A webhook address is written into source", "/x"),
    finding("menu-link-broken", "medium", "The menu link gives a 404", "/menu"),
  ];
  const comment = buildPrComment({
    findings: withPages,
    exitCode: 1,
    failing: 2,
    couldNotCheck: 0,
  });

  it("links a check that has a page in the repository, and prints no link for one that has none", () => {
    expect(comment).toContain(
      `([cms-token-in-client-code](${checkDocsUrl("cms-token-in-client-code")}))`,
    );
    expect(comment).toContain(
      `([webhook-url-hardcoded](${checkDocsUrl("webhook-url-hardcoded")}))`,
    );
    expect(comment).toContain("(`menu-link-broken`)");
    expect(checkDocsUrl("menu-link-broken")).toBeUndefined();
  });

  it("every link starts with the docs base, the only host is github.com, and each linked page is a file in the repository", () => {
    const addresses = comment.match(/https?:\/\/[^\s)]+/g) ?? [];
    expect(addresses).toHaveLength(2);
    for (const a of addresses) {
      expect(a.startsWith(CHECKS_DOCS_BASE), a).toBe(true);
      expect(existsSync(join(repo, "docs", "checks", a.slice(CHECKS_DOCS_BASE.length))), a).toBe(
        true,
      );
    }
    expect(new Set(addresses.map((a) => new URL(a).host))).toEqual(new Set(["github.com"]));
    expect(comment).not.toMatch(/gaugeline\.[a-z]{2,}/i);
  });

  it("the base is written in docs-url.ts and nowhere else in the comment's code", () => {
    const base = "github.com/alvinwquach/gaugeline";
    const files = [
      ...readdirSync(here)
        .filter((n) => n.endsWith(".ts"))
        .map((n) => join(here, n)),
      fileURLToPath(new URL("../../docs-url.ts", import.meta.url)),
      fileURLToPath(new URL("../../../../cli/src/pr-comment.ts", import.meta.url)),
    ];
    const withBase = files.filter((f) => readFileSync(f, "utf8").includes(base));
    expect(withBase.map((f) => f.slice(f.lastIndexOf("/") + 1))).toEqual(["docs-url.ts"]);
    // And no domain of Gaugeline's own in any of them.
    for (const f of files)
      expect(readFileSync(f, "utf8"), f).not.toMatch(/gaugeline\.(dev|io|com|app)/);
  });
});

describe("the exit line says what the CLI decided, not a count of its own", () => {
  const known = buildFindingsBaseline(
    [finding("a-known", "high"), finding("b-known", "high"), finding("c-known", "high")],
    NOW,
  );
  const three = [
    finding("a-known", "high"),
    finding("b-known", "high"),
    finding("c-known", "high"),
    finding("d-new", "high"),
  ];

  it("three known 'Fix this first' findings and one new: one fails, as the CLI said", () => {
    const text = buildPrComment({
      findings: three,
      baseline: known,
      exitCode: 1,
      failing: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain("CLI exit code 1: 1 finding fails this run (--ci).");
    expect(text).not.toContain("4 findings fail");
  });

  it("a 'Fix soon' finding a config sets to block fails the run with no 'Fix this first' one", () => {
    const text = buildPrComment({
      findings: [finding("only-medium", "medium")],
      exitCode: 1,
      failing: 1,
      couldNotCheck: 0,
    });
    expect(text).toContain("CLI exit code 1: 1 finding fails this run (--ci).");
    expect(text).not.toContain("0 findings");
  });

  it("it says it is the CLI's exit code, so a stricter fail-on in the job never makes it false", () => {
    for (const exitCode of [0, 1] as const)
      expect(
        buildPrComment({ findings: three, exitCode, failing: exitCode, couldNotCheck: 0 }),
      ).toMatch(/^CLI exit code [01]/m);
  });
});
