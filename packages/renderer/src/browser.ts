import { posix } from "node:path";

/**
 * Where the person's own Chromium is. Gaugeline never downloads a browser (ADR-0003: a run contacts no host
 * the person did not name; ADR-0009: the browser is installed by a command the person runs). This only asks
 * whether a file exists, in this order:
 *
 *   1. GAUGELINE_BROWSER_PATH, when set. If that file is not there the answer is no: the person named it.
 *   2. The browser Playwright installed, where Playwright looks for it (its own folder, or the one
 *      PLAYWRIGHT_BROWSERS_PATH names): `chromium.executablePath()`.
 *   3. Chrome, Chromium or Edge in the places each system keeps them.
 */

export const BROWSER_PATH_VARIABLE = "GAUGELINE_BROWSER_PATH";

export type BrowserFound =
  | { ok: true; path: string; source: typeof BROWSER_PATH_VARIABLE | "playwright" | "system" }
  | { ok: false; reason: string };

export interface FindBrowserOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Where Playwright expects its own browser, from the driver. */
  bundled?: string;
  exists: (path: string) => boolean;
  platform: NodeJS.Platform;
}

const LINUX_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
];

function candidates(platform: NodeJS.Platform, env: FindBrowserOptions["env"]): readonly string[] {
  if (platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(
      (r): r is string => r !== undefined && r !== "",
    );
    return roots.flatMap((root) => [
      `${root}\\Google\\Chrome\\Application\\chrome.exe`,
      `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${root}\\Chromium\\Application\\chrome.exe`,
    ]);
  }
  const folders = [
    "/usr/bin",
    "/usr/local/bin",
    "/snap/bin",
    ...(env.PATH ?? "").split(":").filter((p) => p !== ""),
  ];
  return [...new Set(folders)].flatMap((folder) => LINUX_NAMES.map((n) => posix.join(folder, n)));
}

export function findBrowser(options: FindBrowserOptions): BrowserFound {
  const named = options.env[BROWSER_PATH_VARIABLE];
  if (named !== undefined && named !== "")
    return options.exists(named)
      ? { ok: true, path: named, source: BROWSER_PATH_VARIABLE }
      : {
          ok: false,
          reason: `${BROWSER_PATH_VARIABLE} is set to ${named}, and there is no file there.`,
        };
  if (options.bundled !== undefined && options.exists(options.bundled))
    return { ok: true, path: options.bundled, source: "playwright" };
  for (const path of candidates(options.platform, options.env))
    if (options.exists(path)) return { ok: true, path, source: "system" };
  return { ok: false, reason: "No Chromium browser was found on this machine." };
}

/** What to do when there is no browser. Plain text: it is printed as it is. */
export function installHint(): string {
  return [
    "Gaugeline never downloads a browser. Install one yourself, then run again:",
    "  npx playwright install chromium     (Playwright's own folder; PLAYWRIGHT_BROWSERS_PATH moves it)",
    "or install Google Chrome, Chromium or Edge the usual way, or set",
    `${BROWSER_PATH_VARIABLE} to the browser's file.`,
  ].join("\n");
}

/** What to do when the driver library is missing. */
export function driverHint(): string {
  return [
    "Rendering needs the playwright-core package, which Gaugeline does not install for you.",
    "Add it to the project that runs Gaugeline, then run again:",
    "  npm install --save-dev gaugeline playwright-core",
    "and run `npx gaugeline ...` from that project.",
  ].join("\n");
}
