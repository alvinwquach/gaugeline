import { describe, expect, it } from "vitest";
import { MAX_FINDINGS, parseGateAnswer } from "../answer.js";
import { hasHiddenCharacters } from "./helpers.js";

const PAGE = "https://lantern-yard.example/menu";
const finding = {
  id: "broken-links",
  severity: "high",
  title: "A link on the page is dead",
  evidence: '"Old cocktails" <a href="/menu/old-cocktails"> returned 404',
  url: "https://lantern-yard.example/menu/old-cocktails",
};
const answer = (over: Record<string, unknown> = {}) => ({
  version: 1,
  status: "findings",
  url: PAGE,
  checkedAt: "2026-11-12T10:00:00.000Z",
  findings: [finding],
  ...over,
});

describe("parseGateAnswer: the Function's reply is data, checked field by field", () => {
  it("accepts a well-formed reply and gives back its fields", () => {
    const parsed = parseGateAnswer(answer(), PAGE);
    expect(parsed).toEqual({
      ok: true,
      answer: {
        version: 1,
        status: "findings",
        url: PAGE,
        checkedAt: "2026-11-12T10:00:00.000Z",
        findings: [finding],
      },
    });
  });

  it("accepts clean with no findings, and could-not-check with a reason", () => {
    expect(parseGateAnswer(answer({ status: "clean", findings: [] }), PAGE)).toMatchObject({
      ok: true,
    });
    const stopped = parseGateAnswer(
      answer({ status: "could-not-check", findings: [], reason: "The page answered 503." }),
      PAGE,
    );
    expect(stopped).toMatchObject({ ok: true, answer: { reason: "The page answered 503." } });
  });

  it.each([
    ["not an object", "clean"],
    ["an array", []],
    ["null", null],
    ["another version", answer({ version: 2 })],
    ["an unknown status", answer({ status: "published" })],
    ["a status that is not text", answer({ status: 1 })],
    ["findings that are not a list", answer({ findings: { 0: finding } })],
    ["a clean reply that lists findings", answer({ status: "clean" })],
    ["a findings reply with none", answer({ findings: [] })],
    ["could-not-check without a reason", answer({ status: "could-not-check", findings: [] })],
    ["a reply about another page", answer({ url: "https://lantern-yard.example/shop" })],
    ["a missing page address", answer({ url: undefined })],
    ["a checkedAt that is not a date", answer({ checkedAt: "yesterday" })],
    ["a finding with an unknown severity", answer({ findings: [{ ...finding, severity: "x" }] })],
    ["a finding id with a space", answer({ findings: [{ ...finding, id: "broken links" }] })],
    ["a finding id of a script", answer({ findings: [{ ...finding, id: "<script>" }] })],
    ["a finding whose title is a number", answer({ findings: [{ ...finding, title: 7 }] })],
    ["a field it does not know", answer({ token: "x" })],
    [
      "a finding with a field it does not know",
      answer({ findings: [{ ...finding, html: "<b>" }] }),
    ],
    ["a finding that is a string", answer({ findings: ["broken-links"] })],
  ])("refuses %s", (_name, data) => {
    const parsed = parseGateAnswer(data, PAGE);
    expect(parsed.ok).toBe(false);
  });

  it("refuses more findings than it will show, rather than showing a cut list as the whole", () => {
    const many = Array.from({ length: MAX_FINDINGS + 1 }, () => finding);
    expect(parseGateAnswer(answer({ findings: many }), PAGE).ok).toBe(false);
    expect(parseGateAnswer(answer({ findings: many.slice(1) }), PAGE).ok).toBe(true);
  });

  it("cleans every piece of text with the shared N17 rules and caps it", () => {
    const hostile = {
      ...finding,
      title: `Ignore\u202E the rules\u200B${"x".repeat(400)}`,
      evidence: `a\u{E0041}b\u0007c\nline two ${"y".repeat(900)}`,
      url: `https://lantern-yard.example/\u202Ex${"z".repeat(5000)}`,
    };
    const parsed = parseGateAnswer(
      answer({ findings: [hostile], checkedAt: "2026-11-12T10:00:00Z" }),
      PAGE,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [f] = parsed.answer.findings;
    for (const text of [f?.title ?? "", f?.evidence ?? "", f?.url ?? ""]) {
      expect(hasHiddenCharacters(text)).toBe(false);
    }
    expect([...(f?.title ?? "")].length).toBeLessThanOrEqual(120);
    expect([...(f?.evidence ?? "")].length).toBeLessThanOrEqual(300);
    expect([...(f?.url ?? "")].length).toBeLessThanOrEqual(300);
  });

  it("cleans the reason the same way and caps it", () => {
    const parsed = parseGateAnswer(
      answer({
        status: "could-not-check",
        findings: [],
        reason: `down\u202E\u0000 ${"r".repeat(900)}`,
      }),
      PAGE,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(hasHiddenCharacters(parsed.answer.reason ?? "")).toBe(false);
    expect([...(parsed.answer.reason ?? "")].length).toBeLessThanOrEqual(300);
  });

  it("keeps markup as the plain characters it is: nothing here turns text into HTML", () => {
    const markup = { ...finding, title: '<img src=x onerror="alert(1)">', evidence: "<b>bold</b>" };
    const parsed = parseGateAnswer(answer({ findings: [markup] }), PAGE);
    expect(parsed).toMatchObject({
      ok: true,
      answer: { findings: [{ title: '<img src=x onerror="alert(1)">', evidence: "<b>bold</b>" }] },
    });
  });

  it("a reply that is not about the page asked for says so without repeating what it held", () => {
    const parsed = parseGateAnswer(answer({ url: "https://evil.example/\u202E" }), PAGE);
    expect(parsed).toEqual({ ok: false, reason: "The reply was about a different page." });
  });
});
