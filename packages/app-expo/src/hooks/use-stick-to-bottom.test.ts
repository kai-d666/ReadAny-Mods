import { describe, expect, it } from "vitest";
import { BOTTOM_THRESHOLD, isNearBottom } from "./use-stick-to-bottom";

describe("isNearBottom", () => {
  it("is true while the viewport bottom sits inside the threshold", () => {
    // 1000 tall content, 600 tall viewport, scrolled to 380 → 20dp from the end.
    expect(isNearBottom(380, 1000, 600)).toBe(true);
  });

  it("is false once the reader is further away than the threshold", () => {
    expect(isNearBottom(200, 1000, 600)).toBe(false);
  });

  it("treats exactly the threshold away as no longer at the bottom", () => {
    // 400 of slack left == BOTTOM_THRESHOLD. The boundary is strict: the pin
    // releases a hair early rather than a hair late, matching the old handler.
    expect(isNearBottom(1000 - 600 - BOTTOM_THRESHOLD, 1000, 600)).toBe(false);
  });

  it("is true when the content is shorter than the viewport", () => {
    // Nothing to scroll — the distance goes negative, which must not read as
    // "the reader scrolled away".
    expect(isNearBottom(0, 100, 600)).toBe(true);
  });

  it("is true for an unscrolled list whose content exactly fills the viewport", () => {
    expect(isNearBottom(0, 600, 600)).toBe(true);
  });
});
