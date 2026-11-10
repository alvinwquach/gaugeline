import { describe, expect, it } from "vitest";
import { describeRetry, retryAfterSeconds } from "../http.js";

describe("Retry-After: unit", () => {
  it("whole seconds are read as before", () => {
    expect(retryAfterSeconds({ "retry-after": "120" })).toBe(120);
    expect(describeRetry({ "retry-after": "120" })).toBe("in 120 seconds");
    expect(describeRetry({ "retry-after": "1" })).toBe("in 1 second");
  });

  it('a decimal ("2.0", Shopify\'s form) is seconds, rounded up, never read as a date', () => {
    expect(retryAfterSeconds({ "retry-after": "2.0" })).toBe(2);
    expect(retryAfterSeconds({ "retry-after": "1.5" })).toBe(2);
    expect(retryAfterSeconds({ "retry-after": "0.2" })).toBe(1);
    expect(describeRetry({ "retry-after": "2.0" })).toBe("in 2 seconds");
    expect(describeRetry({ "retry-after": "1.5" })).toBe("in 2 seconds");
    expect(describeRetry({ "retry-after": "0.5" })).toBe("in 1 second");
  });

  it("a date and nonsense keep their meaning", () => {
    expect(retryAfterSeconds({ "retry-after": "Wed, 11 Nov 2026 08:00:00 GMT" })).toBeUndefined();
    expect(retryAfterSeconds({ "retry-after": "soon" })).toBeUndefined();
    expect(retryAfterSeconds({ "retry-after": "-3" })).toBeUndefined();
    expect(describeRetry({ "retry-after": "1.2.3" })).toBeUndefined();
  });
});
