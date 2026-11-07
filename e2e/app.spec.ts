import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/** The built CLI (pnpm build runs before this in the Docs workflow). */
const BIN = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));

let child: ChildProcess;
let link = "";
let other: Server;
let otherOrigin = "";

// A fresh `gaugeline open` for each test: its link works once, and each test is a new browser.
test.beforeEach(async () => {
  child = spawn(process.execPath, [BIN, "open", "--no-open"], { env: { ...process.env, CI: "" } });
  link = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /Gaugeline is running at (\S+)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    });
    child.on("exit", () => reject(new Error(`gaugeline open exited: ${out}`)));
  });
});
test.afterEach(async () => {
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGINT");
  await exited;
});

test.beforeAll(async () => {
  // A second origin: a page that tries to start a check in the app with the browser's credentials.
  other = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>waiting</title>
<script>
fetch("http://localhost:" + new URLSearchParams(location.search).get("port") + "/api/check", {
  method: "POST", credentials: "include",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "example.com" }),
})
  .then((r) => { document.title = "answered " + r.status; })
  .catch(() => { document.title = "failed"; });
</script>`);
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((r) => other.close(() => r()));
});

test("the printed link ends at / with no key in the address bar, and a reload still loads", async ({
  page,
}) => {
  await page.goto(link);
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByText("Gaugeline is running on this computer")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Gaugeline is running on this computer")).toBeVisible();
});

test("a page on another origin can't start a check, even with credentials", async ({ page }) => {
  await page.goto(link);
  await expect(page.getByText("Gaugeline is running on this computer")).toBeVisible();
  const port = new URL(link).port;
  await page.goto(`${otherOrigin}/?port=${port}`);
  await expect(page).toHaveTitle(/failed|answered/);
  expect(await page.title()).toBe("failed");
  // Back in the app's own session: the attempt left nothing behind.
  await page.goto(`http://localhost:${port}/`);
  const runs = await page.evaluate(async () => (await fetch("/api/runs")).json());
  expect(runs).toEqual([]);
});
