import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORDPRESS_CHECKS } from "../../checks/wordpress.js";
import { copperLanternChecks } from "../../wordpress/__tests__/docs-example.js";
import { adaptersConfigSchema } from "../config.js";
import { WORDPRESS_COUNT_CAP, WORDPRESS_DESCRIPTION, WORDPRESS_ENV_VARS } from "../wordpress.js";
import { COPPER_LANTERN_SETTINGS, copperLanternReads } from "./wordpress-docs-example.js";
import { CONTENT_MARKERS } from "./wordpress-fixture.js";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, root)), "utf8").replace(/\r\n/g, "\n");
const page = read("docs/integrations/wordpress.md");
const blocks = (info: string): string[] =>
  [...page.matchAll(new RegExp("```" + info + "\\n([\\s\\S]*?)\\n```", "g"))].map(
    (m) => m[1] ?? "",
  );

describe("docs/integrations/wordpress.md", () => {
  it("the settings file it shows is valid and is the one the example reads with", () => {
    const [shown] = blocks("json title=gaugeline\\.adapters\\.json");
    expect(adaptersConfigSchema.parse(JSON.parse(shown ?? "null"))).toEqual({
      adapters: [COPPER_LANTERN_SETTINGS],
    });
  });

  it("the outputs it shows for the Copper Lantern are what the adapter and the checks read", async () => {
    const outputs = blocks("json title=Output");
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toBe(await copperLanternReads());
    expect(outputs[1]).toBe(await copperLanternChecks());
  });

  it("shows no text from the site's content", () => {
    for (const text of Object.values(CONTENT_MARKERS)) expect(page).not.toContain(text);
  });

  it("names the key kind, the variables, the checks, the flag and the limits", () => {
    for (const word of [
      ...WORDPRESS_ENV_VARS,
      ...WORDPRESS_CHECKS.map((c) => c.id),
      "--wordpress",
      "run --all --wordpress",
      "Application Passwords",
      "xmlrpc.php",
      "could not be reached from the session",
      WORDPRESS_COUNT_CAP.toLocaleString("en-US"),
      "`scoped`",
    ])
      expect(page, word).toContain(word);
    expect(WORDPRESS_DESCRIPTION.keyKind).toBe("scoped");
  });

  it("is linked from the content systems page as built, and says the docs page it links to exists", () => {
    const index = read("docs/integrations/index.md");
    expect(index).toContain("[WordPress](wordpress.md)");
    expect(WORDPRESS_DESCRIPTION.docsUrl).toBe("https://gaugeline.dev/docs/integrations/wordpress");
  });

  it("states facts: it never calls a site vulnerable or hacked", () => {
    expect(page).not.toMatch(/\byou are (vulnerable|at risk)\b|\bhacked\b|\bexploit(ed|able)\b/i);
  });
});
