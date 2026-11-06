import { describe, expect, it } from "vitest";
import { createPageRegistry } from "../../checks/index.js";
import type { Finding } from "../../model.js";
import type { RunResult } from "../../run.js";
import { escapeHtml, renderReport } from "../html.js";

const registry = createPageRegistry();
const STARTED = new Date("2026-11-05T20:00:00.000Z");

const finding = (
  checkId: string,
  severity: Finding["severity"],
  title: string,
  evidence: string,
): Finding => ({
  checkId,
  severity,
  title,
  evidence,
  url: "https://shop.example/",
});
const result = (r: Partial<RunResult>): RunResult => ({
  findings: [],
  passed: [],
  failed: [],
  warnings: [],
  couldNotCheck: [],
  ...r,
});
const render = (r: RunResult, sampled = "Checked all 2 links, 1 image.") =>
  renderReport({
    result: r,
    url: "https://shop.example/",
    startedAt: STARTED,
    registry,
    sampled,
    version: "0.1.0",
  });

describe("html report: unit", () => {
  it("a mixed result renders summary counts, findings by level, what looked right and the sample (snapshot)", () => {
    const html = render(
      result({
        findings: [
          finding(
            "canonical-elsewhere",
            "high",
            "This page tells Google to show a different page",
            '<link rel="canonical" href="https://shop.example/tools">',
          ),
          finding(
            "og-image-missing",
            "medium",
            "Shared links have no picture",
            "no og:image on https://shop.example/",
          ),
          finding("links-via-redirect", "low", "Links go through redirects", "/old -> /new"),
        ],
        passed: ["noindex", "viewport"],
        failed: [{ id: "explodes", error: "boom" }],
        couldNotCheck: [
          { id: "broken-links", reason: "rate limited (429)", url: "https://shop.example/busy" },
        ],
      }),
    );
    expect(html).toMatchSnapshot();
    expect(html).toContain("<h2>Fix this first <span>1</span></h2>");
    expect(html).toContain("<h2>What looked right <span>2</span></h2>");
    expect(html).toContain("Checked all 2 links, 1 image.");
  });

  it("every dynamic value is escaped: <script> in a title or evidence is text, never markup", () => {
    const html = render(
      result({
        findings: [
          finding(
            "canonical-elsewhere",
            "high",
            '<script>alert("x")</script>',
            "a & b < c > d \"e\" 'f'",
          ),
        ],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;");
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("the file references no http:// or https:// resource (no src=, and no href= on link or script)", () => {
    const html = render(
      result({
        findings: [finding("canonical-elsewhere", "high", "t", "https://cdn.example/x.js")],
      }),
    );
    expect(html).not.toMatch(/\ssrc=["']?https?:/i);
    expect(html).not.toMatch(/<link[^>]+href=["']?https?:/i);
    expect(html).not.toMatch(/<script/i);
  });
});

describe("html report: edge cases", () => {
  it("0 findings: the report still lists what was verified", () => {
    const html = render(result({ passed: ["canonical-missing", "noindex"] }));
    expect(html).toContain("Nothing to fix");
    expect(html).toContain("canonical-missing");
    expect(html).toContain("The page doesn&#39;t say which address is the real one");
  });

  it("500 findings: the file stays under 2 MB", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      finding(
        "broken-links",
        "high",
        "Links on this page go nowhere",
        `"Page ${i}" <a href="/p${i}"> returned 404`,
      ),
    );
    expect(Buffer.byteLength(render(result({ findings: many })))).toBeLessThan(2 * 1024 * 1024);
  });

  it("right-to-left text and emoji in titles survive", () => {
    const html = render(
      result({ findings: [finding("canonical-elsewhere", "high", "صفحة الطلب 🛒", "תפריט 🌮")] }),
    );
    expect(html).toContain("صفحة الطلب 🛒");
    expect(html).toContain("תפריט 🌮");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('dir="auto"');
  });
});
