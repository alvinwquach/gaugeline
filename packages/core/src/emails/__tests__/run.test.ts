import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Fetcher } from "../../fetcher.js";
import { languageRulesSchema } from "../../languages.js";
import { factsConfigSchema } from "../../facts/types.js";
import { paymentsConfigSchema } from "../../payments/types.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { emailsConfigSchema } from "../config.js";
import { NO_BASE_REASON, checkEmails } from "../run.js";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));
const MARLOWE = join(FIXTURES, "emails-marlowe");
const CEDAR = join(FIXTURES, "emails-cedar");

const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const marlowe = {
  config: emailsConfigSchema.parse(json(join(MARLOWE, "gaugeline.emails.json"))),
  payments: paymentsConfigSchema.parse(json(join(MARLOWE, "gaugeline.payments.json"))),
  facts: factsConfigSchema.parse(json(join(MARLOWE, "gaugeline.facts.json"))),
};

/** A fetcher that must never be used: a run with no --base has to make no request. */
const noNetwork: Fetcher = {
  get: () => Promise.reject(new Error("a request was made")),
  getSite: () => Promise.reject(new Error("a request was made")),
  head: () => Promise.reject(new Error("a request was made")),
} as unknown as Fetcher;

const servers: FixtureServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function workdir(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-emails-")));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const target = join(dir, ...name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return dir;
}

const lineOf = (file: string, needle: string): number =>
  readFileSync(join(MARLOWE, "emails", file), "utf8")
    .split("\n")
    .findIndex((l) => l.includes(needle)) + 1;

describe("a folder of six invented emails (Marlowe Street Pop-Up), no site named", () => {
  async function run() {
    return checkEmails({
      dir: join(MARLOWE, "emails"),
      prefix: "emails",
      fetcher: noNetwork,
      ...marlowe,
    });
  }

  it("finds the localhost link, the stale Venmo handle and {{order_id}}, each at its file and line", async () => {
    const r = await run();
    expect(r.emails.map((e) => e.file)).toEqual([
      "emails/booking-request.html",
      "emails/gift-card.html",
      "emails/order-confirmation.html",
      "emails/pickup-reminder.html",
      "emails/receipt.html",
      "emails/welcome.html",
    ]);
    const by = (id: string) => r.result.findings.filter((f) => f.checkId === id);
    const local = by("email-relative-link");
    expect(local).toHaveLength(1);
    expect(local[0]?.source).toEqual({
      file: "emails/booking-request.html",
      line: lineOf("booking-request.html", "localhost"),
    });
    expect(local[0]?.severity).toBe("high");
    expect(local[0]?.evidence).toContain("http://localhost:3000/bookings/42");
    expect(local[0]?.evidence).toContain("/menu");

    const placeholder = by("email-preview-placeholder");
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]?.source).toEqual({
      file: "emails/order-confirmation.html",
      line: lineOf("order-confirmation.html", "{{order_id}}"),
    });
    expect(placeholder[0]?.evidence).toContain("{{order_id}}");

    const venmo = by("payment-handle-mismatch");
    expect(venmo).toHaveLength(1);
    expect(venmo[0]?.source).toEqual({
      file: "emails/receipt.html",
      line: lineOf("receipt.html", "@marlowe-old"),
    });
    expect(venmo[0]?.url).toBe("emails/receipt.html");
    expect(venmo[0]?.evidence).toContain("emails/receipt.html:");
    expect(venmo[0]?.evidence).toContain("@marlowe-old");
    expect(venmo[0]?.evidence).toContain("@marlowe-popup");

    const phone = by("facts-match");
    expect(phone).toHaveLength(1);
    expect(phone[0]?.source?.file).toBe("emails/receipt.html");
    expect(phone[0]?.source?.line).toBe(lineOf("receipt.html", "555-0199"));

    const images = by("email-image-not-absolute");
    expect(images).toHaveLength(1);
    expect(images[0]?.source).toEqual({
      file: "emails/welcome.html",
      line: lineOf("welcome.html", "/mail/logo.png"),
    });
  });

  it("wants a text version for the four emails that have none, and finds nothing else", async () => {
    const r = await run();
    const missing = r.result.findings.filter((f) => f.checkId === "email-no-text-part");
    expect(missing.map((f) => f.source?.file).sort()).toEqual([
      "emails/booking-request.html",
      "emails/order-confirmation.html",
      "emails/receipt.html",
      "emails/welcome.html",
    ]);
    expect(r.result.findings.map((f) => f.checkId).sort()).toEqual(
      [
        "email-image-not-absolute",
        "email-no-text-part",
        "email-no-text-part",
        "email-no-text-part",
        "email-no-text-part",
        "email-preview-placeholder",
        "email-relative-link",
        "facts-match",
        "payment-handle-mismatch",
      ].sort(),
    );
  });

  it("lists the findings high first, and a clean email has none", async () => {
    const r = await run();
    const order = r.result.findings.map((f) => f.severity);
    expect(order).toEqual(
      [...order].sort((a, b) =>
        a === b ? 0 : a === "high" ? -1 : b === "high" ? 1 : a === "medium" ? -1 : 1,
      ),
    );
    const files = new Set(r.result.findings.flatMap((f) => (f.source ? [f.source.file] : [])));
    expect(files.has("emails/pickup-reminder.html")).toBe(false);
    expect(files.has("emails/gift-card.html")).toBe(false);
    expect(r.emails.find((e) => e.file === "emails/gift-card.html")).toMatchObject({ text: true });
  });

  it("makes no request, and says which checks did not run because of it", async () => {
    const r = await run();
    expect(r.requested).toBe(false);
    const ids = r.result.couldNotCheck.filter((c) => c.reason === NO_BASE_REASON).map((c) => c.id);
    expect(ids.sort()).toEqual([
      "broken-links",
      "images-broken",
      "links-via-redirect",
      "payment-link-dead",
    ]);
    for (const id of ids) expect(r.result.passed).not.toContain(id);
    // The checks that read only the files did run and passed.
    expect(r.result.passed).toContain("payment-handle-unknown");
  });

  it("the result is schema 2, and every finding names a file", async () => {
    const r = await run();
    expect(r.result.schema).toBe(2);
    expect(r.result.url).toBe("emails");
    for (const f of r.result.findings) expect(f.source?.file).toMatch(/^emails\//);
  });

  it("the same folder gives the same findings every time", async () => {
    const a = await run();
    const b = await run();
    expect(a.result.findings).toEqual(b.result.findings);
  });

  it("without gaugeline.emails.json the text check says so and passes nothing", async () => {
    const r = await checkEmails({ dir: join(MARLOWE, "emails"), fetcher: noNetwork });
    expect(r.result.findings.some((f) => f.checkId === "email-no-text-part")).toBe(false);
    expect(r.result.passed).not.toContain("email-no-text-part");
    expect(r.result.couldNotCheck.some((c) => c.id === "email-no-text-part")).toBe(true);
  });
});

describe("language parity between paired files (Cedar Row Physio)", () => {
  const languageRules = languageRulesSchema.parse(json(join(CEDAR, "gaugeline.languages.json")));
  const run = () =>
    checkEmails({
      dir: join(CEDAR, "emails"),
      prefix: "emails",
      fetcher: noNetwork,
      languageRules,
    });

  it("pairs by base name and reports the languages the folder uses", async () => {
    const r = await run();
    expect(r.languages).toEqual(["en", "es"]);
    expect(r.emails.map((e) => e.lang)).toEqual(["en", "es", "en"]);
  });

  it("reports each language problem once for a set of twins, at the file to fix", async () => {
    const r = await run();
    const by = (id: string) => r.result.findings.filter((f) => f.checkId === id);
    const cedar = (file: string, needle: string): number =>
      readFileSync(join(CEDAR, "emails", file), "utf8")
        .split("\n")
        .findIndex((l) => l.includes(needle)) + 1;
    // The price differs between the two appointment emails: one finding, on the English one, at its structured data.
    const price = by("lang-price-mismatch");
    expect(price).toHaveLength(1);
    expect(price[0]?.evidence).toContain(
      "first-visit: 85 USD on /appointment.en.html (en), 95 USD on /appointment.es.html (es)",
    );
    expect(price[0]?.source).toEqual({
      file: "emails/appointment.en.html",
      line: cedar("appointment.en.html", "ld+json"),
    });
    // reminder.en.html has no Spanish twin, and the folder is bilingual.
    const twin = by("lang-twin-missing");
    expect(twin).toHaveLength(1);
    expect(twin[0]?.source?.file).toBe("emails/reminder.en.html");
    expect(twin[0]?.evidence).toContain("reminder.es.html is not in the folder");
    // "Book again" is English text in the Spanish email: the finding is at the Spanish file's line.
    const untranslated = by("lang-untranslated");
    expect(untranslated).toHaveLength(1);
    expect(untranslated[0]?.source).toEqual({
      file: "emails/appointment.es.html",
      line: cedar("appointment.es.html", "Book again"),
    });
  });

  it("a Spanish file whose html says English is reported once, on the set of twins", async () => {
    const dir = workdir({
      "a.en.html": '<html lang="en"><body>a</body></html>',
      "a.es.html": '<html lang="en"><body>a</body></html>',
    });
    const r = await checkEmails({ dir, fetcher: noNetwork });
    const found = r.result.findings.filter((f) => f.checkId === "lang-attr-mismatch");
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain('/a.es.html is es but has lang="en"');
  });
});

describe("with --base: the site's links and images are asked for, nothing else", () => {
  it("probes same-site links and images with HEAD, never a third party, never a relative link", async () => {
    const server = await startServer({
      "/orders/1": (_q, res) => void res.writeHead(200, { "content-type": "text/html" }).end("ok"),
      "/img/logo.png": (_q, res) =>
        void res.writeHead(200, { "content-type": "image/png" }).end("x"),
    });
    servers.push(server);
    const dir = workdir({
      "emails/order.html": `<!doctype html><html lang="en"><body>
<a href="${server.origin}/orders/1">ok</a>
<a href="${server.origin}/orders/gone">gone</a>
<a href="/menu">relative</a>
<a href="https://elsewhere.example/x">third party</a>
<img src="${server.origin}/img/logo.png"><img src="${server.origin}/img/missing.png">
</body></html>`,
    });
    const r = await checkEmails({
      dir: join(dir, "emails"),
      prefix: "emails",
      base: server.origin,
      fetcher: createFetcher({ allowPrivate: true, timeoutMs: 5000 }),
    });
    expect(r.requested).toBe(true);
    const broken = r.result.findings.filter((f) => f.checkId === "broken-links");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.source).toEqual({ file: "emails/order.html", line: 3 });
    expect(broken[0]?.evidence).toContain("returned 404");
    const image = r.result.findings.filter((f) => f.checkId === "images-broken");
    expect(image).toHaveLength(1);
    expect(image[0]?.source?.line).toBe(6);
    expect(new Set(server.log.map((q) => q.method))).toEqual(new Set(["HEAD"]));
    const paths = server.log.map((q) => q.path).sort();
    expect(paths).toEqual(["/img/logo.png", "/img/missing.png", "/orders/1", "/orders/gone"]);
    expect(r.result.couldNotCheck.some((c) => c.reason === NO_BASE_REASON)).toBe(false);
  });

  it("an email with 200 links is sampled like a page, and the sample is reported", async () => {
    const server = await startServer({}, (_q, res) => void res.writeHead(200).end("ok"));
    servers.push(server);
    const links = Array.from(
      { length: 200 },
      (_, i) => `<a href="${server.origin}/p/${i}">p${i}</a>`,
    );
    const dir = workdir({ "newsletter.html": `<html><body>${links.join("\n")}</body></html>` });
    const r = await checkEmails({
      dir,
      base: server.origin,
      fetcher: createFetcher({ allowPrivate: true, timeoutMs: 5000 }),
    });
    expect(server.log).toHaveLength(30);
    expect(r.result.sampled.links).toEqual({ seen: 200, taken: 30, limit: 30 });
    expect(r.notes).toContain("newsletter.html: 30 of 200 links checked.");
    expect(r.emails[0]?.links).toBe(200);
  });

  it("a tracking-wrapped link is checked at its destination when the pattern is known, and as it is when not", async () => {
    const server = await startServer({
      "/orders/1": (_q, res) => void res.writeHead(200).end("ok"),
      "/wrapper/AbC": (_q, res) => void res.writeHead(404).end("no"),
    });
    servers.push(server);
    const dest = encodeURIComponent(`${server.origin}/orders/1`);
    const dir = workdir({
      "order.html": `<html><body>
<a href="${server.origin}/click/go?u=${dest}">known</a>
<a href="${server.origin}/wrapper/AbC">opaque</a>
</body></html>`,
    });
    const r = await checkEmails({
      dir,
      base: server.origin,
      config: { tracking: [{ host: "127.0.0.1", param: "u", path: "/click/go" }] },
      fetcher: createFetcher({ allowPrivate: true, timeoutMs: 5000 }),
    });
    expect(server.log.map((q) => q.path).sort()).toEqual(["/orders/1", "/wrapper/AbC"]);
    const broken = r.result.findings.filter((f) => f.checkId === "broken-links");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.source?.line).toBe(3);
  });
});

describe("links that are never asked for", () => {
  it("an unsubscribe or preferences link is not requested, on any site, with or without a token", async () => {
    const server = await startServer({}, (_q, res) => void res.writeHead(200).end("ok"));
    servers.push(server);
    const dir = workdir({
      "a.html": `<a href="${server.origin}/unsubscribe?t=abc">Stop these emails</a>
<a href="${server.origin}/account">Manage your preferences</a>
<a href="${server.origin}/email/optout/9">out</a>
<a href="${server.origin}/orders/1">View your order</a>`,
    });
    await checkEmails({
      dir,
      base: server.origin,
      fetcher: createFetcher({ allowPrivate: true, timeoutMs: 5000 }),
    });
    expect(server.log.map((q) => q.path)).toEqual(["/orders/1"]);
  });
});

describe("reading the folder", () => {
  it("reads CRLF files as bytes, with the same lines", async () => {
    const lf = "<html>\n<body>\n<p>{{who}}</p>\n</body>\n</html>\n";
    const dir = workdir({ "a.html": lf, "b.html": lf.replace(/\n/g, "\r\n") });
    const r = await checkEmails({ dir, fetcher: noNetwork });
    const lines = r.result.findings
      .filter((f) => f.checkId === "email-preview-placeholder")
      .map((f) => f.source?.line);
    expect(lines).toEqual([3, 3]);
  });

  it("one .html file is an email, and a folder with none is a ConfigError", async () => {
    const dir = workdir({ "one.html": "<p>{{x}}</p>", "notes.txt": "hello" });
    const one = await checkEmails({ dir: join(dir, "one.html"), fetcher: noNetwork });
    expect(one.emails).toHaveLength(1);
    await expect(
      checkEmails({ dir: join(workdir({ "x.txt": "x" })), fetcher: noNetwork }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(checkEmails({ dir: join(dir, "missing"), fetcher: noNetwork })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("looks in folders under it, in name order, and leaves hidden folders and node_modules alone", async () => {
    const dir = workdir({
      "b/two.html": "<p>2</p>",
      "a/one.html": "<p>1</p>",
      ".hidden/x.html": "<p>x</p>",
      "node_modules/y/y.html": "<p>y</p>",
    });
    const r = await checkEmails({ dir, fetcher: noNetwork });
    expect(r.emails.map((e) => e.file)).toEqual(["a/one.html", "b/two.html"]);
  });

  it("a .txt with the same name beside an email is its text version, and is read for placeholders too", async () => {
    const dir = workdir({
      "a.html": "<p>hi</p>",
      "a.txt": "Hi {{name}}\nbye",
      "b.html": "<p>b</p>",
    });
    const r = await checkEmails({ dir, config: { textVersion: true }, fetcher: noNetwork });
    expect(
      r.result.findings
        .filter((f) => f.checkId === "email-no-text-part")
        .map((f) => f.source?.file),
    ).toEqual(["b.html"]);
    const p = r.result.findings.find((f) => f.checkId === "email-preview-placeholder");
    expect(p?.source).toEqual({ file: "a.txt", line: 1 });
  });

  it("text from an email is escaped in what is printed", async () => {
    const dir = workdir({ "a.html": "<p>{{na\u202Eme}}</p>" });
    const r = await checkEmails({ dir, fetcher: noNetwork });
    const f = r.result.findings.find((x) => x.checkId === "email-preview-placeholder");
    expect(f?.evidence).toContain("\\u{202E}");
    expect(f?.evidence).not.toContain("\u202E");
  });
});
