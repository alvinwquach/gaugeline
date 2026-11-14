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

const ID = "webhook-url-hardcoded";

// Built at run time: a literal shaped like a webhook address is refused by the repository's secret scanning.
const SECRET = ["T0FAKE", "FAKEFAKE0123", "fakeFAKEfake0123456789"];
const slack = (...tail: string[]): string =>
  ["https://hooks.slack", ".com/services/", tail.join("/")].join("");
const code = (url: string): string => `export const HOOK = "${url}";\n`;

describe(ID, () => {
  it("is in the static pack", () => expect(registered(ID)).toBe(true));

  describe("the two fixtures", () => {
    it("fails the folder with the address in a server action", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "fail"));
      expect(result.findings.length).toBeGreaterThan(0);
      expect(spots(result)).toEqual(["app/enquiry/actions.ts:4"]);
      expect(result.findings[0]?.evidence).toBe(
        "app/enquiry/actions.ts: a webhook address is written in the source.",
      );
      expect(parseResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    it("passes the folder that reads it from the environment", async () => {
      const result = await runOne(ID, await fixtureTree(ID, "pass"));
      expect(result.passed).toEqual([ID]);
    });

    it("never prints the address, its path or its secret, in JSON, SARIF or the report", async () => {
      const tree = await fixtureTree(ID, "fail");
      const result = await runOne(ID, tree);
      expectNoneOf(result, [
        "k3f9a2b7c1d4e8f60a5b",
        "hooks.example.test/webhooks",
        "https://hooks.example.test",
      ]);
    });
  });

  describe("the services it knows", () => {
    const cases: [string, string, string][] = [
      ["Slack", slack(...SECRET), "a Slack incoming webhook"],
      [
        "Discord",
        ["https://discord", ".com/api/webhooks/", "123456789012345678/", SECRET[2]].join(""),
        "a Discord webhook",
      ],
      [
        "Teams",
        `https://acme.webhook.office.com/webhookb2/${SECRET[1]}@${SECRET[2]}/IncomingWebhook/${SECRET[2]}`,
        "a Microsoft Teams webhook",
      ],
      ["Zapier", `https://hooks.zapier.com/hooks/catch/1234567/${SECRET[1]}/`, "a Zapier webhook"],
      ["Make", `https://hook.eu1.make.com/${SECRET[2]}`, "a Make webhook"],
      ["IFTTT", `https://maker.ifttt.com/trigger/order/with/key/${SECRET[2]}`, "an IFTTT webhook"],
      ["n8n", `https://acme.app.n8n.cloud/webhook/${SECRET[2]}`, "an n8n webhook"],
      ["Pipedream", "https://en9fakefake01.m.pipedream.net", "a Pipedream webhook"],
      [
        "Google Chat",
        `https://chat.googleapis.com/v1/spaces/AAAAfake/messages?key=${SECRET[1]}`,
        "a Google Chat webhook",
      ],
      [
        "a generic /webhooks/ path",
        `https://automation.example.test/webhooks/${SECRET[2]}`,
        "a webhook",
      ],
    ];
    it.each(cases)("%s", async (_name, url, label) => {
      const result = await runOne(ID, treeOf({ "app/send.ts": code(url) }));
      expect(
        result.findings.map((f) => f.evidence),
        url.slice(0, 24),
      ).toEqual([`app/send.ts: ${label} address is written in the source.`]);
      expectNoneOf(result, [...SECRET, url]);
    });
  });

  describe("what it leaves alone", () => {
    const quiet: [string, Record<string, string>][] = [
      ["a URL built from an environment variable", { "a.ts": "const u = process.env.HOOK_URL;" }],
      ["a base address with no secret part", { "a.ts": code("https://hooks.slack.com/services/") }],
      [
        "a placeholder",
        { "a.ts": code(slack("T00000000", "B00000000", "XXXXXXXXXXXXXXXXXXXXXXXX")) },
      ],
      [
        "a path with a template variable",
        { "a.ts": "const u = `https://hooks.slack.com/services/${a}/${b}/${c}`;" },
      ],
      ["an address in a comment", { "a.ts": `// ${slack(...SECRET)}\nexport {};` }],
      ["an address in a test file", { "a.test.ts": code(slack(...SECRET)), "b.ts": "export {};" }],
      [
        "a readable path on the site itself",
        { "a.ts": code("https://shop.example/api/webhooks/stripe-checkout-handler-endpoint") },
      ],
      ["a README", { "README.md": slack(...SECRET), "a.ts": "export {};" }],
    ];
    it.each(quiet)("%s", async (_name, files) => {
      const result = await runOne(ID, treeOf(files));
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual([ID]);
    });
  });

  it("reads a CI workflow too, and skips a YAML comment", async () => {
    const result = await runOne(
      ID,
      treeOf({
        "a.ts": "export {};",
        ".github/workflows/notify.yml": `# old: ${slack(...SECRET)}\njobs:\n  n:\n    steps:\n      - run: curl -d x ${slack(...SECRET)}\n`,
      }),
    );
    expect(spots(result)).toEqual([".github/workflows/notify.yml:5"]);
    expectNoneOf(result, SECRET);
  });

  describe("not sure is not a pass", () => {
    it("no source file is could-not-check", async () => {
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
      expect(result.couldNotCheck.map((c) => c.id)).toEqual([ID]);
    });
  });
});
