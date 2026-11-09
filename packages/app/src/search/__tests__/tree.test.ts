import { describe, expect, it } from "vitest";
import { MAX_DEPTH, MAX_NODES, blockTitle, toTree, type Node } from "../tree";

/** The keys of a list of nodes, depth first, with how deep each is. */
const walk = (nodes: Node[] | undefined, depth = 0): string[] =>
  (nodes ?? []).flatMap((n) => [`${depth}:${n.key}`, ...walk(n.children, depth + 1)]);

describe("toTree: unit", () => {
  it("nested objects become nested nodes, and a scalar is a value with no children", () => {
    const tree = toTree({
      "@type": "Product",
      name: "Speckled mug",
      offers: { "@type": "Offer", price: "24.00", priceCurrency: "USD" },
    });
    expect(tree).toEqual([
      { key: "@type", value: "Product" },
      { key: "name", value: "Speckled mug" },
      {
        key: "offers",
        value: "Offer",
        children: [
          { key: "@type", value: "Offer" },
          { key: "price", value: "24.00" },
          { key: "priceCurrency", value: "USD" },
        ],
      },
    ]);
  });

  it("arrays of objects: each item is a node keyed by its place, named by its type", () => {
    const tree = toTree({
      review: [
        { "@type": "Review", author: "Ann" },
        { "@type": "Review", author: "Bo" },
      ],
    });
    expect(walk(tree)).toEqual([
      "0:review",
      "1:0",
      "2:@type",
      "2:author",
      "1:1",
      "2:@type",
      "2:author",
    ]);
    expect(tree[0]?.children?.[0]).toMatchObject({ key: "0", value: "Review" });
  });

  it("@graph lists its members, so a block with a graph reads like any other", () => {
    const tree = toTree({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: "Larkspur" },
        { "@type": "WebSite", name: "Larkspur Pottery" },
      ],
    });
    expect(tree.map((n) => n.key)).toEqual(["@context", "@graph"]);
    expect(tree[1]?.children?.map((n) => [n.key, n.value])).toEqual([
      ["0", "Organization"],
      ["1", "WebSite"],
    ]);
  });

  it("an array block is a list of nodes", () => {
    expect(toTree([{ "@type": "A" }, { "@type": "B" }]).map((n) => [n.key, n.value])).toEqual([
      ["0", "A"],
      ["1", "B"],
    ]);
  });

  it("a string where an object was expected is shown as the string", () => {
    expect(
      toTree({ "@type": "Product", offers: "https://schema.org/InStock", "@graph": "oops" }),
    ).toEqual([
      { key: "@type", value: "Product" },
      { key: "offers", value: "https://schema.org/InStock" },
      { key: "@graph", value: "oops" },
    ]);
    expect(toTree("just text")).toEqual([{ key: "value", value: "just text" }]);
  });

  it("numbers, booleans and null are shown as text; an empty string and empty containers are said so", () => {
    expect(toTree({ a: 1, b: true, c: null, d: "", e: {}, f: [] })).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "true" },
      { key: "c", value: "null" },
      { key: "d", value: "" },
      { key: "e", value: "{}" },
      { key: "f", value: "[]" },
    ]);
  });

  it("a type given as a list is shown as a list", () => {
    expect(toTree({ "@type": ["Product", "Thing"] })[0]).toMatchObject({ value: "Product, Thing" });
  });

  it("twelve levels deep keeps all twelve, depth first", () => {
    let value: unknown = { leaf: "end" };
    for (let i = 11; i >= 1; i--) value = { [`l${i}`]: value };
    const keys = walk(toTree(value));
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe("0:l1");
    expect(keys[11]).toBe("11:leaf");
  });

  it("stops at MAX_DEPTH and says so, instead of running out of stack", () => {
    let value: unknown = "end";
    for (let i = 0; i < 5000; i++) value = { next: value };
    const keys = walk(toTree(value));
    expect(keys.length).toBeLessThanOrEqual(MAX_DEPTH + 1);
    let node: Node | undefined = toTree(value)[0];
    let last: Node | undefined;
    while (node) {
      last = node;
      node = node.children?.[0];
    }
    expect(last?.value).toMatch(/not shown/i);
  });

  it("stops at MAX_NODES and says how much was left out", () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_NODES + 50 }, (_, i) => [`k${i}`, i]));
    const tree = toTree(wide);
    expect(tree).toHaveLength(MAX_NODES + 1);
    expect(tree.at(-1)).toEqual({ key: "\u2026", value: "50 more fields are not shown." });
  });

  it("keys that look like markup are plain keys", () => {
    expect(toTree({ "</script><script>alert(1)</script>": "x" })[0]?.key).toBe(
      "</script><script>alert(1)</script>",
    );
  });
});

describe("blockTitle: unit", () => {
  it.each([
    [{ "@type": "Product" }, "Product"],
    [{ "@type": ["Product", "Thing"] }, "Product, Thing"],
    [{ "@graph": [{ "@type": "Organization" }, { "@type": "WebSite" }] }, "Organization, WebSite"],
    [[{ "@type": "A" }, { "@type": "B" }], "A, B"],
    [{ name: "no type" }, "No type given"],
    ["text", "No type given"],
  ])("%j is %s", (value, title) => {
    expect(blockTitle(value)).toBe(title);
  });
});
