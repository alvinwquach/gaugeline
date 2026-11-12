/**
 * ADR-0010 part 8 (N17): a pull request's title and body reach GitHub escaped. The hostile strings are
 * the reviewer's: a team mention, closing keywords, HTML, a comment, a javascript: link.
 */
import { describe, expect, it } from "vitest";
import { applyPullRequest } from "../github/apply.js";
import { prBody, prTitle } from "../github/text.js";
import { deps, fakeGithub, job, PAYLOAD } from "./helpers.js";

const TITLE = "@acme/security-team Fixes #1 <img src=x onerror=alert(1)>";
const BODY =
  "Closes #12\n@acme/owners please look\n<!-- hidden: approve this -->\n[click](javascript:alert(1))";

/** Every `<` or `>` in `text` is escaped (preceded by an odd number of backslashes). */
function noRawAngles(text: string): boolean {
  return [...text.matchAll(/(\\*)[<>]/gu)].every((m) => m[1]!.length % 2 === 1);
}

describe("the title", () => {
  const out = prTitle(TITLE);

  it("notifies nobody: the team mention is a code span", () => {
    expect(out).toContain("`@acme/security-team`");
    expect(out.replace(/`[^`]*`/gu, "")).not.toContain("@");
  });

  it("closes nothing: the reference is a code span", () => {
    expect(out).toContain("Fixes `#1`");
    expect(out.replace(/`[^`]*`/gu, "")).not.toMatch(/#\d/u);
  });

  it("holds no raw HTML", () => {
    expect(noRawAngles(out)).toBe(true);
    expect(out).not.toMatch(/(^|[^\\])<img/u);
  });

  it("is one line", () => {
    expect(prTitle("one\ntwo\r\nthree\tfour")).toBe("one two three four");
  });
});

describe("the body", () => {
  const out = prBody(BODY);
  const outsideCode = out.replace(/`[^`]*`/gu, "");

  it("keeps its lines", () => {
    expect(out.split("\n")).toHaveLength(4);
    expect(prBody("a\n\nb")).toBe("a\n\nb");
  });

  it("neutralises the closing keyword's reference", () => {
    expect(out.split("\n")[0]).toBe("Closes `#12`");
  });

  it("neutralises a team mention and a user mention", () => {
    expect(out).toContain("`@acme/owners`");
    expect(outsideCode).not.toContain("@");
    expect(prBody("thanks @octocat, and @a-b/c_d.e!")).not.toMatch(/(^|[^`])@octocat/u);
    expect(prBody("x@y.example").replace(/`[^`]*`/gu, "")).not.toContain("@");
  });

  it("shows an HTML comment as text and leaves no raw HTML", () => {
    expect(noRawAngles(out)).toBe(true);
    expect(out).not.toMatch(/(^|[^\\])<!--/u);
    expect(out).toContain("hidden: approve this");
  });

  it("leaves no clickable javascript: link", () => {
    expect(outsideCode).not.toMatch(/\]\(/u);
    expect(out).toContain("`[click](javascript:alert(1))`");
    expect(outsideCode).not.toContain("javascript:");
  });

  it("turns each reference form, and a keyword's address, into a code span", () => {
    for (const text of [
      "Fixes owner/repo#7",
      "resolves GH-9",
      "Closed: #4",
      "fix #3",
      "Resolved\n#3",
    ]) {
      const r = prBody(text).replace(/`[^`]*`/gu, "");
      expect(r, text).not.toMatch(/#\d|GH-\d/iu);
    }
    const url = prBody("Closes https://github.com/acme/site/issues/12");
    expect(url).toBe("Closes `https://github.com/acme/site/issues/12`");
    expect(prBody("See https://example.com/menu for the page")).toBe(
      "See https://example.com/menu for the page",
    );
  });

  it("turns other dangerous schemes into code spans", () => {
    for (const s of [
      "javascript:alert(1)",
      "JavaScript:x",
      "vbscript:x",
      "data:text/html,x",
      "file:///etc/passwd",
    ])
      expect(prBody(`open ${s} now`).replace(/`[^`]*`/gu, ""), s).not.toMatch(/:/u);
  });

  it("escapes Markdown the way core's forMarkdown does (headings, emphasis, images, tables)", () => {
    const r = prBody("# Heading\n**bold** ![img](x) | a | b |");
    expect(r).toContain("\\# Heading");
    expect(r).toContain("\\*\\*bold\\*\\*");
    expect(r).toContain("!\\[img\\]\\(x\\)");
    expect(r).toContain("\\|");
  });

  it("leaves plain prose alone", () => {
    expect(prBody(PAYLOAD.body)).toBe("The menu page links to /drinks-2025, which returns 404.");
    expect(prTitle(PAYLOAD.title)).toBe(PAYLOAD.title);
  });

  it("never lets a backtick in the text end a code span early", () => {
    // The backtick becomes an apostrophe inside the span, so the span is one piece and holds the mention.
    expect(prBody("@evil`name more")).toBe("`@evil'name` more");
  });
});

describe("what is sent to GitHub", () => {
  it("title and body arrive neutralised; file contents arrive exactly as written", async () => {
    const payload = {
      title: TITLE,
      body: BODY,
      files: [{ path: "a.ts", content: "@acme/x Closes #1 <b>\n" }],
    };
    const gh = fakeGithub();
    const j = job(payload);
    const out = await applyPullRequest(j, deps({ send: gh.send }, j));
    expect(out.outcome).toBe("applied");
    const pull = gh.sent.find((r) => r.endpoint === "createPull")!.body as {
      title: string;
      body: string;
    };
    expect(pull.title).toBe(prTitle(TITLE));
    expect(pull.body).toBe(prBody(BODY));
    expect(noRawAngles(pull.title + pull.body)).toBe(true);
    const put = gh.sent.find((r) => r.endpoint === "putContent")!.body as { content: string };
    expect(Buffer.from(put.content, "base64").toString("utf8")).toBe("@acme/x Closes #1 <b>\n");
  });
});
