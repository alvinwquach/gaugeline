import { describe, expect, it } from "vitest";
import { servicesConfigSchema } from "../config.js";
import { buildAuditPack } from "../pack.js";
import { AUDIT_PACK_FILES, auditPackFiles, renderPackHtml, renderPackMarkdown } from "../render.js";
import { CHECKS, FINDINGS, SERVICES, finding, resultOf } from "./world.js";

const lines = (text: string): string[] => text.split(/\r?\n/);
const pack = (opts = {}) =>
  buildAuditPack(resultOf(FINDINGS), CHECKS, {
    services: SERVICES,
    business: "Marlowe Bar",
    ...opts,
  });

describe("audit pack: the Markdown", () => {
  const md = renderPackMarkdown(pack());

  it("matches the pack made from a services file and a bar's findings (snapshot)", () => {
    expect(md).toMatchSnapshot();
  });

  it("starts with the owner's summary: what is at risk, then the five to start with, with evidence", () => {
    const at = (text: string) => lines(md).findIndex((l) => l === text);
    expect(at("## Summary")).toBeGreaterThan(0);
    expect(at("### What is at risk")).toBeGreaterThan(at("## Summary"));
    expect(at("### The five to start with")).toBeGreaterThan(at("### What is at risk"));
    expect(at("## What we would fix, and what it costs")).toBeGreaterThan(
      at("### The five to start with"),
    );
    expect(md).toContain(
      "Gaugeline checked marlowe-bar.example on 10 Nov 2026 and found 5 things worth fixing: 2 to fix first, 2 to fix soon and 1 worth knowing.",
    );
    expect(md).toContain("1. **Title of canonical-elsewhere** (Fix this first)");
  });

  it("shows each package with its price, hours, exclusions and re-run line", () => {
    expect(md).toContain("### Search and sharing tidy-up");
    expect(md).toContain("**Price:** $450\u2013$700. **Time:** 4\u20136 hours.");
    expect(md).toContain("**Price:** $600\u2013$900.");
    expect(md).toContain("**Not included:**");
    expect(md).toContain("- New page copy");
    expect(md).toContain("**How we would check it worked:** We run Gaugeline again on");
  });

  it("adds up the packages and says what the total leaves out", () => {
    expect(md).toContain(
      "**Total for the packages above:** $1,050\u2013$1,600, 4\u20136 hours. \u201CPhone and accessibility pass\u201D has no hours, so it is left out of the hours. The other findings are not included.",
    );
  });

  it("lists the findings no package covers, with no price", () => {
    const at = lines(md).findIndex((l) => l === "## Other findings");
    expect(at).toBeGreaterThan(0);
    expect(lines(md)[at + 2]).toBe(
      "No package above covers these, so they have no price here. We can quote them separately.",
    );
  });

  it("ends with what the audit does not include, and says the private paths were not asked", () => {
    const tail = md.slice(md.indexOf("## What this audit does not include"));
    expect(tail).toContain("It did not log in, fill in a form or change anything.");
    expect(tail).toContain("It did not ask for private or admin paths.");
    expect(tail).toContain("The email records (SPF and DMARC) were not read.");
  });

  it("says so when the probing checks and the mail records were part of the run", () => {
    const text = renderPackMarkdown(pack({ probing: true, dns: true }));
    expect(text).toContain("Because the site's owner agreed to it, it also asked the routes");
    expect(text).not.toContain("It did not ask for private or admin paths.");
    expect(text).not.toContain("were not read");
  });

  it("shows the brand: the logo, the name and the contact line, with the logo from the file", () => {
    expect(md).toContain("![Harbour Studio](https://harbour-studio.example/logo.png)");
    expect(md).toContain(
      "Prepared by **Harbour Studio**. Mia Okafor, hello at harbour-studio.example, 555 0142",
    );
  });

  it("without packages, groups by area and shows no price anywhere", () => {
    const text = renderPackMarkdown(buildAuditPack(resultOf(FINDINGS), CHECKS));
    expect(text).toContain("## What we found, by area");
    expect(text).toContain("### Search \\& sharing");
    expect(text).not.toMatch(/\$|Price:|Total for|How we would check/);
  });
});

describe("audit pack: a site with nothing to fix", () => {
  const healthy = buildAuditPack(resultOf([]), CHECKS, {
    services: SERVICES,
    business: "Marlowe Bar",
  });
  const md = renderPackMarkdown(healthy);

  it("is a short pack that says so, with no packages and no price", () => {
    expect(md).toMatchSnapshot();
    expect(md).toContain("found nothing to fix.");
    expect(md).not.toMatch(/\$|## What we would fix|### What is at risk/);
    expect(lines(md).length).toBeLessThan(30);
  });

  it("has the same in HTML", () => {
    const html = renderPackHtml(healthy);
    expect(html).toContain("found nothing to fix.");
    expect(html).toContain('<h2 dir="auto">What this audit does not include</h2>');
  });
});

describe("audit pack: the HTML", () => {
  const html = renderPackHtml(pack());

  it("is one file with its own styles, no script and a policy that allows nothing else", () => {
    expect(html).toMatchSnapshot();
    expect(html).not.toMatch(/<script|<link|onerror|onclick|javascript:/i);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https:">`,
    );
  });

  it("shows the logo only from an https address", () => {
    expect(html).toContain(
      '<img src="https://harbour-studio.example/logo.png" alt="Harbour Studio">',
    );
    const none = renderPackHtml(
      buildAuditPack(resultOf(FINDINGS), CHECKS, {
        brand: { name: "X", logoUrl: "javascript:alert(1)" },
      }),
    );
    expect(none).not.toContain("<img");
  });
});

describe("audit pack: text from a page is data", () => {
  const attack = "<script>alert(1)</script> [x](https://e.test) # h ![i](https://e.test/p.png)";
  const risky = buildAuditPack(resultOf([finding("alt-missing", "medium", attack)]), CHECKS, {
    business: attack,
    services: servicesConfigSchema.parse({
      services: [
        {
          name: attack,
          covers: { areas: ["Visitors"] },
          price: { from: 1, to: 2 },
          notIncluded: [attack],
        },
      ],
      brand: { name: attack, contact: attack },
    }),
  });

  it("is escaped in the HTML: nothing in it can become an element", () => {
    const html = renderPackHtml(risky);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('<img src="https://e.test');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("is escaped in the Markdown: it cannot start a heading, a link, an image or markup", () => {
    const md = renderPackMarkdown(risky);
    expect(md).not.toContain("<script>");
    expect(md).not.toMatch(/(?<!)\[x\]\(/);
    expect(md).not.toMatch(/(?<!)!\[i\]\(/);
    for (const line of lines(md)) expect(line).not.toMatch(/^# h/);
    expect(md).toContain("\\<script\\>alert(1)\\</script\\>");
  });

  it("shows invisible characters in a business name as escapes, not as themselves", () => {
    const p = buildAuditPack(resultOf(FINDINGS), CHECKS, { business: "Marlowe\u202EBar" });
    const text = `${renderPackMarkdown(p)}${renderPackHtml(p)}`;
    expect(text).not.toContain("\u202E");
  });
});

describe("audit pack: the files", () => {
  it("are the HTML and then the Markdown, named once", () => {
    expect([...AUDIT_PACK_FILES]).toEqual(["audit-pack.html", "audit-pack.md"]);
    const files = auditPackFiles(pack());
    expect(files.map((f) => f.name)).toEqual([...AUDIT_PACK_FILES]);
    expect(files[0]?.text.startsWith("<!doctype html>")).toBe(true);
    expect(files[1]?.text.startsWith("# Site audit: Marlowe Bar")).toBe(true);
  });

  it("hold no key, no token and no full email address", () => {
    const key = ["sk", "live", "abcdefgh12345678"].join("_");
    const email = ["rosa", "marlowe-bar.example"].join("@");
    const p = buildAuditPack(
      resultOf([finding("alt-missing", "medium", `${email} ${key}`)]),
      CHECKS,
      {
        services: SERVICES,
      },
    );
    for (const f of auditPackFiles(p)) {
      expect(f.text).not.toContain(key);
      expect(f.text).not.toContain(email);
    }
  });

  it("end with a newline and use only line feeds", () => {
    for (const f of auditPackFiles(pack())) {
      expect(f.text.endsWith("\n")).toBe(true);
      expect(f.text).not.toContain("\r");
    }
  });
});
