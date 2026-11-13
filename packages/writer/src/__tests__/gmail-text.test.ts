/** N17 for an email body: plain text, line by line (gmail/text.ts). */
import { describe, expect, it } from "vitest";
import { mailBody } from "../gmail/text.js";

describe("mailBody", () => {
  it("keeps a line's leading spaces (a list the person indented) and blank lines", () => {
    expect(mailBody("Fixed:\n  - the drinks link\n    (menu page)\n\nSam")).toBe(
      "Fixed:\n  - the drinks link\n    (menu page)\n\nSam",
    );
  });

  it("turns every line ending into a plain newline", () => {
    expect(mailBody("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("cleans each line: bidi and tag characters go, zero-width characters inside a word are shown", () => {
    expect(mailBody("a \u202Eb\u202C \u{E0041}c\nzero\u200Bwidth")).toBe(
      "a b c\nzero\\u{200B}width",
    );
  });

  it("collapses runs of whitespace inside a line, as the sanitiser does", () => {
    expect(mailBody("a\tb")).toBe("a b");
  });
});
