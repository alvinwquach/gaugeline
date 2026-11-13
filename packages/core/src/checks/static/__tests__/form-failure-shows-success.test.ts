import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import { fixtureTree, registered, runOne, spots, treeOf } from "./tokens-forms-helpers.js";

const ID = "form-failure-shows-success";
const flagged = async (code: string) =>
  (await runOne(ID, treeOf({ "a.ts": code }))).findings.length;

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the action whose catch returns ok: true", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["app/enquiry/actions.ts:10"]);
      expect(result.findings[0]?.evidence).toBe(
        "app/enquiry/actions.ts: the send is in a try block, and its catch block reports success.",
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the action that returns the error and logs without the visitor's details", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    const send = "await resend.emails.send({ to, subject, html });";
    const cases: [string, string][] = [
      ["catch with no binding", `try { ${send} } catch { return { ok: true }; }`],
      [
        "catch with an error binding that is not used",
        `try { ${send} } catch (e) { return { success: true }; }`,
      ],
      [
        "a route handler",
        `export async function POST() { try { await transporter.sendMail(m); } catch (e) { return Response.json({ ok: true }); } }`,
      ],
      [
        "NextResponse.json",
        `try { ${send} } catch (e) { return NextResponse.json({ success: true }); }`,
      ],
      ["a redirect to a thank-you page", `try { ${send} } catch (e) { redirect("/thank-you"); }`],
      [
        "client state",
        `try { await fetch("/api/enquiry", { method: "POST", body }); } catch (e) { setSent(true); }`,
      ],
      ["a status of ok", `try { ${send} } catch { return { status: "ok" }; }`],
      [
        "a log that does not say it failed",
        `try { ${send} } catch (e) { console.error(e); return { ok: true }; }`,
      ],
    ];
    it.each(cases)("%s", async (_name, code) => {
      expect(await flagged(code), code).toBe(1);
    });
  });

  describe("what it leaves alone", () => {
    const send = "await resend.emails.send({ to, subject, html });";
    const quiet: [string, string][] = [
      ["a catch that returns the failure", `try { ${send} } catch { return { ok: false }; }`],
      ["a catch that throws", `try { ${send} } catch (e) { throw new Error("send failed"); }`],
      [
        "a catch that returns an error value",
        `try { ${send} } catch (e) { return { ok: true, error: "partly" }; }`,
      ],
      [
        "a catch that sets a 5xx",
        `try { ${send} } catch (e) { return Response.json({ ok: true }, { status: 502 }); }`,
      ],
      [
        "a catch that sets an error state",
        `try { ${send} } catch (e) { setError("failed"); setSent(true); }`,
      ],
      ["a try with no send", `try { await readMenu(); } catch { return { ok: true }; }`],
      [
        "a fetch that is not a post",
        `try { await fetch("/menu.json"); } catch { return { ok: true }; }`,
      ],
      [
        "a send whose success is after the try",
        `try { ${send} } catch (e) { report(e); }\nreturn { ok: true };`,
      ],
      ["the words in a comment", `// try { ${send} } catch { return { ok: true }; }\nexport {};`],
    ];
    it.each(quiet)("%s", async (_name, code) => {
      expect(await flagged(code), code).toBe(0);
    });
  });

  it("reports each handler once, at its catch", async () => {
    const code =
      "export async function a() {\n  try {\n    await resend.emails.send(m);\n  } catch {\n    return { ok: true };\n  }\n}\n";
    const result = await runOne(ID, treeOf({ "a.ts": code }));
    expect(spots(result)).toEqual(["a.ts:4"]);
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
        treeOf({ "a.ts": "export {};" }, { skipped: new Map([["b.ts", "unreadable"]]) }),
      );
      expect(result.passed).toEqual([]);
    });
  });
});
