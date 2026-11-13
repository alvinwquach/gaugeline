import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRefusal } from "../proposal.js";
import { fixRedirect, redirectProposal, type RepoFile } from "../redirect.js";

const FIX = fileURLToPath(new URL("../../../../fixtures/fix-proposals/", import.meta.url));
const fixture = (name: string) => readFileSync(`${FIX}${name}`, "utf8");
const req = { from: "/old-poetry", to: "/poetry" };
const netlify = (text: string, path = "public/_redirects"): RepoFile[] => [{ path, text }];
const vercel = (text: string, path = "vercel.json"): RepoFile[] => [{ path, text }];
const after = (files: RepoFile[], r = req) => {
  const out = fixRedirect(files, r);
  if (isRefusal(out)) throw new Error(`expected a change, got: ${out.refused}`);
  return out.after;
};
const refused = (files: RepoFile[], r = req) => {
  const out = fixRedirect(files, r);
  if (!isRefusal(out)) throw new Error("expected a refusal");
  return out.refused;
};

describe("a missing redirect: a Netlify _redirects file", () => {
  it("adds one rule in the file's own column style (the fixture, tab separated)", () => {
    expect(after(netlify(fixture("lantern-books/public/_redirects")))).toBe(
      "# Old addresses from the previous site\n/old-fiction\t/fiction\t301\n/fiction-old\t/fiction\t301\n/old-poetry\t/poetry\t301\n",
    );
  });
  it("keeps aligned columns aligned", () => {
    const text = "/old-a        /a         301\n/old-bb       /bb        301\n";
    expect(after(netlify(text))).toBe(`${text}/old-poetry   /poetry    301\n`);
  });
  it("uses the file's single space, and a Windows file keeps its CRLF", () => {
    expect(after(netlify("/a /b 301\n"))).toBe("/a /b 301\n/old-poetry /poetry 301\n");
    expect(after(netlify("# x\r\n/a /b 301\r\n"))).toBe(
      "# x\r\n/a /b 301\r\n/old-poetry /poetry 301\r\n",
    );
  });
  it("hand-reformatted: blank lines, comments between rules, trailing spaces, no final newline", () => {
    const text = "# redirects\n\n/a   /b   301!   \n\n# more\n/c\t/d\n\n\n";
    expect(after(netlify(text))).toBe(
      "# redirects\n\n/a   /b   301!   \n\n# more\n/c\t/d\n/old-poetry\t/poetry\t301\n\n\n",
    );
    expect(after(netlify("/a /b"))).toBe("/a /b\n/old-poetry /poetry 301");
  });
  it("an empty or comment-only file gets the rule after its comments", () => {
    expect(after(netlify(""))).toBe("/old-poetry /poetry 301\n");
    expect(after(netlify("# nothing yet\n"))).toBe("# nothing yet\n/old-poetry /poetry 301\n");
  });
  it("finds the file in the publish folder, not in node_modules or a build folder", () => {
    const files = [
      { path: "node_modules/x/_redirects", text: "/a /b\n" },
      { path: "dist/_redirects", text: "/a /b\n" },
      { path: "static/_redirects", text: "/a /b\n" },
    ];
    const out = fixRedirect(files, req);
    expect(isRefusal(out) ? out.refused : out.path).toBe("static/_redirects");
  });
});

describe("a missing redirect: a vercel.json", () => {
  it("adds an entry after the last one on the same line, in the one-line style of the fixture", () => {
    expect(after(vercel(fixture("cedar-bar/vercel.json")))).toBe(
      '{\n  "cleanUrls": true,\n  "redirects": [{ "source": "/menu-2024", "destination": "/menu", "statusCode": 301 }, { "source": "/old-poetry", "destination": "/poetry", "statusCode": 301 }]\n}\n',
    );
  });
  it("hand-reformatted: tabs, four spaces, expanded objects, compact one-liners", () => {
    const entry = (i: string, n: string) =>
      `{\n${i}${i}${i}"source": "/x",\n${i}${i}${i}"destination": "/y"\n${i}${i}}`.replace(
        /\n/g,
        n,
      );
    for (const [unit, eol] of [
      ["\t", "\n"],
      ["    ", "\n"],
      ["  ", "\r\n"],
    ] as const) {
      const text = `{${eol}${unit}"redirects": [${eol}${unit}${unit}${entry(unit, eol)}${eol}${unit}]${eol}}${eol}`;
      const out = after(vercel(text));
      expect(JSON.parse(out).redirects).toEqual([
        { source: "/x", destination: "/y" },
        { source: "/old-poetry", destination: "/poetry", statusCode: 301 },
      ]);
      expect(out.startsWith(text.slice(0, text.lastIndexOf(`${eol}${unit}]`)))).toBe(true);
      expect(out).toContain(
        `,${eol}${unit}${unit}{${eol}${unit}${unit}${unit}"source": "/old-poetry"`,
      );
    }
    const compact = '{"redirects":[{"source":"/x","destination":"/y"}]}';
    expect(after(vercel(compact))).toBe(
      '{"redirects":[{"source":"/x","destination":"/y"},{"source":"/old-poetry","destination":"/poetry","statusCode":301}]}',
    );
  });
  it("an empty redirects list, and no redirects key at all", () => {
    expect(after(vercel('{\n  "redirects": []\n}\n'))).toBe(
      '{\n  "redirects": [\n    { "source": "/old-poetry", "destination": "/poetry", "statusCode": 301 }\n  ]\n}\n',
    );
    expect(after(vercel('{\n  "cleanUrls": true\n}\n'))).toBe(
      '{\n  "cleanUrls": true,\n  "redirects": [\n    { "source": "/old-poetry", "destination": "/poetry", "statusCode": 301 }\n  ]\n}\n',
    );
    expect(JSON.parse(after(vercel("{}\n")))).toEqual({
      redirects: [{ source: "/old-poetry", destination: "/poetry", statusCode: 301 }],
    });
  });
  it("leaves every other value exactly as it was", () => {
    const text =
      '{\n  "headers": [{"source": "/(.*)", "headers": []}],\n  "redirects": [\n    {"source": "/x", "destination": "/y", "permanent": true}\n  ],\n  "trailingSlash": false\n}\n';
    const out = JSON.parse(after(vercel(text)));
    expect(out.headers).toEqual(JSON.parse(text).headers);
    expect(out.trailingSlash).toBe(false);
    expect(out.redirects).toHaveLength(2);
  });
});

describe("a fixer that is not certain makes no proposal", () => {
  it("there is no redirect config, or more than one", () => {
    expect(refused([{ path: "README.md", text: "x" }])).toMatch(/no redirect file/);
    expect(refused([...netlify("/a /b\n"), ...vercel("{}")])).toMatch(/more than one/);
    expect(refused([...netlify("/a /b\n"), ...netlify("/a /b\n", "static/_redirects")])).toMatch(
      /more than one/,
    );
  });
  it("the old address already has a rule (same letters or not, slash or not)", () => {
    expect(refused(netlify("/old-poetry /elsewhere 301\n"))).toMatch(/already has a rule/);
    expect(refused(netlify("/Old-Poetry/ /elsewhere 301\n"))).toMatch(/already has a rule/);
    expect(refused(vercel('{"redirects":[{"source":"/old-poetry","destination":"/z"}]}'))).toMatch(
      /already has a rule/,
    );
  });
  it("an earlier pattern could take the address first", () => {
    expect(refused(netlify("/old-*  /archive/:splat  301\n"))).toMatch(/pattern/);
    expect(refused(netlify("/:section  /home  301\n"))).toMatch(/pattern/);
    expect(refused(vercel('{"redirects":[{"source":"/old-:slug","destination":"/z"}]}'))).toMatch(
      /pattern/,
    );
    expect(refused(vercel('{"redirects":[{"source":"/(.*)","destination":"/z"}]}'))).toMatch(
      /pattern/,
    );
  });
  it("a line or a file it cannot read exactly", () => {
    expect(refused(netlify("/a\n"))).toMatch(/could not read/);
    expect(refused(vercel("{ // comment\n}"))).toMatch(/not valid JSON/);
    expect(refused(vercel('{"redirects": {"a": 1}}'))).toMatch(/not a list/);
    expect(refused(vercel('{"redirects": [{"destination": "/y"}]}'))).toMatch(/source/);
    expect(refused(vercel('[{"source": "/a"}]'))).toMatch(/not an object/);
  });
  it("an address it cannot write exactly", () => {
    for (const bad of [
      { from: "/a b", to: "/poetry" },
      { from: "/a?x=1", to: "/poetry" },
      { from: "/a*", to: "/poetry" },
      { from: "old", to: "/poetry" },
      { from: "/a", to: "/a" },
      { from: "/a", to: "poetry" },
      { from: "/a", to: "/b c" },
      { from: "/a\n/b", to: "/c" },
    ])
      expect(isRefusal(fixRedirect(netlify("/x /y\n"), bad)), JSON.stringify(bad)).toBe(true);
  });
  it("the old address still answers: a config rule may not take over, so no proposal", () => {
    const finding = {
      checkId: "plan-redirect-missing",
      url: "plan.csv",
      evidence: "/old-about still returns 200: it doesn't redirect",
    };
    const out = redirectProposal(netlify("/a /b\n"), finding, { from: "/old-about", to: "/about" });
    expect(isRefusal(out) ? out.refused : "").toMatch(/still serves a page/);
  });
});

describe("a redirect proposal", () => {
  const finding = {
    checkId: "plan-redirect-missing",
    url: "plan.csv",
    evidence: "/old-poetry returns 404: nothing redirects it",
  };
  it("names the finding, the file, the diff and the re-check, and is the same twice", () => {
    const files = netlify(fixture("lantern-books/public/_redirects"));
    const a = redirectProposal(files, finding, req, "studio/lantern-books");
    const b = redirectProposal(files, finding, req, "studio/lantern-books");
    expect(isRefusal(a)).toBe(false);
    expect(b).toEqual(a);
    if (isRefusal(a)) return;
    expect(a.target).toEqual({ repository: "studio/lantern-books", path: "public/_redirects" });
    expect(a.change.diff).toContain("+/old-poetry\t/poetry\t301\n");
    expect(a.recheck.checkId).toBe("plan-redirect-missing");
    expect(a.summary).toBe("Redirect /old-poetry to /poetry");
  });
});
