import { createFetcher } from "../../fetcher.js";
import { createPageRegistry } from "../../checks/index.js";
import { WORDPRESS_CHECKS } from "../../checks/wordpress.js";
import { checkSite } from "../../site.js";
import { createWordPress } from "../reader.js";
import { addWordPressChecks } from "../registry.js";
import { ROUTES, wpPage, wpWorld, type SiteDef } from "./world.js";

/**
 * What docs/integrations/wordpress.md shows for the two WordPress checks on the Copper Lantern's site (an invented
 * cocktail bar built with Elementor). The wordpress.org answers are the recorded stand-ins in world.ts with invented
 * version numbers. The docs test compares the page's block with this, so the page cannot drift from the checks.
 */
export const COPPER_LANTERN_HOST = "copper-lantern.example";

export const COPPER_LANTERN_SITE: SiteDef = {
  routes: {
    "/": wpPage({
      title: "Copper Lantern",
      generator: "WordPress 6.2.1",
      plugins: [
        ["elementor", "3.19.0"],
        ["easy-booking", "2.1.3"],
        ["gallery-lite", "1.3.0"],
      ],
      themes: [["copper-child", "1.0.4"]],
    }),
    ...ROUTES.usersOpen,
  },
};

export async function copperLanternChecks(): Promise<string> {
  const world = wpWorld({ [COPPER_LANTERN_HOST]: COPPER_LANTERN_SITE });
  const fetcher = createFetcher({ transport: world.transport, timeoutMs: 5000 });
  const registry = addWordPressChecks(createPageRegistry());
  const { result } = await checkSite({
    address: `https://${COPPER_LANTERN_HOST}/`,
    fetcher,
    registry,
    only: WORDPRESS_CHECKS.map((c) => c.id),
    wordpress: createWordPress(fetcher),
  });
  return JSON.stringify(
    {
      findings: result.findings.map((f) => ({
        check: f.checkId,
        severity: f.severity,
        evidence: f.evidence,
      })),
      "could not check": result.couldNotCheck.map((c) => c.reason),
    },
    null,
    2,
  );
}
