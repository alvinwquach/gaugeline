import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../limits.js";
import { PROBING_CHECKS } from "../../presets.js";
import { PAGE_CHECKS } from "../index.js";
import { gatedDownloadOpen } from "../gated-download-open.js";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../${path}`, import.meta.url)), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const delivery = read("docs/delivery.md");
const options = read("docs/options.md");
const privacy = read("docs/privacy.md");
const security = read("docs/security.md");

describe("the docs for the download route probe (G26a)", () => {
  it("delivery.md names the check and says it is a probing check for sites you may test", () => {
    expect(delivery).toContain("`gated-download-open`");
    expect(PAGE_CHECKS.some((c) => c.id === "gated-download-open")).toBe(true);
    expect(PROBING_CHECKS).toContain("gated-download-open");
    expect(delivery).toContain("**probing** check");
    expect(delivery).toContain("Run it only on sites you own or have permission to test.");
    expect(delivery).toContain("--owner-consent");
    expect(delivery).toContain("`--routes <glob>`");
  });

  it("the page's output sample is the shape the check prints", () => {
    expect(delivery).toContain(
      "/api/download/7-day-plan -> 200 application/pdf. Asked with no session and no purchase, the route handed over the file.",
    );
    expect(delivery).toContain(gatedDownloadOpen.title);
  });

  it("every limit the docs state is the limit in the code", () => {
    expect(LIMITS.downloadRoutes).toBe(10);
    expect(LIMITS.downloadPeekBytes).toBe(1024);
    expect(delivery).toContain("At most 10 routes per run");
    expect(delivery).toContain("at most 1,024 bytes");
    expect(privacy).toContain("At most 10 routes per run");
    expect(privacy).toContain("at most 1,024 bytes");
    expect(security).toMatch(/Download routes asked \(consent\)\s+\| 10/);
  });

  it("says what the probe never does", () => {
    for (const text of [delivery, privacy]) {
      expect(text.toLowerCase()).toContain("no cookie, no `authorization` header, no `referer`");
      expect(text).toContain("query string");
    }
    expect(privacy.toLowerCase()).toContain("never a `post`");
    expect(privacy).toContain("never stored, logged, printed");
    expect(privacy).toContain("permission to test");
    expect(delivery).toContain("never guesses or counts through ids");
  });

  it("options.md documents the consent file, --routes and the exit 2 without consent", () => {
    expect(options).toContain("gaugeline.consent.json");
    expect(options).toContain("`--routes <glob>`");
    expect(options).toContain("permission");
    expect(options).toContain("`--routes` without `--owner-consent` is refused");
  });
});
