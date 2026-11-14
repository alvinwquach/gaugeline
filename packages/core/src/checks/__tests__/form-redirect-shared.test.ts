import { describe, expect, it } from "vitest";
import { REDIRECT_FIELD_NAMES, isRedirectFieldName } from "../../forms/redirect-fields.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { readRedirectLeaks, redirectShape } from "../form-redirect-shared.js";

/**
 * form-redirect-leaks-details: what the shape detection and the reading of the page's forms return. Every
 * email- and phone-shaped value is assembled here from parts at run time (community:check refuses such a
 * literal); the people and hosts are invented.
 */
const AT = "@";
const EMAIL = ["sam.reeves", "harbour-physio.example"].join(AT);
const EMAIL_ENC = EMAIL.replace(AT, "%40");
const PHONE = ["+1", "555", "010", "4477"].join(" ");
const PHONE_ENC = encodeURIComponent(PHONE);
const LOCAL = "sam.reeves";
const PAGE = "https://harbour-physio.example/book/";

function snap(body: string, url = PAGE): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Harbour Physio</title></head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}
const form = (action: string | undefined, inner = ""): string =>
  `<form${action === undefined ? "" : ` action="${action}"`} method="post"><input name="note">${inner}</form>`;
const hidden = (name: string, value: string): string =>
  `<input type="hidden" name="${name}" value="${value}">`;
const read = (body: string, url = PAGE) => readRedirectLeaks(snap(body, url));

describe("redirectShape: unit", () => {
  it("names an email, a phone number, and nothing else", () => {
    expect(redirectShape(EMAIL)).toBe("email");
    expect(redirectShape(PHONE)).toBe("phone");
    expect(redirectShape(`mailto:${EMAIL}`)).toBe("email");
    expect(redirectShape(`tel:${PHONE.replace(/ /g, "")}`)).toBe("phone");
    expect(redirectShape("thanks")).toBeUndefined();
    expect(redirectShape("2026-11-14")).toBeUndefined();
    expect(redirectShape("1731600000")).toBeUndefined();
    expect(redirectShape("")).toBeUndefined();
  });

  it("reads a percent-encoded value, and leaves a bad escape alone", () => {
    expect(redirectShape(EMAIL_ENC)).toBe("email");
    expect(redirectShape("100%")).toBeUndefined();
  });

  it("is not fooled by a web address that happens to hold one", () => {
    expect(redirectShape(`https://harbour-physio.example/thanks?e=${EMAIL}`)).toBeUndefined();
  });
});

describe("redirect field names: unit", () => {
  it("is one list, matched without regard to case, underscores or hyphens", () => {
    expect(REDIRECT_FIELD_NAMES).toEqual(
      expect.arrayContaining(["retURL", "redirect_to", "returnUrl", "success_url", "next", "goto"]),
    );
    for (const n of ["retURL", "RETURL", "redirect_to", "Redirect-To", "_next", "thank_you"])
      expect(isRedirectFieldName(n), n).toBe(true);
    for (const n of ["email", "oid", "utm_source", "nextofkin", "note", ""])
      expect(isRedirectFieldName(n), n).toBe(false);
  });
});

describe("readRedirectLeaks: unit", () => {
  it("finds an email in the query of a form action, and prints the parameter, never the value", () => {
    const r = read(form(`/thanks?email=${EMAIL_ENC}&plan=gold`));
    expect(r.hits).toEqual([
      'Form action https://harbour-physio.example/thanks?email=***&plan=***: the "email" parameter holds an email address.',
    ]);
    expect(r.unseen).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(LOCAL);
  });

  it("finds a phone number in the query, written with an encoded plus", () => {
    const r = read(form(`https://harbour-physio.example/thanks?tel=${PHONE_ENC}`));
    expect(r.hits).toEqual([
      'Form action https://harbour-physio.example/thanks?tel=***: the "tel" parameter holds a phone number.',
    ]);
    expect(JSON.stringify(r)).not.toContain("4477");
  });

  it("reads the fragment as well as the query, and says which", () => {
    const r = read(form(`/thanks#email=${EMAIL_ENC}`));
    expect(r.hits).toEqual([
      'Form action https://harbour-physio.example/thanks#email=***: the "email" parameter holds an email address.',
    ]);
    const bare = read(form(`/thanks#${EMAIL_ENC}`));
    expect(bare.hits).toEqual([
      "Form action https://harbour-physio.example/thanks#***: the fragment holds an email address.",
    ]);
  });

  it("reads a redirect field's address, resolving a relative one against the page", () => {
    const r = read(form("/submit", hidden("retURL", `/thanks?email=${EMAIL_ENC}`)));
    expect(r.hits).toEqual([
      'The "retURL" field sends visitors to https://harbour-physio.example/thanks?email=***: the "email" parameter holds an email address.',
    ]);
  });

  it("reads a redirect field on a form with no action of its own", () => {
    const r = read(form(undefined, hidden("redirect_to", `/thanks?phone=${PHONE_ENC}`)));
    expect(r.hits).toHaveLength(1);
    expect(r.unseen).toEqual([]);
  });

  it("finds a field whose whole value is an email or a phone number", () => {
    expect(read(form("/submit", hidden("return", EMAIL))).hits).toEqual([
      'The "return" field holds an email address instead of an address to go to.',
    ]);
    expect(read(form("/submit", hidden("next", PHONE))).hits).toEqual([
      'The "next" field holds a phone number instead of an address to go to.',
    ]);
    expect(read(form("/submit", hidden("thanks", `mailto:${EMAIL}`))).hits).toHaveLength(1);
  });

  it("matches a parameter name without regard to case, and prints it as the page wrote it", () => {
    const r = read(form(`/thanks?EMAIL=${EMAIL_ENC}`));
    expect(r.hits).toEqual([
      'Form action https://harbour-physio.example/thanks?EMAIL=***: the "EMAIL" parameter holds an email address.',
    ]);
  });

  it("finds one hit for each address, naming every parameter that leaks", () => {
    const r = read(form(`/thanks?email=${EMAIL_ENC}&phone=${PHONE_ENC}`));
    expect(r.hits).toEqual([
      'Form action https://harbour-physio.example/thanks?email=***&phone=***: the "email" parameter holds an email address and the "phone" parameter holds a phone number.',
    ]);
  });

  it("reads every form on the page, and a form repeated word for word is one hit", () => {
    const leak = form(`/thanks?email=${EMAIL_ENC}`);
    const other = form(`/other?mobile=${PHONE_ENC}`);
    expect(read(leak + other + form("/clean?plan=gold")).hits).toHaveLength(2);
    expect(read(leak + leak).hits).toHaveLength(1);
  });

  it("looks inside an address that is a parameter of another, and names both", () => {
    const inner = encodeURIComponent(`https://harbour-physio.example/thanks?email=${EMAIL_ENC}`);
    const r = read(form(`https://forms.example/submit?retURL=${inner}`));
    expect(r.hits).toEqual([
      'Form action https://forms.example/submit?retURL=***: the "retURL > email" parameter holds an email address.',
    ]);
  });

  it("does not follow an address more than two deep", () => {
    let nested = `/thanks?email=${EMAIL_ENC}`;
    for (let i = 0; i < 4; i++) nested = `/x?u=${encodeURIComponent(nested)}`;
    expect(read(form(nested)).hits).toEqual([]);
  });

  it("finds nothing when the redirect field holds a clean address", () => {
    const r = read(
      form("/submit?plan=gold", hidden("retURL", "https://harbour-physio.example/thanks")),
    );
    expect(r).toEqual({ hits: [], unseen: [] });
  });

  it("reads only fields named like a redirect: an email in another hidden field is not this check's", () => {
    const r = read(
      form("/submit", hidden("owner_note", EMAIL) + hidden("source", `/x?e=${EMAIL}`)),
    );
    expect(r).toEqual({ hits: [], unseen: [] });
  });

  it("does not read a path, and masks one that holds an email", () => {
    expect(read(form(`/thanks/${LOCAL}`)).hits).toEqual([]);
    const r = read(form("/submit", hidden("retURL", `/thanks/${EMAIL_ENC}?phone=${PHONE_ENC}`)));
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toContain("/thanks/[masked]?phone=***");
    expect(JSON.stringify(r)).not.toContain(LOCAL);
  });

  it("masks a parameter name that is itself a detail", () => {
    const r = read(form(`/thanks?${EMAIL_ENC}`));
    expect(r.hits).toEqual([
      "Form action https://harbour-physio.example/thanks?[masked]=***: a parameter name holds an email address.",
    ]);
  });

  it("caps a very long value: it is cut, never crashes, and a detail past the cap is not seen", () => {
    const long = "a".repeat(5000);
    const early = read(form(`/thanks?email=${EMAIL_ENC}&pad=${long}`));
    expect(early.hits).toHaveLength(1);
    expect(early.hits[0]?.length).toBeLessThan(300);
    const late = read(form(`/thanks?pad=${long}&email=${EMAIL_ENC}`));
    expect(late.hits).toEqual([]);
    const field = read(form("/submit", hidden("retURL", `/thanks?pad=${long}&email=${EMAIL_ENC}`)));
    expect(field.hits).toEqual([]);
  });

  it("reads at most fifty parameters of an address", () => {
    const many = Array.from({ length: 80 }, (_, i) => `p${i}=1`).join("&");
    const r = read(form(`/thanks?${many}&email=${EMAIL_ENC}`));
    expect(r.hits).toEqual([]);
  });

  it("is the same every time it is asked", () => {
    const html = form(`/thanks?email=${EMAIL_ENC}`) + form(undefined);
    const s = snap(html);
    expect(readRedirectLeaks(s)).toEqual(readRedirectLeaks(s));
  });
});

describe("readRedirectLeaks: what it could not see", () => {
  it("says so for a form with no action and no thank-you field", () => {
    const r = read(form(undefined));
    expect(r.hits).toEqual([]);
    expect(r.unseen).toEqual([
      "1 form has no address of its own to read (no action, or an action of # or javascript:) and no thank-you field, so where it sends a visitor is only known after it is submitted or a script runs",
    ]);
  });

  it("says so for a form that submits through script", () => {
    expect(read(form("#") + form("javascript:void(0)")).unseen).toEqual([
      expect.stringContaining("2 forms have no address of its own"),
    ]);
  });

  it("does not say so when a thank-you field gives the form an address to read", () => {
    expect(read(form("#", hidden("retURL", "/thanks"))).unseen).toEqual([]);
  });

  it("does not say so for a form with an address, a search box or a mailto form", () => {
    expect(read(form("/submit")).unseen).toEqual([]);
    expect(read('<form method="get"><input name="q"></form>').unseen).toEqual([]);
    expect(read(form(`mailto:${EMAIL}`)).unseen).toEqual([]);
  });

  it("says so for an embedded form service, which is another document, naming the host and no query", () => {
    const r = read(
      `<iframe src="https://go.pardot.com/l/100001/xk2m?email=${EMAIL_ENC}"></iframe>`,
    );
    expect(r.hits).toEqual([]);
    expect(r.unseen).toHaveLength(1);
    expect(r.unseen[0]).toContain("go.pardot.com");
    expect(r.unseen[0]).toContain("another document");
    expect(JSON.stringify(r)).not.toContain(LOCAL);
  });

  it("says so for a form a script draws", () => {
    const r = read('<script src="https://js.hsforms.net/forms/embed/v2.js"></script>');
    expect(r.unseen).toEqual([expect.stringContaining("drawn by JavaScript")]);
  });

  it("says so for an address that has a detail's parameter with nothing in it, filled on submit", () => {
    for (const v of ["", "%7B%7Bemail%7D%7D", "[email]", "%25email%25"]) {
      const r = read(form(`/thanks?email=${v}`));
      expect(r.hits, v).toEqual([]);
      expect(r.unseen, v).toEqual([
        'Form action https://harbour-physio.example/thanks?email=***: the "email" parameter has no value in the HTML, so what it holds is only known after the form is submitted',
      ]);
    }
  });

  it("does not call a filled parameter or an unrelated empty one unseen", () => {
    expect(read(form("/thanks?plan=")).unseen).toEqual([]);
    expect(read(form("/thanks?email=none")).unseen).toEqual([]);
  });
});
