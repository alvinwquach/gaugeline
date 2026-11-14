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

const ID = "personal-data-in-analytics";
const FAKE_EMAIL = ["ada.fake", "@", "example.test"].join("");
const FAKE_PHONE = ["+44 7700 ", "900123"].join("");

const flagged = async (code: string, extra: Record<string, string> = {}) =>
  (await runOne(ID, treeOf({ "a.tsx": code, ...extra }))).findings.map((f) => f.evidence);

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the form that pushes the email and phone to the data layer", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["components/EnquiryForm.tsx:18"]);
      expect(result.findings[0]?.evidence).toBe(
        'components/EnquiryForm.tsx: dataLayer.push is given the field "email".',
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the form that pushes the event and the form's name", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    const cases: [string, string, string][] = [
      ["gtag with a user_data email", 'gtag("set", "user_data", { email: values.email });', "gtag"],
      ["a shorthand email", 'window.dataLayer.push({ event: "lead", email });', "dataLayer.push"],
      ["posthog.identify with the email as the id", "posthog.identify(email);", "posthog.identify"],
      [
        "mixpanel track with a phone member",
        'mixpanel.track("lead", { contact: form.phone });',
        "mixpanel.track",
      ],
      ["a quoted key", 'dataLayer.push({ "email": data.address });', "dataLayer.push"],
      ["formData.get", 'fbq("track", "Lead", { em: formData.get("email") });', "fbq"],
      [
        "camelCase and snake_case names",
        "analytics.track('x', { userEmail: u, contact_phone: p });",
        "analytics.track",
      ],
      [
        "the whole form, in a file that handles one",
        'const onSubmit = (values) => { posthog.capture("lead", values); };',
        "posthog.capture",
      ],
      [
        "a spread of the values",
        'const onSubmit = (values) => { dataLayer.push({ event: "lead", ...values }); };',
        "dataLayer.push",
      ],
      [
        "sendGTMEvent from @next/third-parties",
        'sendGTMEvent({ event: "lead", email: values.email });',
        "sendGTMEvent",
      ],
    ];
    it.each(cases)("%s", async (_name, code, call) => {
      const out = await flagged(code);
      expect(out, code).toHaveLength(1);
      expect(out[0]).toContain(`${call} is given`);
    });
  });

  describe("what it leaves alone", () => {
    const quiet: [string, string][] = [
      ["a literal in the personal key", 'dataLayer.push({ event: "lead", email: "redacted" });'],
      ["a hashed value", "dataLayer.push({ event: 'lead', email: sha256(values.email) });"],
      ["a masked value", "dataLayer.push({ event: 'lead', phone: maskPhone(values.phone) });"],
      ["an event name with the word in it", 'gtag("event", "email_signup", { method: "footer" });'],
      [
        "a label with a colon after the word",
        'dataLayer.push({ event: "lead", label: `email: ${kind}` });',
      ],
      ["a string that is the word", 'dataLayer.push({ event: "email" });'],
      [
        "a field that only ends like one",
        "dataLayer.push({ event: 'x', ipAddress: ip, hotel: h });",
      ],
      ["the whole form in a file that handles none", "posthog.capture('chart', values);"],
      ["a call that is not analytics", "db.insert({ email: values.email });"],
      ["a comment", "// dataLayer.push({ email });\nexport {};"],
    ];
    it.each(quiet)("%s", async (_name, code) => {
      expect(await flagged(code)).toEqual([]);
    });

    it("ignores test files", async () => {
      const result = await runOne(
        ID,
        treeOf({ "a.test.ts": "dataLayer.push({ email });", "b.ts": "export {};" }),
      );
      expect(result.passed).toEqual([ID]);
    });
  });

  it("reports one finding per call, with the line of the call", async () => {
    const result = await runOne(
      ID,
      treeOf({
        "a.ts":
          'export const a = 1;\n\ndataLayer.push({ email });\ngtag("event", "x", { phone });\n',
      }),
    );
    expect(spots(result)).toEqual(["a.ts:3", "a.ts:4"]);
  });

  describe("not sure is not a pass", () => {
    it("no source is could-not-check", async () => {
      const result = await runOne(ID, treeOf({}));
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
    });
    it("a source file left out is could-not-check", async () => {
      const result = await runOne(
        ID,
        treeOf({ "a.ts": "export {};" }, { skipped: new Map([["b.ts", "too-large"]]) }),
      );
      expect(result.passed).toEqual([]);
    });
  });

  it("never prints an email or phone it sees, in JSON, SARIF or the report", async () => {
    const result = await runOne(
      ID,
      treeOf({
        "a.tsx": `const sample = { email: "${FAKE_EMAIL}", phone: "${FAKE_PHONE}" };\nexport function f(values: { email: string }) { dataLayer.push({ event: "lead", email: values.email, copy: "${FAKE_EMAIL}" }); }`,
      }),
    );
    expectNoneOf(result, [FAKE_EMAIL, FAKE_PHONE]);
  });
});
