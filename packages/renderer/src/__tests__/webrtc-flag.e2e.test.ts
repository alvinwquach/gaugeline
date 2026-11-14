import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import type * as Playwright from "playwright-core";
import { describe, expect, it } from "vitest";
import { findBrowser } from "../browser.js";
import { BROWSER_ARGS, NO_NETWORK } from "../playwright.js";

/**
 * The launch switches, behaviourally: a browser started with BROWSER_ARGS and the dead proxy, and none of the
 * page-side guards, sends no UDP when a page opens a peer connection to a local STUN address; the same
 * browser without the WebRTC switch does. (The adapter also removes the WebRTC names from the page, so its
 * own tests cannot show the switch works: this one can.) Skipped where no browser starts.
 */
const found = findBrowser({ env: process.env, exists: existsSync, platform: process.platform });
let driver: typeof Playwright | undefined;
try {
  driver = await import("playwright-core");
} catch {
  driver = undefined;
}

async function packetsFrom(args: readonly string[]): Promise<number | undefined> {
  if (!driver || !found.ok) return undefined;
  const udp = createSocket("udp4");
  let packets = 0;
  udp.on("message", () => (packets += 1));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const port = udp.address().port;
  try {
    const browser = await driver.chromium
      .launch({
        executablePath: found.path,
        chromiumSandbox: process.getuid?.() !== 0,
        proxy: { ...NO_NETWORK },
        args: [...args],
      })
      .catch(() => undefined);
    if (!browser) return undefined;
    try {
      const context = await browser.newContext();
      await context.route(/.*/, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<h1>x</h1>" }),
      );
      const page = await context.newPage();
      await page.goto("http://site.example/");
      await page.evaluate(`(async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${port}" }, { urls: "turn:127.0.0.1:${port}", username: "a", credential: "b" }] });
        pc.createDataChannel("x");
        await pc.setLocalDescription(await pc.createOffer());
      })()`);
      await new Promise((r) => setTimeout(r, 2500));
      return packets;
    } finally {
      await browser.close();
    }
  } finally {
    udp.close();
  }
}

describe.skipIf(!driver || !found.ok)("the WebRTC launch switch", () => {
  it("keeps a page that opens a peer connection from sending UDP, and the same browser without it does send", async (ctx) => {
    const without = BROWSER_ARGS.filter((a) => !a.includes("webrtc"));
    const control = await packetsFrom(without);
    if (control === undefined) return ctx.skip("the browser does not start here");
    // A browser that sends nothing even without the switch proves nothing about it.
    if (control === 0)
      return ctx.skip("this browser sends no UDP to a local STUN address even without the switch");
    expect(await packetsFrom(BROWSER_ARGS)).toBe(0);
  }, 90_000);
});
