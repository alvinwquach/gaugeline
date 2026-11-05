import { expectedOutput } from "@gaugeline/fixtures";
import { useCassette } from "@gaugeline/testkit";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";

describe("app store links: e2e (CLI, version 0.1.0, recorded store answers)", () => {
  it("prints exactly the Privacy page's Output block", async () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const out: string[] = [];
      const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: () => true } };
      const code = await main(["https://hollyhock-app.example/", "--no-open"], io, {
        version: "0.1.0",
        fetcher: { transport: useCassette("app-stores", { mode: "replay" }) },
      });
      expect(code).toBe(0);
      expect(out.join("").trimEnd()).toBe(expectedOutput("privacy", "App stores"));
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});
