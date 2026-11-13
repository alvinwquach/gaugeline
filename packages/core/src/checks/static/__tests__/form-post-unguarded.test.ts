import { describe, expect, it } from "vitest";
import { parseResult } from "../../../result.js";
import { fixtureTree, registered, runOne, spots, treeOf } from "./tokens-forms-helpers.js";

const ID = "form-post-unguarded";
const route = (body: string, path = "app/api/enquiry/route.ts") => treeOf({ [path]: body });
const POST =
  "export async function POST(request: Request) {\n  const form = await request.formData();\n  return Response.json({ n: form.size });\n}\n";

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the route that takes the form with no guard", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(spots(result)).toEqual(["app/api/enquiry/route.ts:1"]);
      expect(result.findings[0]?.evidence).toBe(
        "app/api/enquiry/route.ts: POST reads a submission and has no origin check, honeypot or token.",
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the route that checks the origin and a honeypot", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  describe("what it finds", () => {
    it("a const POST that reads json", async () => {
      const result = await runOne(
        ID,
        route(
          "export const POST = async (req: Request) => { const b = await req.json(); return Response.json(b); };",
        ),
      );
      expect(result.findings).toHaveLength(1);
    });
    it("a Pages Router API route that reads req.body", async () => {
      const result = await runOne(
        ID,
        route(
          'export default function handler(req, res) {\n  if (req.method === "POST") res.json(req.body);\n}\n',
          "pages/api/contact.ts",
        ),
      );
      expect(spots(result)).toEqual(["pages/api/contact.ts:2"]);
    });
  });

  describe("what it leaves alone", () => {
    const guards: [string, string][] = [
      ["an origin header", 'const o = request.headers.get("origin");'],
      ["a referer header", 'const o = request.headers.get("referer");'],
      ["a honeypot", 'if (form.get("_gotcha")) return new Response(null);'],
      ["Turnstile", "await verifyTurnstile(token);"],
      ["a CSRF token", "checkCsrf(request);"],
      ["a signature", "verifySignature(body, sig);"],
      ["a session", "const session = await getServerSession();"],
    ];
    it.each(guards)("%s", async (_name, guard) => {
      const result = await runOne(ID, route(POST.replace("return", `${guard}\n  return`)));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });

    it("a route with no POST", async () => {
      expect(
        (
          await runOne(
            ID,
            route(
              "export async function GET(request: Request) { return Response.json(await request.json()); }",
            ),
          )
        ).passed,
      ).toEqual([ID]);
    });
    it("a POST that reads no body", async () => {
      expect(
        (
          await runOne(
            ID,
            route("export async function POST() { return Response.json({ ok: true }); }"),
          )
        ).passed,
      ).toEqual([ID]);
    });
    it("a webhook, a cron job and a revalidation route by their paths", async () => {
      for (const path of [
        "app/api/webhooks/sanity/route.ts",
        "app/api/cron/route.ts",
        "app/api/revalidate/route.ts",
      ])
        expect((await runOne(ID, route(POST, path))).passed, path).toEqual([ID]);
    });
    it("a Server Action: Next compares its Origin with the host", async () => {
      const result = await runOne(
        ID,
        treeOf({
          "app/a/actions.ts":
            '"use server";\nexport async function send(formData: FormData) { return formData.get("a"); }',
        }),
      );
      expect(result.passed).toEqual([ID]);
    });
    it("a comment that names a guard", async () => {
      const result = await runOne(ID, route(`// TODO check the origin\n${POST}`));
      expect(result.findings).toHaveLength(1);
    });
  });

  describe("not sure is not a pass", () => {
    it("a middleware that mentions the origin makes the finding could-not-check", async () => {
      const tree = treeOf({
        "app/api/enquiry/route.ts": POST,
        "middleware.ts":
          'export function middleware(req) { return req.headers.get("origin") === "x" ? undefined : new Response(null, { status: 403 }); }',
      });
      const result = await runOne(ID, tree);
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.couldNotCheck[0]?.reason).toMatch(/middleware or proxy file/);
    });
    it("a middleware that says nothing about it changes nothing", async () => {
      const tree = treeOf({
        "app/api/enquiry/route.ts": POST,
        "middleware.ts": "export function middleware() {}",
      });
      expect((await runOne(ID, tree)).findings).toHaveLength(1);
    });
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
});
