// check-community: allow-email (invented addresses at a reserved example domain, only ever parsed as text)
import { describe, expect, it } from "vitest";
import { parseEmail } from "../../emails/parse.js";
import { findPlaceholders } from "../../emails/placeholders.js";
import {
  badHref,
  emailImageNotAbsolute,
  emailNoTextPart,
  emailPreviewPlaceholder,
  emailRelativeLink,
  type EmailInput,
} from "../email-templates.js";
import { ctx } from "./helpers.js";

/** An email's input from its HTML, the way checkEmails builds it. */
function input(html: string, over: Partial<EmailInput> = {}): EmailInput {
  const p = parseEmail(html);
  return {
    file: "emails/order.html",
    links: p.links,
    images: p.images,
    placeholders: findPlaceholders(p.masked).map((m) => ({
      rule: m.rule,
      label: m.label,
      text: m.text,
      file: "emails/order.html",
      line: p.lineAt(m.index),
    })),
    hasTextPart: false,
    textExpected: false,
    ...over,
  };
}

describe("email-relative-link", () => {
  it("is high, and says which file and line", async () => {
    const found = await emailRelativeLink.run(
      input(
        '<p>a</p>\n<a href="/orders/1001">View</a>\n<a href="http://localhost:3000/x?token=SECRETVALUE">x</a>',
      ),
      ctx,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "email-relative-link",
      severity: "high",
      url: "emails/order.html",
      source: { file: "emails/order.html", line: 2 },
    });
    const evidence = found[0]?.evidence ?? "";
    expect(evidence).toContain("emails/order.html:2 1 relative link and 1 link to this computer");
    expect(evidence).toContain("line 2 /orders/1001");
    // The query, which can hold a customer's token, is never printed.
    expect(evidence).toContain("http://localhost:3000/x?\u2026");
    expect(evidence).not.toContain("SECRETVALUE");
  });

  it("classifies addresses", () => {
    expect(badHref("/orders/1")).toBe("relative");
    expect(badHref("orders/1")).toBe("relative");
    expect(badHref("../orders/1")).toBe("relative");
    expect(badHref("//cdn.example/x")).toBe("relative");
    for (const local of [
      "http://localhost:3000/a",
      "https://shop.localhost/a",
      "http://127.0.0.1:8080/a",
      "http://0.0.0.0/a",
      "http://[::1]/a",
      "http://192.168.1.20:3000/a",
      "http://10.0.0.5/a",
      "http://172.20.1.1/a",
      "http://172.32.1.1/a".replace("172.32", "169.254"),
      "http://studio.local/a",
    ])
      expect(badHref(local), local).toBe("local");
    for (const fine of [
      "https://marlowe-popup.example/orders/1",
      "http://172.32.1.1/a",
      "mailto:hello@marlowe-popup.example",
      "tel:+14155550132",
      "#top",
      "sms:+14155550132",
      "{{ order.url }}",
    ])
      expect(badHref(fine), fine).toBeUndefined();
  });

  it("sees through a tracking wrapper whose pattern is known", async () => {
    const wrapped = `https://google.com/url?q=${encodeURIComponent("http://localhost:3000/a")}`;
    const found = await emailRelativeLink.run(input(`<a href="${wrapped}">x</a>`), ctx);
    expect(found).toHaveLength(1);
  });

  it("is quiet for finished links", async () => {
    expect(
      await emailRelativeLink.run(
        input(
          '<a href="https://marlowe-popup.example/o/1">a</a><a href="mailto:a@b.example">b</a>',
        ),
        ctx,
      ),
    ).toEqual([]);
  });
});

describe("email-preview-placeholder", () => {
  it("is medium, one finding for the email, naming the first line and listing a few", async () => {
    const found = await emailPreviewPlaceholder.run(
      input("<p>a</p>\n<p>Order {{order_id}}</p>\n<p>Hi undefined</p>\n<p>{{a}} {{b}}</p>"),
      ctx,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "medium",
      source: { file: "emails/order.html", line: 2 },
    });
    expect(found[0]?.evidence).toBe(
      "emails/order.html:2 4 placeholders left in: line 2 {{order_id}}, line 3 undefined, line 4 {{a}} and 1 more",
    );
  });

  it("a placeholder in the .txt is its own finding at the .txt", async () => {
    const found = await emailPreviewPlaceholder.run(
      input("<p>fine</p>", {
        placeholders: [
          {
            rule: "double-braces",
            label: "x",
            text: "{{name}}",
            file: "emails/order.txt",
            line: 4,
          },
        ],
      }),
      ctx,
    );
    expect(found[0]).toMatchObject({
      url: "emails/order.txt",
      source: { file: "emails/order.txt", line: 4 },
    });
  });

  it("escapes what it prints", async () => {
    const found = await emailPreviewPlaceholder.run(input("<p>{{a\u200Bb}}</p>"), ctx);
    expect(found[0]?.evidence).toContain("{{a\\u{200B}b}}");
  });
});

describe("email-no-text-part", () => {
  it("is low when a text version is expected and there is none", async () => {
    const found = await emailNoTextPart.run(input("<p>x</p>", { textExpected: true }), ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "low",
      source: { file: "emails/order.html", line: 1 },
    });
    expect(found[0]?.evidence).toBe("emails/order.html has no emails/order.txt beside it");
  });

  it("is quiet when the .txt is there", async () => {
    expect(
      await emailNoTextPart.run(input("<p>x</p>", { textExpected: true, hasTextPart: true }), ctx),
    ).toEqual([]);
  });

  it("says it could not check, and finds nothing, when the settings do not ask for one", async () => {
    const notes: [string, string][] = [];
    const found = await emailNoTextPart.run(input("<p>x</p>"), {
      ...ctx,
      couldNotCheck: (url, reason) => notes.push([url, reason]),
    });
    expect(found).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[1]).toContain("textVersion");
  });
});

describe("email-image-not-absolute", () => {
  it("is medium for a relative path, a private address and http://", async () => {
    const found = await emailImageNotAbsolute.run(
      input(
        '<img src="/mail/logo.png">\n<img src="http://shop.example/hero.jpg">\n<img src="http://localhost:3000/a.png">\n<img src="https://shop.example/ok.png">\n<img src="cid:logo">\n<img src="data:image/png;base64,AAAA">',
      ),
      ctx,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "medium",
      source: { file: "emails/order.html", line: 1 },
    });
    expect(found[0]?.evidence).toBe(
      "emails/order.html:1 3 images will not load: line 1 /mail/logo.png (relative path), line 2 http://shop.example/hero.jpg (http), line 3 http://localhost:3000/a.png (private address)",
    );
  });

  it("is quiet for https images, inline images and a template variable", async () => {
    expect(
      await emailImageNotAbsolute.run(
        input('<img src="https://shop.example/a.png"><img src="cid:x"><img src="{{logo}}">'),
        ctx,
      ),
    ).toEqual([]);
  });
});
