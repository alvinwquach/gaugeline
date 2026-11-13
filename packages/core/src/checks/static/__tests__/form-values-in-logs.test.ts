import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import {
  expectNoneOf,
  fixtureTree,
  registered,
  runOne,
  spots,
  treeOf,
} from "./tokens-forms-helpers.js";

const ID = "form-values-in-logs";
const FAKE_EMAIL = ["ada.fake", "@", "example.test"].join("");
const FAKE_PHONE = ["+44 7700 ", "900123"].join("");

const flagged = async (code: string) =>
  (await runOne(ID, treeOf({ "a.ts": code }))).findings.map((f) => f.evidence);

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the action that logs the whole form and the email", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["app/contact/actions.ts:4", "app/contact/actions.ts:7"]);
      expect(result.findings.map((f) => f.evidence)).toEqual([
        "app/contact/actions.ts: console.log is given the whole form.",
        'app/contact/actions.ts: console.error is given the field "email".',
      ]);
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the action that logs a count and a status", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    const cases: [string, string, string][] = [
      [
        "console.log of a field",
        "export const f = (values) => console.log(values.email);",
        "console.log",
      ],
      [
        "console.warn of formData.get",
        'export const f = (formData: FormData) => console.warn("x", formData.get("phone"));',
        "console.warn",
      ],
      [
        "a logger",
        "export const f = (email: string) => logger.info({ email }, 'lead');",
        "logger.info",
      ],
      [
        "a request body",
        "export async function POST(request: Request) { console.log(await request.json()); }",
        "console.log",
      ],
      [
        "Sentry extra",
        "export const f = (e: unknown, values: object) => Sentry.captureException(e, { extra: { ...values } });\nconst onSubmit = 1;",
        "Sentry.captureException",
      ],
      ["Sentry.setUser with an email", "Sentry.setUser({ email: user.email });", "Sentry.setUser"],
      ["optional chaining on the logger", "log?.error('failed', { phone });", "log.error"],
    ];
    it.each(cases)("%s", async (_name, code, call) => {
      const out = await flagged(code);
      expect(out, code).toHaveLength(1);
      expect(out[0]).toContain(`${call} is given`);
    });
  });

  describe("what it leaves alone", () => {
    const quiet: [string, string][] = [
      ["an error object", "try { run(); } catch (err) { console.error(err); }"],
      ["a message that names the field", 'console.log("could not send the email to the kitchen");'],
      [
        "a message with a colon after the word",
        "console.error(`morning email: ${e.name} for one recipient`);",
      ],
      ["a status", "console.error('send failed', { status: res.status });"],
      ["a hashed value", "console.log('lead', hashEmail(values.email));"],
      ["Math.log", "const x = Math.log(values.email);"],
      ["a string literal in the personal key", "console.log({ email: 'redacted' });"],
      ["the whole form in a file that handles none", "console.log(values);"],
      ["a comment", "// console.log(values.email)\nexport {};"],
    ];
    it.each(quiet)("%s", async (_name, code) => {
      expect(await flagged(code)).toEqual([]);
    });
  });

  describe("not sure is not a pass", () => {
    it("no source is could-not-check", async () => {
      const result = await runOne(ID, treeOf({}));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
    });
    it("a truncated folder never passes", async () => {
      const result = await runOne(ID, treeOf({ "a.ts": "export {};" }, { truncated: true }));
      expect(result.passed).toEqual([]);
    });
  });

  it("never prints an email or phone it sees, in JSON, SARIF or the report", async () => {
    const result = await runOne(
      ID,
      treeOf({
        "a.ts": `const sample = { email: "${FAKE_EMAIL}", phone: "${FAKE_PHONE}" };\nexport function f(values: { email: string }) { console.log("lead ${FAKE_EMAIL}", values.email); }`,
      }),
    );
    expectNoneOf(result, [FAKE_EMAIL, FAKE_PHONE]);
  });
});
