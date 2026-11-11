import { describe, expect, it } from "vitest";
import { PLACEHOLDER_RULES, findPlaceholders } from "../placeholders.js";
import { maskSource, parseEmail } from "../parse.js";

const texts = (s: string): string[] => findPlaceholders(s).map((m) => m.text);

describe("placeholders: one sample per rule", () => {
  // Every rule in the table has a case here, so a rule cannot be added or loosened unseen.
  const SAMPLES: Record<string, { yes: string; no: string }> = {
    "handlebars-triple": { yes: "<p>{{{order_html}}}</p>", no: "<p>{ {{ }</p>" },
    "double-braces": { yes: "Order {{order_id}} is confirmed", no: "Order 1001 is confirmed" },
    "liquid-tag": { yes: "{% if order.paid %}Paid{% endif %}", no: "100% sure {x}" },
    "erb-tag": { yes: "Hi <%= user.name %>,", no: "Hi <b>Dana</b>," },
    "template-literal": { yes: "Hi ${customer.firstName}", no: "Hi $5 off" },
    "single-braces": { yes: "Hi {props.name}, order {orderId}", no: "a {b c} d, { }" },
    "object-object": { yes: "Total: [object Object]", no: "Total: [one object]" },
    "merge-tag": { yes: "Hi *|FNAME|*,", no: "a *|b|* c" },
    "js-undefined": { yes: "Hi undefined, you owe $NaN", no: "an undefinedly long word" },
    "js-null": { yes: "<p>null</p> and Hello null,", no: "<p>nullable</p> annulled" },
  };

  it("has a case for every rule, and no case for a rule that is gone", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(PLACEHOLDER_RULES.map((r) => r.id).sort());
  });

  for (const rule of PLACEHOLDER_RULES) {
    const sample = SAMPLES[rule.id];
    it(`${rule.id} reads its sample and leaves ordinary text alone`, () => {
      const yes = findPlaceholders(sample?.yes ?? "");
      expect(
        yes.some((m) => m.rule === rule.id),
        sample?.yes,
      ).toBe(true);
      expect(findPlaceholders(sample?.no ?? "").filter((m) => m.rule === rule.id)).toEqual([]);
    });
  }
});

describe("placeholders: Handlebars, Liquid and JSX leftovers", () => {
  it("Handlebars: variables, blocks, partials and triple braces", () => {
    expect(texts("{{name}} {{#each items}} {{> footer}} {{{body}}}")).toEqual([
      "{{name}}",
      "{{#each items}}",
      "{{> footer}}",
      "{{{body}}}",
    ]);
  });

  it("Liquid: output with filters and tags", () => {
    expect(texts("{{ order.total | money }} {% for line in lines %}x{% endfor %}")).toEqual([
      "{{ order.total | money }}",
      "{% for line in lines %}",
      "{% endfor %}",
    ]);
  });

  it("JSX leftovers: a member access, a bare name, a template literal, an object", () => {
    expect(texts("{props.name} {total} ${price} [object Object]")).toEqual([
      "{props.name}",
      "{total}",
      "${price}",
      "[object Object]",
    ]);
  });

  it("a triple-brace tag is one match, not a double-brace tag inside it", () => {
    expect(texts("{{{html}}}")).toEqual(["{{{html}}}"]);
  });

  it("a double-brace tag is not also read as single braces", () => {
    expect(findPlaceholders("{{name}}").map((m) => m.rule)).toEqual(["double-braces"]);
  });

  it("finished text has none", () => {
    expect(texts("Thanks, Dana. Order 1001 is confirmed: $48.00 (tax incl.), 100% fresh.")).toEqual(
      [],
    );
  });
});

describe("placeholders: where they are looked for", () => {
  it("styles, scripts and comments are blanked, line breaks kept, so CSS braces are not placeholders", () => {
    const html =
      "<style>\n.a { color: red }\n@media x { .b { c: d } }\n</style>\n<p>{{who}}</p>\n<!-- {{note}} -->";
    const masked = maskSource(html);
    expect(masked.split("\n")).toHaveLength(html.split("\n").length);
    expect(texts(masked)).toEqual(["{{who}}"]);
  });

  it("JSON-LD is read: a placeholder there is a real fault", () => {
    const html = '<script type="application/ld+json">{"orderNumber":"{{order_id}}"}</script>';
    expect(texts(maskSource(html))).toEqual(["{{order_id}}"]);
  });

  it('an attribute is read: href="{{url}}"', () => {
    expect(texts(maskSource('<a href="{{url}}">x</a>'))).toEqual(["{{url}}"]);
  });

  it("the line of a match is the line in the file, with CRLF endings too", () => {
    const html = "<p>one</p>\r\n<p>two</p>\r\n<p>{{three}}</p>\r\n";
    const p = parseEmail(html);
    const m = findPlaceholders(p.masked)[0];
    expect(p.lineAt(m?.index ?? 0)).toBe(3);
  });
});
