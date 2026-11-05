import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectedOutput } from "../docs-output.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function docs(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-docs-"));
  temps.push(dir);
  writeFileSync(join(dir, "page.md"), text);
  return `${dir}/`;
}
const fence = "```";

describe("expectedOutput: unit", () => {
  it("returns the block under the named heading, without the fence lines", () => {
    const dir = docs(
      `# Page\n\n## Usage\n\nIntro.\n\n${fence}text title=Output\nline one\nline two\n${fence}\n`,
    );
    expect(expectedOutput("page", "Usage", dir)).toBe("line one\nline two");
  });

  it("two Output blocks under one heading: returns the first", () => {
    const dir = docs(
      `## Usage\n\n${fence}text title=Output\nfirst\n${fence}\n\n${fence}text title=Output\nsecond\n${fence}\n`,
    );
    expect(expectedOutput("page", "Usage", dir)).toBe("first");
  });

  it("trailing whitespace on lines is trimmed; blank lines inside the block are kept", () => {
    const dir = docs(`## Usage\n\n${fence}text title=Output\na   \n\nb\t\n${fence}\n`);
    expect(expectedOutput("page", "Usage", dir)).toBe("a\n\nb");
  });

  it("unknown slug or heading throws with the slug and heading in the message", () => {
    const dir = docs("## Usage\n");
    expect(() => expectedOutput("nope", "Usage", dir)).toThrow(/"nope".*"Usage"/);
    expect(() => expectedOutput("page", "Exit codes", dir)).toThrow(
      /page\.md has no heading "Exit codes"/,
    );
  });

  it("a block under a later heading is not used", () => {
    const dir = docs(
      `## Usage\n\nNo block here.\n\n## Other\n\n${fence}text title=Output\nother\n${fence}\n`,
    );
    expect(() => expectedOutput("page", "Usage", dir)).toThrow(/no Output block under "Usage"/);
  });
});

describe("expectedOutput: edge cases", () => {
  it("a docs block with CRLF line endings still compares as LF", () => {
    const dir = docs(`## Usage\r\n\r\n${fence}text title=Output\r\na\r\nb\r\n${fence}\r\n`);
    expect(expectedOutput("page", "Usage", dir)).toBe("a\nb");
  });

  it("a heading that appears twice on the page throws, asking for a more specific heading", () => {
    const dir = docs(`## Usage\n\n${fence}text title=Output\na\n${fence}\n\n## Usage\n`);
    expect(() => expectedOutput("page", "Usage", dir)).toThrow(
      /2 times; use a more specific heading/,
    );
  });

  it('a Terminal block: lines starting with "$" are the command and are excluded', () => {
    const dir = docs(
      `## Run\n\n${fence}sh title=Terminal\n$ npx gaugeline shop.example\nGaugeline checking shop.example\n\nNothing to look at.\n${fence}\n`,
    );
    expect(expectedOutput("page", "Run", dir)).toBe(
      "Gaugeline checking shop.example\n\nNothing to look at.",
    );
  });
});
