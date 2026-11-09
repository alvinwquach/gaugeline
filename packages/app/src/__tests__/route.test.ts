import { describe, expect, it } from "vitest";
import { formatHash, parseHash } from "../route";

describe("the address bar", () => {
  it("reads #/<run>/<view>, with no open item", () => {
    expect(parseHash("#/r1/problems")).toEqual({ runId: "r1", viewId: "problems", item: null });
    expect(parseHash("#/r1")).toEqual({ runId: "r1", viewId: null, item: null });
    expect(parseHash("")).toEqual({ runId: null, viewId: null, item: null });
  });

  it("reads #/<run>/<view>/<index> as the open item", () => {
    expect(parseHash("#/r1/problems/12")).toEqual({ runId: "r1", viewId: "problems", item: "12" });
    expect(parseHash("#/r1/problems/12/")).toEqual({ runId: "r1", viewId: "problems", item: "12" });
  });

  it("writes the item only when there is one", () => {
    expect(formatHash("r 1", "problems")).toBe("#/r%201/problems");
    expect(formatHash("r1", "problems", 3)).toBe("#/r1/problems/3");
    expect(parseHash(formatHash("r 1", "problems", 3))).toEqual({
      runId: "r 1",
      viewId: "problems",
      item: "3",
    });
  });
});
