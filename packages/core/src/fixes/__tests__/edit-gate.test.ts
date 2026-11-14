/**
 * The gate in front of every automatic image edit (PERF-04, final review): a lexer that guesses the context of an
 * `<img` keeps losing, so a diff is made only for a file where nothing needs guessing, and every other case is a
 * reason ("review by hand") and no diff. Each example the reviewers found is here, and each condition of the gate
 * has a case that fails without it.
 */
import { describe, expect, it } from "vitest";
import { isRefusal } from "../proposal.js";
import { REVIEW_BY_HAND, editGate } from "../edit-gate.js";
import { performanceProposals } from "../performance.js";

const SRC = "https://quillfeather.example/img/hero.jpg";
const LAZY = `The first large image, ${SRC}, is lazy-loaded, so the browser waits to fetch it: it is probably what the page's largest paint waits for.`;
const finding = { checkId: "perf-lcp-image", url: "https://quillfeather.example/", evidence: LAZY };
const TAG = `<img src='/img/hero.jpg' loading='lazy'>`;
const at = (text: string): number => text.toLowerCase().indexOf("<img");
const proposalsFor = (path: string, text: string) =>
  performanceProposals([{ path, text }], finding);

/** Every example: no proposal is made, whatever the scanner made of it. */
const EXAMPLES: Array<[string, string, string]> = [
  [
    "a string that ends in an escaped backslash (.tsx)",
    "A.tsx",
    `const s = "\\\\"; const t = "${TAG}";\n`,
  ],
  [
    "the same string with the tag on its own line (.tsx)",
    "A.tsx",
    `const s = "\\\\";\nconst t = "\n${TAG}";\n`,
  ],
  [
    "text with an apostrophe and a string holding the tag (.tsx)",
    "A.tsx",
    `const a = <p>it's {'${TAG}'}</p>;\n`,
  ],
  ["an MDX comment", "A.mdx", `{/* ${TAG} */}\n`],
  ["a JSX comment (.tsx)", "A.tsx", `const a = <div>\n{/*\n${TAG}\n*/}</div>;\n`],
  ["a line comment after code (.tsx)", "A.tsx", `const a=1;// ${TAG}\n`],
  ["a line comment on its own line (.jsx)", "A.jsx", `const a=1;\n// x\n${TAG}\n`],
  ["a Nunjucks comment", "a.njk", `{# ${TAG} #}\n`],
  ["a Nunjucks comment in an .html file", "a.html", `{# \n#}\n${TAG}\n`],
  ["a Handlebars comment", "a.hbs", `{{!-- ${TAG} --}}\n`],
  ["a Handlebars comment in an .html file", "a.html", `{{!-- x --}}\n${TAG}\n`],
  ["Markdown indented code", "a.md", `Text\n\n    ${TAG}\n`],
  ["Markdown double-backtick code", "a.md", "``\n" + TAG + "\n``\n"],
  ["Markdown fenced code in a quote", "a.md", "> ```html\n> " + TAG + "\n> ```\n"],
  ["a backtick before the tag in an .html file", "a.html", "<p>`</p>\n" + TAG + "\n"],
  [
    "a copy in a noscript, with a data-src image",
    "a.html",
    `<img data-src='/img/hero.jpg' loading='lazy'>\n<noscript>\n${TAG}\n</noscript>\n`,
  ],
  ["a noscript before the tag", "a.html", `<noscript><p>x</p></noscript>\n${TAG}\n`],
  ["a title before the tag", "a.html", `<title>A</title>\n${TAG}\n`],
  ["an xmp element", "a.html", `<xmp>\n</xmp>\n${TAG}\n`],
  ["an HTML comment", "a.html", `<!-- x -->\n${TAG}\n`],
  ["a comment that is closed on the tag's own line", "a.html", `<!--\n-->${TAG}\n`],
];

/** Pages that quote-counting passed and a browser reads differently: the element around the image is not an img. */
const hostilePages = (tag: string): Array<[string, string, string]> => [
  [
    "a quote hidden in an attribute spread over lines (.html)",
    "html",
    `<div title='"' data-a="\n${tag}\n">\n`,
  ],
  ["the same trick in .tsx", "tsx", `const a = (\n<div title='"' data-a="\n${tag}\n">\n);\n`],
  ["the same trick in .jsx", "jsx", `const a = (\n<div title='"' data-a="\n${tag}\n">\n);\n`],
  ["a bogus comment <?x", "html", `<?x\n${tag}\n>\n`],
  ["a bogus comment <!x", "html", `<!x\n${tag}\n>\n`],
  ["a bogus comment </ x", "html", `</ x\n${tag}\n>\n`],
  ["a bogus comment on one balanced line", "html", `<p><?x></p>\n${tag}\n`],
  ["a bogus declaration on one balanced line", "html", `<p><!x></p>\n${tag}\n`],
  ["a bogus end tag on one balanced line", "html", `<p></ x></p>\n${tag}\n`],
  ["an unclosed doctype", "html", `<!doctype html\n${tag}\n`],
  ["an unclosed attribute-less tag", "html", `<div class=x\n${tag}\n`],
  ["a tag left open at the end of a line (.tsx)", "tsx", `const a = (\n<Foo a={1}\n${tag}\n);\n`],
  ["an iframe", "html", `<iframe>\n${tag}\n</iframe>\n`],
  ["a noembed", "html", `<noembed>\n${tag}\n</noembed>\n`],
  ["a noframes", "html", `<noframes>\n${tag}\n</noframes>\n`],
  ["a plaintext", "html", `<plaintext>\n${tag}\n`],
  ["a select", "html", `<select>\n${tag}\n</select>\n`],
  ["an object", "html", `<object>\n${tag}\n</object>\n`],
  ["an embed", "html", `<embed>\n${tag}\n`],
  ["an applet", "html", `<applet>\n${tag}\n</applet>\n`],
  ["a frameset", "html", `<frameset>\n${tag}\n</frameset>\n`],
  ["a frame", "html", `<frame>\n${tag}\n`],
  ["an option", "html", `<option>\n${tag}\n`],
  ["an optgroup", "html", `<optgroup>\n${tag}\n`],
  ["a datalist", "html", `<datalist>\n${tag}\n`],
  ["a canvas", "html", `<canvas>\n${tag}\n</canvas>\n`],
  ["an audio element in capitals", "html", `<AUDIO>\n${tag}\n`],
  ["a video", "html", `<video>\n${tag}\n</video>\n`],
];

describe("the second review: markup the quote count passes but a browser reads differently", () => {
  it.each(hostilePages(TAG))("%s: review by hand, through propose", (_name, ext, text) => {
    const path = `src/a.${ext}`;
    const out = proposalsFor(path, text);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(isRefusal)).toBe(true);
    expect(editGate(text, path, at(text))).toBe(REVIEW_BY_HAND);
  });
  it("a plain page with the exact doctype line, balanced tags and arrows in .tsx still passes", () => {
    const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n</head>\n<body>\n<p>a</p><p>b</p>\n${TAG}\n`;
    expect(editGate(html, "a.html", at(html))).toBeUndefined();
    const tsx = `const f = (a: number) => a >= 1 && a <= 3;\nconst g = useState<string>("");\nexport const A = () => (\n<div>\n${TAG}\n</div>\n);\n`;
    expect(editGate(tsx, "A.tsx", at(tsx))).toBeUndefined();
  });
  it("a doctype that is not exactly `<!doctype html>` refuses", () => {
    for (const d of ["<!doctype html public>", "<!doctype>", "<!DOCTYPE html >", "<!-x>"]) {
      const text = `${d}\n${TAG}\n`;
      expect(editGate(text, "a.html", at(text)), d).toBeDefined();
    }
  });
  it("the bracket rule: each < closes on its own line, and a > must not come first", () => {
    for (const bad of ["<p", "a > b", "> <p", "<<p>", "<p>>", "<a href=x"]) {
      const text = `${bad}\n${TAG}\n`;
      expect(editGate(text, "a.html", at(text)), bad).toBeDefined();
    }
    for (const bad of ["x => <p", "a >= b <"]) {
      const text = `${bad}\n${TAG}\n`;
      expect(editGate(text, "A.tsx", at(text)), bad).toBeDefined();
    }
    // in .html an arrow is not an arrow: `=>` is a stray `>`; in .tsx it is removed first
    const arrow = `const f = () => 1;\n${TAG}\n`;
    expect(editGate(arrow, "A.tsx", at(arrow))).toBeUndefined();
    expect(editGate(arrow, "a.html", at(arrow))).toBeDefined();
  });
  it("bogus comment openers after the tag are not looked at", () => {
    const text = `${TAG}\n<?x <!y </ z\n<iframe>\n`;
    expect(editGate(text, "a.html", 0)).toBeUndefined();
  });
});

describe("every example the reviewers found gets a reason and no diff", () => {
  it.each(EXAMPLES)("%s", (_name, path, text) => {
    const out = proposalsFor(path, text);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(isRefusal)).toBe(true);
    if (at(text) >= 0) expect(editGate(text, path, at(text)), "the gate itself").toBeDefined();
  });
});

describe("what the gate says", () => {
  it("is the same sentence everywhere it is about the file's text, and names review by hand", () => {
    expect(editGate(`<!-- a -->\n${TAG}\n`, "a.html", 11)).toBe(REVIEW_BY_HAND);
    expect(REVIEW_BY_HAND).toMatch(/review by hand/);
    expect(editGate(`${TAG}\n`, "a.vue", 0)).toMatch(/review by hand/);
  });
});

describe("a file that is plain enough is edited", () => {
  const html = (before: string) =>
    `<!doctype html>\n<html>\n${before}<body>\n  ${TAG}\n</body>\n</html>\n`;
  it("a plain page, with a web address before the tag, passes", () => {
    const text = html(
      '<head>\n<link rel="stylesheet" href="https://cdn.example/a.css">\n<meta charset="utf-8">\n</head>\n',
    );
    expect(editGate(text, "index.html", at(text))).toBeUndefined();
    expect(proposalsFor("index.html", text).some((p) => !isRefusal(p))).toBe(true);
  });
  it("a plain component passes, with the tag at the start of its line", () => {
    const text = `import { x } from "./x";\nexport const A = () => (\n  <div>\n    <img src="/img/hero.jpg" loading="lazy" />\n  </div>\n);\n`;
    expect(editGate(text, "A.tsx", at(text))).toBeUndefined();
    expect(proposalsFor("A.tsx", text).some((p) => !isRefusal(p))).toBe(true);
  });
  it("a tab or spaces may come before the tag", () => {
    for (const lead of ["", " ", "\t", " \t  "]) {
      const text = `<main>\n${lead}${TAG}\n</main>\n`;
      expect(editGate(text, "a.htm", at(text))).toBeUndefined();
    }
  });
  it("the tag's own page (the one `<img`) may have its closing text and code after it, which is not looked at", () => {
    const text = `<main>\n${TAG}\n<p>it's here, and "that"</p>\n<script>// after\n</script>\n</main>\n`;
    expect(editGate(text, "a.html", at(text))).toBeUndefined();
  });
});

describe("each condition of the gate, alone", () => {
  const base = (before = "", img = TAG) => `<main>\n${before}${img}\n</main>\n`;
  it("(a) only .html, .htm, .tsx and .jsx; any case", () => {
    const text = base();
    for (const ok of ["a.html", "a.htm", "A.tsx", "A.jsx", "a.HTML", "src/a/b.TSX"])
      expect(editGate(text, ok, at(text)), ok).toBeUndefined();
    for (const no of [
      "a.vue",
      "a.astro",
      "a.svelte",
      "a.md",
      "a.mdx",
      "a.php",
      "a.njk",
      "a.hbs",
      "a.liquid",
      "a.ts",
      "a.js",
      "a.mjs",
      "a.mtsx",
      "a.html.txt",
      "html",
    ])
      expect(editGate(text, no, at(text)), no).toBeDefined();
  });
  it("(b) `<img` exactly once, in any case, anywhere in the file, before or after", () => {
    for (const other of ["<img>", "<IMG src=x>", "<Img", "<img-zoom>", "<imgx"]) {
      for (const text of [
        `${other}\n${TAG}\n`,
        `${TAG}\n${other}\n`,
        `<p>${other}</p>\n${TAG}\n`,
      ]) {
        const found = text.indexOf(TAG);
        expect(editGate(text, "a.html", found), text).toBeDefined();
      }
    }
    // the same text with a differently written tag name counts as the tag
    const upper = `<main>\n<IMG src='/img/hero.jpg' loading='lazy'>\n</main>\n`;
    expect(editGate(upper, "a.html", at(upper))).toBeUndefined();
  });
  it("(b) the index it is given must be the one `<img`", () => {
    const text = `<p>a</p>\n${TAG}\n`;
    expect(editGate(text, "a.html", 0)).toBeDefined();
    expect(editGate(text, "a.html", at(text) + 1)).toBeDefined();
  });
  it("(c) the tag starts its line: nothing but spaces and tabs before it", () => {
    for (const lead of ["<p>", "x", "{cond && ", "\u00a0", "\u3000", "  <b>"]) {
      const text = `<main>\n${lead}${TAG}\n</main>\n`;
      expect(editGate(text, "a.html", at(text)), JSON.stringify(lead)).toBeDefined();
    }
    const first = `${TAG}\n`;
    expect(editGate(first, "a.html", 0)).toBeUndefined();
    const crlf = `<main>\r\n  ${TAG}\r\n</main>\r\n`;
    expect(editGate(crlf, "a.html", at(crlf))).toBeUndefined();
  });
  it.each([
    "<!--",
    "/*",
    "*/",
    "{/*",
    "{#",
    "{{!",
    "`",
    "<script",
    "<SCRIPT",
    "<style",
    "<noscript",
    "<template",
    "<pre",
    "<code",
    "<xmp",
    "<title",
    "<textarea",
    "<svg",
    "<math",
    "<picture",
    "<Picture srcset=x>",
  ])("(d) %s before the tag refuses, in any case, in html and tsx", (opener) => {
    for (const path of ["a.html", "A.tsx"]) {
      const text = `<main>\n<p>${opener}</p>\n${TAG}\n</main>\n`;
      expect(editGate(text, path, at(text)), path).toBeDefined();
    }
  });
  it("(d) the same words after the tag are not looked at", () => {
    for (const opener of ["<!--", "/*", "`", "<script", "<title"]) {
      const text = `${TAG}\n<p>${opener}</p>\n`;
      expect(editGate(text, "a.html", 0), opener).toBeUndefined();
    }
  });
  it("(d) `//` before the tag refuses, unless it is inside a plain http or https address", () => {
    for (const bad of [
      "// c",
      "x //y",
      "ftp://a.example",
      "//cdn.example/a.js",
      "a:// b",
      "https:/ /x// y",
    ]) {
      const text = `<main>\n<p>${bad}</p>\n${TAG}\n`;
      expect(editGate(text, "a.html", at(text)), bad).toBeDefined();
    }
    for (const ok of ["https://a.example/x//y", "http://a.example", "HTTPS://A.EXAMPLE/p"]) {
      const text = `<main>\n<a href="${ok}">a</a>\n${TAG}\n`;
      expect(editGate(text, "a.html", at(text)), ok).toBeUndefined();
    }
    // a comment after an address is still a comment
    const text = `<main>\n<a href="https://a.example/x"></a> // c\n${TAG}\n`;
    expect(editGate(text, "a.html", at(text))).toBeDefined();
  });
  it("(d) an odd number of double or single quotes on a line before the tag refuses", () => {
    for (const bad of [
      "<p>it's</p>",
      '<p>5" wide</p>',
      '<p class="a" title=\'b></p>',
      '"',
      "'",
      "<p>'a' b'</p>",
    ]) {
      const text = `<main>\n${bad}\n${TAG}\n`;
      expect(editGate(text, "a.html", at(text)), bad).toBeDefined();
    }
    for (const ok of ["<p class=\"a\" id='b'>", "<p>'a' and \"b\"</p>", '<a href="x">']) {
      const text = `<main>\n${ok}\n${TAG}\n`;
      expect(editGate(text, "a.html", at(text)), ok).toBeUndefined();
    }
  });
  it("(d) any backslash before the tag refuses in .tsx and .jsx; in .html it is only text", () => {
    for (const path of ["A.tsx", "A.jsx", "a.TSX"]) {
      const text = `const a = 1; // no\nconst b = /\\d/;\n${TAG}\n`.replace("// no", "");
      expect(editGate(text, path, at(text)), path).toBeDefined();
    }
    const text = `<main>\n<p>C:\\temp</p>\n${TAG}\n`;
    expect(editGate(text, "a.html", at(text))).toBeUndefined();
  });
  it("a file over a megabyte is not edited", () => {
    const text = `${" ".repeat(1_000_001)}\n${TAG}\n`;
    expect(editGate(text, "a.html", at(text))).toBeDefined();
  });
  it("is linear: a hostile file of a megabyte is gated in well under a second", () => {
    const t = performance.now();
    for (const text of [
      `${"'".repeat(900_000)}\n${TAG}\n`,
      `${"<img ".repeat(150_000)}\n`,
      `${"http://a/".repeat(100_000)}\n${TAG}\n`,
      `${"a\n".repeat(400_000)}${TAG}\n`,
    ])
      editGate(text, "a.html", at(text));
    expect(performance.now() - t).toBeLessThan(1_000);
  });
});
