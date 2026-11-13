import { describe, expect, it } from "vitest";
import { BROWSER_PATH_VARIABLE, findBrowser, installHint } from "../browser.js";

const has =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe("finding the person's own browser", () => {
  it("uses the path the person named", () => {
    expect(
      findBrowser({
        env: { [BROWSER_PATH_VARIABLE]: "/opt/mine/chrome" },
        exists: has("/opt/mine/chrome", "/usr/bin/google-chrome"),
        platform: "linux",
      }),
    ).toEqual({ ok: true, path: "/opt/mine/chrome", source: BROWSER_PATH_VARIABLE });
  });

  it("does not fall back when the named path is not there: the person asked for that one", () => {
    const found = findBrowser({
      env: { [BROWSER_PATH_VARIABLE]: "/opt/mine/chrome" },
      exists: has("/usr/bin/google-chrome"),
      platform: "linux",
    });
    expect(found).toMatchObject({ ok: false });
    if (!found.ok) expect(found.reason).toContain("/opt/mine/chrome");
  });

  it("then uses the browser Playwright installed, where it looks for one", () => {
    expect(
      findBrowser({
        env: {},
        bundled: "/home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
        exists: has("/home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"),
        platform: "linux",
      }),
    ).toEqual({
      ok: true,
      path: "/home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
      source: "playwright",
    });
  });

  it.each([
    ["linux", "/usr/bin/google-chrome"],
    ["linux", "/usr/bin/chromium"],
    ["linux", "/snap/bin/chromium"],
    ["darwin", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    ["win32", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
  ] as const)("then a browser installed the usual way on %s: %s", (platform, path) => {
    expect(
      findBrowser({
        env: { PROGRAMFILES: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        exists: has(path),
        platform,
      }),
    ).toEqual({ ok: true, path, source: "system" });
  });

  it("says nothing was found, and what was looked at, when nothing is there", () => {
    const found = findBrowser({ env: {}, exists: () => false, platform: "linux" });
    expect(found).toMatchObject({ ok: false });
  });

  it("never reads anything but whether a file exists: it downloads and installs nothing", () => {
    const asked: string[] = [];
    findBrowser({
      env: {},
      exists: (p) => (asked.push(p), false),
      platform: "linux",
    });
    expect(asked.length).toBeGreaterThan(0);
  });
});

describe("the install hint", () => {
  it("says how to install a browser, and that Gaugeline will not", () => {
    const hint = installHint();
    expect(hint).toContain("npx playwright install chromium");
    expect(hint).toContain(BROWSER_PATH_VARIABLE);
    expect(hint).toMatch(/never downloads/i);
  });
});
