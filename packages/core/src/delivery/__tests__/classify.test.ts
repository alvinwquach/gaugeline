import { describe, expect, it } from "vitest";
import { classify, isLoginAddress, sniff, type Verdict } from "../classify.js";

const bytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "latin1"));
const HTML = "<!doctype html><html><body>Please sign in</body></html>";
const PDF = "%PDF-1.7\n%\u00E2\u00E3\u00CF\u00D3\n1 0 obj";
const ZIP = "PK\u0003\u0004\u0014\u0000\u0000\u0000";

describe("sniff: the first bytes are the fact", () => {
  it("reads a few magic numbers", () => {
    expect(sniff(bytes(PDF))).toBe("pdf");
    expect(sniff(bytes(ZIP))).toBe("zip");
    expect(sniff(bytes("ID3\u0004\u0000\u0000\u0000\u0000"))).toBe("mp3");
    expect(sniff(bytes("\u0000\u0000\u0000\u0018ftypmp42"))).toBe("mp4");
    expect(sniff(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]))).toBe("gzip");
  });

  it("does not take the letters PK in text for a zip file", () => {
    expect(sniff(bytes("PK is a sign-in prompt"))).not.toBe("zip");
  });

  it("calls an HTML start html, with or without a byte order mark or leading space", () => {
    expect(sniff(bytes(HTML))).toBe("html");
    expect(sniff(bytes("  \n<HTML><head>"))).toBe("html");
    expect(sniff(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from("<!DOCTYPE html>")]))).toBe(
      "html",
    );
    expect(sniff(bytes("<div class='login'>Sign in</div>"))).toBe("html");
  });

  it("tells JSON, other text, other binary and nothing apart", () => {
    expect(sniff(bytes('{"error":"unauthorised"}'))).toBe("json");
    expect(sniff(bytes("[1,2]"))).toBe("json");
    expect(sniff(bytes("name,city\nAda,Leeds\n"))).toBe("text");
    expect(sniff(Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe]))).toBe("binary");
    expect(sniff(new Uint8Array())).toBe("empty");
  });
});

const pdfHeaders = { "content-type": "application/pdf" };

/** One row of the table: what a route answered, and what it is. */
const TABLE: [string, number, Record<string, string>, string, Partial<Verdict>][] = [
  ["a PDF with no session", 200, pdfHeaders, PDF, { kind: "open", status: 200 }],
  [
    "a zip served as octet-stream",
    200,
    { "content-type": "application/octet-stream" },
    ZIP,
    { kind: "open" },
  ],
  [
    "an attachment whose type is wrong",
    200,
    { "content-type": "text/plain", "content-disposition": 'attachment; filename="plan.pdf"' },
    PDF,
    { kind: "open" },
  ],
  [
    "a csv export",
    200,
    { "content-type": "text/csv; charset=utf-8" },
    "name,city\nAda,Leeds\n",
    { kind: "open" },
  ],
  ["a login page", 200, { "content-type": "text/html" }, HTML, { kind: "page" }],
  ["a refusal: 401", 401, { "content-type": "text/plain" }, "Unauthorised", { kind: "refused" }],
  ["a refusal: 403", 403, {}, "", { kind: "refused" }],
  ["a refusal: 404", 404, {}, "not found", { kind: "refused" }],
  [
    "a redirect to a login page",
    302,
    { location: "/login?next=/api/download/7-day-plan" },
    "",
    { kind: "redirect", toLogin: true },
  ],
  [
    "a redirect to the file",
    302,
    { location: "https://files.example/plan.pdf?Expires=1&Signature=abc" },
    "",
    { kind: "redirect", toLogin: false },
  ],
  ["too many requests", 429, {}, "", { kind: "unclear" }],
  ["a server error", 500, {}, "", { kind: "unclear" }],
];

describe("classify(status, headers, firstBytes)", () => {
  it.each(TABLE)("%s", (_name, status, headers, body, expected) => {
    expect(
      classify(status, headers, bytes(body), "https://tideline.example/api/download/x"),
    ).toMatchObject(expected);
  });

  it("names the content type without its parameters", () => {
    const v = classify(200, { "content-type": "text/csv; charset=utf-8" }, bytes("a,b\n1,2\n"));
    expect(v).toEqual({ kind: "open", status: 200, contentType: "text/csv" });
  });

  it("says where a redirect points, as an absolute address", () => {
    const v = classify(
      302,
      { location: "/files/plan.pdf" },
      new Uint8Array(),
      "https://tideline.example/api/download/x",
    );
    expect(v).toEqual({
      kind: "redirect",
      toLogin: false,
      location: "https://tideline.example/files/plan.pdf",
    });
  });

  it("accepts a label from the fetcher in place of the bytes", () => {
    expect(classify(200, pdfHeaders, "pdf")).toMatchObject({ kind: "open" });
    expect(classify(200, pdfHeaders, "html")).toMatchObject({ kind: "page" });
  });
});

describe("classify: edge cases", () => {
  it("200 text/html that says please sign in is a pass", () => {
    expect(classify(200, { "content-type": "text/html" }, bytes(HTML)).kind).toBe("page");
  });

  it("200 application/octet-stream with an HTML body is a pass: the bytes win over the header", () => {
    expect(classify(200, { "content-type": "application/octet-stream" }, bytes(HTML)).kind).toBe(
      "page",
    );
    expect(
      classify(
        200,
        { "content-disposition": "attachment" },
        bytes("<html><body>Error</body></html>"),
      ).kind,
    ).toBe("page");
  });

  it("an octet-stream answer that is a JSON or plain error is not a file", () => {
    const octet = { "content-type": "application/octet-stream" };
    expect(classify(200, octet, bytes('{"error":"unauthorised"}')).kind).toBe("other");
    expect(classify(200, octet, bytes("Unauthorised")).kind).toBe("other");
  });

  it("a JSON export sent as an attachment is a file", () => {
    expect(
      classify(
        200,
        {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=orders.json",
        },
        bytes('[{"id":1}]'),
      ).kind,
    ).toBe("open");
  });

  it("an empty 200 hands nothing over", () => {
    expect(classify(200, pdfHeaders, new Uint8Array()).kind).toBe("other");
  });

  it("a file-looking body with no header that says file is not reported", () => {
    expect(classify(200, { "content-type": "text/plain" }, bytes(PDF)).kind).toBe("other");
  });

  it("a 204, a 200 JSON and a 400 are passes, not findings", () => {
    expect(classify(204, {}, new Uint8Array()).kind).toBe("other");
    expect(classify(200, { "content-type": "application/json" }, bytes('{"ok":false}')).kind).toBe(
      "other",
    );
    expect(classify(400, {}, bytes("bad request")).kind).toBe("refused");
  });

  it("a redirect with no Location is unclear", () => {
    expect(classify(302, {}, new Uint8Array()).kind).toBe("unclear");
  });
});

describe("isLoginAddress", () => {
  it.each([
    "/login",
    "/log-in?next=/x",
    "/sign-in",
    "/signin",
    "/account/login",
    "/auth/callback",
    "/users/sign_in",
    "https://tideline.us.auth0.com/authorize?client_id=x",
    "https://accounts.google.com/o/oauth2/v2/auth",
    "https://login.microsoftonline.com/common/oauth2",
    "https://tideline.clerk.accounts.dev/sign-in",
  ])("%s is a login address", (a) => {
    expect(isLoginAddress(a, "https://tideline.example/api/download/x")).toBe(true);
  });

  it.each([
    "/pricing",
    "/files/plan.pdf",
    "/blog/logins-explained-badly",
    "https://files.example/plan.pdf?Expires=1&Signature=abc",
  ])("%s is not", (a) => {
    expect(isLoginAddress(a, "https://tideline.example/api/download/x")).toBe(false);
  });
});
